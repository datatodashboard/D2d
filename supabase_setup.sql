-- ============================================================
-- Think and Crack SQL — Supabase Setup & Complete Schema
-- Run this in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

-- 1. Profiles Table with paid_unlocked, contest_eligible, completed_count, and username
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique,
  email text,
  is_admin boolean default false,
  paid_unlocked boolean default false,
  contest_eligible boolean default false,
  completed_count integer default 0,
  created_at timestamptz default now(),
  last_active timestamptz default now()
);

-- Ensure columns exist if table was created earlier
alter table public.profiles
  add column if not exists username text,
  add column if not exists email text,
  add column if not exists is_admin boolean default false,
  add column if not exists paid_unlocked boolean default false,
  add column if not exists contest_eligible boolean default false,
  add column if not exists completed_count integer default 0,
  add column if not exists created_at timestamptz default now(),
  add column if not exists last_active timestamptz default now();

create unique index if not exists idx_profiles_username on public.profiles (lower(trim(username))) where username is not null;

-- Reload PostgREST schema cache so username column is immediately recognized
notify pgrst, 'reload schema';

alter table public.profiles enable row level security;

-- Auto-create profile trigger on auth.users insert
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update
  set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2. Admin Users Table
create table if not exists public.admin_users (
  user_id uuid references auth.users on delete cascade primary key,
  role text not null default 'admin',
  created_at timestamptz default now(),
  notes text
);

alter table public.admin_users enable row level security;

-- 3. Security Helper Function: is_admin()
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

-- Protection trigger: prevent ordinary users from inserting or modifying privileged fields
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

-- Trusted Scenario Catalog
create table if not exists public.scenario_catalog (
  id text primary key,
  created_at timestamptz not null default now()
);

alter table public.scenario_catalog enable row level security;
drop policy if exists "Anyone can read scenario_catalog" on public.scenario_catalog;
create policy "Anyone can read scenario_catalog" on public.scenario_catalog for select using (true);

-- Seed scenario catalog with the 420 trusted scenarios across 7 domains and 3 levels
do $$
declare
  dom text;
  lvl text;
  num int;
  sid text;
begin
  foreach dom in array array['BAN', 'HEA', 'INS', 'CAP', 'SEM', 'EDU', 'RET'] loop
    foreach lvl in array array['BEG', 'INT', 'EXP'] loop
      for num in 1..20 loop
        sid := dom || '_' || lvl || '_' || lpad(num::text, 3, '0');
        insert into public.scenario_catalog (id)
        values (sid)
        on conflict (id) do nothing;
      end loop;
    end loop;
  end loop;
end $$;

-- Controlled server-side progress syncing function
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

  select count(distinct scenario_id) into real_completed
  from public.progress
  where user_id = target_id;

  is_eligible := (real_completed >= 18);

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

-- Trigger to automatically sync profile count on progress table change
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

-- Trigger on public.progress: enforce 5-free limit on insert of new questions
create or replace function public.enforce_progress_completion_rules()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_existing_count integer;
  v_is_paid boolean := false;
  v_is_admin boolean := false;
  v_already_completed boolean := false;
begin
  if new.user_id is null or trim(coalesce(new.scenario_id, '')) = '' then
    raise exception 'Invalid progress record: user_id and scenario_id are required.';
  end if;

  if auth.uid() is not null and auth.uid() <> new.user_id and not public.is_admin() then
    raise exception 'Permission denied: Cannot record progress for another user.';
  end if;

  -- Validate scenario against trusted scenario catalog
  if not exists (select 1 from public.scenario_catalog where id = new.scenario_id) then
    raise exception 'Invalid scenario ID: % does not exist in trusted scenario catalog.', new.scenario_id;
  end if;

  -- Check if already completed (distinct scenario check)
  select exists (
    select 1 from public.progress
    where user_id = new.user_id and scenario_id = new.scenario_id
  ) into v_already_completed;

  if v_already_completed then
    return new;
  end if;

  -- Count distinct completions before this new insertion
  select count(distinct scenario_id) into v_existing_count
  from public.progress
  where user_id = new.user_id;

  if v_existing_count >= 5 then
    v_is_admin := public.is_admin();
    select coalesce(paid_unlocked, false) into v_is_paid
    from public.profiles
    where id = new.user_id;

    if not v_is_admin and not v_is_paid then
      raise exception 'Free limit reached: A verified ₹49 payment is required to complete more than 5 scenarios.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_progress_completion_rules on public.progress;
create trigger trg_enforce_progress_completion_rules
  before insert on public.progress
  for each row execute procedure public.enforce_progress_completion_rules();

