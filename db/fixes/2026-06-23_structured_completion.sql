-- ============================================================================
-- Structured job-completion data (services / add-ons / expenses + timing)
-- Date: 2026-06-23
--
-- WHY: services/add-ons/expenses must be real rows the owner side can read,
-- price, approve, invoice, and export for taxes — NOT free text inside notes.
--
-- This migration is ADDITIVE and does NOT modify submit_job_completion(): the
-- employee still creates the completion with that RPC (notes + photos), then
-- calls record_completion_details() to attach structured data. So the existing
-- demo and the green test suites are unaffected.
--
-- Apply in the Supabase SQL Editor. Versioned record; not auto-run.
-- Assumes public.job_completions(id, company_id, job_id, employee_user_id) and
-- the Phase C storage migration (defines public.job_media_authorized()).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Timing / status columns on the completion (additive, nullable).
-- ----------------------------------------------------------------------------
alter table public.job_completions add column if not exists arrival_time      time;
alter table public.job_completions add column if not exists start_time        time;
alter table public.job_completions add column if not exists end_time          time;
alter table public.job_completions add column if not exists break_minutes     integer;
alter table public.job_completions add column if not exists hours             numeric(10,2);
alter table public.job_completions add column if not exists completion_status text
  check (completion_status is null or completion_status in ('Completed','Partially Completed','Needs Follow-Up'));

-- ----------------------------------------------------------------------------
-- 2. Authorization helper (re-asserted here so this file is self-contained).
--    Same predicate as Phase C: owner/admin of the company, or the assigned
--    (non-cancelled) employee. SECURITY DEFINER so policies aren't blocked by
--    the caller's own RLS on jobs/assignments.
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

-- ----------------------------------------------------------------------------
-- 3. Structured child tables.
-- ----------------------------------------------------------------------------
create table if not exists public.job_completion_services (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  job_id        uuid not null,
  completion_id uuid not null,
  service_name  text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.job_completion_addons (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  job_id        uuid not null,
  completion_id uuid not null,
  addon_name    text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.job_completion_expenses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  job_id        uuid not null,
  completion_id uuid not null,
  expense_type  text not null check (expense_type in ('supplies','mileage','parking','tolls','other')),
  description   text,
  amount_cents  bigint not null default 0,   -- money in cents; for mileage this is the reimbursable $ if computed, else 0
  quantity      numeric,                      -- e.g. miles for mileage
  unit          text,                         -- e.g. 'miles'
  created_at    timestamptz not null default now()
);

create index if not exists jcs_completion_idx on public.job_completion_services(completion_id);
create index if not exists jca_completion_idx on public.job_completion_addons(completion_id);
create index if not exists jce_completion_idx on public.job_completion_expenses(completion_id);

-- ----------------------------------------------------------------------------
-- 4. RLS: owner/admin of company OR assigned employee may READ. Writes happen
--    only through record_completion_details() (SECURITY DEFINER).
-- ----------------------------------------------------------------------------
alter table public.job_completion_services enable row level security;
alter table public.job_completion_addons   enable row level security;
alter table public.job_completion_expenses enable row level security;

grant select on public.job_completion_services to authenticated;
grant select on public.job_completion_addons   to authenticated;
grant select on public.job_completion_expenses to authenticated;

drop policy if exists jcs_read on public.job_completion_services;
create policy jcs_read on public.job_completion_services for select to authenticated
  using ( public.job_media_authorized(job_id, company_id) );

drop policy if exists jca_read on public.job_completion_addons;
create policy jca_read on public.job_completion_addons for select to authenticated
  using ( public.job_media_authorized(job_id, company_id) );

drop policy if exists jce_read on public.job_completion_expenses;
create policy jce_read on public.job_completion_expenses for select to authenticated
  using ( public.job_media_authorized(job_id, company_id) );

-- ----------------------------------------------------------------------------
-- 5. record_completion_details() — the employee enriches THEIR completion with
--    timing + structured services/add-ons/expenses. Idempotent (replaces child
--    rows), so a re-submit before approval overwrites cleanly.
-- ----------------------------------------------------------------------------
create or replace function public.record_completion_details(
  p_completion_id    uuid,
  p_arrival          time,
  p_start            time,
  p_end              time,
  p_break_minutes    integer,
  p_completion_status text,
  p_services         jsonb,
  p_addons           jsonb,
  p_expenses         jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_job     uuid;
  v_emp     uuid;
  v_hours   numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select company_id, job_id, employee_user_id
    into v_company, v_job, v_emp
    from public.job_completions
   where id = p_completion_id;

  if v_company is null then
    raise exception 'completion not found';
  end if;
  if v_emp is distinct from auth.uid() then
    raise exception 'not your completion' using errcode = '42501';
  end if;
  if p_completion_status is null
     or p_completion_status not in ('Completed','Partially Completed','Needs Follow-Up') then
    raise exception 'invalid completion_status';
  end if;

  -- server-side hours (start->end, overnight-safe, minus break); never trust client
  if p_start is not null and p_end is not null then
    v_hours := round(
      (extract(epoch from (
        case when p_end >= p_start then p_end - p_start
             else p_end - p_start + interval '24 hours' end
      )) / 3600.0) - coalesce(p_break_minutes, 0) / 60.0, 2);
    if v_hours < 0 then v_hours := 0; end if;
  end if;

  update public.job_completions
     set arrival_time      = p_arrival,
         start_time        = p_start,
         end_time          = p_end,
         break_minutes     = coalesce(p_break_minutes, 0),
         hours             = v_hours,
         completion_status = p_completion_status
   where id = p_completion_id;

  -- replace structured rows for an idempotent re-submit
  delete from public.job_completion_services where completion_id = p_completion_id;
  delete from public.job_completion_addons   where completion_id = p_completion_id;
  delete from public.job_completion_expenses where completion_id = p_completion_id;

  insert into public.job_completion_services(company_id, job_id, completion_id, service_name)
    select v_company, v_job, p_completion_id, value
    from jsonb_array_elements_text(coalesce(p_services, '[]'::jsonb)) as t(value)
    where length(trim(value)) > 0;

  insert into public.job_completion_addons(company_id, job_id, completion_id, addon_name)
    select v_company, v_job, p_completion_id, value
    from jsonb_array_elements_text(coalesce(p_addons, '[]'::jsonb)) as t(value)
    where length(trim(value)) > 0;

  insert into public.job_completion_expenses(
    company_id, job_id, completion_id, expense_type, description, amount_cents, quantity, unit)
    select
      v_company, v_job, p_completion_id,
      coalesce(nullif(e->>'type',''), 'other'),
      nullif(e->>'description',''),
      coalesce((e->>'amountCents')::bigint, 0),
      nullif(e->>'quantity','')::numeric,
      nullif(e->>'unit','')
    from jsonb_array_elements(coalesce(p_expenses, '[]'::jsonb)) as e
    where coalesce(nullif(e->>'type',''),'other') in ('supplies','mileage','parking','tolls','other');
end;
$$;

revoke all on function public.record_completion_details(uuid, time, time, time, integer, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.record_completion_details(uuid, time, time, time, integer, text, jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY after applying:
--   * \d public.job_completions  -> arrival_time/start_time/end_time/break_minutes/hours/completion_status present
--   * employee enriches own completion -> rows appear in the 3 child tables
--   * owner/admin can SELECT the child rows for company jobs; other employees cannot
--   * employee can read their own; anon none
-- Regression covered by: scripts/structured-completion-test.mjs (STRUCTURED_TESTS=1)
-- ============================================================================
