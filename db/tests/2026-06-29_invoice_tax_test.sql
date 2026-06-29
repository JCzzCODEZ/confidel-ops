-- ============================================================================
-- SQL integration test for create_invoice_draft_from_completion (numeric tax).
-- Run AFTER applying db/fixes/2026-06-29_invoice_tax_numeric.sql to a TEST or
-- branch database:   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f this_file
--
-- Self-contained: seeds fixtures, exercises the real RPC + RLS/authorization via
-- request.jwt.claims impersonation, asserts every required scenario, then ROLLS
-- BACK so nothing persists. Any failed assertion raises and aborts (exit != 0).
-- These are real DB integration assertions, NOT a re-implemented JS formula.
-- ============================================================================

begin;

-- ---- fixtures (arbitrary UUIDs; no FK to auth.users) -----------------------
-- companies
insert into public.companies (id, owner_user_id, name) values
  ('aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Tax Test Co A'),
  ('bbbb0000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003', 'Tax Test Co B');

-- memberships: the A-owner and B-owner rows are auto-created by the
-- company-insert trigger; we only add the A-employee here.
insert into public.company_memberships (company_id, user_id, role, full_name, email, is_active) values
  ('aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'employee', 'A Employee', 'a.emp@test', true);

-- client + job
insert into public.clients (id, company_id, name) values
  ('cccc0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'Test Client');
-- two jobs (one open completion per job+employee is enforced by a unique index)
insert into public.jobs (id, company_id, client_id, title, payroll_cents) values
  ('dddd0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'cccc0000-0000-4000-8000-000000000001', 'Job 1', 0),
  ('dddd0000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000001', 'cccc0000-0000-4000-8000-000000000001', 'Job 2', 0);

-- the employee must be assigned to each job (enforced by a completion-link trigger)
insert into public.job_assignments (company_id, job_id, employee_user_id) values
  ('aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'),
  ('aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002');

-- two completions: C1 = $1,000 taxable (Job 1) ; C2 = $100 taxable + $100 exempt (Job 2)
insert into public.job_completions (id, company_id, job_id, employee_user_id) values
  ('eeee0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'),
  ('eeee0000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002');

-- price catalog
insert into public.service_prices (company_id, service_name, price_cents, taxable, active) values
  ('aaaa0000-0000-4000-8000-000000000001', 'Deep Clean', 100000, true,  true),
  ('aaaa0000-0000-4000-8000-000000000001', 'Std Clean',   10000, true,  true);
insert into public.addon_prices (company_id, addon_name, price_cents, taxable, active) values
  ('aaaa0000-0000-4000-8000-000000000001', 'Exempt Fee',  10000, false, true);

-- completion line memberships
insert into public.job_completion_services (company_id, job_id, completion_id, service_name) values
  ('aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001', 'eeee0000-0000-4000-8000-000000000001', 'Deep Clean'),
  ('aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000002', 'eeee0000-0000-4000-8000-000000000002', 'Std Clean');
insert into public.job_completion_addons (company_id, job_id, completion_id, addon_name) values
  ('aaaa0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000002', 'eeee0000-0000-4000-8000-000000000002', 'Exempt Fee');

-- ---- run scenarios AS the `authenticated` role ----------------------------
-- Fixtures above were created as the superuser. From here we drop to the
-- `authenticated` role so the function's EXECUTE grant and the auth context are
-- exercised exactly as a real API caller would hit them. The RPC is SECURITY
-- DEFINER, so its internal table writes still run as the owner. We impersonate a
-- specific user by setting request.jwt.claims (transaction-local), which
-- auth.uid()/auth.jwt() read inside the RPC and is_company_admin().
set local role authenticated;

-- Scenario 1: $1,000 taxable at 662.5 bps -> tax $66.25 (6625), total 106625
-- Also assert the audit row PERSISTS the exact numeric rate + tax/discount.
do $$
declare r jsonb; v_rate numeric; v_tax bigint; v_txbase bigint; v_ver smallint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  if (r->>'tax_cents')::bigint   <> 6625   then raise exception 'S1 FAIL tax=% (want 6625)',   r->>'tax_cents'; end if;
  if (r->>'total_cents')::bigint <> 106625 then raise exception 'S1 FAIL total=% (want 106625)', r->>'total_cents'; end if;
  select tax_rate_bps, tax_cents, taxable_subtotal_cents, calculation_version
    into v_rate, v_tax, v_txbase, v_ver
    from public.job_financial_summaries where completion_id='eeee0000-0000-4000-8000-000000000001';
  if v_rate   <> 662.5  then raise exception 'S1 PERSIST FAIL tax_rate_bps=% (want 662.5)', v_rate; end if;
  if v_tax    <> 6625   then raise exception 'S1 PERSIST FAIL tax_cents=%', v_tax; end if;
  if v_txbase <> 100000 then raise exception 'S1 PERSIST FAIL taxable_subtotal_cents=%', v_txbase; end if;
  if v_ver    <> 2      then raise exception 'S1 PERSIST FAIL calculation_version=% (want 2)', v_ver; end if;
  raise notice 'S1 PASS: tax 6625; persisted rate 662.5 + taxable-base + calc version 2';
end $$;

-- Scenario 2: $100 taxable + $100 exempt, $100 global discount, 662.5 bps
--   proportional policy -> taxable base $50 -> tax $3.31 (331), total 10331
do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000002', 662.5, 10000, null);
  if (r->>'tax_cents')::bigint   <> 331   then raise exception 'S2 FAIL tax=% (want 331)',   r->>'tax_cents'; end if;
  if (r->>'total_cents')::bigint <> 10331 then raise exception 'S2 FAIL total=% (want 10331)', r->>'total_cents'; end if;
  if (r->>'taxable_discount_cents')::bigint <> 5000 then raise exception 'S2 FAIL taxable_discount=% (want 5000)', r->>'taxable_discount_cents'; end if;
  raise notice 'S2 PASS: mixed invoice, $100 discount -> tax 331 (proportional)';
end $$;

-- Scenario 3: discount >= subtotal -> tax $0, total 0
do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000002', 662.5, 999999, null);
  if (r->>'tax_cents')::bigint   <> 0 then raise exception 'S3 FAIL tax=% (want 0)',   r->>'tax_cents'; end if;
  if (r->>'total_cents')::bigint <> 0 then raise exception 'S3 FAIL total=% (want 0)', r->>'total_cents'; end if;
  raise notice 'S3 PASS: discount >= subtotal -> tax 0';
end $$;

-- Scenario 4: invalid rates rejected (NULL, negative, >10000, NaN, Infinity)
do $$
declare bad numeric; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  -- NULL must be rejected explicitly (not silently treated as 0%).
  foreach bad in array array[null::numeric, (-1)::numeric, 10001::numeric, 'NaN'::numeric, 'Infinity'::numeric] loop
    ok := false;
    begin
      perform public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', bad, 0, null);
    exception when others then ok := true;  -- expected: rejected
    end;
    if not ok then raise exception 'S4 FAIL: rate % was accepted (should be rejected)', coalesce(bad::text,'NULL'); end if;
  end loop;
  raise notice 'S4 PASS: NULL / -1 / 10001 / NaN / Infinity all rejected';
end $$;

-- Scenario 5: employee and cross-company callers rejected
do $$
declare ok boolean;
begin
  -- employee of company A
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000002','role','authenticated','email','a.emp@test')::text, true);
  ok := false;
  begin perform public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'S5a FAIL: employee was allowed'; end if;

  -- owner of a DIFFERENT company (B) acting on company A's completion
  perform set_config('request.jwt.claims', json_build_object('sub','b0000000-0000-4000-8000-000000000003','role','authenticated','email','b.owner@test')::text, true);
  ok := false;
  begin perform public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'S5b FAIL: cross-company owner was allowed'; end if;

  raise notice 'S5 PASS: employee + cross-company callers rejected';
end $$;

-- Scenario 6: IMMUTABILITY — once an invoice has a payment, regeneration is blocked.
do $$
declare v_invoice uuid; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  -- S1 already generated a draft for completion C1; record a payment against it.
  select invoice_id into v_invoice from public.job_financial_summaries
    where completion_id='eeee0000-0000-4000-8000-000000000001';
  insert into public.payments (company_id, invoice_id, amount_cents)
    values ('aaaa0000-0000-4000-8000-000000000001', v_invoice, 5000);
  -- Any attempt to regenerate that completion's invoice must now be rejected.
  ok := false;
  begin perform public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'S6 FAIL: a paid invoice was regenerated'; end if;
  raise notice 'S6 PASS: paid-invoice regeneration blocked';
end $$;

reset role;
rollback;
