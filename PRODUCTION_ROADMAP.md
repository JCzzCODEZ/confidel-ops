# Confidel Ops — Production-Hardening Roadmap

Planning only — **no code changes here.** This turns the v1 known-limitations list into a phased,
sequenced plan so hardening lands in safe order instead of feature soup. Demo-ready today; this is the
path to production-ready.

Grounded in the real codebase: tables `companies`, `settings`, `company_memberships`, `clients`, `jobs`,
`invoices`, `payments`, `job_status_history`, `activity_feed`; RPCs `my_jobs()`, `submit_job_completion()`,
`company_branding()` (+ RLS helpers `current_company_id()`, `is_owner()`, …); routes under `app/api/*`;
auth in `app/api/_shared.ts`, `lib/auth.ts`, `lib/supabase/client.ts`.

Difficulty legend: **Low** = config/doc or contained change; **Medium** = multi-file feature with RLS/test work; **High** = cross-cutting flow touching auth, schema, UI, and tests.

---

## Phase 1 — Production safety blockers
*Don't go live without these. Mostly backend/config; minimal demo surface.*

### 1.1 Alarm-code encryption with Supabase Vault  — ✅ VERIFIED COMPLETE (2026-06-23)
- **Status:** applied and tested green. `db/fixes/2026-06-23_alarm_code_vault.sql` (pgcrypto + Vault key, cipher column, audit table + owner/admin read policy, `set_alarm_code` / `reveal_alarm_code` RPCs), endpoints `app/api/clients/[clientId]/alarm-code` (PUT) and `…/reveal-alarm-code` (POST), `lib/confidel-api.ts` helpers, and gated tests (`ALARM_CODE_TESTS=1`) — all six checks pass. Final fix: `grant select on public.alarm_code_audit to authenticated` + owner/admin read policy joined through `clients`.
- **Why it matters:** `clients.alarm_code` is a physical-security secret (home entry). Plaintext at rest is the single highest-consequence data item in the system.
- **Risk if skipped:** a DB leak, backup exposure, or over-broad SELECT hands attackers literal keys to clients' homes. Reputational and legal exposure.
- **Files / routes / tables:** `clients` table (migrate `alarm_code` to a Vault-encrypted secret / `pgsodium` column); `app/api/clients/route.ts` (write path encrypts, owner read decrypts via a dedicated RPC); keep it **out** of `my_jobs()` (already excluded). New owner-only RPC e.g. `client_alarm_code(client_id)`.
- **Testing:** ciphertext confirmed at rest; owner decrypt works; employee path never returns it; backup dump contains no plaintext.
- **Difficulty:** Medium.

### 1.2 Role / permission + RLS review (incl. anon EXECUTE decision)  — *matrix + tests written, pending live confirm*
- **Status (2026-06-23):** `SECURITY_MATRIX.md` documents routes, tables, RPCs, and helper grants; new gated `scripts/rls-matrix-test.mjs` (`test:rls`) adds cross-company isolation + inactive-employee checks. Remaining: run the matrix inspection queries against the live DB to confirm the **(confirm)** rows, decide the anon-EXECUTE-on-helpers question, then mark complete.
- **Why it matters:** RLS is the *only* enforcement layer (no service-role key in app). It must be provably correct before real tenants exist.
- **Risk if skipped:** a single mis-scoped policy or function grant leaks cross-tenant or owner-only data. Per the SQL review, revoking `EXECUTE` from `anon` on the policy-helper functions can turn clean "0 rows" into "permission denied" errors on public endpoints — decide this deliberately.
- **Files / routes / tables:** all RLS policies; `company_memberships`; `requireCompanyAdmin` in `app/api/_shared.ts`; helper-function grants (`current_company_id`, `is_owner`, `current_user_role`, `actor_name`). Produce a role × route × table access matrix.
- **Testing:** extend the existing proof runner into a repeatable RLS test (owner/admin/employee/inactive/cross-company); confirm anon gets empty sets, not errors, on any reachable table.
- **Difficulty:** Medium.

### 1.3 Backup & recovery plan  — *runbook written, pending PITR enable + restore rehearsal*
- **Status (2026-06-23):** `BACKUP_RUNBOOK.md` written (backup/PITR config, restore-to-scratch steps, RPO/RTO, ownership, emergency steps, post-restore validation incl. the Vault-key/alarm-code coupling). Remaining (dashboard actions, yours): enable PITR, add a second backup operator, fill the retention/RPO/RTO blanks, and rehearse one restore.
- **Why it matters:** no backup = one bad migration or delete from total data loss.
- **Risk if skipped:** unrecoverable loss of clients/jobs/invoices; no path to restore mid-incident.
- **Files / routes / tables:** Supabase project settings (enable automated backups / PITR per plan); a `RUNBOOK.md` (who restores, how, RPO/RTO, contacts).
- **Testing:** perform an actual restore to a scratch project and verify row counts + a known record; time it.
- **Difficulty:** Low (config + doc + one rehearsal).

