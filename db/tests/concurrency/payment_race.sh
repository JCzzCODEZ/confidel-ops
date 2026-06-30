#!/usr/bin/env bash
# ============================================================================
# Two-connection concurrency test for invoice immutability + payment safety.
# Proves the shared FOR UPDATE lock serializes regeneration vs. payment.
#
# REQUIRES a TEST/branch database with BOTH migrations applied:
#   2026-06-29_invoice_tax_numeric.sql, 2026-06-29_payment_safety.sql
#
# Usage:  TEST_DATABASE_URL=postgres://...  bash db/tests/concurrency/payment_race.sh
#
# Seeds an isolated test company, runs scenarios with two real psql connections,
# asserts outcomes, and cleans up (via trap) on any exit. Exit 0 = all passed.
# Cannot run via a single-connection SQL tool — it needs two sessions.
# ============================================================================
set -euo pipefail

: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a TEST database}"

# Refuse to run against the known production project (defense against fat-finger).
PROD_REF="oeunlirtgvqwftcqludy"
if [[ "$TEST_DATABASE_URL" == *"$PROD_REF"* ]]; then
  echo "REFUSING: TEST_DATABASE_URL points at the production project ($PROD_REF)." >&2
  echo "Run against a Supabase branch / disposable test database only." >&2
  exit 1
fi
# Positive DB-level marker in the PRIVATE schema (same check as the CI guard).
# This, not a URL-name heuristic, confirms a disposable test database — a Supabase
# branch pooler URL legitimately contains neither "test" nor "branch". A real
# connection/psql error here fails the script (set -e + ON_ERROR_STOP), not hidden.
MARK="$(psql "$TEST_DATABASE_URL" -X -t -A -v ON_ERROR_STOP=1 \
  -c "select marker from private._ci_test_marker where marker = 'confidel-ci';")"
MARK="$(printf '%s' "$MARK" | tr -d '[:space:]')"
if [[ "$MARK" != "confidel-ci" ]]; then
  echo "REFUSING: private._ci_test_marker did not return 'confidel-ci' (got: '$MARK')." >&2
  echo "Run against a seeded Supabase branch / disposable test database only." >&2
  exit 1
fi

PSQL=(psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -t -A)

CO=aaaa0000-0000-4000-8000-0000000000c1
OWNER=a0000000-0000-4000-8000-0000000000c1
EMP=a0000000-0000-4000-8000-0000000000c2
CL=cccc0000-0000-4000-8000-0000000000c1
JOB=dddd0000-0000-4000-8000-0000000000c1
COMP=eeee0000-0000-4000-8000-0000000000c1

claims() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWNER','role','authenticated','email','o@test')::text, false);"; }

cleanup() {
  psql "$TEST_DATABASE_URL" -X -q -t -A >/dev/null 2>&1 <<SQL || true
    delete from public.payments where company_id='$CO';
    delete from public.job_financial_summaries where company_id='$CO';
    delete from public.invoice_line_items where company_id='$CO';
    delete from public.invoices where company_id='$CO';
    delete from public.job_completion_services where company_id='$CO';
    delete from public.job_completions where company_id='$CO';
    delete from public.job_assignments where company_id='$CO';
    delete from public.jobs where company_id='$CO';
    delete from public.clients where company_id='$CO';
    delete from public.company_memberships where company_id='$CO';
    delete from public.companies where id='$CO';
SQL
}
trap cleanup EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

seed_invoice() {  # prints invoice_id ; total = 106625
  "${PSQL[@]}" >/dev/null <<SQL
    insert into public.companies (id,owner_user_id,name) values ('$CO','$OWNER','ConcTest') on conflict do nothing;
    insert into public.company_memberships (company_id,user_id,role,is_active) values ('$CO','$EMP','employee',true) on conflict do nothing;
    insert into public.clients (id,company_id,name) values ('$CL','$CO','C') on conflict do nothing;
    insert into public.jobs (id,company_id,client_id,title,payroll_cents) values ('$JOB','$CO','$CL','J',0) on conflict do nothing;
    insert into public.job_assignments (company_id,job_id,employee_user_id) values ('$CO','$JOB','$EMP') on conflict do nothing;
    insert into public.job_completions (id,company_id,job_id,employee_user_id) values ('$COMP','$CO','$JOB','$EMP') on conflict do nothing;
    insert into public.service_prices (company_id,service_name,price_cents,taxable,active) values ('$CO','Svc',100000,true,true) on conflict do nothing;
    insert into public.job_completion_services (company_id,job_id,completion_id,service_name) values ('$CO','$JOB','$COMP','Svc') on conflict do nothing;
SQL
  "${PSQL[@]}" <<SQL
    $(claims)
    select (public.create_invoice_draft_from_completion('$COMP', 662.5, 0, null)->>'invoice_id');
SQL
}

reseed() { cleanup; INV=$(seed_invoice | tr -d '[:space:]'); [ -n "$INV" ] || fail "could not seed invoice"; }

