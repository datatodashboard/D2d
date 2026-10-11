-- ============================================================
-- Migration 019: Fix Thinking Engine 2.0 Progress Sync & RPC Reconciliation
-- Auditable Migration ID: 019_fix_progress_sync_and_reconciliation
-- Non-destructive, idempotent, production-safe migration
-- ============================================================

-- 1. Fix sync_user_progress permission & trusted operation handling
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
  is_trusted boolean;
begin
  target_id := coalesce(p_user_id, auth.uid());
  if target_id is null then
    raise exception 'No authenticated user';
  end if;

  is_trusted := (coalesce(current_setting('app.trusted_operation', true), 'false') = 'true');

  if not is_trusted and auth.uid() is not null and target_id <> auth.uid() and not public.is_admin() then
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

  return jsonb_build_object(
    'completed_count', real_completed,
    'contest_eligible', is_eligible
  );
end;
$$;

-- 2. Define/Fix record_scenario_completion RPC
-- Atomically writes to both public.progress and public.learning_progress
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
  v_is_admin boolean := false;
  v_is_paid boolean := false;
  v_new_completed integer;
  v_eligible boolean;
  v_current_state jsonb;
  v_entries jsonb;
  v_entry jsonb;
  v_effective_score numeric;
  v_feedback text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Authentication required to record scenario completion.';
  end if;

  -- Validate scenario ID against trusted catalog
  if not exists (select 1 from public.scenario_catalog where id = p_scenario_id) then
    raise exception 'Invalid scenario ID: % does not exist in trusted scenario catalog.', p_scenario_id;
  end if;

  v_effective_score := coalesce(p_score, 10);
  if v_effective_score < 7 then
    raise exception 'Thinking score must be at least 7/10 to count as completed. Received %.', v_effective_score;
  end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = v_uid;

  -- Check if already completed (distinct scenario check)
  select exists (
    select 1 from public.progress
    where user_id = v_uid and scenario_id = p_scenario_id
  ) into v_already_completed;

  if not v_already_completed then
    select count(distinct scenario_id) into v_existing_count
    from public.progress
    where user_id = v_uid;

    if v_existing_count >= 5 and not v_is_admin and not v_is_paid then
      raise exception 'Free limit reached: A verified ₹49 payment is required to complete more than 5 scenarios.';
    end if;

    insert into public.progress (user_id, scenario_id, completed_at)
    values (v_uid, p_scenario_id, now())
    on conflict (user_id, scenario_id) do nothing;
  end if;

  -- Atomically sync learning_progress table state with full evaluation details
  select state into v_current_state
  from public.learning_progress
  where user_id = v_uid
  for update;

  if v_current_state is null then
    v_current_state := jsonb_build_object('version', 2, 'resetAt', 0, 'entries', '{}'::jsonb);
  end if;

  v_entries := coalesce(v_current_state->'entries', '{}'::jsonb);
  v_entry := coalesce(v_entries->p_scenario_id, '{}'::jsonb);
  v_feedback := coalesce(v_entry->>'feedback', 'Reasoning validated');

  v_entry := v_entry || jsonb_build_object(
    'completed', true,
    'status', 'completed',
    'score', v_effective_score,
    'thinkingScore', v_effective_score,
    'feedback', v_feedback,
    'thinking', jsonb_build_object('response', coalesce(p_thinking_response, v_entry->'thinking'->>'response', '')),
    'evaluation', jsonb_build_object('version', 6, 'score', v_effective_score, 'ready', true, 'message', v_feedback),
    'assessment', jsonb_build_object('version', 6, 'score', v_effective_score, 'ready', true, 'message', v_feedback),
    'updatedAt', (extract(epoch from now()) * 1000)::bigint
  );

  v_current_state := jsonb_set(v_current_state, '{entries}', jsonb_set(v_entries, array[p_scenario_id], v_entry));

  insert into public.learning_progress (user_id, state, updated_at)
  values (v_uid, v_current_state, now())
  on conflict (user_id) do update
  set state = excluded.state,
      updated_at = now();

  -- Sync profile completed count & eligibility
  perform set_config('app.trusted_operation', 'true', true);
  perform public.sync_user_progress(v_uid);

  select completed_count, contest_eligible, paid_unlocked, is_admin
  into v_new_completed, v_eligible, v_is_paid, v_is_admin
  from public.profiles
  where id = v_uid;

  return jsonb_build_object(
    'success', true,
    'scenario_id', p_scenario_id,
    'user_id', v_uid,
    'score', v_effective_score,
    'completed_count', coalesce(v_new_completed, 0),
    'contest_eligible', coalesce(v_eligible, false),
    'paid_unlocked', coalesce(v_is_paid, false),
    'is_admin', coalesce(v_is_admin, false)
  );
end;
$$;

-- 3. Fix reconcile_user_completions
-- Corrects column name from "verified_sqls_count" to "completed_count"
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
  entry_status text;
  is_entry_comp boolean;
