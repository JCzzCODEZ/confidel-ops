# Verify the auth-loading fix (local, persistent dev server)

Run this in the local environment (Codex / Claude Code on the machine that has the repo).

**Guardrails**
- Do not change the database.
- Do not change migrations.
- Do not change API routes unless a browser test proves an API bug.

**Goal:** Confirm the auth-loading fix in the browser and prove the private owner/employee demo is unblocked.

## Step 1 — Final checks
```bash
cd /Users/jc/Documents/Confidel
npm run typecheck
npm run build   # let it finish; do not stop early unless it errors
```

## Step 2 — Start dev server (keep running)
```bash
npm run dev     # serves http://localhost:3000
```

## Step 3 — Browser tests

**Logged out**
- `/` → login screen, `data-testid="login-screen"`
- `/owner` → redirects to `/`, no infinite loading
- `/employee` → redirects to `/`, no infinite loading

**Owner**
- Log in as owner → `/owner` renders `data-testid="owner-dashboard"`
- Owner can reach client / job / dashboard screens
- Visit `/employee` as owner → redirects back to `/owner`

**Employee**
- Log in as employee → `/employee` renders `data-testid="employee-dashboard"`
- Only assigned jobs appear
- Visit `/owner` as employee → redirects back to `/employee`

**Security leak check** — employee UI **and** the `/api/employee/jobs` network response must NOT contain: pricing, payroll, profit, `tax_id`, `admin_notes`, `invoice_id`, or other employees' jobs. (Inspect the actual JSON in DevTools → Network, not just the rendered page.)

**Timeout check** — break/block `/api/session/profile` (e.g., DevTools request-block, or throw in the route temporarily):
- loading clears after 8 seconds
- `data-testid="auth-error"` appears
- no infinite spinner

**Mobile check** — iPhone width (~390px): login, owner dashboard, employee dashboard all usable; no overlapping forms/buttons/cards.

## Step 4 — Fix loop
If a test fails: show the exact error, fix the smallest correct thing, rerun that test, continue until clean.

## Final report
- Build pass/fail
- Browser tests pass/fail
- Screens tested
- Bugs fixed
- Remaining blockers
- Clear statement: is the private owner/employee demo unblocked?

---
### Context for whoever runs this
The fix is already applied in three files (`components/auth/login-landing.tsx`, `components/owner/owner-dashboard.tsx`, `components/employee/employee-dashboard.tsx`). Root cause: session retrieval ran outside `try`, and no-session/error paths never cleared `loading` (no `finally`, no timeout) — so a hung/rejected `getSession()` left the page spinning. The fix wraps it in `try/catch/finally`, always clears loading, adds an 8s timeout (cleared on success/unmount), and keeps role routing split: full redirect only on `/`; `/owner` and `/employee` are guard-only. `tsc` already passes clean. **The one bug that must be confirmed gone: logged-out `/owner` and `/employee` no longer get stuck — they redirect to `/`.**
