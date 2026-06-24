# Confidel Ops

A private operations app for a cleaning/services business. An **owner/admin** console manages clients,
jobs, assignments, completion review, invoices, and payments; a **field employee** view shows only the
jobs assigned to that person and lets them submit completions. Built with Next.js (App Router) and
Supabase (Auth + Postgres with Row-Level Security).

## Architecture at a glance

- **Frontend:** Next.js client components under `app/` (`/` login, `/owner`, `/employee`); shared logic in `lib/`.
- **API:** Next.js route handlers under `app/api/*`. Every handler runs **as the logged-in user** using their Supabase JWT — there is **no service-role key** in the app, so Postgres RLS is the single, un-bypassable enforcement layer.
- **Data boundary:** employees never read the `jobs` table directly. They go through the `my_jobs()` RPC (safe fields only) and `submit_job_completion()`. Owner-only fields (pricing, payroll, admin notes, tax id, invoice ids) never leave the database for an employee.
- **Roles:** `owner`, `admin`, `employee` via the `company_memberships` table. `owner`/`admin` route to `/owner`; `employee` routes to `/employee`.

## Run locally

Requires Node 18+ and npm.

```bash
cd /Users/jc/Documents/Confidel
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

## Required environment variables

Set these in `.env.local` (both are Supabase **public** values — safe for the browser):

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key |

There is intentionally **no** service-role/secret key — the app authenticates as the end user and relies
on RLS. Don't add a service-role key to the client.

## Test commands

```bash
npm run typecheck   # tsc --noEmit (type safety)
npm run build       # next build (production build)
npm run dev         # local dev server on :3000
```

There is no automated test suite yet; verification is manual (see `DEMO_GUIDE.md` section 6, and
`VERIFY_AUTH_FIX.md` for the auth-loading regression checks).

## Demo flow

Full script in `DEMO_GUIDE.md`. Short version:

1. Logged out: `/` shows the login screen; `/owner` and `/employee` redirect to `/` (no infinite spinner).
2. Owner logs in → `/owner`: create a client, create a priced job, assign it to an employee, review/approve completions, create invoices, record payments.
3. Employee logs in (separate window) → `/employee`: sees only assigned jobs, submits a completion.
4. Data boundary: in the employee's DevTools, the `/api/employee/jobs` JSON contains no pricing/payroll/profit/`tax_id`/`admin_notes`/`invoice_id` and no other employees' jobs.
5. Role guards: employee visiting `/owner` → `/employee`; owner visiting `/employee` → `/owner`.

Use clearly-labeled demo accounts in a throwaway demo company (see `DEMO_GUIDE.md` section 2). Never point a demo at real client data.

## Known limitations (not production yet)

- **Alarm codes stored in plaintext** (`clients.alarm_code`) — must move to Supabase Vault before real data.
- **No real file storage** — completion "photos" are just text URLs typed into a form; no upload, validation, or signed storage yet.
- **Audit trail not surfaced** — `job_status_history` and `activity_feed` are recorded but not shown in any UI.
- **Settings not enforced server-side** — `require_photos` / `require_signatures` exist but aren't checked in `submit_job_completion`.
- **No automated payment/invoice reconciliation** — recording a payment doesn't auto-update invoice status; it's owner-driven.
- **Manual onboarding** — users and memberships are created by hand in Supabase; no invite flow.
- **No automated tests**, and the production `build` plus browser flows should be verified on a real machine (the logged-out redirect and employee-leak checks are the must-pass bar).
- **Backups/recovery** not yet configured or rehearsed.

See `confidel-sql-review.md` for the backend security review (including the anon-`EXECUTE` decision on RLS
helper functions to make before any public exposure).
