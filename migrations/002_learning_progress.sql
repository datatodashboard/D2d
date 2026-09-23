-- ============================================================
-- Migration 002: Learning Progress & Atomic Merge
-- Run this in Supabase SQL Editor
-- ============================================================

create table if not exists public.learning_progress (
  user_id uuid references auth.users on delete cascade primary key,
  state jsonb not null default '{"entries":{},"resetAt":0}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.learning_progress enable row level security;

create policy "Users can view own learning progress"
  on public.learning_progress for select
  using (auth.uid() = user_id);

create policy "Users can update own learning progress"
  on public.learning_progress for update
  using (auth.uid() = user_id);

create policy "Users can insert own learning progress"
  on public.learning_progress for insert
  with check (auth.uid() = user_id);

-- Merge function for atomic updates across devices
create or replace function public.merge_learning_progress(
  incoming jsonb,
  expected_user uuid
) returns jsonb as $$
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
  if auth.uid() is null or auth.uid() <> expected_user then
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
  set state = excluded.state, updated_at = now();

  return current_state;
end;
$$ language plpgsql security definer;
