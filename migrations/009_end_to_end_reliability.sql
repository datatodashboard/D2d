-- ============================================================
-- Migration 009: End-to-End Reliability, Atomic Payments,
-- Strict RLS Database Authorization, and Unification
-- ============================================================

-- 1. Ensure required tables exist with proper constraints
create table if not exists public.admin_users (
  user_id uuid references auth.users on delete cascade primary key,
  role text not null default 'admin',
  created_at timestamptz default now(),
  notes text
);

alter table public.admin_users enable row level security;

-- 2. Authoritative is_admin() function with safe search_path
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

-- 3. Resolve Super Admin datatodashboard2@gmail.com to real auth.users UUID
do $$
declare
  v_super_admin_id uuid;
begin
  select id into v_super_admin_id
  from auth.users
  where lower(email) = 'datatodashboard2@gmail.com'
  limit 1;

  if v_super_admin_id is not null then
    insert into public.admin_users (user_id, role, notes)
    values (v_super_admin_id, 'super_admin', 'Authoritative Super Admin')
    on conflict (user_id) do update
    set role = 'super_admin',
        notes = 'Authoritative Super Admin';

    update public.profiles
    set is_admin = true
    where id = v_super_admin_id;
  end if;
end $$;

-- 4. Protection trigger: prevent non-admins from modifying privileged fields on profiles
-- (admin roles, paid_unlocked, contest_eligible, completed_count)
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

-- 5. Protection triggers on payments: prevent learners from modifying verification status,
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

-- 6. Authoritative Progress Syncing, Trusted Scenario Catalog & 5-Free-Question Rule Enforcement

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

-- Authoritative progress sync
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

  -- Count distinct completed scenarios in public.progress
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

-- Trigger on public.progress: enforce 5-free limit and scenario catalog validation on insert of new questions
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

-- Auto-sync profile completed count whenever progress changes
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

  insert into public.learning_progress (user_id, state, updated_at)
  values (expected_user, current_state, now())
  on conflict (user_id) do update
  set state = excluded.state,
      updated_at = now();

  return current_state;
end;
$$;

