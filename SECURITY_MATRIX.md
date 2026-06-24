# Confidel Ops — Security Matrix (Phase B)

The access-control model: who can reach what, across HTTP routes, database tables (RLS), and RPCs.

**Roles:** `owner` and `admin` (treated the same — full company access), `employee` (assigned work
only), `anon` (unauthenticated). Tenancy is by `company_id` via `company_memberships`.

**Two enforcement layers:**
1. **Route layer** — `requireUser` (must be logged in) and `requireCompanyAdmin` (must be active
   owner/admin of the target company), in `app/api/_shared.ts`.
2. **Database layer** — RLS policies + `SECURITY DEFINER` RPCs. The app uses **no service-role key**, so
   every call runs as the logged-in user and RLS is the floor under everything.

> Rows below marked **(confirm)** are the intended/observed model derived from app code and the SQL in
> `db/fixes/`. Confirm them against the live database with the inspection queries in §5 — this repo can't
> read the live policies directly. Where the route layer is only `requireUser`, authorization is enforced
> **inside** the `SECURITY DEFINER` RPC; the Phase 1.4 suite already proves employees are blocked on those.

## 1. HTTP routes

| Route | Method | Route guard | Who can succeed | Notes |
|---|---|---|---|---|
| `/api/session/profile` | GET | `requireUser` | any logged-in user | returns only the caller's own memberships + branding |
| `/api/company/branding` | GET | `requireUser` → `company_branding()` | any member | safe fields only (id, name, logo_url) |
| `/api/clients` | GET | `requireCompanyAdmin` | owner/admin | column allowlist; **no** alarm/tax/admin fields |
| `/api/clients` | POST | `requireUser` → `create_client()` | owner/admin (RPC) | RPC enforces role |
| `/api/clients/[id]/alarm-code` | PUT | `requireUser` → `set_alarm_code()` | owner/admin (RPC) | encrypts at rest |
| `/api/clients/[id]/reveal-alarm-code` | POST | `requireUser` → `reveal_alarm_code()` | owner/admin (RPC) | decrypts + audits |
| `/api/jobs` | GET | `requireCompanyAdmin` | owner/admin | column allowlist; no pricing/admin |
| `/api/jobs` | POST | `requireUser` → `create_job()` | owner/admin (RPC) | RPC enforces role |
| `/api/jobs/assign` | POST | `requireUser` → `assign_job()` | owner/admin (RPC) | RPC enforces role |
| `/api/jobs/complete` | POST | `requireUser` → `submit_job_completion()` | employee on **own** assigned job | RPC enforces assignment |
| `/api/jobs/[id]/review` | POST | `requireUser` → `approve_/reject_job_completion()` | owner/admin (RPC) | RPC enforces role |
| `/api/employee/jobs` | GET | `requireUser` → `my_jobs()` | employee (own) / owner-admin (company) | safe fields only |
| `/api/completions` | GET | `requireCompanyAdmin` | owner/admin | review queue |
| `/api/employees` | GET | `requireCompanyAdmin` | owner/admin | membership list |
| `/api/invoices` | GET / POST | `requireCompanyAdmin` / `create_invoice()` | owner/admin | |
| `/api/payments` | POST | `requireUser` → `mark_payment()` | owner/admin (RPC) | RPC enforces role |