begin
  target_id := coalesce(p_user_id, auth.uid());
  if target_id is null then
    raise exception 'No authenticated user';
  end if;

  if auth.uid() is not null and target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied to reconcile completions for another user.';
  end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = target_id;

  -- Inspect learning_progress to backfill valid completions into public.progress
  select state into lp_state
  from public.learning_progress
  where user_id = target_id;

  if lp_state is not null and lp_state ? 'entries' then
    lp_entries := lp_state->'entries';
    for k in select jsonb_object_keys(lp_entries) loop
      entry_data := lp_entries->k;
      if exists (select 1 from public.scenario_catalog where id = k) then
        entry_score := coalesce(
          (entry_data->>'score')::numeric,
          (entry_data->>'thinkingScore')::numeric,
          (entry_data->'assessment'->>'score')::numeric,
          (entry_data->'evaluation'->>'score')::numeric,
          0
        );
        entry_status := coalesce(entry_data->>'status', '');

        is_entry_comp := coalesce((entry_data->>'completed')::boolean, false)
                         or entry_status = 'completed'
                         or entry_score >= 7;

        if is_entry_comp then
          select count(distinct scenario_id) into v_count
          from public.progress
          where user_id = target_id;

          if v_count < 5 or v_is_paid or v_is_admin then
            insert into public.progress (user_id, scenario_id, completed_at)
            values (target_id, k, now())
            on conflict (user_id, scenario_id) do nothing;
          end if;
        end if;
      end if;
    end loop;
  end if;

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

-- 4. Upgrade merge_learning_progress with multi-property completion check and auto-sync
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
  cur_is_comp boolean;
  inc_is_comp boolean;
  cur_score numeric;
  inc_score numeric;
  v_is_paid boolean := false;
  v_is_admin boolean := false;
  v_prog_count integer;
begin
  if auth.uid() is not null and auth.uid() <> expected_user and not public.is_admin() then
    raise exception 'Unauthorized user progress merge';
  end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = expected_user;

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

    cur_score := coalesce(
      (cur_entry->>'score')::numeric,
      (cur_entry->>'thinkingScore')::numeric,
      (cur_entry->'assessment'->>'score')::numeric,
      (cur_entry->'evaluation'->>'score')::numeric,
      0
    );

    inc_score := coalesce(
      (inc_entry->>'score')::numeric,
      (inc_entry->>'thinkingScore')::numeric,
      (inc_entry->'assessment'->>'score')::numeric,
      (inc_entry->'evaluation'->>'score')::numeric,
      0
    );

    cur_is_comp := coalesce((cur_entry->>'completed')::boolean, false)
                   or coalesce(cur_entry->>'status', '') = 'completed'
                   or cur_score >= 7;

    inc_is_comp := coalesce((inc_entry->>'completed')::boolean, false)
                   or coalesce(inc_entry->>'status', '') = 'completed'
                   or inc_score >= 7;

    if cur_entry is null then
      merged_entries := jsonb_set(merged_entries, array[key], inc_entry);
    elsif cur_is_comp and not inc_is_comp then
      null;
    elsif inc_is_comp and not cur_is_comp then
      merged_entries := jsonb_set(merged_entries, array[key], inc_entry);
    elsif coalesce((inc_entry->>'updatedAt')::bigint, 0) >= coalesce((cur_entry->>'updatedAt')::bigint, 0) then
      merged_entries := jsonb_set(merged_entries, array[key], inc_entry);
    end if;

    -- Ensure completed entry is mirrored to public.progress
    if inc_is_comp and exists (select 1 from public.scenario_catalog where id = key) then
      select count(distinct scenario_id) into v_prog_count
      from public.progress
      where user_id = expected_user;

      if v_prog_count < 5 or v_is_paid or v_is_admin then
        insert into public.progress (user_id, scenario_id, completed_at)
        values (expected_user, key, now())
        on conflict (user_id, scenario_id) do nothing;
      end if;
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

  perform set_config('app.trusted_operation', 'true', true);
  perform public.sync_user_progress(expected_user);

  return current_state;
end;
$$;

-- 5. Permissions
grant execute on function public.sync_user_progress(uuid) to authenticated, anon;
grant execute on function public.record_scenario_completion(text, text, numeric) to authenticated, anon;
grant execute on function public.reconcile_user_completions(uuid) to authenticated, anon;
grant execute on function public.merge_learning_progress(jsonb, uuid) to authenticated, anon;

-- Ensure RLS on public.progress and public.learning_progress allows authenticated upserts
drop policy if exists "Users can view own progress" on public.progress;
create policy "Users can view own progress" on public.progress for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own progress" on public.progress;
create policy "Users can insert own progress" on public.progress for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own progress" on public.progress;
create policy "Users can update own progress" on public.progress for update using (auth.uid() = user_id);

drop policy if exists "Users can view own learning progress" on public.learning_progress;
create policy "Users can view own learning progress" on public.learning_progress for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own learning progress" on public.learning_progress;
create policy "Users can insert own learning progress" on public.learning_progress for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own learning progress" on public.learning_progress;
create policy "Users can update own learning progress" on public.learning_progress for update using (auth.uid() = user_id);

notify pgrst, 'reload schema';
