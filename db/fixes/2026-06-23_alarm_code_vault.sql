-- ============================================================================
-- Phase 1.1 — Alarm-code encryption (reveal-only)
-- Date: 2026-06-23
--
-- Goal: client alarm codes are encrypted at rest and never returned by normal
-- APIs. They can only be revealed on demand by an owner/admin of the same
-- company, and every reveal is logged.
--
-- Pattern: pgcrypto (pgp_sym_encrypt/decrypt) with the symmetric key stored in
-- Supabase Vault. This is the current Supabase-supported approach for per-column
-- secrets (pgsodium Transparent Column Encryption is deprecated). The plaintext
-- key never lives in a table — only in Vault, read by a SECURITY DEFINER helper.
--
-- Apply in the Supabase SQL Editor. This file is the versioned record; it is not
-- run automatically from the repo.
--
-- ---------------------------------------------------------------------------
-- BEFORE YOU RUN — confirm these against the live schema (they're assumptions):
--   * public.clients exists with a uuid `id` and uuid `company_id`.
--   * public.company_memberships(user_id, company_id, role, is_active) exists.
--   * Vault is enabled (Supabase: Database > Extensions/Integrations > Vault).
--   * pgcrypto is available (extensions schema).
-- Run the inspection block at the very bottom first if unsure.
-- ============================================================================

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- 1. Symmetric key in Vault (created once; never regenerated on re-run).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'alarm_code_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'alarm_code_key',
      'Symmetric key for client alarm code encryption'
    );
  end if;
end $$;

-- Key accessor — SECURITY DEFINER, locked away from app roles. Never exposes
-- the key to a query; only the encrypt/decrypt functions call it.
create or replace function private.alarm_code_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'alarm_code_key'
  limit 1;
$$;

revoke all on function private.alarm_code_key() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Ciphertext column + migrate/drop any existing plaintext column.
-- ----------------------------------------------------------------------------
alter table public.clients add column if not exists alarm_code_cipher bytea;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'alarm_code'
  ) then
    -- migrate existing plaintext, then remove the plaintext column entirely
    update public.clients
       set alarm_code_cipher = extensions.pgp_sym_encrypt(alarm_code, private.alarm_code_key())
     where alarm_code is not null and alarm_code_cipher is null;
    alter table public.clients drop column alarm_code;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Audit log (dedicated table — does not depend on activity_feed's schema).
-- ----------------------------------------------------------------------------
create table if not exists public.alarm_code_audit (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  client_id   uuid not null,
  revealed_by uuid not null,
  revealed_at timestamptz not null default now()
);

alter table public.alarm_code_audit enable row level security;

-- RLS decides which ROWS are visible, but the role still needs table-level
-- SELECT privilege to read at all — without this grant, authenticated callers
-- get "permission denied for table alarm_code_audit". (This grant was the final
-- fix needed for the reveal-audit test to pass.)
grant select on public.alarm_code_audit to authenticated;

-- Owner/admin of the client's company may read its audit rows. The company is
-- derived through the client (not a denormalized column), so the policy can't
-- be fooled by a mismatched company_id. No insert/update/delete policy: only
-- the SECURITY DEFINER reveal RPC writes (bypassing RLS).
drop policy if exists alarm_audit_read on public.alarm_code_audit;
drop policy if exists alarm_code_audit_owner_admin_read on public.alarm_code_audit;
create policy alarm_code_audit_owner_admin_read
on public.alarm_code_audit
for select
to authenticated
using (
  exists (
    select 1
    from public.clients c
    join public.company_memberships m
      on m.company_id = c.company_id
    where c.id = alarm_code_audit.client_id
      and m.user_id = auth.uid()
      and m.is_active
      and m.role in ('owner', 'admin')
  )
);

-- ----------------------------------------------------------------------------
-- 4. Write path: set_alarm_code() — owner/admin only.
-- ----------------------------------------------------------------------------
create or replace function public.set_alarm_code(p_client_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select company_id into v_company from public.clients where id = p_client_id;
  if v_company is null then
    raise exception 'client not found';
  end if;

  if not exists (
    select 1 from public.company_memberships m
    where m.company_id = v_company and m.user_id = auth.uid()
      and m.is_active and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin access required' using errcode = '42501';
  end if;

  update public.clients
     set alarm_code_cipher = case
           when p_code is null or p_code = '' then null
           else extensions.pgp_sym_encrypt(p_code, private.alarm_code_key())
         end
   where id = p_client_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Reveal path: reveal_alarm_code() — owner/admin only, audited.
-- ----------------------------------------------------------------------------
create or replace function public.reveal_alarm_code(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_company uuid;
  v_cipher  bytea;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select company_id, alarm_code_cipher
    into v_company, v_cipher
    from public.clients
   where id = p_client_id;

  if v_company is null then
    raise exception 'client not found';
  end if;

  if not exists (
    select 1 from public.company_memberships m
    where m.company_id = v_company and m.user_id = auth.uid()
      and m.is_active and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin access required' using errcode = '42501';
  end if;

  -- Audit the reveal (recorded even when there is no code stored).
  insert into public.alarm_code_audit(company_id, client_id, revealed_by)
  values (v_company, p_client_id, auth.uid());

  if v_cipher is null then
    return null;
  end if;

  return extensions.pgp_sym_decrypt(v_cipher, private.alarm_code_key());
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Grants: callable by logged-in users; internal role checks do the real work.
--    anon/public cannot call them at all; employees get "owner or admin
--    access required" from inside the function.
-- ----------------------------------------------------------------------------
revoke all on function public.set_alarm_code(uuid, text)  from public, anon;
grant  execute on function public.set_alarm_code(uuid, text)  to authenticated;

revoke all on function public.reveal_alarm_code(uuid) from public, anon;
grant  execute on function public.reveal_alarm_code(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY after applying:
--   * select column_name from information_schema.columns
--       where table_schema='public' and table_name='clients'
--         and column_name in ('alarm_code','alarm_code_cipher');
--     -> expect alarm_code_cipher present, alarm_code ABSENT.
--   * owner/admin: select public.reveal_alarm_code('<client_id>')  -> the code.
--   * employee:    same call -> ERROR 'owner or admin access required'.
--   * anon:        same call -> permission denied (not granted).
--   * select * from public.alarm_code_audit;  -> one row per reveal.
-- Regression covered by: scripts/api-integration.mjs with ALARM_CODE_TESTS=1.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- INSPECTION (optional, run first if unsure about the live schema):
--   select column_name, data_type from information_schema.columns
--     where table_schema='public' and table_name='clients' order by ordinal_position;
--   select exists(select 1 from pg_extension where extname='pgcrypto') as has_pgcrypto;
--   select exists(select 1 from information_schema.schemata where schema_name='vault') as has_vault;
-- ---------------------------------------------------------------------------
