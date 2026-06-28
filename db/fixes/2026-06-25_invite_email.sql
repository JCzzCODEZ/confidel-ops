-- ============================================================================
-- Invite emails — harden company_invites for expiring, single-use, revocable
-- invitations. Idempotent. Apply in the Supabase SQL Editor.
--
-- Acceptance security model:
--   * Gated by a real Supabase Auth session (the invite/magic link).
--   * accept_my_invite() matches the caller's AUTH email to a pending invite,
--     checks it is not expired, then claims it atomically (single-use,
--     race-safe) before creating/activating the membership — all in one
--     transaction, so a failure rolls the claim back.
--   * Accepting under a different email, or a revoked/expired/already-used
--     invite, returns accepted=false.
-- ============================================================================

alter table public.company_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '7 days');

-- Backfill any pre-existing rows that were created before this column existed.
update public.company_invites
   set expires_at = created_at + interval '7 days'
 where expires_at is null;

-- ----------------------------------------------------------------------------
-- accept_my_invite(p_token): token + email + pending + expiry + single-use, all
-- checked atomically. The token is REQUIRED — acceptance only works from the
-- invite link. Replaces the old no-arg version.
-- ----------------------------------------------------------------------------
drop function if exists public.accept_my_invite();

create or replace function public.accept_my_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text;
  v_inv     public.company_invites;
  v_claimed uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    return jsonb_build_object('accepted', false, 'reason', 'no_email');
  end if;

  -- newest pending, non-expired invite for this exact email (and token if given)
  select * into v_inv
    from public.company_invites
   where lower(email) = v_email
     and status = 'pending'
     and (expires_at is null or expires_at > now())
     and token = p_token
   order by created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'no_pending_invite');
  end if;

  -- Atomic single-use claim: the WHERE re-checks pending + expiry + token, so the
  -- flip to 'accepted' is the one and only authoritative gate.
  update public.company_invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
   where id = v_inv.id
     and status = 'pending'
     and (expires_at is null or expires_at > now())
     and token = p_token
   returning id into v_claimed;

  if v_claimed is null then
    return jsonb_build_object('accepted', false, 'reason', 'already_used');
  end if;

  -- Create or re-activate the membership (role from the invite, not metadata).
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

  return jsonb_build_object('accepted', true, 'company_id', v_inv.company_id, 'role', v_inv.role);
end;
$$;
revoke all on function public.accept_my_invite(text) from public, anon;
grant execute on function public.accept_my_invite(text) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY:
--   * \d public.company_invites  -> expires_at present.
--   * pending invite + matching auth email -> accept_my_invite() accepted=true.
--   * second call -> accepted=false (already_used).
--   * status='revoked' or expired -> accepted=false.
--   * different auth email -> accepted=false (no_pending_invite).
-- ============================================================================
