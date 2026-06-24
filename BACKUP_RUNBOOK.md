# Confidel Ops — Backup & Recovery Runbook (Phase A)

Owner of this runbook: **JC** (primary). Backup of contact: _add a second person before go-live._

This covers how Confidel Ops data is backed up, how to restore it, and what to do in an incident.
The whole system is one Supabase Postgres project (Auth + data), so "backup" means the Supabase
project's database backups. There is no separate app-state to back up — the Next.js app is stateless.

> Scope note: this is operational documentation. It requires no app-code changes. The only actions are
> in the Supabase dashboard; do them on the **production** project, and rehearse restores on a **scratch**
> project — never restore over production.

## 1. What must be recoverable

| Data | Where | Sensitivity |
|---|---|---|
| Companies, memberships, clients, jobs, assignments, completions, invoices, payments | Postgres (public schema) | High — business records |
| Alarm codes (encrypted) + the Vault key | `clients.alarm_code_cipher` + Supabase Vault | Critical — encrypted; **the Vault key must survive too or codes are unrecoverable** |
| Auth users / sessions | Supabase Auth (`auth` schema) | High — login identities |
| Audit rows | `alarm_code_audit` (+ any activity tables) | Medium — compliance trail |

**Critical coupling:** alarm codes are encrypted with a key stored in **Supabase Vault**. A database
backup includes the encrypted column; confirm your plan also preserves the Vault key (it is part of the
project). If you ever migrate to a *new* project, the Vault secret must be re-created/migrated or every
stored alarm code becomes undecryptable. Treat the Vault key as part of the backup surface.

## 2. Backup configuration (set once, verify monthly)

In the Supabase dashboard → **Database → Backups**:

1. **Daily backups** — confirm automated daily backups are enabled (available on Pro and above).
2. **Point-in-Time Recovery (PITR)** — enable if on a plan that supports it. PITR lets you restore to a
   specific second (much smaller RPO than daily). Strongly recommended before real client data.
3. Record the **retention window** your plan provides (e.g. 7 days daily, or the PITR window) here:
   - Daily backup retention: ______ days
   - PITR window: ______ (if enabled)
4. Note that backups are managed by Supabase; you do not store dumps yourself. Optionally, for extra
   safety, take a periodic manual logical dump (see §6) and store it somewhere access-controlled.

## 3. RPO / RTO targets

| Metric | Target (set before go-live) | Notes |
|---|---|---|
| **RPO** (max acceptable data loss) | ≤ 24h with daily backups; ≤ 5 min with PITR | PITR strongly preferred once there's real data |
| **RTO** (max acceptable downtime to restore) | ≤ 2h | Dominated by Supabase restore time + DNS/app re-point |

Revisit these once you have paying clients; tighten if needed.

## 4. Who restores

- **Primary:** JC — has Supabase project owner access.
- **Backup operator:** _add a second trusted person with Supabase access before go-live (single point of
  failure today)._
- No one should restore over production without a second person's confirmation (see §5 step 1).

## 5. Restore procedure (rehearse on a scratch project first)

**Always restore to a scratch project first to validate, before touching production.**

1. **Declare the incident.** Note time, what's wrong, and the target recovery point. Get a second
   person's acknowledgement before any production-affecting action.
2. **Create / pick a scratch Supabase project** (or use Supabase's "restore to new project" if offered).
3. **Restore the chosen backup / PITR timestamp** into the scratch project (Dashboard → Database →
   Backups → Restore).
4. **Run post-restore validation** (§7) against the scratch project. Only proceed if it passes.
5. **Cut over:**
   - If restoring data into the *existing* production project: follow Supabase's restore flow for that
     project (this is the higher-risk path — confirm with the second operator).
   - If promoting the scratch project: update the app's env vars (`NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) to the new project, update Supabase Auth redirect URLs, and
     redeploy. Update DNS only after validation.
6. **Re-verify** with the post-restore checklist (§7) against the now-live target.
7. **Close the incident:** record what happened, the recovery point used, actual RPO/RTO achieved, and any
   follow-ups.

## 6. Optional manual logical backup (extra belt-and-suspenders)

For an independent copy you control (store access-controlled, it contains sensitive data):

```bash
# Connection string from Supabase: Project Settings -> Database -> Connection string (URI)
pg_dump "postgresql://...:...@...supabase.co:5432/postgres" \
  --no-owner --no-privileges -Fc -f confidel_$(date +%Y%m%d).dump
```

Note: a logical dump captures the encrypted `alarm_code_cipher` bytes but **not** the Vault key — keep the
Vault key recorded separately and securely, or restored alarm codes won't decrypt.

## 7. Post-restore validation checklist

Run against the restored target before trusting it:

- [ ] Row counts look sane for `companies`, `company_memberships`, `clients`, `jobs`, `invoices`, `payments`.
- [ ] A known owner can log in and reach `/owner`; a known employee reaches `/employee`.
- [ ] `select public.reveal_alarm_code('<known client id>')` as owner returns the **correct** code
      (proves the Vault key + cipher survived together). If it errors/garbles, the key didn't come across.
- [ ] Employee `my_jobs()` returns only their assigned jobs; anon gets none.
- [ ] Run the security regression suites against the restored project:
      `npm run test:e2e`, `npm run test:api`, `ALARM_CODE_TESTS=1 npm run test:api` — all green.
- [ ] Auth: password reset / login flows work.

## 8. Emergency quick steps (cut-out-and-keep)

1. Stop writes if data is being corrupted (pause the app / take it to maintenance).
2. Identify the last-good recovery point (timestamp before the bad event).
3. Restore to a **scratch** project at that point. Validate (§7).
4. Get second-operator confirmation. Cut over (§5.5). Re-validate.
5. Record RPO/RTO actually achieved; file follow-ups.

---
**Pre-go-live gaps to close:** enable PITR, add a second backup operator, fill in the retention/RPO/RTO
blanks above, and **rehearse one full restore to a scratch project** so this runbook is proven, not
theoretical.
