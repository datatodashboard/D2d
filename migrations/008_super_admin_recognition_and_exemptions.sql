-- ============================================================
-- Migration 008: Super Admin Recognition and Authoritative Exemptions
-- ============================================================

-- 1. Ensure public.admin_users table exists
create table if not exists public.admin_users (
  user_id uuid references auth.users on delete cascade primary key,
  role text not null default 'admin',
  created_at timestamptz default now(),
  notes text
);

alter table public.admin_users enable row level security;

-- 2. Additive, rerunnable Super Admin assignment for datatodashboard2@gmail.com
-- Resolves real user ID from auth.users; raises clear setup error if not found.
do $$
declare
  v_super_admin_id uuid;
begin
  select id into v_super_admin_id
  from auth.users
  where lower(email) = 'datatodashboard2@gmail.com'
  limit 1;

  if v_super_admin_id is null then
    raise exception 'Super Admin account datatodashboard2@gmail.com does not exist in auth.users. Please sign in via Google first, then run this migration.';
  end if;

  -- Assign to protected admin_users table
  insert into public.admin_users (user_id, role, notes)
  values (v_super_admin_id, 'super_admin', 'Authoritative Super Admin')
  on conflict (user_id) do update
  set role = 'super_admin',
      notes = 'Authoritative Super Admin';

  -- Sync profiles.is_admin
  update public.profiles
  set is_admin = true
  where id = v_super_admin_id;
end $$;

-- 3. Authoritative public.is_admin() function
-- Uses ONLY protected role sources (admin_users table and protected profiles.is_admin)
-- Narrowly scoped with safe search_path. Does NOT rely on browser email or client-controlled metadata.
create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if auth.uid() is null then
    return false;
  end if;

  return exists (
    select 1 from public.admin_users
    where user_id = auth.uid()
  ) or exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  );
end;
$$;

-- 4. Protection trigger: prevent ordinary users from inserting or modifying privileged fields
-- Privileged fields: is_admin, paid_unlocked, contest_eligible, completed_count
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  is_admin_caller boolean;
  trusted_op boolean;
begin
  trusted_op := coalesce(current_setting('app.trusted_operation', true), 'false') = 'true';
  is_admin_caller := public.is_admin();

  if tg_op = 'INSERT' then
    if not is_admin_caller and not trusted_op then
      new.is_admin := false;
      new.paid_unlocked := false;
      new.contest_eligible := false;
      new.completed_count := 0;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if not is_admin_caller and not trusted_op then
      if new.is_admin is distinct from old.is_admin then
        raise exception 'Modifying is_admin is restricted to administrators.';
      end if;
      if new.paid_unlocked is distinct from old.paid_unlocked then
        raise exception 'Modifying paid_unlocked is restricted to administrators.';
      end if;
      if new.contest_eligible is distinct from old.contest_eligible then
        raise exception 'Modifying contest_eligible directly is restricted.';
      end if;
      if new.completed_count is distinct from old.completed_count then
        raise exception 'Modifying completed_count directly is restricted.';
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_profile_privileged_fields on public.profiles;
create trigger trg_protect_profile_privileged_fields
  before insert or update on public.profiles
  for each row execute procedure public.protect_profile_privileged_fields();

-- 5. Controlled server-side progress syncing function
create or replace function public.sync_user_progress(p_user_id uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  target_id uuid;
  real_completed integer;
  is_eligible boolean;
begin
  target_id := coalesce(p_user_id, auth.uid());
  if target_id is null then
    raise exception 'No authenticated user';
  end if;

  if target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied to sync progress for another user.';
  end if;

  -- Count distinct completed scenarios recorded in public.progress
  select count(distinct scenario_id) into real_completed
  from public.progress
  where user_id = target_id;

  is_eligible := (real_completed >= 18);

  -- Set session flag for trigger
  perform set_config('app.trusted_operation', 'true', true);

  update public.profiles
  set completed_count = real_completed,
      contest_eligible = is_eligible,
      last_active = now()
  where id = target_id;

  return json_build_object(
    'completed_count', real_completed,
    'contest_eligible', is_eligible
  )::jsonb;
end;
$$;

-- 6. Trigger to automatically sync profile count on progress write
create or replace function public.on_progress_table_changed()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  target_uid uuid;
begin
  target_uid := coalesce(new.user_id, old.user_id);
  if target_uid is not null then
    perform public.sync_user_progress(target_uid);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_progress_table_changed on public.progress;
create trigger trg_progress_table_changed
  after insert or update or delete on public.progress
  for each row execute procedure public.on_progress_table_changed();

-- 7. Update RLS policies to enforce clean separation and admin contest exemption

-- Admin users: only admins can view or manage
drop policy if exists "Admins can view admin_users" on public.admin_users;
create policy "Admins can view admin_users" on public.admin_users for select using (public.is_admin());

drop policy if exists "Admins can manage admin_users" on public.admin_users;
create policy "Admins can manage admin_users" on public.admin_users for all using (public.is_admin());

-- Contest registrations: admins can register for any published contest without audience barrier
drop policy if exists "Eligible users can register for published contests" on public.contest_registrations;
create policy "Eligible users can register for published contests" on public.contest_registrations for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
        and (
          public.is_admin()
          or c.audience_type = 'ALL'
          or exists (
            select 1 from public.contest_eligibility e
            where e.contest_id = c.id and e.user_id = auth.uid()
          )
        )
    )
  );

-- Contest attempts: drop old permissive policies to prevent bypass; allow admins exempt, learners require verified payment or free contest
drop policy if exists "Verified users can create single attempt" on public.contest_attempts;
drop policy if exists "Users can create single contest attempt" on public.contest_attempts;
drop policy if exists "Authorized users can create single attempt" on public.contest_attempts;
create policy "Authorized users can create single attempt"
  on public.contest_attempts for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
        and (
          public.is_admin()
          or c.entry_fee = 0
          or exists (
            select 1 from public.contest_payments p
            where p.contest_id = c.id
              and p.user_id = auth.uid()
              and p.status = 'VERIFIED'
          )
        )
    )
  );

-- 8. Grant execute permissions on helper functions
grant execute on function public.is_admin() to authenticated, anon;
grant execute on function public.sync_user_progress(uuid) to authenticated;

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
