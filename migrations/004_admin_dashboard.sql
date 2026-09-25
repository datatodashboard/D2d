-- ============================================================
-- Migration 004: Admin Dashboard, Roles & Policies
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Ensure is_admin column exists on profiles table
alter table public.profiles
  add column if not exists is_admin boolean default false;

-- 2. Create admin_users table for explicit role management
create table if not exists public.admin_users (
  user_id uuid references auth.users on delete cascade primary key,
  role text not null default 'admin',
  created_at timestamptz default now(),
  notes text
);

alter table public.admin_users enable row level security;

-- 3. Security helper function to check if current user is an authorized admin
create or replace function public.is_admin()
returns boolean as $$
begin
  return exists (
    select 1 from public.admin_users
    where user_id = auth.uid()
  ) or exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  ) or (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean, false) = true
  );
end;
$$ language plpgsql security definer;

-- 4. RLS policies on admin_users table
drop policy if exists "Admins can view admin_users" on public.admin_users;
create policy "Admins can view admin_users"
  on public.admin_users for select
  using (public.is_admin());

drop policy if exists "Admins can manage admin_users" on public.admin_users;
create policy "Admins can manage admin_users"
  on public.admin_users for all
  using (public.is_admin());

-- 5. Admin read access policies across core tables
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.is_admin());

drop policy if exists "Admins can view all progress" on public.progress;
create policy "Admins can view all progress"
  on public.progress for select
  using (public.is_admin());

drop policy if exists "Admins can view all learning_progress" on public.learning_progress;
create policy "Admins can view all learning_progress"
  on public.learning_progress for select
  using (public.is_admin());

drop policy if exists "Admins can view all challenge attempts" on public.sql_challenge_attempts;
create policy "Admins can view all challenge attempts"
  on public.sql_challenge_attempts for select
  using (public.is_admin());

-- 6. RPC: Aggregate stats for the Admin Dashboard
create or replace function public.get_admin_dashboard_stats()
returns jsonb as $$
declare
  total_users_count bigint;
  active_users_7d_count bigint;
  total_completions_count bigint;
  total_attempts_count bigint;
  verified_attempts_count bigint;
  avg_score numeric;
  recent_attempts_json jsonb;
  domain_summary_json jsonb;
begin
  -- Only authorized admins can call this function
  if not public.is_admin() then
    raise exception 'Access denied: User is not an authorized administrator.';
  end if;

  select count(*) into total_users_count from public.profiles;
  select count(*) into active_users_7d_count from public.profiles where last_active > now() - interval '7 days';
  select count(*) into total_completions_count from public.progress;
  select count(*) into total_attempts_count from public.sql_challenge_attempts;
  select count(*) into verified_attempts_count from public.sql_challenge_attempts where is_verified = true;
  select coalesce(avg(thinking_score), 0) into avg_score from public.sql_challenge_attempts where thinking_score is not null;

  select coalesce(jsonb_agg(sub), '[]'::jsonb) into recent_attempts_json
  from (
    select id, user_id, scenario_id, domain, level, thinking_score, is_verified, created_at
    from public.sql_challenge_attempts
    order by created_at desc
    limit 20
  ) sub;

  select coalesce(jsonb_object_agg(domain, cnt), '{}'::jsonb) into domain_summary_json
  from (
    select domain, count(*) as cnt
    from public.sql_challenge_attempts
    group by domain
  ) d;

  return jsonb_build_object(
    'total_users', total_users_count,
    'active_users_7d', active_users_7d_count,
    'total_completions', total_completions_count,
    'total_attempts', total_attempts_count,
    'verified_attempts', verified_attempts_count,
    'avg_thinking_score', round(avg_score, 2),
    'domain_summary', domain_summary_json,
    'recent_attempts', recent_attempts_json
  );
end;
$$ language plpgsql security definer;
