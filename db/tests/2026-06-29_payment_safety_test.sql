-- ============================================================================
-- SQL integration test for payment safety + invoice immutability.
-- Run AFTER applying BOTH 2026-06-29_invoice_tax_numeric.sql and
-- 2026-06-29_payment_safety.sql to a TEST/branch DB:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f this_file
--
-- Covers (SEQUENTIAL): authoritative paid/balance/status return, overpayment
-- rejection, reference idempotency (no double-count, one row), and that a paid
-- invoice cannot be regenerated. Seeds fixtures, runs as the `authenticated`
-- role, then ROLLS BACK. The TOCTOU race is covered by the two-session harness
-- at the bottom (requires two connections — see the note).
-- ============================================================================

begin;

insert into public.companies (id, owner_user_id, name)
  values ('aaaa0000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','PaySafe Co');
insert into public.company_memberships (company_id, user_id, role, is_active)
  values ('aaaa0000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','employee',true);
insert into public.clients (id, company_id, name)
  values ('cccc0000-0000-4000-8000-000000000001','aaaa0000-0000-4000-8000-000000000001','Client');
insert into public.jobs (id, company_id, client_id, title, payroll_cents) values
  ('dddd0000-0000-4000-8000-000000000001','aaaa0000-0000-4000-8000-000000000001','cccc0000-0000-4000-8000-000000000001','J1',0),
  ('dddd0000-0000-4000-8000-000000000002','aaaa0000-0000-4000-8000-000000000001','cccc0000-0000-4000-8000-000000000001','J2',0),
  ('dddd0000-0000-4000-8000-000000000003','aaaa0000-0000-4000-8000-000000000001','cccc0000-0000-4000-8000-000000000001','J3',0);
insert into public.job_assignments (company_id, job_id, employee_user_id) values
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002'),
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002'),
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000002');
insert into public.job_completions (id, company_id, job_id, employee_user_id) values
  ('eeee0000-0000-4000-8000-000000000001','aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002'),
  ('eeee0000-0000-4000-8000-000000000002','aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002'),
  ('eeee0000-0000-4000-8000-000000000003','aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000002');
insert into public.service_prices (company_id, service_name, price_cents, taxable, active)
  values ('aaaa0000-0000-4000-8000-000000000001','Svc',100000,true,true);
insert into public.job_completion_services (company_id, job_id, completion_id, service_name) values
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001','eeee0000-0000-4000-8000-000000000001','Svc'),
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000002','eeee0000-0000-4000-8000-000000000002','Svc'),
  ('aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000003','eeee0000-0000-4000-8000-000000000003','Svc');

set local role authenticated;

-- P1: authoritative return + overpayment rejection + freeze-after-payment.
do $$
declare r jsonb; v_inv uuid; p jsonb; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  v_inv := (r->>'invoice_id')::uuid;  -- total 106625

  p := public.mark_payment(v_inv, 100000, gen_random_uuid(), now(), 'manual', null);  -- partial
  if (p->>'amount_paid_cents')::int <> 100000 or (p->>'balance_due_cents')::int <> 6625
     or (p->>'payment_status') <> 'partial' then raise exception 'P1a wrong: %', p; end if;

  ok := false;  -- overpayment rejected
  begin perform public.mark_payment(v_inv, 7000, gen_random_uuid(), now(), 'manual', null); exception when others then ok := true; end;
  if not ok then raise exception 'P1b FAIL: overpayment accepted'; end if;

  p := public.mark_payment(v_inv, 6625, gen_random_uuid(), now(), 'manual', null);  -- fully paid
  if (p->>'payment_status') <> 'paid' or (p->>'balance_due_cents')::int <> 0 then raise exception 'P1c wrong: %', p; end if;

  ok := false;  -- regeneration blocked once paid
  begin perform public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000001', 662.5, 0, null);
  exception when others then ok := true; end;
  if not ok then raise exception 'P1d FAIL: paid invoice regenerated'; end if;
  raise notice 'P1 PASS: authoritative return + overpayment + freeze-after-payment';
end $$;

