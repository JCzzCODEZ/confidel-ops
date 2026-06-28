# Confidel Ops — Employee Invitation Emails

How automatic employee invitations work, and the exact Supabase + Vercel setup
to make the emails actually send in production.

## How it works

1. Owner/admin opens **Team → Invite**, enters an email + role.
2. The server route (`/api/team/invite`) authenticates the requester, requires
   active owner/admin membership in the target company, then:
   - creates/refreshes a **pending** `company_invites` row (7-day expiry), and
   - sends a **Supabase Auth "Invite user" email** via a server-only admin
     client (`SUPABASE_SERVICE_ROLE_KEY`), with `redirectTo` →
     `${APP_URL}/accept-invite?invite=<token>`.
3. The employee clicks **Accept invitation** in the email → lands on
   `/accept-invite` (already authenticated via the link).
4. New users set a password; existing users can continue with theirs.
5. `accept_my_invite()` (SECURITY DEFINER) matches their **auth email** to the
   pending, non-expired invite, **atomically claims it** (single-use, race-safe),
   and creates/activates their `company_memberships` row with the invited role.
6. Redirect: employee → `/employee`, admin → `/owner`.

**Security:** the service-role key is server-only (never `NEXT_PUBLIC_`, never in
a client component, never logged). Authorization always comes from
`company_memberships`, never `user_metadata`. Invites expire, are single-use, and
support `revoked`. Accepting under a different email, or a revoked/expired/used
invite, fails. Employees never receive pricing/payroll/profit/tax/invoice data.

> **No service-role key?** Invites still work — the Team UI shows a **Copy invite
> link** the owner can share manually. The UI never claims an email was sent
> unless Supabase confirmed it. For an existing account, Supabase can't auto-send
> via admin, so the UI surfaces a magic sign-in link to share.

## Required environment variables (Vercel → Production)

| Variable | Public? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | anon key (normal user requests) |
| `SUPABASE_SERVICE_ROLE_KEY` | **NO — server only** | sends invite emails (Supabase → Project Settings → API → service_role key) |
| `APP_URL` | server | `https://confidel-ops.vercel.app` — acceptance link base |

Set `SUPABASE_SERVICE_ROLE_KEY` and `APP_URL` for **Production** (and Preview if
you test there). Do **not** add the service-role key anywhere with a `NEXT_PUBLIC_`
prefix.

## Supabase configuration

### 1) Auth → URL Configuration
- **Site URL:** `https://confidel-ops.vercel.app`
- **Redirect URLs (add all):**
  - `https://confidel-ops.vercel.app/**`
  - `http://localhost:3000/**`
  - your Vercel preview pattern, e.g. `https://*.vercel.app/**`

The `/accept-invite` URL must match an allowlisted redirect or Supabase will
reject the link.

### 2) Auth → Emails → SMTP (use a verified provider — required for production)
Supabase's built-in email is rate-limited and **not** production-ready. Configure
custom SMTP, e.g. **Resend**:

1. Create a Resend account; **verify your sending domain** (add the DKIM/SPF DNS
   records Resend gives you). Use a domain you control, e.g. `confidel.co`.
2. Create a Resend **SMTP** credential (or API key for SMTP).
3. In Supabase → **Authentication → Emails → SMTP Settings**, enable custom SMTP:
   - Host: `smtp.resend.com`
   - Port: `465` (SSL) or `587` (STARTTLS)
   - Username: `resend`
   - Password: your Resend API key / SMTP password
   - Sender email: e.g. `team@confidel.co` (on the verified domain)
   - Sender name: `Confidel`
4. Save and send a test.

### 3) Auth → Emails → Templates → "Invite user"
Brand it as Confidel. Keep it minimal and **do not include company/job details**:
- Subject: `You're invited to Confidel`
- One clear button linking to `{{ .ConfirmationURL }}` labeled **Accept invitation**.
- Body: short Confidel intro. No pricing, payroll, or client data.

## Testing

Automated (`npm run test:onboarding`, with the dev server + a staging Supabase):
owner invites, employee can't invite, pending stored, duplicate handled safely,
resend + revoke work, reused acceptance fails, admin→/owner, employee→/employee,
employee blocked from owner routes, no financial fields in employee responses.
(The email itself isn't asserted — without a service key the invite row is still
created; `emailed` is reported truthfully.)

Manual inbox test (production, with SMTP configured): owner invites a real email →
email arrives → open link → set password → membership active → owner assigns a job
→ employee logs in → only the assigned job appears.

## Service-role safety check (CI)
Confirm the key never reaches the browser bundle:
```bash
npm run build
! grep -rl "SUPABASE_SERVICE_ROLE_KEY" .next/static 2>/dev/null && echo "OK: not in client bundle"
```
(The key is only read in `lib/supabase/admin.ts`, imported solely by server routes.)
