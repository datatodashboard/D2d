-- ============================================================
-- Migration 010: Contest Lifecycle, Authoritative Timer & Server Operations
-- ============================================================

-- 1. Ensure duration_minutes on contests and deadline on contest_attempts
alter table public.contests
  add column if not exists duration_minutes integer not null default 30;

alter table public.contest_attempts
  add column if not exists deadline timestamptz;

-- 2. Protection trigger on contest_attempts:
-- Prevent tampering with user_id, contest_id, started_at, deadline, or reopening submitted attempts
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
      -- Immutable fields
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

      -- While in progress, only draft_response and updated_at can be updated
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

-- 3. Authoritative start_contest_attempt RPC
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

  -- 1. Check existing attempt (idempotent resume & preserve existing attempt even if registration closed)
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

  -- 2. Fetch contest
  select * into v_contest
  from public.contests
  where id = p_contest_id;

  if v_contest is null then
    raise exception 'Contest not found.';
  end if;

  -- 3. Check publication status
  if v_contest.status <> 'PUBLISHED' then
    raise exception 'Contest is not open for new attempts (status: %).', v_contest.status;
  end if;

  -- 4. Check contest window
  if v_contest.start_date is not null and now() < v_contest.start_date then
    raise exception 'Contest has not started yet. Starts at %.', v_contest.start_date;
  end if;
  if v_contest.end_date is not null and now() > v_contest.end_date then
    raise exception 'Contest has ended. Ended at %.', v_contest.end_date;
  end if;

  -- 5. Check audience eligibility
  if v_contest.audience_type <> 'ALL' and not v_is_admin then
    select exists (
      select 1 from public.contest_eligibility
      where contest_id = p_contest_id and user_id = v_uid
    ) into v_elig_exists;

    if not v_elig_exists then
      raise exception 'You are not invited to participate in this targeted contest.';
    end if;
  end if;

  -- 6. Check qualification (18+ distinct completions required; Admins exempt)
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

  -- 7. Check agreed rules
  select coalesce(agreed_rules, false) into v_reg_exists
  from public.contest_registrations
  where contest_id = p_contest_id and user_id = v_uid;

  if not v_reg_exists then
    raise exception 'You must read and agree to official contest rules before starting.';
  end if;

  -- 8. Check applicable payment
  if coalesce(v_contest.entry_fee, 0) > 0 and not v_is_admin then
    select status into v_pay_status
    from public.contest_payments
    where contest_id = p_contest_id and user_id = v_uid;

    if v_pay_status is distinct from 'VERIFIED' then
      raise exception 'A verified contest entry payment is required to start your attempt.';
    end if;
  end if;

  -- 9. Calculate deadline from attempt duration and contest window
  v_deadline := now() + (coalesce(v_contest.duration_minutes, 30) || ' minutes')::interval;
  if v_contest.end_date is not null and v_contest.end_date < v_deadline then
    v_deadline := v_contest.end_date;
  end if;

  -- 10. Atomic insert of new attempt (safe concurrent start handling)
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

-- 4. Authoritative save_contest_draft RPC
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

  -- Check deadline with 60-second network grace window
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

-- 5. Authoritative submit_contest_attempt RPC (idempotent, server-computed elapsed & deadline)
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

  -- Idempotent: If already submitted, return confirmed success without altering data
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

  -- Determine timing and deadline behavior for disconnected users
  -- Server gives a 60-second network grace window over the official deadline
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

-- Grant permissions to authenticated users
grant execute on function public.start_contest_attempt(uuid) to authenticated;
grant execute on function public.save_contest_draft(uuid, text) to authenticated;
grant execute on function public.submit_contest_attempt(uuid, text) to authenticated;
