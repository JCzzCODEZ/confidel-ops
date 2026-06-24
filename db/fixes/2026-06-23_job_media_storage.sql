-- ============================================================================
-- Phase C — Supabase Storage for job-completion media (photos / signatures)
-- Date: 2026-06-23
--
-- Private bucket + metadata table + RLS, all RLS-pure (no service-role key).
-- Object bytes live in a PRIVATE bucket; the app stores object PATHS, never
-- public URLs, and serves bytes only via short-lived signed URLs gated by RLS.
--
-- Path convention (enforced by the storage policies below):
--   {company_id}/{job_id}/{completion_id}/{media_type}/{filename}
--   media_type in: before_photo | after_photo | signature | other
--
-- Apply in the Supabase SQL Editor. Versioned record; not auto-run.
--
-- BEFORE YOU RUN — assumes (confirm with SECURITY_MATRIX.md §5 queries):
--   public.jobs(id, company_id), public.job_completions(id),
--   public.job_assignments(job_id, employee_user_id, status),
--   public.company_memberships(user_id, company_id, role, is_active).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Private bucket (public = false -> no public URLs, no public listing).
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('job-media', 'job-media', false)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Metadata table — the authoritative record of what media exists.
-- ----------------------------------------------------------------------------
create table if not exists public.job_completion_media (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  job_id         uuid not null,
  completion_id  uuid not null,
  uploaded_by    uuid not null,
  media_type     text not null check (media_type in ('before_photo','after_photo','signature','other')),
  storage_bucket text not null default 'job-media',
  storage_path   text not null,
  mime_type      text,
  size_bytes     bigint,
  created_at     timestamptz not null default now()
);

create index if not exists job_completion_media_job_idx on public.job_completion_media(job_id);
create index if not exists job_completion_media_company_idx on public.job_completion_media(company_id);

alter table public.job_completion_media enable row level security;

-- RLS needs the base SELECT privilege too (rows are then filtered by policy).
grant select on public.job_completion_media to authenticated;

-- ----------------------------------------------------------------------------
-- Authorization helper (SECURITY DEFINER).
-- WHY: RLS policy expressions run AS THE CALLER. Employees cannot SELECT
-- public.jobs under its own RLS, so any policy that sub-queries public.jobs
-- directly returns nothing for them and blocks even their own media (this was
-- the cause of "new row violates row-level security policy" on employee upload).
-- This helper runs the SAME owner/admin-or-assigned predicate but bypasses the
-- caller's RLS on jobs/assignments/memberships. It does NOT widen access — it
-- returns true only for the exact documented cases.
-- ----------------------------------------------------------------------------
create or replace function public.job_media_authorized(p_job_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.jobs j
    join public.company_memberships m on m.company_id = j.company_id
    where j.id = p_job_id
      and j.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.is_active
      and (
        m.role in ('owner','admin')
        or exists (
          select 1 from public.job_assignments ja
          where ja.job_id = j.id
            and ja.employee_user_id = auth.uid()
            and ja.status <> 'cancelled'
        )
      )
  );
$$;

revoke all on function public.job_media_authorized(uuid, uuid) from public, anon;
grant execute on function public.job_media_authorized(uuid, uuid) to authenticated;

-- Read: owner/admin of the company, OR the employee currently assigned to the job.
drop policy if exists job_media_meta_read on public.job_completion_media;
create policy job_media_meta_read on public.job_completion_media
  for select to authenticated
  using ( public.job_media_authorized(job_completion_media.job_id, job_completion_media.company_id) );
-- No insert/update/delete policy: rows are written only by record_job_media()
-- (SECURITY DEFINER), which validates assignment first.

-- ----------------------------------------------------------------------------
-- 3. Metadata write path: record_job_media() — assigned employee or owner/admin.
-- ----------------------------------------------------------------------------
create or replace function public.record_job_media(
  p_job_id        uuid,
  p_completion_id uuid,
  p_media_type    text,
  p_storage_path  text,
  p_mime_type     text,
  p_size_bytes    bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_media_type not in ('before_photo','after_photo','signature','other') then
    raise exception 'invalid media_type';
  end if;

  select company_id into v_company from public.jobs where id = p_job_id;
  if v_company is null then
    raise exception 'job not found';
  end if;

  -- caller must be active owner/admin of the company OR the assigned employee
  if not exists (
    select 1 from public.company_memberships m
    where m.company_id = v_company and m.user_id = auth.uid() and m.is_active
      and (
        m.role in ('owner','admin')
        or exists (
          select 1 from public.job_assignments ja
          where ja.job_id = p_job_id and ja.employee_user_id = auth.uid()
            and ja.status <> 'cancelled'
        )
      )
  ) then
    raise exception 'not authorized for this job' using errcode = '42501';
  end if;

  insert into public.job_completion_media(
    company_id, job_id, completion_id, uploaded_by,
    media_type, storage_bucket, storage_path, mime_type, size_bytes
  )
  values (
    v_company, p_job_id, p_completion_id, auth.uid(),
    p_media_type, 'job-media', p_storage_path, p_mime_type, p_size_bytes
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_job_media(uuid, uuid, text, text, text, bigint) from public, anon;
grant execute on function public.record_job_media(uuid, uuid, text, text, text, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Storage object RLS (bucket 'job-media'). Path segment [1]=company_id,
--    [2]=job_id. Read = owner/admin or assigned employee. Write same. No public.
-- ----------------------------------------------------------------------------
-- storage.foldername(name) -> {company_id, job_id, completion_id, media_type}
-- ([1] = company_id, [2] = job_id). Authorization goes through the SECURITY
-- DEFINER helper above so it is NOT blocked by the caller's own RLS on
-- public.jobs (the bug that denied assigned-employee uploads).
drop policy if exists job_media_objects_read on storage.objects;
create policy job_media_objects_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'job-media'
    and public.job_media_authorized(
      ((storage.foldername(name))[2])::uuid,
      ((storage.foldername(name))[1])::uuid
    )
  );

drop policy if exists job_media_objects_insert on storage.objects;
create policy job_media_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'job-media'
    and public.job_media_authorized(
      ((storage.foldername(name))[2])::uuid,
      ((storage.foldername(name))[1])::uuid
    )
  );

-- (No update/delete policy: media is immutable from the app for now. Add an
--  owner/admin delete policy later if a retention/redaction flow is needed.)

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY after applying:
--   * select id, public from storage.buckets where id='job-media'; -> public = false
--   * employee assigned to a job: storage upload to that job's path SUCCEEDS;
--     to another job's path FAILS.
--   * owner/admin: can createSignedUrl for company media; another company's =
--     denied. anon: denied everywhere.
--   * select * from public.job_completion_media; visible only per the read policy.
-- Regression covered by: scripts/storage-media-test.mjs (npm run test:storage).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- POLICY / HELPER INSPECTION (run to confirm the fix is in place):
--   -- storage.objects policies for this bucket
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies where schemaname='storage' and tablename='objects'
--     and policyname like 'job_media_%';
--
--   -- metadata table policy
--   select policyname, cmd, qual from pg_policies
--   where schemaname='public' and tablename='job_completion_media';
--
--   -- helper exists, is SECURITY DEFINER, executable by authenticated only
--   select p.proname, p.prosecdef as security_definer,
--          pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' and p.proname='job_media_authorized';
--   select grantee, privilege_type from information_schema.role_routine_grants
--   where routine_name='job_media_authorized';
--
--   -- quick predicate check: as the assigned employee's JWT context this returns true
--   -- select public.job_media_authorized('<job_id>'::uuid, '<company_id>'::uuid);
-- ---------------------------------------------------------------------------
