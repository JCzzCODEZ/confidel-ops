-- ============================================================================
-- Owner pricing / invoice-draft / financial-summary layer
-- Date: 2026-06-23
--
-- Turns structured completion data into priced invoices and tax-ready records.
-- ALL of this is OWNER/ADMIN-ONLY. Employees never get pricing, revenue,
-- profit, payroll, invoice totals, or tax records — none of these tables are
-- readable by employees and no employee API returns them.
--
-- Apply in the Supabase SQL Editor. Versioned record; not auto-run.
-- Confirmed schema in use: invoices, payments, jobs (price_cents/cost_cents/
-- payroll_cents/profit_cents), job_completions (hours…), job_completion_*.
--
-- ASSUMPTIONS baked into the draft RPC (adjust on first test if needed):
--   * Tax rate + discount are passed in by the owner (params), not derived.
--   * Expenses are owner COST / reimbursement to the employee — they feed the
--     financial summary, NOT client-charged invoice revenue lines.
--   * Employee pay starts from jobs.payroll_cents (owner-controlled).
--   * Mileage reimbursement = the $ the employee entered on the mileage expense
--     (0 if none); miles are stored separately. No mileage rate is invented.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Owner/admin check (SECURITY DEFINER so it never depends on caller RLS).
-- ----------------------------------------------------------------------------
create or replace function public.is_company_admin(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.is_active
      and m.role in ('owner','admin')
  );
$$;
revoke all on function public.is_company_admin(uuid) from public, anon;
grant execute on function public.is_company_admin(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 1. Pricing tables (owner/admin only).
-- ----------------------------------------------------------------------------
create table if not exists public.service_prices (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  service_name text not null,
  price_cents  bigint not null default 0,
  taxable      boolean not null default true,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, service_name)
);

create table if not exists public.addon_prices (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  addon_name  text not null,
  price_cents bigint not null default 0,
  taxable     boolean not null default true,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, addon_name)
);

-- ----------------------------------------------------------------------------
-- 2. Invoice line items (owner/admin only).
-- ----------------------------------------------------------------------------
create table if not exists public.invoice_line_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  invoice_id        uuid not null,
  job_id            uuid,
  completion_id     uuid,
  line_type         text not null check (line_type in ('service','addon','labor','expense','discount','tax','custom')),
  label             text not null,
  quantity          numeric not null default 1,
  unit_amount_cents bigint not null default 0,
  amount_cents      bigint not null default 0,
  taxable           boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists ili_invoice_idx on public.invoice_line_items(invoice_id);

