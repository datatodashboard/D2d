-- Migration 017: Thinking Logic 2 Merge Protection and System Settings Schema

-- 1. Configuration Table for Global Progress Reset and System Settings
create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.system_settings enable row level security;

-- RLS Policies
drop policy if exists "Anyone can read system_settings" on public.system_settings;
create policy "Anyone can read system_settings"
  on public.system_settings
  for select
  using (true);

drop policy if exists "Admins can manage system_settings" on public.system_settings;
create policy "Admins can manage system_settings"
  on public.system_settings
  for all
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

grant select on table public.system_settings to anon, authenticated;

-- 2. Enhanced merge_learning_progress function with completed entry preservation & server reset epoch enforcement
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
  system_reset bigint := 0;
  effective_reset bigint := 0;
  clean_entries jsonb := '{}'::jsonb;
  key text;
  inc_entry jsonb;
  cur_entry jsonb;
  cur_is_comp boolean;
  inc_is_comp boolean;
begin
  if auth.uid() is null or (auth.uid() <> expected_user and not public.is_admin()) then
    raise exception 'Unauthorized user progress merge';
  end if;

  -- 1. Check authoritative global_progress_reset setting in system_settings
  select coalesce((value->>'resetAt')::bigint, (value)::bigint, 0) into system_reset
  from public.system_settings
  where key = 'global_progress_reset';
  if system_reset is null then system_reset := 0; end if;

  -- 2. Fetch existing state from public.learning_progress
  select state into current_state
  from public.learning_progress
  where user_id = expected_user
  for update;

  if current_state is null then
    current_state := '{"entries":{},"resetAt":0}'::jsonb;
  end if;

  incoming_reset := coalesce((incoming->>'resetAt')::bigint, 0);
  current_reset := coalesce((current_state->>'resetAt')::bigint, 0);

  effective_reset := greatest(incoming_reset, current_reset, system_reset);

  current_state := jsonb_set(current_state, '{resetAt}', to_jsonb(effective_reset));

  merged_entries := coalesce(current_state->'entries', '{}'::jsonb);

  -- 3. Prune existing stored entries that predate the effective reset epoch
  if effective_reset > 0 then
    for key in select jsonb_object_keys(merged_entries) loop
      cur_entry := merged_entries->key;
      if coalesce((cur_entry->>'updatedAt')::bigint, 0) > effective_reset then
        clean_entries := jsonb_set(clean_entries, array[key], cur_entry);
      end if;
    end loop;
    merged_entries := clean_entries;
  end if;

  incoming_entries := coalesce(incoming->'entries', '{}'::jsonb);

  -- 4. Merge incoming entries strictly newer than effective_reset
  for key in select jsonb_object_keys(incoming_entries) loop
    inc_entry := incoming_entries->key;
    cur_entry := merged_entries->key;

    if effective_reset > 0 and coalesce((inc_entry->>'updatedAt')::bigint, 0) <= effective_reset then
      continue;
    end if;

    cur_is_comp := coalesce((cur_entry->>'completed')::boolean, false) OR coalesce((cur_entry->'assessment'->>'score')::numeric, 0) >= 7;
    inc_is_comp := coalesce((inc_entry->>'completed')::boolean, false) OR coalesce((inc_entry->'assessment'->>'score')::numeric, 0) >= 7;

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

grant execute on function public.merge_learning_progress(jsonb, uuid) to authenticated;

-- 3. Reset-aware reconcile_user_completions function
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
  v_reset_at bigint := 0;
  lp_state jsonb;
  lp_entries jsonb;
  k text;
  entry_data jsonb;
  entry_score numeric;
  entry_updated_at bigint;
begin
  target_id := coalesce(p_user_id, auth.uid());
  if target_id is null then
    raise exception 'No authenticated user';
  end if;

  if target_id <> auth.uid() and not public.is_admin() then
    raise exception 'Permission denied to reconcile completions for another user.';
  end if;

  -- Read server reset epoch from system_settings
  select coalesce((value->>'resetAt')::bigint, (value)::bigint, 0) into v_reset_at
  from public.system_settings
  where key = 'global_progress_reset';
  if v_reset_at is null then v_reset_at := 0; end if;

  select coalesce(paid_unlocked, false), coalesce(is_admin, false)
  into v_is_paid, v_is_admin
  from public.profiles
  where id = target_id;

  select state into lp_state
  from public.learning_progress
  where user_id = target_id;

  if lp_state is not null then
    v_reset_at := greatest(v_reset_at, coalesce((lp_state->>'resetAt')::bigint, 0));
  end if;

  if lp_state is not null and lp_state ? 'entries' then
    lp_entries := lp_state->'entries';
    for k in select jsonb_object_keys(lp_entries) loop
      entry_data := lp_entries->k;
      entry_updated_at := coalesce((entry_data->>'updatedAt')::bigint, 0);

      -- Ignore entries predating reset epoch
      if v_reset_at > 0 and entry_updated_at <= v_reset_at then
        continue;
      end if;

      if exists (select 1 from public.scenario_catalog where id = k) then
        entry_score := coalesce((entry_data->'assessment'->>'score')::numeric, 0);

        if coalesce((entry_data->>'completed')::boolean, false) or entry_score >= 7 then
          if v_reset_at > 0 then
            select count(distinct scenario_id) into v_count
            from public.progress
            where user_id = target_id
              and completed_at is not null
              and extract(epoch from completed_at) * 1000 > v_reset_at;
          else
            select count(distinct scenario_id) into v_count
            from public.progress
            where user_id = target_id;
          end if;

          if v_count < 5 or v_is_paid or v_is_admin then
            insert into public.progress (user_id, scenario_id, completed_at)
            values (target_id, k, now())
            on conflict (user_id, scenario_id) do update
            set completed_at = excluded.completed_at
            where progress.completed_at is null or (v_reset_at > 0 and extract(epoch from progress.completed_at) * 1000 <= v_reset_at);
          end if;
        end if;
      end if;
    end loop;
  end if;

  if v_reset_at > 0 then
    select count(distinct scenario_id) into v_count
    from public.progress
    where user_id = target_id
      and completed_at is not null
      and extract(epoch from completed_at) * 1000 > v_reset_at;
  else
    select count(distinct scenario_id) into v_count
    from public.progress
    where user_id = target_id;
  end if;

  v_eligible := (v_count >= 18);

  perform set_config('app.trusted_operation', 'true', true);

  update public.profiles
  set verified_sqls_count = v_count,
      contest_eligible = v_eligible
  where id = target_id;

  return jsonb_build_object(
    'completed_count', v_count,
    'contest_eligible', v_eligible,
    'paid_unlocked', coalesce(v_is_paid, false),
    'is_admin', coalesce(v_is_admin, false)
  );
end;
$$;

grant execute on function public.reconcile_user_completions(uuid) to authenticated;

