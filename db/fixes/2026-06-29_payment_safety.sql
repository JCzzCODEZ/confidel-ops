-- ============================================================================
-- Payment safety: race-free invoice locking, overpayment rejection, a DEDICATED
-- idempotency key (not the business `reference`), and an AUTHORITATIVE return so
-- the client never guesses paid/balance.
--
-- Pairs with 2026-06-29_invoice_tax_numeric.sql: BOTH the invoice-draft RPC and
-- mark_payment `SELECT ... FOR UPDATE` the same invoices row, so a payment and a
-- regeneration serialize (PostgreSQL holds the row lock to transaction end),
-- closing the check-then-act (TOCTOU) race on invoice immutability.
--
-- IDEMPOTENCY: a required `idempotency_key uuid` (transport key) dedupes retries.
-- `reference` stays a free business field (e.g. check number) and is NOT a
-- transport key. A partial unique index makes a duplicate retry physically
-- impossible; the FOR UPDATE lock + a unique_violation catch make it safe even
-- under true concurrency.
--
-- Return type changes to jsonb, so both functions are dropped and recreated.
-- Apply AFTER the invoice-tax migration. Idempotent / rerunnable.
-- ============================================================================

begin;

-- New transport key column (nullable; existing rows stay NULL and are excluded
-- by the partial index — so no collision with historical data, blank refs, etc.).
alter table public.payments add column if not exists idempotency_key uuid;

-- Pre-index safety: a brand-new column has no values, so no dedup needed; the
-- partial index ignores NULLs (existing rows). Drop earlier index variants.
-- Scope uniqueness to the TENANT (company), NOT the invoice: an idempotency key
-- identifies ONE logical operation per company, so reusing it for a different
-- invoice must collide (and then fail the fingerprint check) rather than create a
-- second payment on another invoice.
drop index if exists public.payments_invoice_reference_ux;
drop index if exists public.payments_invoice_idempotency_ux;
create unique index if not exists payments_company_idempotency_ux
  on public.payments (company_id, idempotency_key)
  where idempotency_key is not null;

drop function if exists public.mark_payment(uuid, integer, timestamptz, text, text);
drop function if exists public.mark_payment(uuid, integer, uuid, timestamptz, text, text);
drop function if exists private.mark_payment_impl(uuid, integer, timestamptz, text, text);
drop function if exists private.mark_payment_impl(uuid, integer, uuid, timestamptz, text, text);