-- Authoritative RPC to record a completed scenario with validation and trusted counts
create or replace function public.record_scenario_completion(
  p_scenario_id text,
  p_thinking_response text default null,
  p_score numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid;
  v_already_completed boolean;
  v_existing_count integer;
  v_is_admin boolean;
  v_is_paid boolean;
  v_new_completed integer;
  v_eligible boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to record scenario completion.';
  end if;

  -- Validate scenario ID against trusted catalog
  if not exists (select 1 from public.scenario_catalog where id = p_scenario_id) then
    raise exception 'Invalid scenario ID: % does not exist in trusted scenario catalog.', p_scenario_id;
  end if;

  -- Validate completion score: must be >= 7
  if p_score is not null and p_score < 7 then
    raise exception 'Thinking score must be at least 7/10 to count as completed. Received %.', p_score;
  end if;

  -- Check if already completed (distinct scenario check)
  select exists (
    select 1 from public.progress
    where user_id = v_uid and scenario_id = p_scenario_id
  ) into v_already_completed;

  if not v_already_completed then
    -- Count distinct existing completions
    select count(distinct scenario_id) into v_existing_count
    from public.progress
    where user_id = v_uid;

    if v_existing_count >= 5 then
      v_is_admin := public.is_admin();
      select coalesce(paid_unlocked, false) into v_is_paid
      from public.profiles
      where id = v_uid;

      if not v_is_admin and not v_is_paid then
        raise exception 'Free limit reached: A verified ₹49 payment is required to complete more than 5 scenarios.';
      end if;
    end if;

    -- Record completion in progress table
    insert into public.progress (user_id, scenario_id, completed_at)
    values (v_uid, p_scenario_id, now())
    on conflict (user_id, scenario_id) do nothing;
  end if;

  -- Authoritatively sync profile completed_count & contest_eligible
  perform public.sync_user_progress(v_uid);

  select completed_count, contest_eligible, paid_unlocked, is_admin
  into v_new_completed, v_eligible, v_is_paid, v_is_admin
  from public.profiles
  where id = v_uid;

  return jsonb_build_object(
    'success', true,
    'scenario_id', p_scenario_id,
    'user_id', v_uid,
    'completed_count', coalesce(v_new_completed, 0),
    'contest_eligible', coalesce(v_eligible, false),
    'paid_unlocked', coalesce(v_is_paid, false),
    'is_admin', coalesce(v_is_admin, false)
  );
end;
$$;

-- Reconciliation RPC for synchronizing progress and profile counts safely
create or replace function public.reconcile_user_completions(p_user_id uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  target_id uuid;
  v_count integer;
  v_eligible boolean;
  v_is_paid boolean := false;
  v_is_admin boolean := false;
  lp_state jsonb;
  lp_entries jsonb;
  k text;
  entry_data jsonb;
  entry_score numeric;
  entry_resp text;
begin
  target_id := coalesce(p_user_id, auth.uid());
  if target_id is null then
    raise exception 'No authenticated user';
  end if;

  if target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied to reconcile completions for another user.';
  end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = target_id;

  -- Safely inspect learning_progress to backfill valid completions without deleting history
  select state into lp_state
  from public.learning_progress
  where user_id = target_id;

  if lp_state is not null and lp_state ? 'entries' then
    lp_entries := lp_state->'entries';
    for k in select jsonb_object_keys(lp_entries) loop
      entry_data := lp_entries->k;
      -- Validate scenario ID exists in trusted catalog
      if exists (select 1 from public.scenario_catalog where id = k) then
        entry_score := coalesce((entry_data->'assessment'->>'score')::numeric, 0);
        entry_resp := coalesce(entry_data->'thinking'->>'response', '');

        -- Count as completed if explicitly flagged completed or score >= 7
        if coalesce((entry_data->>'completed')::boolean, false) or entry_score >= 7 then
          -- Count current distinct completions before inserting
          select count(distinct scenario_id) into v_count
          from public.progress
          where user_id = target_id;

          -- Enforce 5-free question limit unless verified paid or admin
          if v_count < 5 or v_is_paid or v_is_admin then
            insert into public.progress (user_id, scenario_id, completed_at)
            values (target_id, k, now())
            on conflict (user_id, scenario_id) do nothing;
          end if;
        end if;
      end if;
    end loop;
  end if;

  -- Derive completed count and contest eligibility from authoritative progress table
  select count(distinct scenario_id) into v_count
  from public.progress
  where user_id = target_id;

  v_eligible := (v_count >= 18);

  perform set_config('app.trusted_operation', 'true', true);

  update public.profiles
  set completed_count = v_count,
      contest_eligible = v_eligible,
      last_active = now()
  where id = target_id;

  return jsonb_build_object(
    'success', true,
    'user_id', target_id,
    'completed_count', v_count,
    'contest_eligible', v_eligible,
    'paid_unlocked', v_is_paid,
    'is_admin', v_is_admin
  );
end;
$$;

-- 4. Learning Progress & Progress Tables
create table if not exists public.learning_progress (
  user_id uuid references auth.users on delete cascade primary key,
  state jsonb not null default '{"entries":{},"resetAt":0}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.learning_progress enable row level security;

create table if not exists public.progress (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade not null,
  scenario_id text not null,
  completed_at timestamptz default now(),
  unique (user_id, scenario_id)
);

alter table public.progress enable row level security;

-- 5. Payments Table (₹49 Course Unlock for Questions 6+)
create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  amount numeric not null default 49,
  currency text not null default 'INR',
  payment_method text not null default 'UPI',
  upi_id text not null default 'ramgokul1987@axisbank',
  transaction_reference text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  admin_notes text,
  submitted_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payments enable row level security;

-- 6. Contests Table
create table if not exists public.contests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  instructions text,
  rules text,
  scenario_text text not null,
  scenario_id text,
  entry_fee numeric not null default 0,
  currency text not null default 'INR',
  first_prize text not null default '₹1,000',
  second_prize text not null default '₹500',
  third_prize text not null default '₹250',
  audience_type text not null default 'ALL' check (audience_type in ('ALL', 'SELECTED', 'INVITED')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'PAUSED', 'REGISTRATION_CLOSED', 'CONTEST_CLOSED', 'EVALUATION', 'RESULTS_PUBLISHED', 'ARCHIVED')),
  start_date timestamptz,
  end_date timestamptz,
  results_published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contests enable row level security;

-- 7. Contest Eligibility Table
create table if not exists public.contest_eligibility (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  is_invited boolean not null default true,
  created_at timestamptz not null default now(),
  constraint uq_contest_eligibility unique (contest_id, user_id)
);

alter table public.contest_eligibility enable row level security;

-- 8. Contest Registrations Table
create table if not exists public.contest_registrations (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  agreed_rules boolean not null default false,
  agreed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_contest_registrations unique (contest_id, user_id)
);

alter table public.contest_registrations enable row level security;

-- 9. Contest Attempts Table (Strictly 1 official attempt per user per contest)
create table if not exists public.contest_attempts (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  elapsed_seconds integer not null default 0,
  draft_response text,
  final_response text,
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT', 'CANCELLED')),
  updated_at timestamptz not null default now(),
  constraint uq_contest_attempts unique (contest_id, user_id)
);

alter table public.contest_attempts enable row level security;

-- 10. Contest Evaluations Table
create table if not exists public.contest_evaluations (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id bigint references public.contest_attempts(id) on delete cascade,
  score_req_understanding numeric not null default 0 check (score_req_understanding between 0 and 20),
  score_data_identification numeric not null default 0 check (score_data_identification between 0 and 15),
  score_logical_sequence numeric not null default 0 check (score_logical_sequence between 0 and 25),
  score_operation_reasoning numeric not null default 0 check (score_operation_reasoning between 0 and 25),
  score_completeness_clarity numeric not null default 0 check (score_completeness_clarity between 0 and 15),
  admin_final_score numeric not null default 0 check (admin_final_score between 0 and 100),
  ai_suggested_score numeric,
  ai_suggested_breakdown jsonb,
  evaluation_status text not null default 'DRAFT' check (evaluation_status in ('DRAFT', 'FINALIZED')),
  admin_feedback text,
  evaluated_by uuid references auth.users(id) on delete set null,
  evaluated_at timestamptz,
  finalized_at timestamptz,
  rank integer,
  constraint uq_contest_evaluations unique (contest_id, user_id)
);

alter table public.contest_evaluations enable row level security;

-- 11. Contest Payments Table
create table if not exists public.contest_payments (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null default 49,
  currency text not null default 'INR',
  status text not null default 'PENDING' check (status in ('PENDING', 'VERIFIED', 'FAILED', 'REFUNDED')),
  payment_method text not null default 'MANUAL_VERIFICATION',
  transaction_ref text,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_contest_payments unique (contest_id, user_id)
);

alter table public.contest_payments enable row level security;

-- Protection triggers on payments and contest_payments: prevent learners from modifying verification status,
-- verifier identity, or verified timestamps directly
create or replace function public.protect_payment_verification_fields()
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

  if not is_admin_caller and not trusted_op then
    if tg_op = 'INSERT' then
      new.status := lower(coalesce(new.status, 'pending'));
      if new.status <> 'pending' then
        raise exception 'Learners may only submit payment requests with pending status.';
      end if;
      new.amount := 49;
      new.currency := 'INR';
      new.verified_at := null;
      new.verified_by := null;
    elsif tg_op = 'UPDATE' then
      raise exception 'Learners are not permitted to modify payment records directly.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_payment_verification_fields on public.payments;
create trigger trg_protect_payment_verification_fields
  before insert or update on public.payments
  for each row execute procedure public.protect_payment_verification_fields();

create or replace function public.protect_contest_payment_verification_fields()
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

  if not is_admin_caller and not trusted_op then
    if tg_op = 'INSERT' then
      new.status := upper(coalesce(new.status, 'PENDING'));
      if new.status <> 'PENDING' then
        raise exception 'Learners may only submit contest payment requests with PENDING status.';
      end if;
      new.currency := 'INR';
      new.verified_at := null;
      new.verified_by := null;
    elsif tg_op = 'UPDATE' then
      raise exception 'Learners are not permitted to modify contest payment records directly.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_contest_payment_verification_fields on public.contest_payments;
create trigger trg_protect_contest_payment_verification_fields
  before insert or update on public.contest_payments
  for each row execute procedure public.protect_contest_payment_verification_fields();

-- Secure merge_learning_progress function with safe search_path
create or replace function public.merge_learning_progress(
  incoming jsonb,
  expected_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  current_state jsonb;
  merged_entries jsonb;
  incoming_entries jsonb;
  incoming_reset bigint;
  current_reset bigint;
  key text;
  inc_entry jsonb;
  cur_entry jsonb;
begin
  if auth.uid() is null or (auth.uid() <> expected_user and not public.is_admin()) then
    raise exception 'Unauthorized user progress merge';
  end if;

  select state into current_state
  from public.learning_progress
  where user_id = expected_user
  for update;

  if current_state is null then
    current_state := '{"entries":{},"resetAt":0}'::jsonb;
  end if;

  incoming_reset := coalesce((incoming->>'resetAt')::bigint, 0);
  current_reset := coalesce((current_state->>'resetAt')::bigint, 0);

  if incoming_reset > current_reset then
    current_state := jsonb_set(current_state, '{resetAt}', to_jsonb(incoming_reset));
    current_reset := incoming_reset;
  end if;

  incoming_entries := coalesce(incoming->'entries', '{}'::jsonb);
  merged_entries := coalesce(current_state->'entries', '{}'::jsonb);

  for key in select jsonb_object_keys(incoming_entries) loop
    inc_entry := incoming_entries->key;
    cur_entry := merged_entries->key;

    if coalesce((inc_entry->>'updatedAt')::bigint, 0) < current_reset then
      continue;
    end if;

    if cur_entry is null or coalesce((inc_entry->>'updatedAt')::bigint, 0) >= coalesce((cur_entry->>'updatedAt')::bigint, 0) then
      merged_entries := jsonb_set(merged_entries, array[key], inc_entry);
    end if;
  end loop;

  current_state := jsonb_set(current_state, '{entries}', merged_entries);

  if incoming ? 'levelFeedback' then
    current_state := jsonb_set(
      current_state,
      '{levelFeedback}',
      coalesce(current_state->'levelFeedback', '{}'::jsonb) || coalesce(incoming->'levelFeedback', '{}'::jsonb)
    );
  end if;

  if incoming ? 'skills' then
    current_state := jsonb_set(
      current_state,
      '{skills}',
      coalesce(current_state->'skills', '{}'::jsonb) || coalesce(incoming->'skills', '{}'::jsonb)
    );
  end if;

  insert into public.learning_progress (user_id, state, updated_at)
  values (expected_user, current_state, now())
  on conflict (user_id) do update
  set state = excluded.state,
      updated_at = now();

  return current_state;
end;
$$;

-- ============================================================
-- Row Level Security (RLS) Policies
-- ============================================================

-- PROFILES
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles" on public.profiles for select using (public.is_admin());

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

drop policy if exists "Admins can update all profiles" on public.profiles;
create policy "Admins can update all profiles" on public.profiles for update using (public.is_admin());

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);

-- ADMIN USERS
drop policy if exists "Admins can view admin_users" on public.admin_users;
create policy "Admins can view admin_users" on public.admin_users for select using (public.is_admin());

drop policy if exists "Admins can manage admin_users" on public.admin_users;
create policy "Admins can manage admin_users" on public.admin_users for all using (public.is_admin());

-- LEARNING PROGRESS
drop policy if exists "Users can view own learning progress" on public.learning_progress;
create policy "Users can view own learning progress" on public.learning_progress for select using (auth.uid() = user_id);

drop policy if exists "Admins can view all learning progress" on public.learning_progress;
create policy "Admins can view all learning progress" on public.learning_progress for select using (public.is_admin());

drop policy if exists "Users can update own learning progress" on public.learning_progress;
create policy "Users can update own learning progress" on public.learning_progress for update using (auth.uid() = user_id);

drop policy if exists "Users can insert own learning progress" on public.learning_progress;
create policy "Users can insert own learning progress" on public.learning_progress for insert with check (auth.uid() = user_id);

-- PROGRESS
drop policy if exists "Users can view own progress" on public.progress;
create policy "Users can view own progress" on public.progress for select using (auth.uid() = user_id);

drop policy if exists "Admins can view all progress" on public.progress;
create policy "Admins can view all progress" on public.progress for select using (public.is_admin());

drop policy if exists "Users can insert own progress" on public.progress;
create policy "Users can insert own progress" on public.progress for insert with check (auth.uid() = user_id);

-- PAYMENTS (COURSE UNLOCK)
drop policy if exists "Users can view own payments" on public.payments;
create policy "Users can view own payments" on public.payments for select using (auth.uid() = user_id);

drop policy if exists "Admins can view all payments" on public.payments;
create policy "Admins can view all payments" on public.payments for select using (public.is_admin());

drop policy if exists "Users can create pending payment" on public.payments;
create policy "Users can create pending payment" on public.payments for insert
  with check (auth.uid() = user_id and status = 'pending' and amount = 49);

drop policy if exists "Admins can manage payments" on public.payments;
create policy "Admins can manage payments" on public.payments for all using (public.is_admin());

-- CONTESTS
drop policy if exists "Admins have full access to contests" on public.contests;
create policy "Admins have full access to contests" on public.contests for all using (public.is_admin());

drop policy if exists "Eligible learners can view active contests" on public.contests;
create policy "Eligible learners can view active contests" on public.contests for select
  using (
    status in ('PUBLISHED', 'REGISTRATION_CLOSED', 'CONTEST_CLOSED', 'EVALUATION', 'RESULTS_PUBLISHED')
    and (
      audience_type = 'ALL'
      or exists (
        select 1 from public.contest_eligibility e
        where e.contest_id = public.contests.id
          and e.user_id = auth.uid()
      )
    )
  );

-- CONTEST ELIGIBILITY
drop policy if exists "Admins have full access to contest eligibility" on public.contest_eligibility;
create policy "Admins have full access to contest eligibility" on public.contest_eligibility for all using (public.is_admin());

drop policy if exists "Users can view own contest eligibility" on public.contest_eligibility;
create policy "Users can view own contest eligibility" on public.contest_eligibility for select using (auth.uid() = user_id);

-- CONTEST REGISTRATIONS
drop policy if exists "Admins have full access to contest registrations" on public.contest_registrations;
create policy "Admins have full access to contest registrations" on public.contest_registrations for all using (public.is_admin());

drop policy if exists "Users can view own contest registration" on public.contest_registrations;
create policy "Users can view own contest registration" on public.contest_registrations for select using (auth.uid() = user_id);

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

-- CONTEST ATTEMPTS
drop policy if exists "Admins have full access to contest attempts" on public.contest_attempts;
create policy "Admins have full access to contest attempts" on public.contest_attempts for all using (public.is_admin());

drop policy if exists "Users can view own contest attempt" on public.contest_attempts;
create policy "Users can view own contest attempt" on public.contest_attempts for select using (auth.uid() = user_id);

drop policy if exists "Verified users can create single attempt" on public.contest_attempts;
drop policy if exists "Users can create single contest attempt" on public.contest_attempts;
drop policy if exists "Authorized users can create single attempt" on public.contest_attempts;
create policy "Authorized users can create single attempt" on public.contest_attempts for insert
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

drop policy if exists "Users can update own in-progress contest attempt" on public.contest_attempts;
create policy "Users can update own in-progress contest attempt" on public.contest_attempts for update
  using (auth.uid() = user_id and status = 'IN_PROGRESS');

-- CONTEST EVALUATIONS
drop policy if exists "Admins have full access to contest evaluations" on public.contest_evaluations;
create policy "Admins have full access to contest evaluations" on public.contest_evaluations for all using (public.is_admin());

drop policy if exists "Users can view own evaluation when results published" on public.contest_evaluations;
create policy "Users can view own evaluation when results published" on public.contest_evaluations for select
  using (
    auth.uid() = user_id
    and evaluation_status = 'FINALIZED'
    and exists (
      select 1 from public.contests c
      where c.id = contest_id and c.status = 'RESULTS_PUBLISHED'
    )
  );

-- CONTEST PAYMENTS
drop policy if exists "Admins have full access to contest payments" on public.contest_payments;
drop policy if exists "Users can view own contest payment" on public.contest_payments;
drop policy if exists "Users can create pending payment record" on public.contest_payments;
drop policy if exists "Users can create contest payment" on public.contest_payments;
drop policy if exists "Users can create pending contest payment" on public.contest_payments;

create policy "Admins have full access to contest payments" on public.contest_payments for all using (public.is_admin());
create policy "Users can view own contest payment" on public.contest_payments for select using (auth.uid() = user_id);
create policy "Users can create pending contest payment" on public.contest_payments for insert
  with check (
    auth.uid() = user_id
    and status = 'PENDING'
    and currency = 'INR'
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
        and amount = c.entry_fee
    )
  );

-- ============================================================
-- Atomic Transactional RPCs for Payments
-- ============================================================

-- Safely resolve existing duplicate references among verified payments before creating uniqueness constraints
do $$
declare
  r record;
begin
  for r in (
    select id, transaction_reference,
           row_number() over (
             partition by upper(regexp_replace(trim(transaction_reference), '[^A-Za-z0-9]', '', 'g'))
             order by coalesce(verified_at, created_at) asc, id asc
           ) as rn
    from public.payments
    where status = 'verified'
      and trim(coalesce(transaction_reference, '')) <> ''
  ) loop
    if r.rn > 1 then
      update public.payments
      set admin_notes = coalesce(admin_notes, '') || ' [Automated Cleanup: Duplicate reference detected; duplicate verification flagged]',
          status = 'rejected'
      where id = r.id;
    end if;
  end loop;
end $$;

-- Uniqueness constraint on normalized reference for verified practice payments
create unique index if not exists uq_verified_payments_norm_ref
  on public.payments (upper(regexp_replace(trim(transaction_reference), '[^A-Za-z0-9]', '', 'g')))
  where status = 'verified' and trim(coalesce(transaction_reference, '')) <> '';

create or replace function public.verify_learner_payment(p_payment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_norm_ref text;
  v_dup_id bigint;
  v_contest_dup_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Permission denied: Administrator privileges required.';
  end if;

  if p_payment_id is null then
    raise exception 'Payment ID is required.';
  end if;

  -- Lock payment row for atomic transaction
  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Payment record % not found.', p_payment_id;
  end if;

  -- Validate payment type
  if coalesce(v_payment.payment_method, 'UPI') not in ('UPI', 'MANUAL_VERIFICATION') then
    raise exception 'Invalid payment type: %.', v_payment.payment_method;
  end if;

  -- Validate payment amount
  if v_payment.amount <> 49 then
    raise exception 'Invalid practice payment amount: expected ₹49, found ₹%.', v_payment.amount;
  end if;

  -- Validate payment status
  if v_payment.status not in ('pending', 'verified', 'rejected') then
    raise exception 'Invalid payment status: %.', v_payment.status;
  end if;

  -- Validate reference
  if trim(coalesce(v_payment.transaction_reference, '')) = '' then
    raise exception 'Payment missing valid transaction reference.';
  end if;

  -- Documented normalization rule: uppercase alphanumeric only
  v_norm_ref := upper(regexp_replace(trim(v_payment.transaction_reference), '[^A-Za-z0-9]', '', 'g'));

  if length(v_norm_ref) < 4 then
    raise exception 'Invalid transaction reference format: %.', v_payment.transaction_reference;
  end if;

  -- Check for duplicate reference already credited to another verified payment (different account or record)
  select id into v_dup_id
  from public.payments
  where id <> p_payment_id
    and status = 'verified'
    and upper(regexp_replace(trim(transaction_reference), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
  limit 1;

  if v_dup_id is not null then
    raise exception 'Duplicate transaction reference: reference % is already verified on practice payment #%.', v_payment.transaction_reference, v_dup_id;
  end if;

  -- Prevent the same actual payment being credited to multiple payment purposes (contest entry fee)
  select id into v_contest_dup_id
  from public.contest_payments
  where status = 'VERIFIED'
    and upper(regexp_replace(trim(coalesce(transaction_ref, '')), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
  limit 1;

  if v_contest_dup_id is not null then
    raise exception 'Duplicate transaction reference: reference % is already credited to contest payment #%.', v_payment.transaction_reference, v_contest_dup_id;
  end if;

  -- Update payment to verified (idempotent for repeated verification)
  update public.payments
  set status = 'verified',
      verified_at = coalesce(v_payment.verified_at, now()),
      verified_by = coalesce(v_payment.verified_by, auth.uid()),
      updated_at = now()
  where id = p_payment_id;

  -- Atomically unlock learner profile
  perform set_config('app.trusted_operation', 'true', true);

  update public.profiles
  set paid_unlocked = true,
      last_active = now()
  where id = v_payment.user_id;

  -- Return confirmed authoritative access state
  return jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'user_id', v_payment.user_id,
    'status', 'verified',
    'paid_unlocked', true,
    'verified_at', coalesce(v_payment.verified_at, now()),
    'verified_by', coalesce(v_payment.verified_by, auth.uid())
  );
end;
$$;

create or replace function public.reject_learner_payment(p_payment_id bigint, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_has_other_verified boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Permission denied: Administrator privileges required.';
  end if;

  if p_payment_id is null then
    raise exception 'Payment ID is required.';
  end if;

  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Payment record % not found.', p_payment_id;
  end if;

  update public.payments
  set status = 'rejected',
      admin_notes = coalesce(p_reason, admin_notes),
      verified_at = now(),
      verified_by = auth.uid(),
      updated_at = now()
  where id = p_payment_id;

  -- Crucial Rule: Rejecting a duplicate pending request must not revoke access granted by an earlier valid payment
  select exists (
    select 1 from public.payments
    where user_id = v_payment.user_id
      and id <> p_payment_id
      and status = 'verified'
  ) into v_has_other_verified;

  if not v_has_other_verified then
    perform set_config('app.trusted_operation', 'true', true);
    update public.profiles
    set paid_unlocked = false,
        last_active = now()
    where id = v_payment.user_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'user_id', v_payment.user_id,
    'status', 'rejected',
    'paid_unlocked', v_has_other_verified,
    'admin_notes', coalesce(p_reason, v_payment.admin_notes)
  );
end;
$$;

create or replace function public.verify_contest_payment(p_payment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_cpay public.contest_payments%rowtype;
  v_norm_ref text;
  v_dup_id bigint;
  v_practice_dup_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Permission denied: Administrator privileges required.';
  end if;

  if p_payment_id is null then
    raise exception 'Payment ID is required.';
  end if;

  select * into v_cpay
  from public.contest_payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Contest payment record % not found.', p_payment_id;
  end if;

  if v_cpay.status not in ('PENDING', 'VERIFIED', 'FAILED') then
    raise exception 'Invalid contest payment status: %.', v_cpay.status;
  end if;

  if trim(coalesce(v_cpay.transaction_ref, '')) <> '' then
    v_norm_ref := upper(regexp_replace(trim(v_cpay.transaction_ref), '[^A-Za-z0-9]', '', 'g'));

    -- Check duplicate among contest payments
    select id into v_dup_id
    from public.contest_payments
    where id <> p_payment_id
      and status = 'VERIFIED'
      and upper(regexp_replace(trim(coalesce(transaction_ref, '')), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
    limit 1;

    if v_dup_id is not null then
      raise exception 'Duplicate transaction reference: reference % is already verified on contest payment #%.', v_cpay.transaction_ref, v_dup_id;
    end if;

    -- Prevent same payment reference being used across purposes (practice payments)
    select id into v_practice_dup_id
    from public.payments
    where status = 'verified'
      and upper(regexp_replace(trim(coalesce(transaction_reference), '')), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
    limit 1;

    if v_practice_dup_id is not null then
      raise exception 'Duplicate transaction reference: reference % is already credited to practice payment #%.', v_cpay.transaction_ref, v_practice_dup_id;
    end if;
  end if;

  update public.contest_payments
  set status = 'VERIFIED',
      verified_at = coalesce(v_cpay.verified_at, now()),
      verified_by = coalesce(v_cpay.verified_by, auth.uid()),
      updated_at = now()
  where id = p_payment_id;

  return jsonb_build_object(
    'success', true,
    'contest_id', v_cpay.contest_id,
    'user_id', v_cpay.user_id,
    'status', 'VERIFIED',
    'verified_at', coalesce(v_cpay.verified_at, now()),
    'verified_by', coalesce(v_cpay.verified_by, auth.uid())
  );
end;
$$;

-- ============================================================
-- Contest Lifecycle, Authoritative Timer & Server Operations
-- ============================================================

alter table public.contests
  add column if not exists duration_minutes integer not null default 30;

alter table public.contest_attempts
  add column if not exists deadline timestamptz;

create or replace function public.protect_contest_attempt_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  is_admin_caller boolean;
  trusted_op boolean;
  contest_rec record;
  calc_deadline timestamptz;
begin
  trusted_op := coalesce(current_setting('app.trusted_operation', true), 'false') = 'true';
  is_admin_caller := public.is_admin();

  if tg_op = 'INSERT' then
    if not is_admin_caller and not trusted_op then
      new.started_at := now();
      new.submitted_at := null;
      new.elapsed_seconds := 0;
      new.status := 'IN_PROGRESS';

      select duration_minutes, end_date into contest_rec
      from public.contests
      where id = new.contest_id;

      calc_deadline := now() + (coalesce(contest_rec.duration_minutes, 30) || ' minutes')::interval;
      if contest_rec.end_date is not null and contest_rec.end_date < calc_deadline then
        calc_deadline := contest_rec.end_date;
      end if;
      new.deadline := calc_deadline;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if not is_admin_caller and not trusted_op then
      if new.user_id is distinct from old.user_id then
        raise exception 'Changing contest attempt ownership is prohibited.';
      end if;
      if new.contest_id is distinct from old.contest_id then
        raise exception 'Changing contest ID on an attempt is prohibited.';
      end if;
      if new.started_at is distinct from old.started_at then
        raise exception 'Modifying attempt started_at timestamp is prohibited.';
      end if;
      if new.deadline is distinct from old.deadline then
        raise exception 'Modifying attempt deadline is prohibited.';
      end if;

      -- Cannot reopen or modify a submitted or timed-out attempt
      if old.status in ('SUBMITTED', 'TIMED_OUT') then
        if new.status is distinct from old.status or new.final_response is distinct from old.final_response then
          raise exception 'Reopening or modifying a submitted or timed-out contest attempt is prohibited.';
        end if;
      end if;

      if old.status = 'IN_PROGRESS' and new.status = 'IN_PROGRESS' then
        new.started_at := old.started_at;
        new.deadline := old.deadline;
        new.final_response := old.final_response;
        new.submitted_at := old.submitted_at;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_contest_attempt_integrity on public.contest_attempts;
create trigger trg_protect_contest_attempt_integrity
  before insert or update on public.contest_attempts
  for each row execute procedure public.protect_contest_attempt_integrity();

create or replace function public.start_contest_attempt(p_contest_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid;
  v_is_admin boolean;
  v_contest record;
  v_existing record;
  v_deadline timestamptz;
  v_completed_count integer;
  v_elig_exists boolean;
  v_reg_exists boolean;
  v_pay_status text;
  v_attempt record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to start a contest attempt.';
  end if;

  v_is_admin := public.is_admin();

  select * into v_existing
  from public.contest_attempts
  where contest_id = p_contest_id and user_id = v_uid;

  if v_existing is not null then
    return jsonb_build_object(
      'success', true,
      'is_new', false,
      'attempt', row_to_json(v_existing),
      'server_time', now(),
      'deadline', v_existing.deadline,
      'status', v_existing.status
    );
  end if;

  select * into v_contest
  from public.contests
  where id = p_contest_id;

  if v_contest is null then
    raise exception 'Contest not found.';
  end if;

  if v_contest.status <> 'PUBLISHED' then
    raise exception 'Contest is not open for new attempts (status: %).', v_contest.status;
  end if;

  if v_contest.start_date is not null and now() < v_contest.start_date then
    raise exception 'Contest has not started yet. Starts at %.', v_contest.start_date;
  end if;
  if v_contest.end_date is not null and now() > v_contest.end_date then
    raise exception 'Contest has ended. Ended at %.', v_contest.end_date;
  end if;

  if v_contest.audience_type <> 'ALL' and not v_is_admin then
    select exists (
      select 1 from public.contest_eligibility
      where contest_id = p_contest_id and user_id = v_uid
    ) into v_elig_exists;

    if not v_elig_exists then
      raise exception 'You are not invited to participate in this targeted contest.';
    end if;
  end if;

  if not v_is_admin then
    select coalesce(completed_count, 0) into v_completed_count
    from public.profiles
    where id = v_uid;

    if v_completed_count < 18 then
      select count(distinct scenario_id) into v_completed_count
      from public.progress
      where user_id = v_uid;
    end if;

    if v_completed_count < 18 then
      raise exception 'Qualification required: You must complete at least 18 SQL thinking challenges to enter official contests.';
    end if;
  end if;

  select coalesce(agreed_rules, false) into v_reg_exists
  from public.contest_registrations
  where contest_id = p_contest_id and user_id = v_uid;

  if not v_reg_exists then
    raise exception 'You must read and agree to official contest rules before starting.';
  end if;

  if coalesce(v_contest.entry_fee, 0) > 0 and not v_is_admin then
    select status into v_pay_status
    from public.contest_payments
    where contest_id = p_contest_id and user_id = v_uid;

    if v_pay_status is distinct from 'VERIFIED' then
      raise exception 'A verified contest entry payment is required to start your attempt.';
    end if;
  end if;

  v_deadline := now() + (coalesce(v_contest.duration_minutes, 30) || ' minutes')::interval;
  if v_contest.end_date is not null and v_contest.end_date < v_deadline then
    v_deadline := v_contest.end_date;
  end if;

  perform set_config('app.trusted_operation', 'true', true);

  insert into public.contest_attempts (
    contest_id,
    user_id,
    started_at,
    deadline,
    elapsed_seconds,
    draft_response,
    status
  ) values (
    p_contest_id,
    v_uid,
    now(),
    v_deadline,
    '',
    'IN_PROGRESS'
  )
  on conflict (contest_id, user_id) do nothing;

  select * into v_attempt
  from public.contest_attempts
  where contest_id = p_contest_id and user_id = v_uid;

  return jsonb_build_object(
    'success', true,
    'is_new', true,
    'attempt', row_to_json(v_attempt),
    'server_time', now(),
    'deadline', v_attempt.deadline,
    'duration_minutes', coalesce(v_contest.duration_minutes, 30)
  );
end;
$$;

create or replace function public.save_contest_draft(
  p_contest_id uuid,
  p_draft_response text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid;
  v_attempt record;
  v_rows_affected integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to save draft.';
  end if;

  select * into v_attempt
  from public.contest_attempts
  where contest_id = p_contest_id and user_id = v_uid;

  if v_attempt is null then
    raise exception 'No active contest attempt found.';
  end if;

  if v_attempt.status <> 'IN_PROGRESS' then
    raise exception 'Cannot update draft for attempt with status %.', v_attempt.status;
  end if;

  if v_attempt.deadline is not null and now() > (v_attempt.deadline + interval '60 seconds') then
    raise exception 'Contest deadline has passed. Drafts can no longer be updated.';
  end if;

  perform set_config('app.trusted_operation', 'true', true);

  update public.contest_attempts
  set draft_response = p_draft_response,
      updated_at = now()
  where contest_id = p_contest_id and user_id = v_uid and status = 'IN_PROGRESS';

  get diagnostics v_rows_affected = row_count;

  if v_rows_affected = 0 then
    raise exception 'Failed to update draft: attempt is no longer active.';
  end if;

  return jsonb_build_object(
    'success', true,
    'saved_at', now(),
    'rows_affected', v_rows_affected
  );
end;
$$;

create or replace function public.submit_contest_attempt(
  p_contest_id uuid,
  p_final_response text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid;
  v_attempt record;
  v_is_past_deadline boolean;
  v_final_status text;
  v_elapsed integer;
  v_clean_response text;
  v_updated record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to submit contest attempt.';
  end if;

  select * into v_attempt
  from public.contest_attempts
  where contest_id = p_contest_id and user_id = v_uid;

  if v_attempt is null then
    raise exception 'No contest attempt found to submit.';
  end if;

  if v_attempt.status = 'SUBMITTED' then
    return jsonb_build_object(
      'success', true,
      'already_submitted', true,
      'status', 'SUBMITTED',
      'attempt', row_to_json(v_attempt),
      'elapsed_seconds', v_attempt.elapsed_seconds,
      'submitted_at', v_attempt.submitted_at
    );
  end if;

  v_is_past_deadline := (v_attempt.deadline is not null and now() > (v_attempt.deadline + interval '60 seconds'));
  v_final_status := case when v_is_past_deadline then 'TIMED_OUT' else 'SUBMITTED' end;

  v_elapsed := greatest(0, extract(epoch from (now() - v_attempt.started_at))::integer);
  v_clean_response := coalesce(nullif(trim(p_final_response), ''), v_attempt.draft_response, '');

  if v_clean_response = '' and v_final_status = 'SUBMITTED' then
    raise exception 'Cannot submit an empty contest response.';
  end if;

  perform set_config('app.trusted_operation', 'true', true);

  update public.contest_attempts
  set final_response = v_clean_response,
      submitted_at = now(),
      elapsed_seconds = v_elapsed,
      status = v_final_status,
      updated_at = now()
  where contest_id = p_contest_id and user_id = v_uid;

  select * into v_updated
  from public.contest_attempts
  where contest_id = p_contest_id and user_id = v_uid;

  return jsonb_build_object(
    'success', (v_final_status = 'SUBMITTED'),
    'status', v_final_status,
    'attempt', row_to_json(v_updated),
    'elapsed_seconds', v_elapsed,
    'submitted_at', v_updated.submitted_at,
    'deadline_exceeded', v_is_past_deadline
  );
end;
$$;

-- Stored Procedure for secure, admin-only payment reconciliation
create or replace function public.admin_reconcile_payment(
  p_payment_id text,
  p_order_id text default null,
  p_customer_email text default null,
  p_amount_paise integer default 4900,
  p_currency text default 'INR',
  p_admin_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_caller_is_admin boolean := false;
  v_matched_user_id uuid;
  v_matched_count integer := 0;
  v_matched_username text;
  v_existing_dup bigint;
  v_now timestamptz := now();
  v_existing_pay_id bigint;
begin
  -- 1. Security: Authoritatively verify caller is administrator
  v_caller_is_admin := public.is_admin();
  if not v_caller_is_admin then
    raise exception 'Unauthorized: Only authorized administrators can reconcile customer payments.';
  end if;

  -- 2. Input validation
  if p_payment_id is null or trim(p_payment_id) = '' then
    raise exception 'Payment ID is required for reconciliation.';
  end if;

  if p_amount_paise is null or p_amount_paise <> 4900 then
    raise exception 'Invalid amount: Expected 4900 paise (₹49).';
  end if;

  if p_currency is null or upper(trim(p_currency)) <> 'INR' then
    raise exception 'Invalid currency: Expected INR.';
  end if;

  -- 3. Identify exact application user in public.profiles
  if p_customer_email is not null and trim(p_customer_email) <> '' then
    select count(*), max(id), max(username)
    into v_matched_count, v_matched_user_id, v_matched_username
    from public.profiles
    where lower(email) = lower(trim(p_customer_email));
  end if;

  -- Fallback lookup via razorpay_orders if email query had no match
  if v_matched_user_id is null and p_order_id is not null and trim(p_order_id) <> '' then
    select count(distinct user_id), max(user_id)
    into v_matched_count, v_matched_user_id
    from public.razorpay_orders
    where id = trim(p_order_id);

    if v_matched_user_id is not null then
      select username into v_matched_username
      from public.profiles
      where id = v_matched_user_id;
    end if;
  end if;

  -- If no unique match exists, fail closed with "NEEDS REVIEW"
  if v_matched_count = 0 or v_matched_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'NO_USER_MATCH',
      'status', 'NEEDS REVIEW',
      'error', 'No unique matching user profile found in application. Needs review.'
    );
  end if;

  if v_matched_count > 1 then
    return jsonb_build_object(
      'success', false,
      'code', 'AMBIGUOUS_USER_MATCH',
      'status', 'NEEDS REVIEW',
      'error', 'Multiple user accounts match this identity. Needs manual review.'
    );
  end if;

  -- 4. Anti-reuse check: prevent duplicate payment ID reuse across different users
  select id into v_existing_dup
  from public.payments
  where transaction_reference = trim(p_payment_id)
    and user_id <> v_matched_user_id
    and status = 'verified'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  select id into v_existing_dup
  from public.contest_payments
  where transaction_ref = trim(p_payment_id)
    and user_id <> v_matched_user_id
    and status = 'VERIFIED'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  -- 5. Idempotent payment recording in public.payments
  select id into v_existing_pay_id
  from public.payments
  where transaction_reference in (trim(p_payment_id), trim(coalesce(p_order_id, '')))
    and user_id = v_matched_user_id
  limit 1;

  if v_existing_pay_id is not null then
    update public.payments
    set status = 'verified',
        transaction_reference = trim(p_payment_id),
        verified_at = coalesce(verified_at, v_now),
        verified_by = coalesce(verified_by, auth.uid()::text),
        admin_notes = coalesce(p_admin_notes, 'Admin reconciliation verified'),
        updated_at = v_now
    where id = v_existing_pay_id;
  else
    insert into public.payments (
      user_id,
      user_email,
      amount,
      currency,
      payment_method,
      transaction_reference,
      status,
      submitted_at,
      verified_at,
      verified_by,
      admin_notes,
      updated_at
    ) values (
      v_matched_user_id,
      trim(p_customer_email),
      49,
      'INR',
      'RAZORPAY',
      trim(p_payment_id),
      'verified',
      v_now,
      v_now,
      auth.uid()::text,
      coalesce(p_admin_notes, 'Admin reconciliation verified'),
      v_now
    );
  end if;

  -- Update razorpay_orders if order_id is provided
  if p_order_id is not null and trim(p_order_id) <> '' then
    update public.razorpay_orders
    set status = 'paid',
        payment_id = trim(p_payment_id),
        updated_at = v_now
    where id = trim(p_order_id);
  end if;

  -- 6. Atomically set profiles.paid_unlocked = true with trusted operation flag
  perform set_config('app.trusted_operation', 'true', true);
  update public.profiles
  set paid_unlocked = true,
      last_active = v_now
  where id = v_matched_user_id;

  return jsonb_build_object(
    'success', true,
    'status', 'verified',
    'user_id', v_matched_user_id,
    'username', v_matched_username,
    'email', trim(p_customer_email),
    'payment_id', trim(p_payment_id),
    'order_id', trim(coalesce(p_order_id, '')),
    'message', 'Payment successfully reconciled and premium access unlocked.'
  );
end;
$$;

-- Grant permissions on functions
grant execute on function public.is_admin() to authenticated, anon;
grant execute on function public.admin_reconcile_payment(text, text, text, integer, text, text) to authenticated;
grant execute on function public.sync_user_progress(uuid) to authenticated;
grant execute on function public.verify_learner_payment(bigint) to authenticated;
grant execute on function public.reject_learner_payment(bigint, text) to authenticated;
grant execute on function public.verify_contest_payment(bigint) to authenticated;
grant execute on function public.record_scenario_completion(text, text, numeric) to authenticated;
grant execute on function public.reconcile_user_completions(uuid) to authenticated;
grant execute on function public.start_contest_attempt(uuid) to authenticated;
grant execute on function public.save_contest_draft(uuid, text) to authenticated;
grant execute on function public.submit_contest_attempt(uuid, text) to authenticated;
grant select on table public.scenario_catalog to authenticated, anon;

-- 13. Level Completion Tracking, Immutable Certificates & Public Verification
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  credential_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  recipient_name text not null,
  domain text not null,
  level text not null check (level in ('Beginner', 'Intermediate', 'Expert')),
  course_title text not null,
  description text not null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint uq_certificates_user_domain_level unique (user_id, domain, level)
);

create index if not exists idx_certificates_user_id on public.certificates(user_id);
create index if not exists idx_certificates_credential_id on public.certificates(lower(credential_id));

alter table public.certificates enable row level security;
drop policy if exists "Anyone can read certificates for verification" on public.certificates;
create policy "Anyone can read certificates for verification" on public.certificates for select using (true);
drop policy if exists "No direct insert on certificates" on public.certificates;
create policy "No direct insert on certificates" on public.certificates for insert with check (false);
drop policy if exists "No direct update on certificates" on public.certificates;
create policy "No direct update on certificates" on public.certificates for update using (false);
drop policy if exists "No direct delete on certificates" on public.certificates;
create policy "No direct delete on certificates" on public.certificates for delete using (false);

create or replace function public.get_domain_code(p_domain text)
returns text language sql immutable as $$
  select case lower(trim(p_domain))
    when 'banking' then 'BAN'
    when 'healthcare' then 'HEA'
    when 'insurance' then 'INS'
    when 'capital markets' then 'CAP'
    when 'semiconductor' then 'SEM'
    when 'education' then 'EDU'
    when 'retail' then 'RET'
    else null
  end;
$$;

create or replace function public.get_level_code(p_level text)
returns text language sql immutable as $$
  select case lower(trim(p_level))
    when 'beginner' then 'BEG'
    when 'intermediate' then 'INT'
    when 'expert' then 'EXP'
    else null
  end;
$$;

create or replace function public.claim_level_certificate(
  p_domain text,
  p_level text,
  p_recipient_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_uid uuid;
  v_dom_code text;
  v_lvl_code text;
  v_completed_count int;
  v_clean_name text;
  v_course_title text;
  v_description text;
  v_credential_id text;
  v_existing_cert record;
  v_new_cert record;
  v_rand_hex text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to claim certificate.';
  end if;

  v_dom_code := public.get_domain_code(p_domain);
  v_lvl_code := public.get_level_code(p_level);

  if v_dom_code is null then
    raise exception 'Invalid domain: %', p_domain;
  end if;

  if v_lvl_code is null then
    raise exception 'Invalid level: %', p_level;
  end if;

  select * into v_existing_cert
  from public.certificates
  where user_id = v_uid and domain = p_domain and level = p_level;

  if v_existing_cert.id is not null then
    return jsonb_build_object(
      'success', true,
      'already_issued', true,
      'certificate', jsonb_build_object(
        'id', v_existing_cert.id,
        'credential_id', v_existing_cert.credential_id,
        'recipient_name', v_existing_cert.recipient_name,
        'domain', v_existing_cert.domain,
        'level', v_existing_cert.level,
        'course_title', v_existing_cert.course_title,
        'description', v_existing_cert.description,
        'completed_at', v_existing_cert.completed_at,
        'issuer', 'Data2Dashboard (D2D)',
        'organization', 'Crack SQL Learning Platform'
      )
    );
  end if;

  select count(distinct scenario_id) into v_completed_count
  from public.progress
  where user_id = v_uid
    and scenario_id like (v_dom_code || '_' || v_lvl_code || '_%');

  if v_completed_count < 20 then
    insert into public.progress (user_id, scenario_id)
    select v_uid, k
    from public.learning_progress lp,
         lateral jsonb_each(coalesce(lp.state->'entries', '{}'::jsonb)) as e(k, v)
    where lp.user_id = v_uid
      and k like (v_dom_code || '_' || v_lvl_code || '_%')
      and (
        (v->>'completed')::boolean = true or
        ((v->'assessment'->>'score')::numeric >= 7)
      )
    on conflict (user_id, scenario_id) do nothing;

    select count(distinct scenario_id) into v_completed_count
    from public.progress
    where user_id = v_uid
      and scenario_id like (v_dom_code || '_' || v_lvl_code || '_%');
  end if;

  if v_completed_count < 20 then
    return jsonb_build_object(
      'success', false,
      'code', 'LEVEL_INCOMPLETE',
      'error', 'Level incomplete: ' || v_completed_count || '/20 distinct scenarios completed in ' || p_domain || ' (' || p_level || ').',
      'completed_count', v_completed_count,
      'required_count', 20
    );
  end if;

  v_clean_name := trim(coalesce(p_recipient_name, ''));
  if v_clean_name = '' then
    select username into v_clean_name from public.profiles where id = v_uid;
  end if;
  if v_clean_name is null or trim(v_clean_name) = '' then
    select raw_user_meta_data->>'full_name' into v_clean_name from auth.users where id = v_uid;
  end if;
  if v_clean_name is null or trim(v_clean_name) = '' then
    select split_part(email, '@', 1) into v_clean_name from auth.users where id = v_uid;
  end if;
  if v_clean_name is null or trim(v_clean_name) = '' then
    v_clean_name := 'Learner';
  end if;

  case v_lvl_code
    when 'BEG' then v_course_title := 'Crack SQL: Beginner SQL Practitioner';
    when 'INT' then v_course_title := 'Crack SQL: Intermediate SQL Practitioner';
    when 'EXP' then v_course_title := 'Crack SQL: Expert SQL Practitioner';
  end case;

  v_description := 'Successfully completed 20 scenario-based SQL challenges in ' || p_domain || '.';
  v_rand_hex := upper(substr(md5(random()::text || clock_timestamp()::text || v_uid::text), 1, 6));
  v_credential_id := 'D2D-CSQL-' || v_lvl_code || '-' || to_char(now(), 'YYYY') || '-' || v_rand_hex;

  insert into public.certificates (
    credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at
  ) values (
    v_credential_id, v_uid, v_clean_name, p_domain, p_level, v_course_title, v_description, now()
  )
  on conflict (user_id, domain, level) do update
    set recipient_name = coalesce(nullif(excluded.recipient_name, 'Learner'), public.certificates.recipient_name)
  returning * into v_new_cert;

  return jsonb_build_object(
    'success', true,
    'already_issued', false,
    'certificate', jsonb_build_object(
      'id', v_new_cert.id,
      'credential_id', v_new_cert.credential_id,
      'recipient_name', v_new_cert.recipient_name,
      'domain', v_new_cert.domain,
      'level', v_new_cert.level,
      'course_title', v_new_cert.course_title,
      'description', v_new_cert.description,
      'completed_at', v_new_cert.completed_at,
      'issuer', 'Data2Dashboard (D2D)',
      'organization', 'Crack SQL Learning Platform'
    )
  );
end;
$$;

create or replace function public.verify_certificate(p_credential_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_cert record;
begin
  if p_credential_id is null or trim(p_credential_id) = '' then
    return jsonb_build_object('valid', false, 'message', 'Certificate not found');
  end if;

  select credential_id, recipient_name, domain, level, course_title, description, completed_at
  into v_cert
  from public.certificates
  where lower(credential_id) = lower(trim(p_credential_id));

  if not found then
    return jsonb_build_object('valid', false, 'message', 'Certificate not found');
  end if;

  return jsonb_build_object(
    'valid', true,
    'credential_id', v_cert.credential_id,
    'recipient_name', v_cert.recipient_name,
    'domain', v_cert.domain,
    'level', v_cert.level,
    'course_title', v_cert.course_title,
    'description', v_cert.description,
    'completed_at', v_cert.completed_at,
    'issuer', 'Data2Dashboard (D2D)',
    'organization', 'Crack SQL Learning Platform'
  );
end;
$$;

create or replace function public.get_user_certificates(p_user_id uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_target_id uuid;
  v_certs jsonb;
begin
  v_target_id := coalesce(p_user_id, auth.uid());
  if v_target_id is null then
    return '[]'::jsonb;
  end if;

  if v_target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied: Cannot view another user certificates.';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'credential_id', credential_id,
      'recipient_name', recipient_name,
      'domain', domain,
      'level', level,
      'course_title', course_title,
      'description', description,
      'completed_at', completed_at,
      'issuer', 'Data2Dashboard (D2D)',
      'organization', 'Crack SQL Learning Platform'
    ) order by completed_at desc
  ), '[]'::jsonb) into v_certs
  from public.certificates
  where user_id = v_target_id;

  return v_certs;
end;
$$;

grant select on table public.certificates to authenticated, anon;
grant execute on function public.claim_level_certificate(text, text, text) to authenticated;
grant execute on function public.verify_certificate(text) to authenticated, anon;
grant execute on function public.get_user_certificates(uuid) to authenticated;

-- 16. Question Feedback Table & Policies (Single Source of Truth)
CREATE TABLE IF NOT EXISTS public.question_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  username text,
  question_id text,
  question_title text,
  domain text,
  level text,
  emoji text NOT NULL,
  feedback_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.question_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert question feedback" ON public.question_feedback;
CREATE POLICY "Anyone can insert question feedback" ON public.question_feedback
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view their own question feedback" ON public.question_feedback;
DROP POLICY IF EXISTS "Admins can view all question feedback" ON public.question_feedback;
CREATE POLICY "Users can view their own question feedback" ON public.question_feedback
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());

GRANT SELECT, INSERT ON public.question_feedback TO authenticated, anon;

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
