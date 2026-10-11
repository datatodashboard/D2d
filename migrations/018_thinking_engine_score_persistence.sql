-- ============================================================
-- Migration 018: Thinking Engine 2.0 Score Persistence & Progress Synchronization
-- Auditable Migration ID: 018_thinking_engine_score_persistence
-- Non-destructive, safe, idempotent migration
-- ============================================================

-- 1. Upgrade reconcile_user_completions to recognize top-level score, thinkingScore, status = 'completed', and evaluation
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

  if target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied to reconcile completions for another user.';
  end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = target_id;

  -- Safely inspect learning_progress to backfill valid completions into public.progress
  select state into lp_state
  from public.learning_progress
  where user_id = target_id;

  if lp_state is not null and lp_state ? 'entries' then
    lp_entries := lp_state->'entries';
    for k in select jsonb_object_keys(lp_entries) loop
      entry_data := lp_entries->k;
      -- Validate scenario ID exists in trusted catalog
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

        -- Count as completed if explicitly completed, status = 'completed', or score >= 7
        if is_entry_comp then
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

-- 2. Upgrade merge_learning_progress with multi-property completion check and auto-sync to public.progress
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
  if auth.uid() is null or (auth.uid() <> expected_user and not public.is_admin()) then
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
      -- Retain existing completed entry over incomplete draft
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

  -- Sync profile completed count & eligibility
  perform public.sync_user_progress(expected_user);

  return current_state;
end;
$$;

-- 3. Idempotent Data Repair: Reconcile all existing user progress records
do $$
declare
  r record;
begin
  for r in (select user_id from public.learning_progress) loop
    begin
      perform public.reconcile_user_completions(r.user_id);
    exception when others then
      raise notice 'Notice reconciling user %: %', r.user_id, sqlerrm;
    end;
  end loop;
end $$;

grant execute on function public.reconcile_user_completions(uuid) to authenticated;
grant execute on function public.merge_learning_progress(jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';