### 1.4 Security regression tests (the demo's must-pass boundary)
- **Why it matters:** locks in the two things that already work (logged-out redirects; employee leak boundary) so future changes can't silently break them.
- **Risk if skipped:** a refactor reintroduces the auth-loading hang or leaks owner-only fields and no one notices until a customer does.
- **Files / routes / tables:** new `tests/` (Playwright for `/`, `/owner`, `/employee` logged-out redirects; assertion that `/api/employee/jobs` JSON excludes pricing/payroll/`tax_id`/`admin_notes`/`invoice_id`); CI workflow.
- **Testing:** the tests *are* the deliverable; run in CI on every PR.
- **Difficulty:** Medium.

---

## Phase 2 — Operational usability
*Makes it usable by real staff and real proof-of-work. Touches employee/owner UI — gate behind flags so the demo path stays intact.*

### 2.1 Supabase Storage for photos / signatures  — *backend (C-1) tested green; UI (C-2) wired, pending browser check*
- **Status (2026-06-23):** backend applied + `test:storage` green (incl. the storage-RLS helper fix). UI now wired: employee completion form uploads before/after photos, signature, and other files to the private bucket via `jobMediaStoragePath()` + `recordJobMedia()` (text photo-URL field removed); owner Review queue lists attachments via `listJobMedia()` and previews them with short-lived signed URLs (`getJobMediaSignedUrl()`). No storage paths or public URLs shown. Remaining: browser upload/preview + 390px mobile check, then mark complete.
- **Why it matters:** today "photos" are just text URLs typed into a form — no real evidence of work, no control over where images live.
- **Risk if skipped:** completions can't be trusted as proof; disputes have no backing; URLs can point anywhere.
- **Files / routes / tables:** new Storage bucket + bucket RLS scoped by company; new signed-URL route (e.g. `app/api/uploads/route.ts`); store object paths on completions (`completions` table / `submit_job_completion`); later, employee form swap in `components/employee/employee-dashboard.tsx`.
- **Testing:** upload as employee; owner reads via signed URL; employee cannot read another company's/employee's objects; bucket denies public listing.
- **Difficulty:** Medium-High.

### 2.2 Server-side required photo / signature enforcement
- **Why it matters:** `settings.require_photos` / `require_signatures` exist but are inert — nothing enforces them. Client promises ("we document every visit") are currently unbacked.
- **Risk if skipped:** false sense of policy; completions submitted with nothing attached.
- **Files / routes / tables:** `settings` table; `submit_job_completion()` RPC (add the checks server-side); `app/api/jobs/complete/route.ts`. Depends on 2.1 for real attachments.
- **Testing:** with flags on, submit without photo/signature → rejected; with attachment → accepted; flags off → unchanged (preserves demo).
- **Difficulty:** Low-Medium.

### 2.3 Invite / onboarding flow  — *built (code), pending apply + test*
- **Status (2026-06-23):** `db/fixes/2026-06-23_onboarding.sql` (`company_invites` + RLS, `accept_my_invite`, `set_company_membership`, `team_member_stats`), routes under `/api/team/*` (invite/invites/membership/accept/stats), `lib` helpers, LoginLanding auto-accept of a pending invite, owner **Team** tab (invite by email+role, deactivate/reactivate, promote/demote, per-employee stats, pending invites), and gated tests `test:onboarding`. **No service-role key** — owner creates a pending invite, employee self-signs-up with that email and accepts on login. Authorization is always from `company_memberships`, never user_metadata. **Production:** wire an SMTP provider for real invite emails (currently a shareable link).
- **Why it matters:** users + memberships are created by hand in Supabase today. Doesn't scale and isn't safe for real staff.
- **Risk if skipped:** manual errors granting wrong roles/companies; no offboarding; bottleneck on you.
- **Files / routes / tables:** Supabase Auth invite; `company_memberships` (create/activate/deactivate); `app/api/employees/route.ts` (exists — extend) + new invite/accept routes; email templates; owner UI to invite/deactivate.
- **Testing:** invite → accept → membership active → routes to correct dashboard; deactivate → blocked; wrong-role invite rejected.
- **Difficulty:** High.

