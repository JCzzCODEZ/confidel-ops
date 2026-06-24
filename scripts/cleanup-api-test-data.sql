-- ============================================================================
-- Safe cleanup for API integration test data
-- Run label: phase14g-1782188759
--
-- Scoped strictly to the test company + test users below. It does NOT drop
-- tables and cannot touch real data: destructive statements are double-guarded
-- by the test naming patterns ('API Test %' companies, 'confidel.api.%@example.com'
-- users), so even a wrong id can't delete a real row.
--
-- HOW TO USE (Supabase -> SQL Editor):
--   1. Run STEP 1 (preview). Read the counts — that's exactly what will go.
--   2. If they look right, run STEP 2 (transactional delete).
--   3. Optionally run STEP 3 to remove the test auth users.
--   4. Optionally run the APPENDIX to also clear leftover companies from
--      earlier re-runs (same run id seeds a NEW company each time).
--
-- Fixture ids (from the test's CLEANUP_LABEL line):
--   company_id     = 6c673134-c005-45b2-a626-4797aeac0691
--   owner          = 4b65149e-26c3-40b9-a88d-48cfe96f930e
--   employee       = e899e194-bffb-4350-ab65-432cb0dc2cce
--   other_employee = 8d63bdf6-d470-44df-9381-280de7ad3c90
-- (Replace these four values to clean a different run.)
-- ============================================================================


-- ============================================================================
-- STEP 1 — PREVIEW (read-only). Run first; review before deleting.
-- ============================================================================
select 'companies'           as table_name,
       count(*)              as rows_to_delete
  from public.companies
 where id = '6c673134-c005-45b2-a626-4797aeac0691'
   and name like 'API Test %'
union all
select 'company_memberships', count(*)
  from public.company_memberships
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691'
union all
select 'clients', count(*)
  from public.clients
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691'
union all
select 'jobs', count(*)
  from public.jobs
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691'
union all
select 'job_assignments', count(*)
  from public.job_assignments
 where job_id in (select id from public.jobs
                   where company_id = '6c673134-c005-45b2-a626-4797aeac0691')
union all
select 'job_completions', count(*)
  from public.job_completions
 where job_id in (select id from public.jobs
                   where company_id = '6c673134-c005-45b2-a626-4797aeac0691')
union all
select 'invoices', count(*)
  from public.invoices
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691'
union all
select 'payments', count(*)
  from public.payments
 where invoice_id in (select id from public.invoices
                       where company_id = '6c673134-c005-45b2-a626-4797aeac0691')
union all
select 'auth.users (test only)', count(*)
  from auth.users
 where id in (
         '4b65149e-26c3-40b9-a88d-48cfe96f930e',
         'e899e194-bffb-4350-ab65-432cb0dc2cce',
         '8d63bdf6-d470-44df-9381-280de7ad3c90'
       )
   and email like 'confidel.api.%@example.com';


-- ============================================================================
-- STEP 2 — DELETE company-scoped data (transactional; children first).
-- If any statement errors, the whole block rolls back. Change COMMIT to
-- ROLLBACK if you want to abort after inspecting.
-- ============================================================================
begin;

delete from public.payments
 where invoice_id in (select id from public.invoices
                       where company_id = '6c673134-c005-45b2-a626-4797aeac0691');

delete from public.invoices
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691';

delete from public.job_completions
 where job_id in (select id from public.jobs
                   where company_id = '6c673134-c005-45b2-a626-4797aeac0691');

delete from public.job_assignments
 where job_id in (select id from public.jobs
                   where company_id = '6c673134-c005-45b2-a626-4797aeac0691');

delete from public.jobs
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691';

delete from public.clients
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691';

delete from public.company_memberships
 where company_id = '6c673134-c005-45b2-a626-4797aeac0691';

-- name guard: only the test company can match
delete from public.companies
 where id = '6c673134-c005-45b2-a626-4797aeac0691'
   and name like 'API Test %';

commit;


-- ============================================================================
-- STEP 3 — OPTIONAL: remove the test auth users.
-- Skip this if you want to reuse the same API_TEST_RUN_ID accounts for re-runs.
-- email guard: only the throwaway example.com test accounts can match.
-- ============================================================================
-- delete from auth.users
--  where id in (
--          '4b65149e-26c3-40b9-a88d-48cfe96f930e',
--          'e899e194-bffb-4350-ab65-432cb0dc2cce',
--          '8d63bdf6-d470-44df-9381-280de7ad3c90'
--        )
--    and email like 'confidel.api.%@example.com';


-- ============================================================================
-- APPENDIX — OPTIONAL: clear leftover companies from earlier re-runs.
-- Re-running `test:api` with the same run id seeds a NEW company each time, so
-- several 'API Test %' companies owned by the test owner may exist. This finds
-- and removes ALL of them (still scoped to the test owner + test name pattern).
-- ============================================================================
-- Preview the leftovers first:
-- select id, name, created_at
--   from public.companies
--  where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--    and name like 'API Test %'
--  order by created_at;

-- Then delete them all (children first), scoped by the owner's test companies:
-- begin;
--   delete from public.payments
--    where invoice_id in (select i.id from public.invoices i
--                          join public.companies co on co.id = i.company_id
--                         where co.owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                           and co.name like 'API Test %');
--   delete from public.invoices
--    where company_id in (select id from public.companies
--                          where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                            and name like 'API Test %');
--   delete from public.job_completions
--    where job_id in (select j.id from public.jobs j
--                      join public.companies co on co.id = j.company_id
--                     where co.owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                       and co.name like 'API Test %');
--   delete from public.job_assignments
--    where job_id in (select j.id from public.jobs j
--                      join public.companies co on co.id = j.company_id
--                     where co.owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                       and co.name like 'API Test %');
--   delete from public.jobs
--    where company_id in (select id from public.companies
--                          where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                            and name like 'API Test %');
--   delete from public.clients
--    where company_id in (select id from public.companies
--                          where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                            and name like 'API Test %');
--   delete from public.company_memberships
--    where company_id in (select id from public.companies
--                          where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--                            and name like 'API Test %');
--   delete from public.companies
--    where owner_user_id = '4b65149e-26c3-40b9-a88d-48cfe96f930e'
--      and name like 'API Test %';
-- commit;
-- ============================================================================