-- P2: idempotency-key retry does NOT double-count (same key returns replay).
do $$
declare r jsonb; v_inv uuid; v_key uuid := gen_random_uuid(); p1 jsonb; p2 jsonb; n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000002', 662.5, 0, null);
  v_inv := (r->>'invoice_id')::uuid;
  p1 := public.mark_payment(v_inv, 500, v_key, now(), 'manual', null);
  p2 := public.mark_payment(v_inv, 500, v_key, now(), 'manual', null);  -- duplicate retry, SAME key
  if (p2->>'idempotent_replay')::boolean is distinct from true then raise exception 'P2 FAIL: retry not idempotent %', p2; end if;
  if (p2->>'amount_paid_cents')::int <> 500 then raise exception 'P2 FAIL: retry double-counted %', p2; end if;
  select count(*) into n from public.payments where invoice_id = v_inv and idempotency_key = v_key;
  if n <> 1 then raise exception 'P2 FAIL: % payment rows for one idempotency_key', n; end if;
  raise notice 'P2 PASS: idempotent retry (one row, no double-count)';

  -- P3: the partial unique index physically rejects a duplicate key (the DB
  -- backstop). Uniqueness is TENANT-scoped (company_id, idempotency_key).
  begin
    insert into public.payments (company_id, invoice_id, amount_cents, idempotency_key)
      values ('aaaa0000-0000-4000-8000-000000000001', v_inv, 1, v_key);
    raise exception 'P3 FAIL: duplicate idempotency_key was inserted';
  exception when unique_violation then null;  -- expected
  end;
  raise notice 'P3 PASS: unique index rejects duplicate (company_id, idempotency_key)';

  -- P3b: reusing v_key for a DIFFERENT invoice in the same company is rejected
  -- (tenant-scoped key + invoice_id fingerprint) — NOT a second payment.
  declare v_other uuid; ok2 boolean;
  begin
    select invoice_id into v_other from public.job_financial_summaries
      where completion_id = 'eeee0000-0000-4000-8000-000000000001';  -- C1's invoice
    ok2 := false;
    begin perform public.mark_payment(v_other, 500, v_key, now(), 'manual', null);
    exception when others then ok2 := true; end;
    if not ok2 then raise exception 'P3b FAIL: key reused on a different invoice was accepted'; end if;
  end;
  raise notice 'P3b PASS: same key on a different invoice rejected';
end $$;

-- P4: full fingerprint (amount + method + reference), replay-BEFORE-status
-- (returns original even after paid AND after void), and parameter-mismatch
-- rejection on both amount and reference.
do $$
declare r jsonb; v_inv uuid; v_key uuid := gen_random_uuid(); pay_id uuid; p jsonb; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  r := public.create_invoice_draft_from_completion('eeee0000-0000-4000-8000-000000000003', 662.5, 0, null);
  v_inv := (r->>'invoice_id')::uuid;  -- total 106625

  -- pay in full with key v_key + reference 'CHK-1'
  p := public.mark_payment(v_inv, 106625, v_key, now(), 'manual', 'CHK-1');
  if (p->>'payment_status') <> 'paid' then raise exception 'P4a FAIL not paid: %', p; end if;
  pay_id := (p->'payment'->>'id')::uuid;

  -- replay (same fingerprint) on the now-PAID invoice -> ORIGINAL payment
  p := public.mark_payment(v_inv, 106625, v_key, now(), 'manual', 'CHK-1');
  if (p->>'idempotent_replay')::boolean is distinct from true then raise exception 'P4b FAIL not replay: %', p; end if;
  if (p->'payment'->>'id')::uuid <> pay_id then raise exception 'P4b FAIL different payment'; end if;

  -- same key, DIFFERENT reference -> rejected (fingerprint mismatch)
  ok := false;
  begin perform public.mark_payment(v_inv, 106625, v_key, now(), 'manual', 'CHK-2'); exception when others then ok := true; end;
  if not ok then raise exception 'P4c FAIL: key reuse with different reference accepted'; end if;

  -- same key, DIFFERENT amount -> rejected
  ok := false;
  begin perform public.mark_payment(v_inv, 5000, v_key, now(), 'manual', 'CHK-1'); exception when others then ok := true; end;
  if not ok then raise exception 'P4d FAIL: key reuse with different amount accepted'; end if;

  -- same key, DIFFERENT method -> rejected (full fingerprint)
  ok := false;
  begin perform public.mark_payment(v_inv, 106625, v_key, now(), 'card', 'CHK-1'); exception when others then ok := true; end;
  if not ok then raise exception 'P4d2 FAIL: key reuse with different method accepted'; end if;

  -- void the invoice, then replay the SAME fingerprint -> still the ORIGINAL
  update public.invoices set status='void' where id = v_inv;
  p := public.mark_payment(v_inv, 106625, v_key, now(), 'manual', 'CHK-1');
  if (p->>'idempotent_replay')::boolean is distinct from true then raise exception 'P4e FAIL void replay: %', p; end if;
  if (p->'payment'->>'id')::uuid <> pay_id then raise exception 'P4e FAIL void replay returned different payment'; end if;
  -- but a NEW key on the void invoice is rejected
  ok := false;
  begin perform public.mark_payment(v_inv, 100, gen_random_uuid(), now(), 'manual', null); exception when others then ok := true; end;
  if not ok then raise exception 'P4f FAIL: new payment on void invoice accepted'; end if;

  raise notice 'P4 PASS: full fingerprint; replay-before-status (paid+void); amount/reference mismatch rejected';
