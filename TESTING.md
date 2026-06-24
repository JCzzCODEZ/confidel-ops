# Confidel Ops — Security regression tests (Phase 1.4)

> **Status: Phase 1.4 COMPLETE ✅ (2026-06-23)**
> - Browser logged-out guards: **passed** (`/`, `/owner`, `/employee` redirect correctly, no infinite loading).
> - API / RLS suite: **passed** (`API integration tests completed: PASS`).
> - **Anon `my_jobs` read leak found and fixed.** The regression test caught anonymous callers receiving
>   job rows; fixed in the database via a `SECURITY DEFINER` wrapper + hidden `private.my_jobs_impl()`
>   with a hard `auth.uid()` guard and locked-down grants — recorded in
>   [`db/fixes/2026-06-23_my_jobs_auth_guard.sql`](db/fixes/2026-06-23_my_jobs_auth_guard.sql).
> - Also fixed a test-correctness bug: the anon check now uses a fresh, never-signed-in Supabase client
>   so it can't be contaminated by a prior session.
>
> The demo's security guarantees are now locked by these tests. Re-run both suites after any change.
> Test data cleanup: [`scripts/cleanup-api-test-data.sql`](scripts/cleanup-api-test-data.sql).

> **Status: Phase 1.1 (alarm-code encryption) VERIFIED COMPLETE ✅ (2026-06-23)**
> - Alarm codes encrypted at rest (pgcrypto + key in Supabase Vault); plaintext column removed.
> - Owner/admin-only `set_alarm_code` / `reveal_alarm_code`; every reveal is audited.
> - Employees and anon cannot set or reveal; normal client APIs never return the code.
> - All six gated checks pass (`ALARM_CODE_TESTS=1 npm run test:api`). The final fix was a
>   table-level `grant select on public.alarm_code_audit to authenticated` plus an owner/admin
>   read policy joined through `clients` — both recorded in
>   [`db/fixes/2026-06-23_alarm_code_vault.sql`](db/fixes/2026-06-23_alarm_code_vault.sql).

These lock in the demo's security guarantees so production-hardening can't silently break them.
Two layers:

- **Browser flows (Playwright)** — `tests/e2e/auth-guards.spec.ts`: logged-out guards + role routing.
- **API + RLS (Node script)** — `scripts/api-integration.mjs`: employee data boundary, owner/employee/anon access, and direct-SELECT RLS proofs.

