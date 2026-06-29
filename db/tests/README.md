# Payment-safety test handoff

These tests run against a **dedicated Supabase TEST BRANCH**, never production.

## One-time branch seed (run once, on the test branch only)

The CI guard requires a positive marker in the **private** schema (not API-exposed,
so no RLS is needed; readable only by the privileged CI database role):

```sql
create schema if not exists private;
create table if not exists private._ci_test_marker (token text primary key);
insert into private._ci_test_marker (token) values ('confidel-ci')
  on conflict do nothing;
-- Lock it down: never reachable by API roles.
revoke all on private._ci_test_marker from public, anon, authenticated;
revoke usage on schema private from anon, authenticated;  -- if not already revoked
```

## What CI does (`.github/workflows/payment-safety-ci.yml`, `workflow_dispatch` only)

1. Refuses the production project ref and any non-`test`/`branch` URL; requires the
   `private._ci_test_marker` row. **Never sets `ALLOW_NONTEST_DB`.**
2. Applies both migrations **twice** (rerunnable):
   `db/fixes/2026-06-29_invoice_tax_numeric.sql`, then `db/fixes/2026-06-29_payment_safety.sql`.
3. Runs the SQL integration tests (`ON_ERROR_STOP=1`):
   `db/tests/2026-06-29_invoice_tax_test.sql`, `db/tests/2026-06-29_payment_safety_test.sql`.
   These call the **public** `mark_payment`/draft RPCs as the `authenticated` role.
4. Runs the two-connection concurrency test: `db/tests/concurrency/payment_race.sh`.
5. Asserts signatures + grants + schema: `db/tests/2026-06-29_assert_grants.sql`.

Set `TEST_DATABASE_URL` as a secret in a protected GitHub **Environment** named `test`.

## Run locally against a branch

```bash
export TEST_DATABASE_URL='postgres://...branch...'   # must contain "test" or "branch"
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixes/2026-06-29_invoice_tax_numeric.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixes/2026-06-29_payment_safety.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/2026-06-29_invoice_tax_test.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/2026-06-29_payment_safety_test.sql
bash db/tests/concurrency/payment_race.sh
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/2026-06-29_assert_grants.sql
```

## Separate gate (NOT automated)

Accountant sign-off on the proportional mixed-invoice discount policy
(`db/fixes/2026-06-29_invoice_tax_numeric.sql` header) remains a manual deployment gate.
