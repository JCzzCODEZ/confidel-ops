# Confidel Ops — Deployment & CI

Deploying the Next.js (App Router) + Supabase app to Vercel at **ops.confidel.co**.
This is operational documentation — no product features here. Work top to bottom for a first deploy.

---

## 1. Local prerequisites

- Node 20+ and npm (the repo also has a `pnpm-lock.yaml`; either works — CI uses `npm install`).
- A Supabase project (Postgres + Auth + Storage + Vault).
- Git access to the repo, and a Vercel account with access to the team/project.
- Supabase SQL Editor access (owner) to apply the migrations in `db/fixes/`.

## 2. Required environment variables

Only two, both **public** (safe in the browser). **No service-role key is used or required** anywhere
in the app — every request runs as the logged-in user and RLS is the enforcement layer.

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel + local `.env.local` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel + local `.env.local` | Supabase publishable (anon) key |

Do **not** add `SUPABASE_SERVICE_ROLE_KEY` to Vercel — the app does not need it, and it must never reach
the frontend.

## 3. Supabase project setup checklist

- [ ] Project created; note the **Project URL** and **publishable (anon) key**.
- [ ] **Vault** enabled (Database → Extensions/Integrations) — required for alarm-code encryption.
- [ ] `pgcrypto` available (extensions schema).
- [ ] Apply the SQL migrations in order (section 5).
- [ ] Run the Supabase **advisors** (Database → Advisors) and resolve anything critical.
- [ ] Confirm RLS is enabled on every app table (the migrations do this).
- [ ] Daily backups on; enable **PITR** (section 10).

## 4. Supabase Auth setup

In Supabase → Authentication → URL Configuration:

- **Site URL:** `https://ops.confidel.co`
- **Redirect URLs (add all):**
  - `https://ops.confidel.co/**`
  - `http://localhost:3000/**` (local dev)
  - any Vercel preview pattern you use, e.g. `https://*.vercel.app/**`
- **Email confirmation (production):** decide deliberately. For real users, keep "Confirm email" **on**
  and configure SMTP (below). For dev/test projects, turn it **off** (or pre-confirm) so the self-signup
  invite-accept flow can sign in immediately.
- **SMTP (before real users):** the app has **no mailer**. Employee invites are surfaced as a shareable
  link in the owner Team tab. Before onboarding real staff, configure a Supabase SMTP provider (or your
  own) so invites/resets/confirmations actually send — and never send to fake/invalid domains.

## 5. Apply SQL migrations / fixes (in order)

Run each file's contents in the Supabase **SQL Editor**, in this order (later files depend on earlier
helpers like `job_media_authorized` and `is_company_admin`):

1. `db/fixes/2026-06-23_my_jobs_auth_guard.sql`
2. `db/fixes/2026-06-23_alarm_code_vault.sql`
3. `db/fixes/2026-06-23_job_media_storage.sql`
4. `db/fixes/2026-06-23_structured_completion.sql`
5. `db/fixes/2026-06-23_pricing_invoicing.sql`
6. `db/fixes/2026-06-23_onboarding.sql`

Each file is idempotent (drops/recreates policies, `create … if not exists`, `create or replace`), so
re-running is safe. After applying, each file ends with `notify pgrst, 'reload schema'`. Verify with the
`-- VERIFY` block at the bottom of each file.

> These migrations assume the base schema (`companies`, `company_memberships`, `clients`, `jobs`,
> `job_assignments`, `job_completions`, `invoices`, `payments`) already exists in the project.

## 6. Vercel setup

1. Import the Git repo into Vercel (framework auto-detected as **Next.js**).
2. Project Settings → Environment Variables → add the two vars from section 2 for **Production**
   (and Preview/Development as needed).
3. Set the custom domain **ops.confidel.co** (Settings → Domains) and follow the DNS instructions.
4. Deploy. Build command `next build`, output is the default Next.js build.
5. After the first deploy, add the production + preview URLs to Supabase Auth redirect URLs (section 4).

## 7. Run tests before deploy

CI (`.github/workflows/ci.yml`) runs on every push/PR: `npm install` → `typecheck` → `build`, plus the
**logged-out** Playwright auth guards (no secrets needed).

The data-touching suites need a **dev/staging** Supabase project + the test accounts; run them locally
against staging before promoting to production (never against the production project):

```bash
npm run typecheck
npm run build
npm run test:e2e          # logged-out guards (set E2E_* to also run role routing)
# with the dev server running and a staging project:
npm run test:api && ALARM_CODE_TESTS=1 npm run test:api
npm run test:rls && npm run test:storage
npm run test:structured && npm run test:pricing && npm run test:onboarding
```