### 2.4 Audit / activity UI
- **Why it matters:** `job_status_history` and `activity_feed` are already written but invisible. Auditability you can't see isn't auditability.
- **Risk if skipped:** no way to answer "who changed/approved what, when" — bad for disputes and trust.
- **Files / routes / tables:** `activity_feed`, `job_status_history` (read policies already owner-only); new `app/api/activity/route.ts`; new owner dashboard tab in `components/owner/owner-dashboard.tsx`. Decide retention.
- **Testing:** owner sees scoped feed; employee/cross-company cannot; pagination/retention behave.
- **Difficulty:** Medium.

---

## Phase 3 — Automation and reporting
*Reduce manual owner work and produce the documents the business actually needs.*

### 3.0 Structured completion data  — *capture layer done (code), pending apply + test; pricing/invoice/tax layer next*
- **Status (2026-06-23):** services/add-ons/expenses + timing are now structured rows, not free text — `db/fixes/2026-06-23_structured_completion.sql` (`job_completion_services` / `_addons` / `_expenses` + timing/status columns + `record_completion_details` RPC, additive: does not touch `submit_job_completion`), route `app/api/completions/[completionId]/details` (GET/POST), `lib` helpers, employee form (timing, status, itemized expenses, structured submit; notes are employee-only), owner Review "View details", and gated tests `scripts/structured-completion-test.mjs` (`test:structured`). **Next:** owner pricing/invoice-draft from this data + receipt/tax records + CSV/PDF exports — built once this is applied/tested and the live `invoices`/`payments` schema is confirmed.

### 3.0b Owner pricing / invoice-draft / tax records  — *backend tested; owner UI wired, pending browser check*
- **Status (2026-06-23):** `db/fixes/2026-06-23_pricing_invoicing.sql` adds `service_prices`, `addon_prices`, `invoice_line_items`, `job_financial_summaries` (all owner/admin RLS via `is_company_admin`) + the `create_invoice_draft_from_completion` RPC (prices structured services/add-ons, computes subtotal/tax/total, rolls expenses into reimbursement/cost, writes `jobs` financials + a tax-ready summary). Routes: `/api/pricing/services`, `/api/pricing/addons`, `/api/completions/[id]/invoice-draft`, `/api/reports/financials`. `lib` helpers + gated tests `test:pricing`. **Assumptions to confirm on first test:** tax rate + discount are owner params; expenses are cost/reimbursement (not client revenue); payroll starts from `jobs.payroll_cents`. **Owner UI (2026-06-23):** Review tab now has a price editor (set/edit service + add-on prices) and, per completion, tax %/discount inputs, "Generate invoice draft", line items, and totals (subtotal/tax/total/reimbursements/employee pay/net profit/amount paid/balance due/payment status) plus a record-payment control — all reusing the verified RPC. Employee side unchanged (no pricing). Pending: browser run-through + a dedicated tax/report screen (the numbers already come back from the draft).

### 3.1 Invoice / payment status automation
- **Why it matters:** recording a payment doesn't update invoice status today — owner reconciles by hand.
- **Risk if skipped:** invoices show wrong status; double-charging or missed collections; messy books.
- **Files / routes / tables:** `invoices`, `payments` (trigger or route logic to set `partial`/`paid` from summed payments); `app/api/payments/route.ts`, `app/api/invoices/route.ts`.
- **Testing:** partial payment → `partial`; full → `paid`; overpayment/refund handled; concurrent payments serialize correctly.
- **Difficulty:** Medium.