-- ----------------------------------------------------------------------------
-- 3. Job financial summary (owner/admin only) — one row per completion.
-- ----------------------------------------------------------------------------
create table if not exists public.job_financial_summaries (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null,
  job_id                      uuid not null,
  completion_id               uuid not null unique,
  invoice_id                  uuid,
  gross_revenue_cents         bigint not null default 0,
  taxable_subtotal_cents      bigint not null default 0,
  tax_cents                   bigint not null default 0,
  discount_cents              bigint not null default 0,
  invoice_total_cents         bigint not null default 0,
  employee_pay_cents          bigint not null default 0,
  reimbursement_cents         bigint not null default 0,
  supplies_cents              bigint not null default 0,
  mileage_miles               numeric not null default 0,
  mileage_reimbursement_cents bigint not null default 0,
  parking_cents               bigint not null default 0,
  tolls_cents                 bigint not null default 0,
  other_expenses_cents        bigint not null default 0,
  net_profit_cents            bigint not null default 0,
  payment_status              text not null default 'unpaid',
  amount_paid_cents           bigint not null default 0,
  balance_due_cents           bigint not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- RLS: owner/admin only on every pricing/financial table.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'service_prices','addon_prices','invoice_line_items','job_financial_summaries'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I_admin_all on public.%I', t, t);
    execute format(
      'create policy %I_admin_all on public.%I for all to authenticated '
      || 'using (public.is_company_admin(company_id)) '
      || 'with check (public.is_company_admin(company_id))', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Invoice-draft RPC (owner/admin only).
-- ----------------------------------------------------------------------------
create or replace function public.create_invoice_draft_from_completion(
  p_completion_id uuid,
  p_tax_rate_bps  integer default 0,   -- basis points, e.g. 700 = 7.00%
  p_discount_cents integer default 0,
  p_due_date      date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company        uuid;
  v_job            uuid;
  v_client         uuid;
  v_invoice        uuid;
  v_subtotal       bigint := 0;
  v_taxable_sub    bigint := 0;
  v_tax            bigint := 0;
  v_discount       bigint := greatest(coalesce(p_discount_cents, 0), 0);
  v_total          bigint := 0;
  v_payroll        bigint := 0;
  v_supplies       bigint := 0;
  v_mileage_miles  numeric := 0;
  v_mileage_reimb  bigint := 0;
  v_parking        bigint := 0;
  v_tolls          bigint := 0;
  v_other          bigint := 0;
  v_reimburse      bigint := 0;
  v_cost           bigint := 0;
  v_profit         bigint := 0;
  v_paid           bigint := 0;
  v_status         text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
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

  -- reuse the invoice already tied to this completion (survives status changes
  -- so re-drawing after a payment updates the same invoice), else create one
  select invoice_id into v_invoice
    from public.job_financial_summaries
   where completion_id = p_completion_id;

  if v_invoice is null then
    insert into public.invoices (company_id, client_id, job_id, amount_cents, status, due_date, created_by)
    values (v_company, v_client, v_job, 0, 'draft', p_due_date, auth.uid())
    returning id into v_invoice;
  else
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

  v_discount := least(v_discount, v_subtotal);
  v_tax := round((greatest(v_taxable_sub - v_discount, 0)) * coalesce(p_tax_rate_bps, 0) / 10000.0);
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

  -- finalize invoice total
  update public.invoices set amount_cents = v_total, updated_at = now() where id = v_invoice;

  -- payments already recorded against this invoice
  select coalesce(sum(amount_cents), 0) into v_paid from public.payments where invoice_id = v_invoice;
  v_status := case
    when v_total > 0 and v_paid >= v_total then 'paid'
    when v_paid > 0 then 'partial'
    else 'unpaid'
  end;

  -- owner financial fields on the job.
  -- NOTE: jobs.profit_cents is a GENERATED column (derived from price/cost), so
  -- it must NOT be set here — Postgres rejects writes to generated columns.
  -- Net profit is recorded in job_financial_summaries below.
  update public.jobs
     set price_cents = (v_subtotal - v_discount),
         cost_cents = v_cost,
         updated_at = now()
   where id = v_job;

  -- upsert the tax-ready summary (one per completion)
  insert into public.job_financial_summaries (
    company_id, job_id, completion_id, invoice_id,
    gross_revenue_cents, taxable_subtotal_cents, tax_cents, discount_cents, invoice_total_cents,
    employee_pay_cents, reimbursement_cents, supplies_cents, mileage_miles, mileage_reimbursement_cents,
    parking_cents, tolls_cents, other_expenses_cents, net_profit_cents,
    payment_status, amount_paid_cents, balance_due_cents, updated_at
  ) values (
    v_company, v_job, p_completion_id, v_invoice,
    (v_subtotal - v_discount), v_taxable_sub, v_tax, v_discount, v_total,
    v_payroll, v_reimburse, v_supplies, v_mileage_miles, v_mileage_reimb,
    v_parking, v_tolls, v_other, v_profit,
    v_status, v_paid, greatest(v_total - v_paid, 0), now()
  )
  on conflict (completion_id) do update set
    invoice_id = excluded.invoice_id,
    gross_revenue_cents = excluded.gross_revenue_cents,
    taxable_subtotal_cents = excluded.taxable_subtotal_cents,
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

revoke all on function public.create_invoice_draft_from_completion(uuid, integer, integer, date) from public, anon;
grant execute on function public.create_invoice_draft_from_completion(uuid, integer, integer, date) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY after applying:
--   * owner: insert/select service_prices/addon_prices -> works; employee -> 0 rows / denied.
--   * owner: select public.create_invoice_draft_from_completion('<completion_id>', 700, 0, null);
--       -> jsonb with invoice_id, subtotal/tax/total, line_items matching priced services/add-ons.
--   * employee: same call -> 'owner or admin access required'.
--   * select * from public.job_financial_summaries; visible to owner/admin only.
-- Regression covered by: scripts/pricing-invoice-test.mjs (PRICING_TESTS=1)
-- ============================================================================
