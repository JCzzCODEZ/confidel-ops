-- Asserts the final signatures, grants, and schema objects after both migrations.
-- Run with: psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f this_file  (raises on any failure)
do $$
begin
  -- 1. Numeric invoice-draft RPC signature exists.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='create_invoice_draft_from_completion'
      and pg_get_function_identity_arguments(p.oid) = 'p_completion_id uuid, p_tax_rate_bps numeric, p_discount_cents integer, p_due_date date'
  ) then raise exception 'create_invoice_draft_from_completion(uuid,numeric,integer,date) missing'; end if;

  -- 2. mark_payment signature includes the uuid idempotency key.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='mark_payment'
      and pg_get_function_identity_arguments(p.oid) = 'p_invoice_id uuid, p_amount_cents integer, p_idempotency_key uuid, p_paid_at timestamp with time zone, p_method text, p_reference text'
  ) then raise exception 'mark_payment(uuid,integer,uuid,timestamptz,text,text) missing'; end if;

  -- 3. EXECUTE granted ONLY to authenticated (not anon/public) on both.
  if not has_function_privilege('authenticated','public.create_invoice_draft_from_completion(uuid,numeric,integer,date)','EXECUTE')
     then raise exception 'draft RPC not executable by authenticated'; end if;
  if has_function_privilege('anon','public.create_invoice_draft_from_completion(uuid,numeric,integer,date)','EXECUTE')
     then raise exception 'draft RPC is executable by anon'; end if;
  if not has_function_privilege('authenticated','public.mark_payment(uuid,integer,uuid,timestamptz,text,text)','EXECUTE')
     then raise exception 'mark_payment not executable by authenticated'; end if;
  if has_function_privilege('anon','public.mark_payment(uuid,integer,uuid,timestamptz,text,text)','EXECUTE')
     then raise exception 'mark_payment is executable by anon'; end if;

  -- 4. Tenant-scoped idempotency index + audit columns present.
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='payments_company_idempotency_ux')
     then raise exception 'payments_company_idempotency_ux index missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='idempotency_key')
     then raise exception 'payments.idempotency_key missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='job_financial_summaries' and column_name='tax_rate_bps')
     then raise exception 'job_financial_summaries.tax_rate_bps missing'; end if;

  raise notice 'GRANTS/SIGNATURES OK';
end $$;
