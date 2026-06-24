-- ============================================================================
-- Employee onboarding / account management
-- Date: 2026-06-23
--
-- No service-role key anywhere. Flow:
--   1. Owner/admin creates a pending invite (company_invites).
--   2. Employee signs themselves up (anon signUp) with the invited email.
--   3. On login, accept_my_invite() matches their auth email to the pending
--      invite and creates an ACTIVE company_memberships row. No admin API needed.
--   4. Owner can deactivate/reactivate and change role via set_company_membership().
--
-- Authorization is always from company_memberships (never user_metadata).
-- Apply in the Supabase SQL Editor. Requires is_company_admin() from the
-- pricing migration (re-asserted below so this file is self-contained).
-- ============================================================================

create or replace function public.is_company_admin(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.is_active
      and m.role in ('owner','admin')
  );
$$;
revoke all on function public.is_company_admin(uuid) from public, anon;
grant execute on function public.is_company_admin(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 1. Invites
-- ----------------------------------------------------------------------------
create table if not exists public.company_invites (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  email            text not null,
  full_name        text,
  role             text not null default 'employee' check (role in ('employee','admin')),
  token            text not null default encode(gen_random_bytes(16), 'hex'),
  status           text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by       uuid,
  created_at       timestamptz not null default now(),
  accepted_at      timestamptz,
  accepted_user_id uuid
);
create index if not exists company_invites_company_idx on public.company_invites(company_id);
create index if not exists company_invites_email_idx on public.company_invites(lower(email));

alter table public.company_invites enable row level security;
grant select, insert, update, delete on public.company_invites to authenticated;

-- owner/admin of the company manage invites
drop policy if exists company_invites_admin on public.company_invites;
create policy company_invites_admin on public.company_invites
  for all to authenticated
  using (public.is_company_admin(company_id))
  with check (public.is_company_admin(company_id));

-- the invited user may READ their own pending invite (by auth email)
drop policy if exists company_invites_invitee_read on public.company_invites;
create policy company_invites_invitee_read on public.company_invites
  for select to authenticated
  using (status = 'pending' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ----------------------------------------------------------------------------
-- 2. accept_my_invite() — employee activates their own membership from a
--    pending invite that matches their auth email. SECURITY DEFINER.
-- ----------------------------------------------------------------------------
create or replace function public.accept_my_invite()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_inv   public.company_invites;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    return jsonb_build_object('accepted', false);
  end if;

  select * into v_inv
    from public.company_invites
   where lower(email) = v_email and status = 'pending'
   order by created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('accepted', false);
  end if;

  if exists (
    select 1 from public.company_memberships
    where company_id = v_inv.company_id and user_id = auth.uid()
  ) then
    update public.company_memberships
       set is_active = true,
           role = v_inv.role::public.company_role,
           full_name = coalesce(v_inv.full_name, full_name),
           email = v_inv.email
     where company_id = v_inv.company_id and user_id = auth.uid();
  else
    insert into public.company_memberships (company_id, user_id, role, full_name, email, is_active)
    values (v_inv.company_id, auth.uid(), v_inv.role::public.company_role, v_inv.full_name, v_inv.email, true);
  end if;

  update public.company_invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
   where id = v_inv.id;

  return jsonb_build_object('accepted', true, 'company_id', v_inv.company_id, 'role', v_inv.role);
end;
$$;
revoke all on function public.accept_my_invite() from public, anon;
grant execute on function public.accept_my_invite() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. set_company_membership() — owner/admin changes role / active status.
-- ----------------------------------------------------------------------------
create or replace function public.set_company_membership(
  p_company_id uuid,
  p_user_id    uuid,
  p_role       text,
  p_is_active  boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_company_admin(p_company_id) then
    raise exception 'owner or admin access required' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('employee','admin','owner') then
    raise exception 'invalid role';
  end if;

  update public.company_memberships
     set role = coalesce(p_role::public.company_role, role),
         is_active = coalesce(p_is_active, is_active)
   where company_id = p_company_id and user_id = p_user_id;
end;
$$;
revoke all on function public.set_company_membership(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.set_company_membership(uuid, uuid, text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. team_member_stats() — owner/admin per-employee rollups (owner-only data).
-- ----------------------------------------------------------------------------
create or replace function public.team_member_stats(p_company_id uuid)
returns table (
  user_id            uuid,
  assigned_jobs      bigint,
  completed_jobs     bigint,
  hours              numeric,
  reimbursement_cents bigint,
  payroll_cents      bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_company_admin(p_company_id) then
    raise exception 'owner or admin access required' using errcode = '42501';
  end if;

  return query
  select
    m.user_id,
    (select count(*) from public.job_assignments ja
       join public.jobs j on j.id = ja.job_id
      where ja.employee_user_id = m.user_id and j.company_id = p_company_id and ja.status <> 'cancelled')::bigint,
    (select count(*) from public.job_completions c
      where c.employee_user_id = m.user_id and c.company_id = p_company_id)::bigint,
    coalesce((select sum(c.hours) from public.job_completions c
      where c.employee_user_id = m.user_id and c.company_id = p_company_id), 0)::numeric,
    coalesce((select sum(s.reimbursement_cents) from public.job_financial_summaries s
       join public.job_completions c on c.id = s.completion_id
      where c.employee_user_id = m.user_id and s.company_id = p_company_id), 0)::bigint,
    coalesce((select sum(s.employee_pay_cents) from public.job_financial_summaries s
       join public.job_completions c on c.id = s.completion_id
      where c.employee_user_id = m.user_id and s.company_id = p_company_id), 0)::bigint
  from public.company_memberships m
  where m.company_id = p_company_id;
end;
$$;
revoke all on function public.team_member_stats(uuid) from public, anon;
grant execute on function public.team_member_stats(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY after applying:
--   * owner: insert into company_invites (via /api/team/invite) -> pending row.
--   * employee signs up with that email, logs in, accept_my_invite() -> active membership.
--   * owner: set_company_membership(company, user, null, false) -> employee blocked.
--   * employee: select * from company_invites -> only their own pending invite.
--   * employee: team_member_stats/ set_company_membership -> 'owner or admin access required'.
-- Regression covered by: scripts/onboarding-test.mjs (ONBOARDING_TESTS=1)
-- ============================================================================