-- 7. Atomic Payment Verification & Rejection Transactional RPCs

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
      and upper(regexp_replace(trim(coalesce(transaction_reference, '')), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
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

-- 8. CLEAN UP ALL OLD POLICIES & ENFORCE STRICT DATABASE AUTHORIZATION
-- Dropping all older policies across all migrations (002 through 008) to prevent permissive bypass

-- PROFILES
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Admins can view all profiles" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Admins can update all profiles" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;

create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Admins can view all profiles" on public.profiles for select using (public.is_admin());
create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Admins can update all profiles" on public.profiles for update using (public.is_admin());

-- ADMIN USERS
drop policy if exists "Admins can view admin_users" on public.admin_users;
drop policy if exists "Admins can manage admin_users" on public.admin_users;

create policy "Admins can view admin_users" on public.admin_users for select using (public.is_admin());
create policy "Admins can manage admin_users" on public.admin_users for all using (public.is_admin());

-- LEARNING PROGRESS
drop policy if exists "Users can view own learning progress" on public.learning_progress;
drop policy if exists "Admins can view all learning progress" on public.learning_progress;
drop policy if exists "Admins can view all learning_progress" on public.learning_progress;
drop policy if exists "Users can update own learning progress" on public.learning_progress;
drop policy if exists "Users can insert own learning progress" on public.learning_progress;

create policy "Users can view own learning progress" on public.learning_progress for select using (auth.uid() = user_id);
create policy "Admins can view all learning progress" on public.learning_progress for select using (public.is_admin());
create policy "Users can update own learning progress" on public.learning_progress for update using (auth.uid() = user_id);
create policy "Users can insert own learning progress" on public.learning_progress for insert with check (auth.uid() = user_id);

-- PROGRESS
drop policy if exists "Users can view own progress" on public.progress;
drop policy if exists "Admins can view all progress" on public.progress;
drop policy if exists "Users can insert own progress" on public.progress;

create policy "Users can view own progress" on public.progress for select using (auth.uid() = user_id);
create policy "Admins can view all progress" on public.progress for select using (public.is_admin());
create policy "Users can insert own progress" on public.progress for insert with check (auth.uid() = user_id);

-- PAYMENTS (₹49 PRACTICE COURSE UNLOCK)
drop policy if exists "Users can view own payments" on public.payments;
drop policy if exists "Admins can view all payments" on public.payments;
drop policy if exists "Users can create pending payment" on public.payments;
drop policy if exists "Admins can manage payments" on public.payments;

create policy "Users can view own payments" on public.payments for select using (auth.uid() = user_id);
create policy "Admins can view all payments" on public.payments for select using (public.is_admin());
-- Learners may submit only their own pending payment requests for exactly ₹49 INR
create policy "Users can create pending payment" on public.payments for insert
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and amount = 49
    and currency = 'INR'
  );
create policy "Admins can manage payments" on public.payments for all using (public.is_admin());

-- CONTESTS (SERVER-SIDE PUBLICATION & ELIGIBILITY ENFORCEMENT)
drop policy if exists "Admins have full access to contests" on public.contests;
drop policy if exists "Eligible learners can view active contests" on public.contests;
drop policy if exists "Eligible users can view active contests" on public.contests;

create policy "Admins have full access to contests" on public.contests for all using (public.is_admin());
create policy "Eligible learners can view active contests" on public.contests for select
  using (
    status in ('PUBLISHED', 'REGISTRATION_CLOSED', 'CONTEST_CLOSED', 'EVALUATION', 'RESULTS_PUBLISHED')
    and (
      public.is_admin()
      or (
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and (p.contest_eligible = true or p.completed_count >= 18)
        )
        and (
          audience_type = 'ALL'
          or exists (
            select 1 from public.contest_eligibility e
            where e.contest_id = public.contests.id and e.user_id = auth.uid()
          )
        )
      )
    )
  );

-- CONTEST ELIGIBILITY
drop policy if exists "Admins have full access to contest eligibility" on public.contest_eligibility;
drop policy if exists "Users can view own contest eligibility" on public.contest_eligibility;
drop policy if exists "Users can view own eligibility" on public.contest_eligibility;

create policy "Admins have full access to contest eligibility" on public.contest_eligibility for all using (public.is_admin());
create policy "Users can view own contest eligibility" on public.contest_eligibility for select using (auth.uid() = user_id);

-- CONTEST REGISTRATIONS
drop policy if exists "Admins have full access to contest registrations" on public.contest_registrations;
drop policy if exists "Users can view own contest registration" on public.contest_registrations;
drop policy if exists "Eligible users can register for published contests" on public.contest_registrations;

create policy "Admins have full access to contest registrations" on public.contest_registrations for all using (public.is_admin());
create policy "Users can view own contest registration" on public.contest_registrations for select using (auth.uid() = user_id);
create policy "Eligible users can register for published contests" on public.contest_registrations for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
        and (
          public.is_admin()
          or (
            exists (
              select 1 from public.profiles p
              where p.id = auth.uid()
                and (p.contest_eligible = true or p.completed_count >= 18)
            )
            and (
              c.audience_type = 'ALL'
              or exists (
                select 1 from public.contest_eligibility e
                where e.contest_id = c.id and e.user_id = auth.uid()
              )
            )
          )
        )
    )
  );

-- CONTEST ATTEMPTS (SERVER-SIDE TIMING, REGISTRATION, ELIGIBILITY, ONE ATTEMPT)
drop policy if exists "Admins have full access to contest attempts" on public.contest_attempts;
drop policy if exists "Users can view own contest attempt" on public.contest_attempts;
drop policy if exists "Verified users can create single attempt" on public.contest_attempts;
drop policy if exists "Users can create single contest attempt" on public.contest_attempts;
drop policy if exists "Authorized users can create single attempt" on public.contest_attempts;
drop policy if exists "Users can update own in-progress contest attempt" on public.contest_attempts;
drop policy if exists "Users can update own in-progress attempt draft" on public.contest_attempts;