All green = safe to deploy. Clean up test data afterward with `scripts/cleanup-api-test-data.sql`.

## 8. Release smoke test (run against production after deploy)

Use a **real** owner account and a throwaway employee email on a staging-like company:

- [ ] Owner logs in → lands on `/owner`.
- [ ] Owner Team tab → **invite** an employee by email.
- [ ] Employee signs up with that email → logs in → lands on `/employee`.
- [ ] Owner creates a **client**.
- [ ] Owner creates a **job** and **assigns** it to the employee.
- [ ] Employee opens the job → submits a **completion** with before/after **photos** + **signature** + confirmation.
- [ ] Owner **Review**: sees structured details + media (signed previews).
- [ ] Owner sets prices → **generates invoice draft** → totals look right.
- [ ] Owner **records a payment** → balance/status update.
- [ ] Owner **Records** tab → monthly totals → **Export CSV** downloads with the expected columns.
- [ ] **Employee leak check:** employee UI/network shows no pricing, payroll, profit, invoice, tax, or
      admin fields, and no Records/pricing/team access.

If any step fails, roll back (section 9).

## 9. Rollback plan

- **App:** in Vercel → Deployments, **promote the previous successful deployment** (instant rollback).
  Vercel keeps prior builds; no rebuild needed.
- **Env vars:** if a bad env change caused it, restore the previous values and redeploy.
- **Database:** the migrations are additive and idempotent; avoid destructive rollbacks. If a migration
  caused a problem, fix forward with a corrective `create or replace`. For data corruption, restore from
  backup/PITR to a **scratch** project first (see `BACKUP_RUNBOOK.md`), validate, then cut over.
- Record what happened and the recovery point used.

## 10. Backup / recovery checklist

Full procedure in `BACKUP_RUNBOOK.md`. Minimum before real data:

- [ ] Supabase **daily backups** enabled.
- [ ] **PITR** enabled (Database → Backups) and the retention window recorded.
- [ ] **Vault key** preservation confirmed — alarm codes are encrypted with a Vault key; a restore must
      preserve it or stored alarm codes become undecryptable.
- [ ] **One full restore rehearsed** to a scratch project, validated with the post-restore checklist.
- [ ] A second person has Supabase access (avoid a single point of failure).

## 10b. Monitoring & health check

**Error monitoring is optional and env-driven** — the app works with none configured. To enable it,
set a Sentry DSN (DSNs are public ingest keys, not secrets):

| Variable | Where | Captures |
|---|---|---|
| `SENTRY_DSN` | Vercel (server) | API route / server errors (unexpected 5xx) |
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel (client) | frontend errors (global error boundary) |

Set them in Vercel → Environment Variables (Production). With no DSN, `lib/monitoring.ts` is a no-op,
so local dev and CI need nothing. Errors are sent fire-and-forget to Sentry's ingest endpoint over HTTP;
no SDK or extra build config is required. (If you later want full tracing/source maps, install
`@sentry/nextjs` and point it at the same DSNs.)

**Health check** — after every deploy, verify:

```bash
curl https://ops.confidel.co/api/health
# -> {"status":"ok","app":"Confidel Ops","timestamp":"…","environment":"production","supabaseConfigured":true}
```

`supabaseConfigured: false` means the `NEXT_PUBLIC_SUPABASE_*` env vars are missing in Vercel — fix
before going live. Point your uptime monitor at `/api/health`.

## 11. Security notes (confirm before go-live)

- **Employees cannot access pricing / tax / Records / invoices / payroll / profit / admin notes** — all
  owner/admin-only via `requireCompanyAdmin` + RLS (`is_company_admin`); the employee dashboard has no
  links to them.
- **Job media is in a private Storage bucket** — object paths only, served via short-lived signed URLs;
  never public.
- **Alarm-code reveal is audited** — every `reveal_alarm_code` writes an `alarm_code_audit` row;
  codes are encrypted at rest (pgcrypto + Vault key).
- **RLS is the enforcement layer** — the app uses only the public anon key and runs as the logged-in
  user; there is **no service-role key** in the app.
- **Authorization comes from `company_memberships`**, never `user_metadata`.

---

### CI summary (`.github/workflows/ci.yml`)

- `build` job: `npm install` → `npm run typecheck` → `npm run build` (placeholder env; no secrets).
- `e2e` job: installs Chromium and runs the logged-out auth-guard tests (no secrets). The API/RLS/
  storage/structured/pricing/onboarding suites are **not** in CI — they need a live staging project and
  are part of the pre-deploy checklist (section 7).