Anon → **401** on all of the above (no session). Employee → **4xx** on every owner/admin route (verified
by the Phase 1.4 suite's "employee requests to owner-only routes fail" + "anon requests fail").

## 2. Tables (RLS) — (confirm via §5)

| Table | owner/admin | employee | anon | How enforced |
|---|---|---|---|---|
| `companies` | read (own company) | **no direct**; branding via RPC | none | RLS owner-only read; `company_branding()` for members |
| `settings` | read/write (own) | none | none | owner-only (currently unused by API) |
| `company_memberships` | read/write (own company) | read **own** membership | none | RLS; session/profile reads caller's rows |
| `clients` | full (own company) | **none** (direct SELECT = 0) | none | RLS company+role; API allowlist hides sensitive cols |
| `jobs` | full (own company) | **none direct**; via `my_jobs()` only | none | direct SELECT = 0 (Phase 1.4 test) |
| `job_assignments` | manage (own company) | read own via `my_jobs()` join | none | (confirm direct employee access = none) |
| `job_completions` | read (own company) | write via `submit_job_completion()`; read own (confirm) | none | review route is owner/admin |
| `invoices` | full (own company) | none | none | owner/admin only |
| `payments` | full (own company) | none | none | owner/admin only |
| `alarm_code_audit` | **read** (own company, via clients join) | none | none | `grant select` to authenticated + owner/admin policy; writes only by reveal RPC |

## 3. RPCs

| RPC | Executor (granted) | Returns | SECURITY DEFINER | Authorization inside |
|---|---|---|---|---|
| `my_jobs()` | authenticated | safe job fields | **yes** (wrapper) | null uid → 0 rows; delegates to `private.my_jobs_impl()` |
| `private.my_jobs_impl()` | **owner only** (not app roles) | safe job fields | **yes** | employee = assigned only; owner/admin = company; raises if no uid |
| `company_branding()` | authenticated | id, name, logo_url | yes | scoped to caller's company |
| `create_client()` | authenticated | client (safe fields) | yes (confirm) | owner/admin (confirm) |
| `create_job()` | authenticated | job | yes (confirm) | owner/admin (confirm) |
| `assign_job()` | authenticated | assignment | yes (confirm) | owner/admin (confirm) |
| `submit_job_completion()` | authenticated | completion | yes (confirm) | employee, own assigned job |
| `approve_job_completion()` / `reject_job_completion()` | authenticated | completion | yes (confirm) | owner/admin (confirm) |
| `create_invoice()` / `mark_payment()` | authenticated | invoice / payment | yes (confirm) | owner/admin (confirm) |
| `set_alarm_code()` | authenticated | void | **yes** | owner/admin of client's company, else raises |
| `reveal_alarm_code()` | authenticated | text (code) | **yes** | owner/admin, else raises; audits every call |
| `private.alarm_code_key()` | **none** (revoked from all app roles) | text (key) | **yes** | reachable only by the encrypt/decrypt functions (owner) |

**Helper-function grant note (Phase 1.2 decision):** if older RLS-helper functions
(`current_company_id`, `is_owner`, etc.) exist and are referenced inside policies, keep them executable
by `authenticated` (and, if any reachable table grants exist for `anon`, leave the helpers executable by
`anon` too so anon queries return *empty* rather than erroring with "permission denied for function").
Confirm with §5; revoke only the **data** RPCs from anon, never the policy helpers, unless anon has no
table grants at all.

## 4. Automated test coverage

| Guarantee | Covered by |
|---|---|
| anon → 401 on routes; anon `my_jobs()` denied/empty | `api-integration.mjs` (Phase 1.4) |
| employee → 4xx on every owner/admin route | `api-integration.mjs` |
| employee direct SELECT `jobs`/`companies` = 0 | `api-integration.mjs` (RLS proofs) |
| employee sees only assigned jobs (not others') | `api-integration.mjs` |
| owner-only fields never leak to employee | `api-integration.mjs` (`ensureNoForbiddenKeys`) |
| alarm code: owner reveal/set, employee+anon denied, audited, no-leak | `api-integration.mjs` (`ALARM_CODE_TESTS=1`) |
| **cross-company isolation** | **`rls-matrix-test.mjs` (new, `RLS_MATRIX_TESTS=1`)** |
| **inactive employee blocked** | **`rls-matrix-test.mjs` (new)** |
| logged-out route guards / role routing | `tests/e2e/auth-guards.spec.ts` |

## 5. Inspection queries (run in Supabase to confirm the (confirm) rows)

```sql
-- RLS policies per table
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' order by tablename, policyname;

-- table-level grants (who has SELECT/INSERT/...)
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
order by table_name, grantee;

-- functions: security mode + signature
select n.nspname, p.proname, p.prosecdef as security_definer,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','private') order by n.nspname, p.proname;

-- function EXECUTE grants
select routine_schema, routine_name, grantee, privilege_type
from information_schema.role_routine_grants
where routine_schema in ('public','private') and grantee in ('anon','authenticated')
order by routine_name, grantee;
```

## 6. Open items to confirm / harden (Phase 1.2)

- Confirm the **(confirm)** rows above against §5 output; update this doc with the real policy text.
- Confirm `create_job` / `assign_job` / `approve_/reject_job_completion` / `create_invoice` / `mark_payment`
  each enforce owner/admin internally (route layer is only `requireUser`). The Phase 1.4 employee-denial
  tests imply they do — make it explicit in the matrix once read from the DB.
- Decide the anon-`EXECUTE`-on-policy-helpers question (above) deliberately.
- Confirm employees have no direct read on `job_assignments` / `job_completions` (only via RPC).
