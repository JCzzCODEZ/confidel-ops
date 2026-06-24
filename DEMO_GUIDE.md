# Confidel Ops — Private Demo Guide

Everything you need to run a clean private demo of the owner/employee operations app.
This is a **demo** guide, not a production sign-off — see section 5 before any real data goes near it.

Guardrails this guide respects: no schema changes, no security weakening. All demo accounts use a
separate demo company and clearly-labeled test users, never real client data.

---

## 1. Live demo checklist (follow in order)

**Before the call (15 min ahead)**

- [ ] `git status` clean; on the branch you intend to show.
- [ ] `.env.local` present with the two required vars (see README).
- [ ] `npm run typecheck` → passes.
- [ ] `npm run build` → completes with no errors.
- [ ] `npm run dev` running; `http://localhost:3000` loads the login screen.
- [ ] Run the smoke test in section 6 once, end to end.
- [ ] Demo accounts exist and you can log into each (section 2).
- [ ] Browser zoom at 100%; close unrelated tabs; have a second browser profile or incognito window ready for the "logged out" tests.
- [ ] DevTools Network tab ready (for the employee leak check).

**During the demo**

- [ ] Start logged out on `/` — show the login screen.
- [ ] Show the guard: visit `/owner` and `/employee` while logged out → both bounce to `/`, no stuck spinner.
- [ ] Owner walkthrough (section 3).
- [ ] Employee walkthrough (section 4).
- [ ] Show the data boundary: same job, owner sees pricing, employee does not (section 4 leak check).
- [ ] Sign out cleanly at the end.

**If something breaks**

- [ ] Stay on the failing screen, open DevTools Console/Network, capture the exact error.
- [ ] Don't improvise schema or API changes mid-demo; note it and move on.

---

## 2. Demo test accounts and what each should show

Create these in **Supabase → Authentication → Users** (email + password), then give each an **active
membership** in a dedicated demo company (`company_memberships`: `user_id`, `company_id`, `role`,
`full_name`, `email`, `is_active = true`). Use a throwaway demo company id so nothing touches real data.

| Account | Role | Lands on | What it should show |
|---|---|---|---|
| `owner@confidel.demo` | `owner` | `/owner` | Full dashboard: Clients, Jobs, Assign, Review, Billing tabs; metrics; can create clients/jobs, assign work, review completions, create invoices, record payments. Sees pricing/payroll/admin fields. |
| `crew@confidel.demo` | `employee` | `/employee` | Only **their assigned** jobs (via the `my_jobs()` RPC). Can submit a completion (services, add-ons, notes, photo URLs). **No** pricing, payroll, profit, tax id, admin notes, or invoice ids anywhere. |

Optional, to make the security story land harder:

| Account | Role | Purpose in demo |
|---|---|---|
| `admin@confidel.demo` | `admin` | Proves `admin` is treated like `owner` (also routes to `/owner`). |
| `crew2@confidel.demo` | `employee` | Assign a job to `crew@` only — log in as `crew2@` and show that job does **not** appear. Proves per-employee isolation. |
| `inactive@confidel.demo` | `employee` (`is_active = false`) | Proves a deactivated member is blocked. |

Notes
- Two distinct browser windows/profiles (or one normal + one incognito) let you keep owner and employee logged in side by side.
- After the demo, deactivate or delete these users and the demo company. They are dev-only.

---

## 3. Owner walkthrough script (~3–4 min)

> "This is the owner's operations console. Everything pricing, billing, and assignment lives here."