end $$;

-- P5: DB-enforced allowlist + canonicalization, exercised through the PUBLIC
-- wrapper as the authenticated role (verifies grant + wrapper + DB validation
-- together — a direct caller cannot bypass the route's checks).
do $$
declare v_inv uuid; v_key uuid := gen_random_uuid(); p jsonb; ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','a0000000-0000-4000-8000-000000000001','role','authenticated','email','a.owner@test')::text, true);
  select invoice_id into v_inv from public.job_financial_summaries
    where completion_id = 'eeee0000-0000-4000-8000-000000000002';  -- C2 (has remaining balance)

  -- invalid method is rejected by the DB even though the route was bypassed
  ok := false;
  begin perform public.mark_payment(v_inv, 100, gen_random_uuid(), now(), 'bogus-method', null);
  exception when others then ok := true; end;
  if not ok then raise exception 'P5a FAIL: invalid method accepted by the DB'; end if;

  -- 'MANUAL' canonicalizes to 'manual'; a same-key replay with 'manual' matches
  p := public.mark_payment(v_inv, 100, v_key, now(), 'MANUAL', null);
  if (p->>'idempotent_replay')::boolean <> false then raise exception 'P5b FAIL first not new: %', p; end if;
  p := public.mark_payment(v_inv, 100, v_key, now(), 'manual', null);
  if (p->>'idempotent_replay')::boolean <> true then raise exception 'P5b FAIL canonical replay: %', p; end if;
  raise notice 'P5 PASS: DB allowlist + canonicalization via public wrapper (authenticated)';
end $$;

reset role;
rollback;

-- ============================================================================
-- CONCURRENCY (TOCTOU race) — REQUIRES TWO CONNECTIONS; not runnable in a single
-- session. A runnable two-psql harness covering all 5 permutations lives at
-- db/tests/concurrency/payment_race.sh (run in CI against a test DB). Manual
-- reproduction, for reference:
--
--   -- session A (holds the invoice lock, does not commit yet):
--   BEGIN;
--   SELECT public.create_invoice_draft_from_completion('<completion>', 662.5, 0, null);
--   -- (the draft RPC has taken `SELECT ... FOR UPDATE` on the invoices row)
--
--   -- session B (concurrently):
--   SELECT public.mark_payment('<invoice>', 100, now(), 'manual', null);
--   -- EXPECTED: session B BLOCKS until session A ends.
--
--   -- session A:  COMMIT;  (or ROLLBACK)
--   -- Then session B unblocks. Whichever transaction committed first wins:
--   --   * draft committed first -> payment lands on the freshly rebuilt invoice.
--   --   * payment committed first -> the draft's re-check sees the payment and
--   --     RAISES 'regeneration blocked'.
--   -- In NO interleaving can a payment be lost or an invoice rebuilt under a payment.
--
-- Equivalent isolation-tester spec (run via pg_isolation_regress):
--   permutation "draftLock" "payB" "commitA"   -- payment waits, then succeeds
--   permutation "payLock"   "draftB" "commitA"  -- draft waits, then is blocked
-- ============================================================================