Nothing here changes production behavior — it only observes it. (If a test ever fails, that's a real bug to fix, not a test to loosen.)

## What is covered

| Item | Where | Checks |
|---|---|---|
| 1. Logged-out guards | Playwright | `/` shows `login-screen`; `/owner` and `/employee` redirect to `/`; `auth-loading` clears (no infinite spinner) |
| 2. Role routing | Playwright | owner/admin → `/owner`; employee → `/employee`; employee on `/owner` → `/employee`; owner on `/employee` → `/owner` |
| 3. Employee API boundary | API script | `/api/employee/jobs` returns only assigned jobs and **none** of `price_cents`, `cost_cents`, `payroll_cents`, `profit_cents`, `tax_id`, `admin_notes`, `invoice_id`; cannot see another employee's job |
| 4. Owner/admin access | API script | owner can use clients/jobs/employees/completions/invoices/payments; employee gets 4xx on owner-only routes; anon gets 401 |
| 5. RLS proofs | API script | employee direct `SELECT jobs` = 0 rows; direct `SELECT companies` = 0 rows; direct `INSERT jobs` rejected; `company_branding` returns only id/name/logo_url; anon denied `my_jobs()` |

Known gap (follow-up): true cross-**company** linking rejection needs a second seeded company; the current harness is single-company and proves cross-**employee** isolation instead. Add a two-company fixture when convenient.

## Required env vars

In `.env.local` (already used by the app):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

For the **API script** (creates and uses its own throwaway accounts):

- `API_TEST_RUN_ID` — any unique string per run, e.g. `2026-06-23a` (namespaces the test users/company).
- `API_TEST_PASSWORD` — optional, defaults to a built-in dev password.
- `API_TEST_BASE_URL` — optional, defaults to `http://127.0.0.1:3000`.
- `ALARM_CODE_TESTS=1` — optional. Includes the Phase 1.1 alarm-code tests (set/reveal,
  employee/anon denial, no-leak, audit row). **Only enable after applying
  `db/fixes/2026-06-23_alarm_code_vault.sql`** — without the migration these will fail.
  Left off by default so the Phase 1.4 suite stays green independently.

For the **RLS matrix script** (`scripts/rls-matrix-test.mjs`, Phase B — cross-company isolation +
inactive employee). It's a separate script, so it never affects the Phase 1.4 suite:

- `RLS_TEST_RUN_ID` — unique per run (e.g. `rls-2026-06-23a`). Creates its own `@example.com` accounts.
- Run with the dev server up:
  `pnpm run test:rls:signup` (once per run id) then `pnpm run test:rls`.
- Passing output ends with `RLS matrix tests completed: PASS` and prints a `CLEANUP_LABEL` line.

For the **storage media script** (`scripts/storage-media-test.mjs`, Phase C — private bucket + RLS).
**Apply `db/fixes/2026-06-23_job_media_storage.sql` first.** Separate script; does not touch other suites.

- `STORAGE_TEST_RUN_ID` — unique per run. Creates its own `@example.com` accounts.
- Run with the dev server up:
  `pnpm run test:storage:signup` (once per run id) then `pnpm run test:storage`.
- Verifies: assigned-employee upload + record, owner list + signed (private) URL, unassigned-employee
  denied (list/sign/upload), anon denied, and that metadata exposes no storage internals. Ends with
  `storage media tests completed: PASS`.

For the **structured-completion script** (`scripts/structured-completion-test.mjs`).
**Apply `db/fixes/2026-06-23_structured_completion.sql` first.**

- `STRUCTURED_TEST_RUN_ID` — unique per run. Creates its own `@example.com` accounts.
- `pnpm run test:structured:signup` then `pnpm run test:structured` (dev server up).
- Verifies: employee records structured services/add-ons/expenses + timing; owner reads them back;
  expenses are itemized (mileage keeps miles, supplies keep their own cost); server-computed hours;
  the details payload exposes no pricing fields; unassigned employee + anon are denied. Ends with
  `structured completion tests completed: PASS`.

For the **pricing/invoice script** (`scripts/pricing-invoice-test.mjs`).
**Apply both `…_structured_completion.sql` and `…_pricing_invoicing.sql` first.**

- `PRICING_TEST_RUN_ID` — unique per run.
- `pnpm run test:pricing:signup` then `pnpm run test:pricing` (dev server up).
- Verifies: owner creates service/add-on prices; employee cannot read prices; owner generates an
  invoice draft whose line items + tax + total match the priced structured services/add-ons; itemized
  expenses roll into the reimbursement summary; a payment updates amount-paid/balance/status;
  employee APIs leak no pricing/invoice/tax fields; the owner tax report carries the tax-ready fields.
  Ends with `pricing invoice tests completed: PASS`.

For the **onboarding script** (`scripts/onboarding-test.mjs`).
**Apply `db/fixes/2026-06-23_onboarding.sql` first.**

- `ONBOARDING_TEST_RUN_ID` — unique per run.
- `pnpm run test:onboarding:signup` then `pnpm run test:onboarding` (dev server up).
- Verifies: owner invites employee + admin; invited employee accepts and gets employee access (no
  pricing leak); employee blocked on owner/records/pricing/team routes; invited admin accepts and gets
  owner-dashboard access; owner deactivates employee → blocked; anon denied. Ends with
  `onboarding tests completed: PASS`.

## How to invite / manage employees (real onboarding)

1. Owner opens the **Team** tab → enters the employee's email + name + role → **Invite**. A pending
   invite is created; the owner sees an invite link (dev convenience).
2. The employee **signs up themselves** (normal Supabase sign-up) using that exact email, then logs in.
   On login the app calls `accept_my_invite()`, which matches their auth email to the pending invite and
   creates their active membership — they land on `/employee` (or `/owner` for an admin invite).
3. **Deactivate / reactivate / change role** from the Team tab (owner/admin only). A deactivated member
   can't see jobs, submit completions, or reach any owner route; historical records stay intact.

**No service-role key is used** — invites are token/email based, acceptance is the user's own action.

> **Production email warning:** there is no SMTP/email provider wired in. Invites are surfaced as a link
> for the owner to share manually. Before production, configure a Supabase SMTP provider (or your own
> mailer) if you want automatic invite emails, and **never** send to fake/invalid domains. In dev, keep
> "Confirm email" off (or pre-confirm) so the self-signup step can sign in.

### Employee completion form (field workflow) — manual browser checks

The completion form's required-field rules are client-side, so verify them in the browser (the
API/RLS guarantees stay covered by the suites above):

