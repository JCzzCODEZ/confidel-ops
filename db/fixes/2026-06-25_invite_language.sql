-- ============================================================================
-- Bilingual invitations — add the invitation language to company_invites.
-- Idempotent. Apply in the Supabase SQL Editor. Does NOT change RLS, expiry,
-- token, single-use, or acceptance logic. Language is non-authoritative
-- (email/UI presentation only) — role still comes from company_invites.
-- ============================================================================

alter table public.company_invites
  add column if not exists preferred_language text not null default 'en';

-- Backfill any rows created before the column existed.
update public.company_invites set preferred_language = 'en' where preferred_language is null;

-- Add the constraint only once (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_invites_preferred_language_check'
  ) then
    alter table public.company_invites
      add constraint company_invites_preferred_language_check
      check (preferred_language in ('en', 'es'));
  end if;
end $$;

notify pgrst, 'reload schema';

-- VERIFY: \d public.company_invites -> preferred_language text not null default 'en'
--         with a check (preferred_language in ('en','es')).
