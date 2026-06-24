# Confidel Ops — Production Readiness Checklist

Work through every box before onboarding real clients. References: `DEPLOY.md`,
`BACKUP_RUNBOOK.md`, `SECURITY_MATRIX.md`, `TESTING.md`. Many items run on your machine / Supabase
dashboard and can't be auto-verified from the repo.

## Security
- [ ] **No service-role key in the app** — only `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are set; no `SUPABASE_SERVICE_ROLE_KEY` anywhere.
- [ ] **RLS enabled** on every app table (verify with `SECURITY_MATRIX.md` §5 inspection queries).
- [ ] **Employees blocked** from pricing / tax / Records / invoices / payroll / profit / admin notes — confirmed by `test:api`, `test:pricing`, `test:onboarding` leak checks.
- [ ] **Private storage verified** — `job-media` bucket is private; media served only via signed URLs (`test:storage`).
- [ ] **Alarm-code reveal audited** — encrypted at rest; each reveal writes `alarm_code_audit` (`ALARM_CODE_TESTS=1`).
- [ ] **Onboarding verified** — invite → self-signup → accept → active membership; deactivation blocks access (`test:onboarding`).

## Database
- [ ] All migrations applied **in order** (`DEPLOY.md` §5): my_jobs_auth_guard → alarm_code_vault → job_media_storage → structured_completion → pricing_invoicing → onboarding.
- [ ] **Backup / PITR enabled**; retention window recorded.
- [ ] **Restore rehearsal completed** to a scratch project, validated (`BACKUP_RUNBOOK.md`).
- [ ] Supabase **advisors reviewed**; criticals resolved.

## Auth
- [ ] Production **redirect URLs** configured (`https://ops.confidel.co/**`, localhost, preview).
- [ ] **SMTP configured** (or invites shared manually, and the team knows).
- [ ] **Email-confirmation policy** chosen for production (on, with SMTP) vs dev (off).
- [ ] **Owner account created** and can log in.
- [ ] **Employee invite flow tested** end to end on staging.

## App
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] **Logged-out auth guards pass** (`test:e2e` — also runs in CI).
- [ ] **Owner flow passes** (login → clients/jobs/assign/review/pricing/invoice/payment).
- [ ] **Employee flow passes** (login → assigned job → completion with photos + signature).
- [ ] **Records CSV export works** (owner Records tab → Export CSV).
- [ ] **Mobile layout checked** at ~390px — no horizontal overflow on key screens.

## Deployment
- [ ] **Vercel env vars set** (the two `NEXT_PUBLIC_*`; optionally `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`).
- [ ] **Production domain connected** (`ops.confidel.co`) with DNS verified.
- [ ] **Smoke test completed** post-deploy (`DEPLOY.md` §8).
- [ ] `GET /api/health` returns `status: ok` and `supabaseConfigured: true` in production.
- [ ] **Rollback plan documented** and understood (Vercel promote-previous; DB fix-forward/PITR).
- [ ] **Monitoring confirmed** — with a DSN set, a forced error appears in Sentry; with no DSN, the app still works.

## Operations
- [ ] **Monthly Records reviewed** (owner Records tab) — totals look right.
- [ ] **Tax CSV export verified** — columns present and values correct for filing.
- [ ] **Payroll / reimbursement records verified** — per-employee stats (Team tab) reconcile with completions.
- [ ] **Support contact / process documented** — who handles issues, how users report them, and the backup operator for Supabase.

---
**Sign-off:** date ______ · owner ______ · all boxes checked: yes / no
