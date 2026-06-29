-- ============================================================================
-- Invoice tax precision + discount-allocation fix.
--
-- WHY:
--   * p_tax_rate_bps was `integer`, so NJ's 6.625% (= 662.5 bps) was not
--     representable (only 662/663). Change to `numeric` basis points.
--   * Validate the rate is finite and in [0, 10000] in the RPC (and the route).
--   * POLICY (Confidel's, NOT a statutory mandate): a GLOBAL invoice discount is
--     allocated PROPORTIONALLY across taxable vs. exempt charges before tax is
--     computed. NJ ANJ-9 confirms a seller-funded discount reduces the taxable
--     receipt, but does NOT specifically require proportional allocation on a
--     mixed taxable/exempt invoice. Proportional allocation is Confidel's chosen
--     global-discount treatment, PENDING ACCOUNTANT CONFIRMATION. (Future:
--     per-line-item discounts will override this global policy.)
--
-- Postgres keys functions by argument type, so `CREATE OR REPLACE` with a new
-- type would leave the old `integer` overload callable. We DROP the integer
-- signature and CREATE the numeric one in ONE transaction.
--
-- Preserves: SECURITY DEFINER, owner = postgres, and the auth.uid()/
-- is_company_admin authorization. EXECUTE revoked from PUBLIC/anon, granted only
-- to authenticated.
--
-- search_path = 'public, pg_temp' is safe here: anon/authenticated/PUBLIC all
-- have CREATE = false on schema public (verified), so no untrusted role can plant
-- a shadowing object, and pg_catalog is always resolved first for built-ins. If
-- that CREATE grant ever changes, switch to `set search_path = ''` with fully
-- schema-qualified identifiers (incl. pg_catalog) instead.
-- ============================================================================

begin;

-- Persist the exact inputs needed to reconstruct the tax later (auditability):
-- the numeric tax RATE used and the taxable discount actually allocated. tax_cents,
-- discount_cents, and taxable_subtotal_cents already exist on this table.
--
-- Columns are NULLABLE on purpose: rows created before this migration predate rate
-- capture, so we do NOT invent 0% for them (that would falsify historical invoices).
-- `calculation_version` distinguishes legacy rows (NULL) from this numeric-rate +
-- proportional-discount logic (2). New/updated rows are stamped version 2.
alter table public.job_financial_summaries
  add column if not exists tax_rate_bps           numeric,
  add column if not exists taxable_discount_cents bigint,
  add column if not exists calculation_version    smallint;

-- Normalize the definition in case a PRIOR run created these as NOT NULL DEFAULT 0
-- (ADD COLUMN IF NOT EXISTS would keep that wrong definition). drop default/not
-- null are idempotent no-ops when already nullable/defaultless. NOTE: this fixes
-- the column DEFINITION only; any 0 values a prior bad run already wrote into
-- existing rows would need separate data remediation.
alter table public.job_financial_summaries
  alter column tax_rate_bps           drop default,
  alter column tax_rate_bps           drop not null,
  alter column taxable_discount_cents drop default,
  alter column taxable_discount_cents drop not null,
  alter column calculation_version    drop default,
  alter column calculation_version    drop not null;

-- Rerunnable: drop BOTH the old integer and the new numeric signatures, so a
-- second run does not fail on an already-present numeric function.
drop function if exists public.create_invoice_draft_from_completion(uuid, integer, integer, date);
drop function if exists public.create_invoice_draft_from_completion(uuid, numeric, integer, date);

create function public.create_invoice_draft_from_completion(
  p_completion_id  uuid,
  p_tax_rate_bps   numeric,             -- REQUIRED basis points; 662.5 = 6.625% (NJ)
  p_discount_cents integer default 0,
  p_due_date       date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company           uuid;
  v_job               uuid;
  v_client            uuid;
  v_invoice           uuid;
  v_subtotal          bigint  := 0;
  v_taxable_sub       bigint  := 0;
  v_taxable_discount  bigint  := 0;   -- discount allocated to the taxable portion
  v_tax               bigint  := 0;
  v_discount          bigint  := greatest(coalesce(p_discount_cents, 0), 0);
  v_total             bigint  := 0;
  v_payroll           bigint  := 0;
  v_supplies          bigint  := 0;
  v_mileage_miles     numeric := 0;
  v_mileage_reimb     bigint  := 0;
  v_parking           bigint  := 0;
  v_tolls             bigint  := 0;
  v_other             bigint  := 0;
  v_reimburse         bigint  := 0;
  v_cost              bigint  := 0;
  v_profit            bigint  := 0;
  v_paid              bigint  := 0;
  v_status            text;
  v_inv_status        public.invoice_status;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Tax rate is REQUIRED. NULL is rejected (it is NOT silently treated as 0%),
  -- and `between` rejects NaN/+-Infinity and out-of-range values. The NULL check
  -- must come first: `NULL between 0 and 10000` is NULL, so `not (...)` is NULL
  -- (not true) and would otherwise let NULL slip through.
  if p_tax_rate_bps is null or not (p_tax_rate_bps between 0 and 10000) then
    raise exception 'invalid tax rate: % (required; must be a finite value between 0 and 10000 bps)', p_tax_rate_bps
      using errcode = '22023';
  end if;

  select company_id, job_id into v_company, v_job
    from public.job_completions where id = p_completion_id;
  if v_company is null then
    raise exception 'completion not found';
  end if;
  if not public.is_company_admin(v_company) then
    raise exception 'owner or admin access required' using errcode = '42501';
  end if;

  select client_id, coalesce(payroll_cents, 0) into v_client, v_payroll
    from public.jobs where id = v_job;

  select invoice_id into v_invoice
    from public.job_financial_summaries
   where completion_id = p_completion_id;

  if v_invoice is null then
    insert into public.invoices (company_id, client_id, job_id, amount_cents, status, due_date, created_by)
    values (v_company, v_client, v_job, 0, 'draft', p_due_date, auth.uid())
    returning id into v_invoice;
  else
    -- IMMUTABILITY GUARD (race-safe). Lock the invoice row FOR UPDATE so a
    -- concurrent payment cannot be inserted between this check and the rebuild
    -- (mark_payment takes the SAME row lock; PostgreSQL holds it to tx end, so
    -- the two serialize — closing the TOCTOU race). Regeneration is allowed ONLY
    -- while the invoice is still a draft with zero payments: once it is sent,
    -- paid, void, or has ANY payment, lines/tax/discount/summary are frozen.
    select status into v_inv_status from public.invoices where id = v_invoice for update;
    if v_inv_status is distinct from 'draft'
       or exists (select 1 from public.payments where invoice_id = v_invoice) then
      raise exception 'invoice % is finalized or has payments; regeneration is blocked', v_invoice
        using errcode = '22023';
    end if;
    delete from public.invoice_line_items where invoice_id = v_invoice;
    update public.invoices set due_date = coalesce(p_due_date, due_date), updated_at = now()
      where id = v_invoice;
  end if;

  -- service revenue lines (priced from service_prices)
  insert into public.invoice_line_items
    (company_id, invoice_id, job_id, completion_id, line_type, label, quantity, unit_amount_cents, amount_cents, taxable)
  select v_company, v_invoice, v_job, p_completion_id, 'service', sp.service_name, 1, sp.price_cents, sp.price_cents, sp.taxable
  from public.job_completion_services s
  join public.service_prices sp
    on sp.company_id = v_company and sp.service_name = s.service_name and sp.active
  where s.completion_id = p_completion_id;

  -- add-on revenue lines (priced from addon_prices)
  insert into public.invoice_line_items
    (company_id, invoice_id, job_id, completion_id, line_type, label, quantity, unit_amount_cents, amount_cents, taxable)
  select v_company, v_invoice, v_job, p_completion_id, 'addon', ap.addon_name, 1, ap.price_cents, ap.price_cents, ap.taxable
  from public.job_completion_addons a
  join public.addon_prices ap
    on ap.company_id = v_company and ap.addon_name = a.addon_name and ap.active
  where a.completion_id = p_completion_id;

  select coalesce(sum(amount_cents), 0),
         coalesce(sum(amount_cents) filter (where taxable), 0)
    into v_subtotal, v_taxable_sub
  from public.invoice_line_items
  where invoice_id = v_invoice and line_type in ('service','addon');

  -- A global discount cannot exceed the subtotal.
  v_discount := least(v_discount, v_subtotal);

  -- POLICY: allocate the global discount PROPORTIONALLY to the taxable portion,
  -- then tax the reduced taxable base. Exact integer cents via numeric round().
  v_taxable_discount := case
    when v_subtotal > 0 then round(v_discount::numeric * v_taxable_sub::numeric / v_subtotal::numeric)
    else 0
  end;
  v_tax   := round(greatest(v_taxable_sub - v_taxable_discount, 0)::numeric * p_tax_rate_bps / 10000.0);
  v_total := v_subtotal - v_discount + v_tax;

  if v_discount > 0 then
    insert into public.invoice_line_items
      (company_id, invoice_id, job_id, completion_id, line_type, label, quantity, unit_amount_cents, amount_cents, taxable)
    values (v_company, v_invoice, v_job, p_completion_id, 'discount', 'Discount', 1, -v_discount, -v_discount, false);
  end if;
  if v_tax > 0 then
    insert into public.invoice_line_items
      (company_id, invoice_id, job_id, completion_id, line_type, label, quantity, unit_amount_cents, amount_cents, taxable)
    values (v_company, v_invoice, v_job, p_completion_id, 'tax', 'Sales tax', 1, v_tax, v_tax, false);
  end if;

  -- expenses -> cost / reimbursement summary (NOT client revenue)
  select
    coalesce(sum(amount_cents) filter (where expense_type = 'supplies'), 0),
    coalesce(sum(coalesce(quantity,0)) filter (where expense_type = 'mileage'), 0),
    coalesce(sum(amount_cents) filter (where expense_type = 'mileage'), 0),
    coalesce(sum(amount_cents) filter (where expense_type = 'parking'), 0),
    coalesce(sum(amount_cents) filter (where expense_type = 'tolls'), 0),
    coalesce(sum(amount_cents) filter (where expense_type = 'other'), 0)
    into v_supplies, v_mileage_miles, v_mileage_reimb, v_parking, v_tolls, v_other
  from public.job_completion_expenses
  where completion_id = p_completion_id;

  v_reimburse := v_supplies + v_mileage_reimb + v_parking + v_tolls + v_other;
  v_cost := v_payroll + v_reimburse;
  v_profit := (v_subtotal - v_discount) - v_cost;  -- tax is pass-through, excluded from profit

  update public.invoices set amount_cents = v_total, updated_at = now() where id = v_invoice;

  select coalesce(sum(amount_cents), 0) into v_paid from public.payments where invoice_id = v_invoice;
  v_status := case
    when v_total > 0 and v_paid >= v_total then 'paid'
    when v_paid > 0 then 'partial'
    else 'unpaid'
  end;

  -- jobs.profit_cents is GENERATED; do not set it here.
  update public.jobs
     set price_cents = (v_subtotal - v_discount),
         cost_cents = v_cost,
         updated_at = now()
   where id = v_job;

  insert into public.job_financial_summaries (
    company_id, job_id, completion_id, invoice_id,
    gross_revenue_cents, taxable_subtotal_cents, tax_rate_bps, taxable_discount_cents, calculation_version,
    tax_cents, discount_cents, invoice_total_cents,
    employee_pay_cents, reimbursement_cents, supplies_cents, mileage_miles, mileage_reimbursement_cents,
    parking_cents, tolls_cents, other_expenses_cents, net_profit_cents,
    payment_status, amount_paid_cents, balance_due_cents, updated_at
  ) values (
    v_company, v_job, p_completion_id, v_invoice,
    (v_subtotal - v_discount), v_taxable_sub, p_tax_rate_bps, v_taxable_discount, 2,
    v_tax, v_discount, v_total,
    v_payroll, v_reimburse, v_supplies, v_mileage_miles, v_mileage_reimb,
    v_parking, v_tolls, v_other, v_profit,
    v_status, v_paid, greatest(v_total - v_paid, 0), now()
  )
  on conflict (completion_id) do update set
    invoice_id = excluded.invoice_id,
    gross_revenue_cents = excluded.gross_revenue_cents,
    taxable_subtotal_cents = excluded.taxable_subtotal_cents,
    tax_rate_bps = excluded.tax_rate_bps,
    taxable_discount_cents = excluded.taxable_discount_cents,
    calculation_version = excluded.calculation_version,
    tax_cents = excluded.tax_cents,
    discount_cents = excluded.discount_cents,
    invoice_total_cents = excluded.invoice_total_cents,
    employee_pay_cents = excluded.employee_pay_cents,
    reimbursement_cents = excluded.reimbursement_cents,
    supplies_cents = excluded.supplies_cents,
    mileage_miles = excluded.mileage_miles,
    mileage_reimbursement_cents = excluded.mileage_reimbursement_cents,
    parking_cents = excluded.parking_cents,
    tolls_cents = excluded.tolls_cents,
    other_expenses_cents = excluded.other_expenses_cents,
    net_profit_cents = excluded.net_profit_cents,
    payment_status = excluded.payment_status,
    amount_paid_cents = excluded.amount_paid_cents,
    balance_due_cents = excluded.balance_due_cents,
    updated_at = now();

  return jsonb_build_object(
    'invoice_id', v_invoice,
    'subtotal_cents', v_subtotal,
    'discount_cents', v_discount,
    'taxable_subtotal_cents', v_taxable_sub,
    'taxable_discount_cents', v_taxable_discount,
    'tax_rate_bps', p_tax_rate_bps,
    'tax_cents', v_tax,
    'total_cents', v_total,
    'reimbursement_cents', v_reimburse,
    'employee_pay_cents', v_payroll,
    'net_profit_cents', v_profit,
    'amount_paid_cents', v_paid,
    'balance_due_cents', greatest(v_total - v_paid, 0),
    'payment_status', v_status,
    'line_items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'line_type', line_type, 'label', label, 'quantity', quantity,
        'unit_amount_cents', unit_amount_cents, 'amount_cents', amount_cents, 'taxable', taxable
      ) order by created_at), '[]'::jsonb)
      from public.invoice_line_items where invoice_id = v_invoice
    )
  );
end;
$$;

-- Preserve ownership + least-privilege execution.
alter function public.create_invoice_draft_from_completion(uuid, numeric, integer, date) owner to postgres;
revoke all on function public.create_invoice_draft_from_completion(uuid, numeric, integer, date) from public, anon;
grant execute on function public.create_invoice_draft_from_completion(uuid, numeric, integer, date) to authenticated;

commit;

notify pgrst, 'reload schema';