1. **Log in** as `owner@confidel.demo` → lands on `/owner` (`data-testid="owner-dashboard"`).
2. **Metrics** — point to the Clients / Jobs / Open / Invoices counters at the top.
3. **Clients tab** — "I add a client here." Create one: name + a couple fields → it appears in the list.
4. **Jobs tab** — "I create the job and set the price and payroll. This stays in the owner workflow — the field crew never sees it." Create a job for the new client with a price.
5. **Assign tab** — assign that job to the employee (`crew@confidel.demo`'s user id).
6. **Review tab** — "When the crew submits a completion, I approve or reject it here." (You'll approve the one the employee submits in section 4.)
7. **Billing tab** — create an invoice for the client, then record a payment against it. "Invoice numbers are issued server-side, per company, no gaps."
8. Close with: "Owner sees the whole picture — money, assignments, approvals."

---

## 4. Employee walkthrough script (~2–3 min)

> "Now the same company from the field crew's phone. Notice what's *missing*."

1. **Log in** as `crew@confidel.demo` (separate window) → lands on `/employee` (`data-testid="employee-dashboard"`).
2. **Assigned jobs** — "They only see jobs assigned to them — nothing else from the company." Point out the assigned job from section 3.
3. **Job detail** — open the job. "Title, client, schedule, what to do. No price, no payroll, no admin notes."
4. **Submit completion** — fill Services completed (required), optionally add-ons/notes, and attach real before/after photos, a signature, or other files (they upload to private storage — no public links) → Submit. A completion id appears.
5. **Back to owner window** → Review tab → approve that completion. "Round trip done: assigned → completed → approved."
6. **Leak check (do this live):** with the employee logged in, open DevTools → Network → reload the dashboard → click the `employee/jobs` request → Response. Confirm the JSON contains **none** of: `price`, `payroll`, `profit`, `tax_id`, `admin_notes`, `invoice_id`, or other employees' jobs. "The server only returns safe fields — this isn't hidden in the UI, it never leaves the database."
7. **Role guard:** as the employee, type `/owner` in the URL → it redirects back to `/employee`. (And owner → `/employee` redirects to `/owner`.)

---

## 5. "Not production yet" checklist

Be upfront in the demo that this is a working private build, not production. Outstanding items:

**Encryption / secrets**
- [ ] `clients.alarm_code` is stored in plaintext (flagged `TODO` in the schema). Move to Supabase Vault before any real client data.
- [ ] Confirm all secrets are server-side only. (Good today: the app uses only the public anon key client-side and never a service-role key — RLS is the single enforcement point.)
- [ ] Rotate the demo Supabase keys before/after if the project will also hold real data.

**Backups / recovery**
- [ ] Enable Supabase automated backups (PITR if on a plan that supports it) and confirm a restore actually works.
- [ ] Document a recovery runbook (who, how, RPO/RTO).

**File storage**
- [ ] Photo "uploads" are currently just text URLs typed into the completion form — there is no real file storage or validation of where images live. Wire up Supabase Storage (or equivalent) with signed URLs before relying on photos as proof of work.

**Audit review**
- [ ] `job_status_history` and `activity_feed` are written but not yet surfaced in the UI. Add an owner-facing audit view before claiming auditability.
- [ ] Decide retention and who can read the audit trail.

**Real onboarding**
- [ ] Replace manual Supabase user creation with a real invite/onboarding flow (owner invites employee → email → set password → membership created).
- [ ] Define role assignment and deactivation flows for real staff.
- [ ] Per-company settings (`require_photos`, `require_signatures`) are not yet enforced server-side — enforce in `submit_job_completion` before they're promised to clients.

**Security follow-ups from the backend review**
- [ ] Decide the anon `EXECUTE` question on the RLS policy-helper functions (see `confidel-sql-review.md`) before exposing any public endpoint.
- [ ] Add automated tests (currently none) covering the logged-out redirects and the employee-leak boundary.

---

## 6. Final smoke test (run once right before the demo)

Do this end to end. If any step fails, fix the smallest thing and rerun from the top.

1. `npm run typecheck` → passes.
2. `npm run build` → no errors.
3. `npm run dev` → `http://localhost:3000` shows the login screen (`login-screen`).
4. **Logged out:** visit `/owner` → redirects to `/`, no infinite spinner. Repeat `/employee` → redirects to `/`.
5. **Owner:** log in as `owner@confidel.demo` → `/owner` renders (`owner-dashboard`). Create a client and a priced job; assign it to `crew@confidel.demo`.
6. **Employee:** log in as `crew@confidel.demo` (2nd window) → `/employee` renders (`employee-dashboard`); the assigned job is visible; submit a completion.
7. **Owner:** approve the completion in Review.
8. **Leak check:** employee `Network → employee/jobs → Response` contains no pricing/payroll/profit/`tax_id`/`admin_notes`/`invoice_id` and no other employees' jobs.
9. **Role guards:** employee → `/owner` bounces to `/employee`; owner → `/employee` bounces to `/owner`.
10. **Timeout:** in DevTools, block `/api/session/profile`, reload a dashboard → after ~8s the spinner clears and `auth-error` shows ("Session check timed out…"), no infinite spin.
11. **Mobile:** set viewport to ~390px (iPhone) → login, owner dashboard, employee dashboard all usable, no overlapping forms/buttons/cards.
12. Sign out; reset to the login screen so you start the demo clean.

Green on all 12 = ready to demo.