# --- S1: PAYMENT wins the lock; regeneration waits, then is blocked ---------
reseed
( "${PSQL[@]}" >/dev/null <<SQL
    begin; $(claims)
    select public.mark_payment('$INV', 100000, gen_random_uuid(), now(), 'manual', null);
    select pg_sleep(2);
    commit;
SQL
) & B1=$!
sleep 0.5
if A1_OUT=$("${PSQL[@]}" 2>&1 <<SQL
  $(claims)
  select public.create_invoice_draft_from_completion('$COMP', 662.5, 0, null);
SQL
); then A1_RC=0; else A1_RC=$?; fi
wait "$B1" || fail "S1: the paying worker (B1) failed unexpectedly"
[ "$A1_RC" -ne 0 ] || fail "S1: regeneration succeeded despite a committed payment"
echo "$A1_OUT" | grep -qi "regeneration is blocked" || fail "S1: wrong error: $A1_OUT"
echo "S1 PASS: payment won lock; regeneration waited then blocked"

# --- S2: REGENERATION wins; payment waits, then uses the committed total ----
reseed
( "${PSQL[@]}" >/dev/null <<SQL
    begin; $(claims)
    select public.create_invoice_draft_from_completion('$COMP', 662.5, 0, null);
    select pg_sleep(2);
    commit;
SQL
) & B2=$!
sleep 0.5
if P2_OUT=$("${PSQL[@]}" 2>&1 <<SQL
  $(claims)
  select public.mark_payment('$INV', 106625, gen_random_uuid(), now(), 'manual', null)->>'payment_status';
SQL
); then P2_RC=0; else P2_RC=$?; fi
wait "$B2" || fail "S2: the regenerating worker (B2) failed unexpectedly"
[ "$P2_RC" -eq 0 ] || fail "S2: payment failed after regeneration committed: $P2_OUT"
echo "$P2_OUT" | grep -qi "paid" || fail "S2: payment did not reach 'paid': $P2_OUT"
echo "S2 PASS: regeneration won lock; payment waited then paid the committed total"

# --- S3: SAME idempotency key concurrently -> one row (both calls succeed) ---
reseed
KEY=$(uuidgen | tr 'A-F' 'a-f')
"${PSQL[@]}" >/dev/null 2>&1 <<SQL & P3A=$!
  $(claims)
  select public.mark_payment('$INV', 5000, '$KEY', now(), 'manual', null);
SQL
"${PSQL[@]}" >/dev/null 2>&1 <<SQL & P3B=$!
  $(claims)
  select public.mark_payment('$INV', 5000, '$KEY', now(), 'manual', null);
SQL
# Both must succeed (one inserts, the other replays the same row) — assert it.
wait "$P3A" || fail "S3: worker A failed (same-key should insert-or-replay, not error)"
wait "$P3B" || fail "S3: worker B failed (same-key should insert-or-replay, not error)"
N=$("${PSQL[@]}" -c "select count(*) from public.payments where invoice_id='$INV' and idempotency_key='$KEY';" | tr -d '[:space:]')
[ "$N" = "1" ] || fail "S3: expected exactly 1 payment row for the key, got $N"
echo "S3 PASS: concurrent same-key -> both calls OK, a single payment row"

# --- S4: two concurrent payments that TOGETHER exceed the balance -----------
# Exactly ONE succeeds; the other must FAIL with the overpayment error.
reseed
A4=$(mktemp); B4=$(mktemp)
"${PSQL[@]}" >"$A4" 2>&1 <<SQL & P4A=$!
  $(claims)
  select public.mark_payment('$INV', 60000, gen_random_uuid(), now(), 'manual', null);
SQL
"${PSQL[@]}" >"$B4" 2>&1 <<SQL & P4B=$!
  $(claims)
  select public.mark_payment('$INV', 60000, gen_random_uuid(), now(), 'manual', null);
SQL
if wait "$P4A"; then RCA=0; else RCA=$?; fi
if wait "$P4B"; then RCB=0; else RCB=$?; fi
SUCC=$(( (RCA==0 ? 1 : 0) + (RCB==0 ? 1 : 0) ))
[ "$SUCC" -eq 1 ] || { echo "A4:$(cat "$A4") B4:$(cat "$B4")"; fail "S4: expected exactly one success (rcA=$RCA rcB=$RCB)"; }
[ "$RCA" -eq 0 ] || grep -qi "exceeds balance" "$A4" || fail "S4: worker A failed with wrong error: $(cat "$A4")"
[ "$RCB" -eq 0 ] || grep -qi "exceeds balance" "$B4" || fail "S4: worker B failed with wrong error: $(cat "$B4")"
rm -f "$A4" "$B4"
PAID=$("${PSQL[@]}" -c "select coalesce(sum(amount_cents),0) from public.payments where invoice_id='$INV';" | tr -d '[:space:]')
[ "$PAID" = "60000" ] || fail "S4: expected one 60000 payment to win (paid=$PAID)"
echo "S4 PASS: one over-balance payment won; the other failed with 'exceeds balance'"

# --- S5: sent / paid / void invoices cannot regenerate (no payments) --------
for ST in sent paid void; do
  reseed
  "${PSQL[@]}" -c "update public.invoices set status='$ST' where id='$INV';" >/dev/null
  if S5_OUT=$("${PSQL[@]}" 2>&1 <<SQL
    $(claims)
    select public.create_invoice_draft_from_completion('$COMP', 662.5, 0, null);
SQL
); then S5_RC=0; else S5_RC=$?; fi
  [ "$S5_RC" -ne 0 ] || fail "S5($ST): regeneration succeeded on a $ST invoice"
  echo "$S5_OUT" | grep -qi "regeneration is blocked" || fail "S5($ST): wrong error: $S5_OUT"
done
echo "S5 PASS: sent / paid / void invoices cannot be regenerated"

echo "ALL CONCURRENCY SCENARIOS PASSED"
