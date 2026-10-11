-- ============================================================
-- Migration 017: Global Learning Reset for Thinking Engine 2.0
-- Auditable Migration ID: 017_thinking_engine_2_0_global_reset
-- Enforces:
-- 1. Back up existing learning progress, learning_progress states, and certificates to immutable read-only historical archive tables.
-- 2. Reset completed scenario progress (public.progress) to 0.
-- 3. Reset learning_progress state and thinking submissions to fresh Thinking Engine 2.0 zero state.
-- 4. Reset active certificates (public.certificates) to 0/21 while preserving historical certificates in historical_certificates.
-- 5. Reset completed_count and contest_eligible in public.profiles.
-- 6. STRICTLY PRESERVE: auth.users, public.profiles (username, email, paid_unlocked, is_admin), admin_users, payments, contest tables, contest_payments, historical certificates.
-- 7. Idempotent execution and rollback documentation.
-- ============================================================

-- 1. Create Historical Archive Tables (if not exist)
create table if not exists public.historical_progress (
  archive_id bigint generated always as identity primary key,
  original_id bigint,
  user_id uuid not null,
  scenario_id text not null,
  completed_at timestamptz,
  archived_at timestamptz not null default now()
);

create table if not exists public.historical_learning_progress (
  archive_id bigint generated always as identity primary key,
  user_id uuid not null,
  state jsonb not null,
  updated_at timestamptz,
  archived_at timestamptz not null default now()
);

create table if not exists public.historical_certificates (
  archive_id bigint generated always as identity primary key,
  original_id uuid,
  credential_id text not null,
  user_id uuid not null,
  recipient_name text not null,
  domain text not null,
  level text not null,
  course_title text not null,
  description text not null,
  completed_at timestamptz not null,
  created_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  archived_at timestamptz not null default now()
);

-- Enable RLS on historical archive tables
alter table public.historical_progress enable row level security;
alter table public.historical_learning_progress enable row level security;
alter table public.historical_certificates enable row level security;

-- Policies for historical archives (users can view their own, admins view all)
drop policy if exists "Users can view own historical progress" on public.historical_progress;
create policy "Users can view own historical progress" on public.historical_progress for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Users can view own historical learning progress" on public.historical_learning_progress;
create policy "Users can view own historical learning progress" on public.historical_learning_progress for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Users can view own historical certificates" on public.historical_certificates;
create policy "Users can view own historical certificates" on public.historical_certificates for select using (auth.uid() = user_id or public.is_admin());

-- 2. Back up existing records before reset (Idempotent: only copy if not already archived)
insert into public.historical_progress (original_id, user_id, scenario_id, completed_at)
select id, user_id, scenario_id, completed_at
from public.progress
on conflict do nothing;

insert into public.historical_learning_progress (user_id, state, updated_at)
select user_id, state, updated_at
from public.learning_progress
where not exists (
  select 1 from public.historical_learning_progress hlp where hlp.user_id = public.learning_progress.user_id
);

insert into public.historical_certificates (original_id, credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at, created_at, metadata)
select id, credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at, created_at, metadata
from public.certificates
on conflict do nothing;

-- 3. Perform Learning Reset (Clear active tables for Thinking Engine 2.0)
-- Clear active scenario completions
truncate table public.progress restart identity cascade;

-- Reset active learning_progress state to empty Thinking Engine 2.0 state (resetAt = current epoch ms)
update public.learning_progress
set state = jsonb_build_object(
      'version', 2.0,
      'engine', 'Thinking Engine 2.0',
      'resetAt', (extract(epoch from now()) * 1000)::bigint,
      'entries', '{}'::jsonb
    ),
    updated_at = now();

-- Clear active certificates (active count = 0/21)
truncate table public.certificates restart identity cascade;

-- 4. Update profiles: reset completed_count to 0 and contest_eligible to false.
-- PRESERVE paid_unlocked, is_admin, username, email, etc.
update public.profiles
set completed_count = 0,
    contest_eligible = false,
    last_active = now();

-- 5. Audit Log Entry or Notice
do $$
begin
  raise notice 'Global Learning Reset for Thinking Engine 2.0 successfully completed. Learning records backed up to historical archive tables. Active progress reset to 0.';
end $$;

-- ============================================================
-- ROLLBACK PROCEDURE (For reference / emergency rollback):
-- To restore from backup:
-- 1. Restore public.progress from public.historical_progress:
--    insert into public.progress (user_id, scenario_id, completed_at)
--    select user_id, scenario_id, completed_at from public.historical_progress;
-- 2. Restore public.learning_progress from public.historical_learning_progress:
--    insert into public.learning_progress (user_id, state, updated_at)
--    select user_id, state, updated_at from public.historical_learning_progress
--    on conflict (user_id) do update set state = excluded.state;
-- 3. Restore public.certificates from public.historical_certificates:
--    insert into public.certificates (credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at, created_at, metadata)
--    select credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at, created_at, metadata from public.historical_certificates;
-- 4. Run reconciliation:
--    select public.reconcile_user_completions(id) from public.profiles;
-- ============================================================