### 3.1b Records / monthly tax ledger  — *built (code), pending browser + build check*
- **Status (2026-06-23):** owner-only **Records** tab groups completed/invoiced jobs by month of a selected year, shows monthly totals (revenue, sales tax, invoice totals, paid, outstanding, payroll, reimbursements, supplies, mileage miles + reimbursement, parking, tolls, other, net profit, # jobs, # paid, # unpaid/partial) and per-job rows, with **Export CSV**. Uses the extended `/api/reports/financials` (owner/admin only — now enriched with date/client/job/employee/services/add-ons/payment method, no schema change). Employee side has no Records link or access. Also: placeholder "C" replaced with the real Confidel logo (`public/confidel-logo.png`) across login/owner/employee headers.

### 3.2 Tax / export improvements
- **Why it matters:** the business needs invoices/statements out of the system (PDF/CSV) and correct tax handling for filing.
- **Risk if skipped:** manual re-keying into accounting; tax errors; no client-facing documents.
- **Files / routes / tables:** `settings.tax_rate`, `invoices`, `payments`; new export routes (`app/api/invoices/[id]/export`, CSV/PDF); verify tax math centrally.
- **Testing:** totals/tax math vs hand calc; export format opens cleanly in Excel/accounting tools; rounding correct.
- **Difficulty:** Medium.

### 3.3 Reporting / metrics
- **Why it matters:** owner needs revenue, outstanding A/R, jobs completed, payroll due — beyond the current four counters.
- **Risk if skipped:** flying blind; decisions on gut not data.
- **Files / routes / tables:** read-only aggregate RPCs/views over `jobs`/`invoices`/`payments`; owner dashboard widgets.
- **Testing:** aggregates match raw queries; company-scoped; performant on realistic volume.
- **Difficulty:** Medium.

---

## Phase 4 — Launch readiness
*Final gates before real customers.*

### 4.1 Full automated test suite + CI
- **Why it matters:** Phase 1.4 covers the security boundary; production needs broader coverage (RLS matrix, API contract, critical flows) running on every change.
- **Risk if skipped:** regressions ship silently; every release is a manual gamble.
- **Files / routes / tables:** `tests/` (unit for `lib/auth.ts`; integration for each `app/api/*` route; e2e for owner/employee flows); CI gate blocking merge on failure.
- **Testing:** the suite itself; track coverage of auth + money paths.
- **Difficulty:** Medium-High.

### 4.2 Deployment checklist + observability  — *CI + DEPLOY.md written (2026-06-23)*
- **Status:** `.github/workflows/ci.yml` (install → typecheck → build, plus the secret-free logged-out e2e) and `DEPLOY.md` (prereqs, env vars, Vercel + Supabase setup, Auth redirect URLs, migration apply order, pre-deploy test list, production smoke test, rollback, backup/PITR, security notes). No service-role key required. Remaining: add error monitoring (Sentry or similar) and uptime alerts.
- **Why it matters:** repeatable, safe deploys with the ability to see failures in production.
- **Risk if skipped:** misconfigured envs, secret leaks, silent outages.
- **Files / routes / tables:** host config (e.g. Vercel) env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`); `next build` in CI; error monitoring (Sentry or similar); uptime/log alerts; a `DEPLOY.md` checklist (migrations applied, RLS advisors clean, backups on, smoke test passed).
- **Testing:** staging deploy mirrors prod; rollback path verified; alerts actually fire on a forced error.
- **Difficulty:** Low-Medium.

### 4.2b Observability  — *done (code), pending DSN wiring*
- **Status (2026-06-24):** optional, dependency-free error reporter (`lib/monitoring.ts`) wired into API errors (`handleRouteError`) and a frontend global error boundary (`app/global-error.tsx`); `GET /api/health`; `PRODUCTION_READY.md`; DEPLOY.md monitoring/health section. No-op without a DSN, so dev/build unaffected. Remaining: set `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` in Vercel and confirm a forced error lands.

### 4.3 Final security + data pass
- **Why it matters:** last look before real PII/secrets land.
- **Risk if skipped:** ship with a known gap.
- **Files / routes / tables:** Supabase security advisors; confirm no service-role key anywhere client-side; re-run the RLS matrix; verify alarm-code encryption end to end; backup restore rehearsed.
- **Testing:** advisors clean; pen-style spot checks on cross-tenant access; secret-scan the repo.
- **Difficulty:** Low-Medium.

---

## Safest build order (without breaking the demo)

The demo rests on five things staying green: the `/` → `/owner` / `/employee` routing, the logged-out
redirects, `my_jobs()`, `submit_job_completion()`, and the employee leak boundary. Sequence so nothing
touches those until they're protected by tests, and so new enforcement ships **flag-gated, default off.**

1. **1.4 Security regression tests first.** Lock the demo's guarantees *before* changing anything else. Now every later step has a safety net.
2. **1.3 Backup/recovery** and **1.2 role/RLS review.** Pure config + analysis (and test additions) — zero demo surface, but they de-risk everything after.
3. **1.1 Alarm-code encryption.** Backend + a new owner-only RPC; `my_jobs()` already excludes the field, so the employee/demo path is untouched. Ship behind a read-compatibility shim so existing rows keep working.
4. **2.1 Storage**, then **2.2 required-enforcement (flag default OFF).** Storage is additive (new bucket/route). Keep `require_photos`/`require_signatures` off so the current completion flow — and the demo — is unchanged until real accounts are ready.
5. **2.4 Audit UI**, then **3.1 invoice/payment automation**, then **3.2 tax/export**, then **3.3 reporting.** Each is additive (new owner tabs/routes) and never alters the employee boundary.
6. **2.3 invite/onboarding.** Highest-risk because it touches auth and membership/routing — do it once the test net (1.4/4.1) is strong, and verify the role-routing guards after.
7. **4.1–4.3 launch gates** last: full suite + CI, deployment checklist/observability, final security pass.

Rule of thumb throughout: **after every change, re-run the Phase 1.4 tests + the `DEMO_GUIDE.md` smoke
test.** If the logged-out redirects or the employee leak check ever go red, stop and fix before moving on.