create policy "Admins have full access to contest attempts" on public.contest_attempts for all using (public.is_admin());
create policy "Users can view own contest attempt" on public.contest_attempts for select using (auth.uid() = user_id);
create policy "Authorized users can create single attempt" on public.contest_attempts for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
        and (c.start_date is null or now() >= c.start_date)
        and (c.end_date is null or now() <= c.end_date)
        and (
          public.is_admin()
          or (
            exists (
              select 1 from public.contest_registrations r
              where r.contest_id = c.id and r.user_id = auth.uid()
            )
            and (
              c.entry_fee = 0
              or exists (
                select 1 from public.contest_payments p
                where p.contest_id = c.id
                  and p.user_id = auth.uid()
                  and p.status = 'VERIFIED'
              )
            )
          )
        )
    )
  );
create policy "Users can update own in-progress contest attempt" on public.contest_attempts for update
  using (auth.uid() = user_id and status = 'IN_PROGRESS');

-- CONTEST EVALUATIONS
drop policy if exists "Admins have full access to contest evaluations" on public.contest_evaluations;
drop policy if exists "Users can view own evaluation when results published" on public.contest_evaluations;

create policy "Admins have full access to contest evaluations" on public.contest_evaluations for all using (public.is_admin());
create policy "Users can view own evaluation when results published" on public.contest_evaluations for select
  using (
    auth.uid() = user_id
    and evaluation_status = 'FINALIZED'
    and exists (
      select 1 from public.contests c
      where c.id = contest_id and c.status = 'RESULTS_PUBLISHED'
    )
  );

-- CONTEST PAYMENTS (SEPARATE CONTEST ENTRY FEE PAYMENT)
drop policy if exists "Admins have full access to contest payments" on public.contest_payments;
drop policy if exists "Users can view own contest payment" on public.contest_payments;
drop policy if exists "Users can create pending payment record" on public.contest_payments;
drop policy if exists "Users can create contest payment" on public.contest_payments;
drop policy if exists "Users can create pending contest payment" on public.contest_payments;

create policy "Admins have full access to contest payments" on public.contest_payments for all using (public.is_admin());
create policy "Users can view own contest payment" on public.contest_payments for select using (auth.uid() = user_id);
-- Learners can only insert PENDING payment for their own account with amount matching the contest entry fee
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

-- LEGACY CHALLENGE ATTEMPTS CLEANUP
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'challenge_attempts') then
    execute 'drop policy if exists "Users can view own attempts" on public.challenge_attempts';
    execute 'drop policy if exists "Users can insert own attempts" on public.challenge_attempts';
    execute 'drop policy if exists "Admins can view all challenge attempts" on public.challenge_attempts';
    execute 'create policy "Users can view own attempts" on public.challenge_attempts for select using (auth.uid() = user_id)';
    execute 'create policy "Admins can view all challenge attempts" on public.challenge_attempts for all using (public.is_admin())';
  end if;
end $$;

-- 9. Function permissions
grant execute on function public.is_admin() to authenticated, anon;
grant execute on function public.sync_user_progress(uuid) to authenticated;
grant execute on function public.merge_learning_progress(jsonb, uuid) to authenticated;
grant execute on function public.verify_learner_payment(bigint) to authenticated;
grant execute on function public.reject_learner_payment(bigint, text) to authenticated;
grant execute on function public.verify_contest_payment(bigint) to authenticated;
grant execute on function public.record_scenario_completion(text, text, numeric) to authenticated;
grant execute on function public.reconcile_user_completions(uuid) to authenticated;
grant select on table public.scenario_catalog to authenticated, anon;

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
