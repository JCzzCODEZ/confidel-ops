-- ============================================================================
-- Fix: my_jobs() anonymous-read leak + per-role isolation
-- Date: 2026-06-23
-- Found by: scripts/api-integration.mjs — "RLS: anon cannot read jobs via
--           my_jobs RPC" failed with "anon my_jobs() exposed 3 rows".
--
-- Apply in the Supabase SQL Editor (this file is the versioned record of the
-- change; it is not run automatically from the repo).
--
-- SECURITY MODEL
-- -------------------------------------------------------------------------
-- * public.my_jobs() is the ONLY entry point app roles may call. It is
--   SECURITY DEFINER so it executes as the function owner. That is what lets a
--   logged-in `authenticated` user reach private.my_jobs_impl() even though the
--   `authenticated` role has NO execute privilege on it — the privilege check
--   for the inner call is against the owner, not the caller. With a plain
--   SECURITY INVOKER wrapper the call would run as the caller and fail, because
--   the implementation is deliberately locked away in the `private` schema.
--
-- * private.my_jobs_impl() is also SECURITY DEFINER so it can read public.jobs
--   on behalf of an employee who has no direct table access, while its WHERE
--   clause does the real row filtering. It is revoked from public/anon/
--   authenticated so it is NOT directly executable by any app role — it can
--   only be reached through the public wrapper.
--
-- * Anonymous callers get ZERO rows: the wrapper returns early when
--   auth.uid() is null, and (defense in depth) the implementation raises
--   'authentication required' if it is ever reached without a user.
--
-- * Employees see ONLY jobs assigned to them (a non-cancelled job_assignment
--   for auth.uid()). Owners/admins see ALL jobs for their active company
--   membership. This is enforced in the WHERE clause of my_jobs_impl().
--
-- * Pinned search_path on both functions prevents search_path hijacking, which
--   matters specifically because they are SECURITY DEFINER.
-- ============================================================================

create schema if not exists private;

-- ----------------------------------------------------------------------------
-- Implementation (privileged, hidden from app roles).
-- ----------------------------------------------------------------------------
create or replace function private.my_jobs_impl()
returns table (
  id uuid,
  company_id uuid,
  client_id uuid,
  client_name text,
  title text,
  description text,
  status job_status,
  scheduled_for timestamptz,
  assigned_at timestamptz,
  assignment_status text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Hard auth guard (defense in depth; the wrapper also guards before calling).
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return query
    select
      j.id,
      j.company_id,
      j.client_id,
      c.name        as client_name,
      j.title,
      j.description,
      j.status,
      j.scheduled_for,
      ja.assigned_at,
      ja.status     as assignment_status
    from public.jobs j
    join public.clients c
      on c.id = j.client_id
    -- membership scopes the caller to a company they actually belong to
    join public.company_memberships m
      on m.company_id = j.company_id
    -- assignment is only matched to the CALLER, so employees can't see others'
    left join public.job_assignments ja
      on ja.job_id = j.id
     and ja.employee_user_id = auth.uid()
     and ja.status <> 'cancelled'
    where m.user_id = auth.uid()
      and m.is_active
      and (
        -- owners/admins see every job in their company
        m.role in ('owner', 'admin')
        -- employees see only jobs assigned to them
        or (m.role = 'employee' and ja.id is not null)
      )
    order by j.scheduled_for nulls last, j.created_at desc;
end;
$$;

-- ----------------------------------------------------------------------------
-- Public wrapper (the only function app roles may call).
-- ----------------------------------------------------------------------------
create or replace function public.my_jobs()
returns table (
  id uuid,
  company_id uuid,
  client_id uuid,
  client_name text,
  title text,
  description text,
  status job_status,
  scheduled_for timestamptz,
  assigned_at timestamptz,
  assignment_status text
)
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
begin
  -- Anonymous / unauthenticated callers get zero rows, always — they never
  -- reach the implementation.
  if auth.uid() is null then
    return;
  end if;

  return query select * from private.my_jobs_impl();
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: lock the implementation away; expose only the wrapper to logged-in users.
-- ----------------------------------------------------------------------------
revoke all on function public.my_jobs() from public;
revoke all on function public.my_jobs() from anon;
grant  execute on function public.my_jobs() to authenticated;

revoke all on function private.my_jobs_impl() from public;
revoke all on function private.my_jobs_impl() from anon;
revoke all on function private.my_jobs_impl() from authenticated;

-- Ask PostgREST to reload its schema cache so the changes take effect immediately.
notify pgrst, 'reload schema';

-- ============================================================================
-- Verify after applying:
--   anon my_jobs()      -> error or 0 rows
--   employee my_jobs()  -> only jobs assigned to them
--   owner/admin my_jobs() -> all jobs for their active company
-- Regression covered by: scripts/api-integration.mjs (npm run test:api)
-- ============================================================================