- Inactive/finished jobs (approved/rejected/completed/cancelled/submitted/paid, or cancelled
  assignment) show a read-only card (`employee-job-readonly`), **no** form.
- Submit is blocked with a clear message when: no services checked, no before photo, no after photo,
  no signature drawn, or the confirmation box (`completion-confirm`) is unchecked.
- Services/add-ons are checklists (`service-*` / `addon-*`); signature is a canvas pad
  (`completion-signature-pad`) with Clear (`completion-signature-clear`), exported to PNG and uploaded
  as `media_type=signature`.
- Owner Review shows the checklist values (in the completion notes) and previews each photo/signature/
  attachment via signed URLs. Check the 390px layout: checklists tappable, inputs and signature pad
  don't overflow, submit stays visible.

For the **Playwright role-routing** tests (optional — logged-out tests run without them):

- `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`
- `E2E_EMPLOYEE_EMAIL`, `E2E_EMPLOYEE_PASSWORD`
- `E2E_BASE_URL` — optional, defaults to `http://127.0.0.1:3000`

> **Safety rules for automated test signups:**
>
> - **Dev/staging Supabase project only** — never run this against the production project. The script
>   signs up real auth users and inserts a demo company.
> - **Turn off email confirmation** for the API test users (disable "Confirm email" on the dev project,
>   or pre-confirm them), or `signInWithPassword` will fail.
> - **Never use real email domains** for automated tests. The accounts use the reserved, non-deliverable
>   `@example.com` domain so signups can't send mail to a real inbox. Don't switch them to gmail.com or
>   any deliverable domain.
> - **Delete test users after runs** if needed — the script prints a `CLEANUP_LABEL` line with the
>   company/user ids it created so you can clean them up.

## Test / demo accounts

- **API script:** creates them for you. Run the `signup` phase once per `API_TEST_RUN_ID`:
  `confidel.api.owner.<runId>@example.com`, `confidel.api.employee.<runId>@example.com`, `confidel.api.other.<runId>@example.com`.
  These use the reserved, non-deliverable `@example.com` domain on purpose — never change them to a real domain.
- **Playwright role routing:** point `E2E_OWNER_*` / `E2E_EMPLOYEE_*` at any confirmed accounts that have an active owner (or admin) and employee membership in a company (the API script's accounts work once confirmed).

## How to run

```bash
# install (first time) — pnpm is the repo's package manager
pnpm install
pnpm run test:e2e:install        # downloads the Chromium browser for Playwright

# 1) Browser flows — auto-starts the dev server
pnpm run test:e2e                # logged-out guards always run; role routing runs if E2E_* set

# 2) API + RLS — needs the dev server running in another terminal
pnpm run dev                     # terminal A
export API_TEST_RUN_ID=$(date +%Y%m%d%H%M)   # terminal B
pnpm run test:api:signup         # once per run id (creates the auth users)
pnpm run test:api                # seeds the company + runs all API/RLS assertions

# Combined gate (typecheck + browser flows)
pnpm run test:security
```

(`npm run …` works too; the repo just uses pnpm by default.)

## What passing looks like

**API script** — each assertion prints `PASS <name>` and the run ends with:

```
PASS employee can see assigned job through the API only
PASS RLS: employee direct SELECT on jobs returns 0 rows
PASS RLS: employee direct SELECT on companies returns 0 rows
PASS RLS: employee direct INSERT into jobs is rejected
PASS RLS: company_branding RPC returns only id/name/logo_url
PASS RLS: anon cannot execute sensitive RPC (my_jobs)
PASS employee requests to owner-only routes fail
PASS anon requests fail
CLEANUP_LABEL run=... company_id=... owner=... employee=... other_employee=...
API integration tests completed: PASS
```

Any `FAIL <name>` line (with a stack) means a real regression — stop and fix the code, not the test.

**Playwright** — the `list` reporter shows each test with a green check, ending with `N passed`.
The must-pass lines are the three logged-out guard tests; if `/owner` or `/employee` ever stays on the
spinner instead of redirecting to `/`, those tests fail.