create function private.mark_payment_impl(
  p_invoice_id      uuid,
  p_amount_cents    integer,
  p_idempotency_key uuid,                    -- REQUIRED transport key
  p_paid_at         timestamptz default now(),
  p_method          text default null,
  p_reference       text default null        -- business reference only
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice  public.invoices;
  v_payment  public.payments;
  v_existing public.payments;
  v_paid     integer;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency_key is required' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'payment amount must be a positive integer (cents)' using errcode = '22023';
  end if;

  -- Canonicalize + validate method/reference HERE — the DB is the authoritative
  -- allowlist boundary because an authenticated user can call this RPC directly,
  -- bypassing the API route. trim leading/trailing whitespace, lower-case method,
  -- treat empty reference as NULL. Stored + compared values are these canonicals.
  p_method := lower(regexp_replace(coalesce(p_method, ''), '^\s+|\s+$', '', 'g'));
  if p_method = '' then p_method := 'manual'; end if;
  if p_method not in ('manual','cash','check','card','ach','transfer','other') then
    raise exception 'invalid payment method: %', p_method using errcode = '22023';
  end if;
  p_reference := nullif(regexp_replace(coalesce(p_reference, ''), '^\s+|\s+$', '', 'g'), '');

  -- Lock the invoice for the rest of the tx (serializes with the draft RPC and
  -- with other payments on this invoice, so the checks below are race-free).
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    raise exception 'invoice not found' using errcode = '22023';
  end if;
  if not private.is_company_admin(v_invoice.company_id) then
    raise exception 'not allowed to mark payment for this invoice' using errcode = '42501';
  end if;

  -- IDEMPOTENT REPLAY — checked BEFORE the status/overpayment guards (Stripe
  -- contract): an exact key match returns the ORIGINAL payment regardless of the
  -- invoice's current status (incl. paid or void). The FULL request fingerprint
  -- (amount + normalized method + normalized reference) must match, else the key
  -- was reused with different parameters -> reject.
  select * into v_existing from public.payments
    where company_id = v_invoice.company_id and idempotency_key = p_idempotency_key
    limit 1;
  if v_existing.id is not null then
    -- Fingerprint includes invoice_id: reusing the key for a DIFFERENT invoice
    -- (or amount/method/reference) is a client bug -> reject.
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.amount_cents <> p_amount_cents
       or v_existing.method    is distinct from p_method      -- canonicalized by the API route
       or v_existing.reference is distinct from p_reference then
      raise exception 'idempotency key reused with different payment parameters' using errcode = '22023';
    end if;
    select coalesce(sum(amount_cents), 0)::int into v_paid
      from public.payments where invoice_id = p_invoice_id;
    return jsonb_build_object(
      'payment', to_jsonb(v_existing),
      'amount_paid_cents', v_paid,
      'balance_due_cents', greatest(v_invoice.amount_cents - v_paid, 0),
      'payment_status', case when v_invoice.amount_cents > 0 and v_paid >= v_invoice.amount_cents then 'paid'
                             when v_paid > 0 then 'partial' else 'unpaid' end,
      'idempotent_replay', true
    );
  end if;

  -- NEW payment: now enforce status + overpayment.
  if v_invoice.status = 'void' then
    raise exception 'cannot record a payment on a void invoice' using errcode = '22023';
  end if;
  select coalesce(sum(amount_cents), 0)::int into v_paid
    from public.payments where invoice_id = p_invoice_id;
  if v_paid + p_amount_cents > v_invoice.amount_cents then
    raise exception 'payment exceeds balance due (paid % + % > invoice total %)',
      v_paid, p_amount_cents, v_invoice.amount_cents using errcode = '22023';
  end if;

  -- Insert; if a concurrent tx with the SAME key already inserted, nothing is
  -- written. ON CONFLICT DO NOTHING (scoped to the partial index) is preferred
  -- over a broad `unique_violation` catch, which could mask unrelated constraint
  -- failures.
  insert into public.payments (company_id, invoice_id, amount_cents, idempotency_key, paid_at, method, reference)
  values (v_invoice.company_id, p_invoice_id, p_amount_cents, p_idempotency_key, p_paid_at, p_method, p_reference)
  on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing
  returning * into v_payment;

  if v_payment.id is null then
    -- The key already exists for this company (concurrent insert won). Fetch +
    -- fingerprint (incl. invoice_id).
    select * into v_existing from public.payments
      where company_id = v_invoice.company_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.amount_cents <> p_amount_cents
       or v_existing.method    is distinct from p_method      -- canonicalized by the API route
       or v_existing.reference is distinct from p_reference then
      raise exception 'idempotency key reused with different payment parameters' using errcode = '22023';
    end if;
    select coalesce(sum(amount_cents), 0)::int into v_paid
      from public.payments where invoice_id = p_invoice_id;
    return jsonb_build_object(
      'payment', to_jsonb(v_existing),
      'amount_paid_cents', v_paid,
      'balance_due_cents', greatest(v_invoice.amount_cents - v_paid, 0),
      'payment_status', case when v_invoice.amount_cents > 0 and v_paid >= v_invoice.amount_cents then 'paid'
                             when v_paid > 0 then 'partial' else 'unpaid' end,
      'idempotent_replay', true
    );
  end if;

  select coalesce(sum(amount_cents), 0)::int into v_paid
    from public.payments where invoice_id = p_invoice_id;
  update public.invoices
     set status  = case when v_paid >= amount_cents then 'paid'::public.invoice_status else status end,
         paid_at = case when v_paid >= amount_cents then p_paid_at else paid_at end
   where id = p_invoice_id;

  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'amount_paid_cents', v_paid,
    'balance_due_cents', greatest(v_invoice.amount_cents - v_paid, 0),
    'payment_status', case when v_invoice.amount_cents > 0 and v_paid >= v_invoice.amount_cents then 'paid'
                           when v_paid > 0 then 'partial' else 'unpaid' end,
    'idempotent_replay', false
  );
end;
$$;

create function public.mark_payment(
  p_invoice_id      uuid,
  p_amount_cents    integer,
  p_idempotency_key uuid,
  p_paid_at         timestamptz default now(),
  p_method          text default null,
  p_reference       text default null
) returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select private.mark_payment_impl(p_invoice_id, p_amount_cents, p_idempotency_key, p_paid_at, p_method, p_reference);
$$;

-- The public wrapper is SECURITY DEFINER (owner: postgres) so it can cross into
-- the private schema on behalf of an authenticated caller. The impl is reachable
-- ONLY through the wrapper: authenticated gets no USAGE on schema private and no
-- EXECUTE on the impl. Authorization is enforced inside the impl (is_company_admin).
alter function private.mark_payment_impl(uuid, integer, uuid, timestamptz, text, text) owner to postgres;
revoke all  on function private.mark_payment_impl(uuid, integer, uuid, timestamptz, text, text) from public, anon, authenticated;
alter function public.mark_payment(uuid, integer, uuid, timestamptz, text, text) owner to postgres;
revoke all  on function public.mark_payment(uuid, integer, uuid, timestamptz, text, text) from public, anon;
grant execute on function public.mark_payment(uuid, integer, uuid, timestamptz, text, text) to authenticated;

commit;

notify pgrst, 'reload schema';
