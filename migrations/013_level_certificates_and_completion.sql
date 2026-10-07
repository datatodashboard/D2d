-- Migration 013: Level Completion Tracking, Immutable Certificates & Public Verification
-- Enforces:
-- 1. Atomic certificate claiming only after 20 distinct scenario completions in domain/level.
-- 2. Unique constraint: exactly 1 certificate per user/domain/level.
-- 3. Public verification without exposing private learner data.
-- 4. Idempotent claiming and backfill for existing qualified progress.

-- 1. Create Certificates Table
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

-- 2. Row Level Security
alter table public.certificates enable row level security;

-- Public can verify certificates by ID
drop policy if exists "Anyone can read certificates for verification" on public.certificates;
create policy "Anyone can read certificates for verification"
  on public.certificates for select
  using (true);

-- Disallow direct user mutation; all issuance happens via security definer RPC
drop policy if exists "No direct insert on certificates" on public.certificates;
create policy "No direct insert on certificates"
  on public.certificates for insert
  with check (false);

drop policy if exists "No direct update on certificates" on public.certificates;
create policy "No direct update on certificates"
  on public.certificates for update
  using (false);

drop policy if exists "No direct delete on certificates" on public.certificates;
create policy "No direct delete on certificates"
  on public.certificates for delete
  using (false);

-- 3. Helper to map domain name to scenario catalog prefix
create or replace function public.get_domain_code(p_domain text)
returns text
language sql
immutable
as $$
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
returns text
language sql
immutable
as $$
  select case lower(trim(p_level))
    when 'beginner' then 'BEG'
    when 'intermediate' then 'INT'
    when 'expert' then 'EXP'
    else null
  end;
$$;

-- 4. Authoritative RPC: Claim Level Certificate
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

  -- Return existing certificate if already claimed (idempotent)
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

  -- Check distinct scenario completions from public.progress
  select count(distinct scenario_id) into v_completed_count
  from public.progress
  where user_id = v_uid
    and scenario_id like (v_dom_code || '_' || v_lvl_code || '_%');

  -- If count < 20, reconcile with learning_progress if present
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

  -- Enforce strictly all 20 distinct scenarios completed
  if v_completed_count < 20 then
    return jsonb_build_object(
      'success', false,
      'code', 'LEVEL_INCOMPLETE',
      'error', 'Level incomplete: ' || v_completed_count || '/20 distinct scenarios completed in ' || p_domain || ' (' || p_level || ').',
      'completed_count', v_completed_count,
      'required_count', 20
    );
  end if;

  -- Resolve recipient name
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

  -- Dynamic course title
  case v_lvl_code
    when 'BEG' then v_course_title := 'Crack SQL: Beginner SQL Practitioner';
    when 'INT' then v_course_title := 'Crack SQL: Intermediate SQL Practitioner';
    when 'EXP' then v_course_title := 'Crack SQL: Expert SQL Practitioner';
  end case;

  v_description := 'Successfully completed 20 scenario-based SQL challenges in ' || p_domain || '.';

  -- Generate unique credential ID: e.g. D2D-CSQL-BEG-2026-A1B2C3
  v_rand_hex := upper(substr(md5(random()::text || clock_timestamp()::text || v_uid::text), 1, 6));
  v_credential_id := 'D2D-CSQL-' || v_lvl_code || '-' || to_char(now(), 'YYYY') || '-' || v_rand_hex;

  -- Insert certificate atomically
  insert into public.certificates (
    credential_id,
    user_id,
    recipient_name,
    domain,
    level,
    course_title,
    description,
    completed_at
  ) values (
    v_credential_id,
    v_uid,
    v_clean_name,
    p_domain,
    p_level,
    v_course_title,
    v_description,
    now()
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

-- 5. Public Verification RPC
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
    return jsonb_build_object(
      'valid', false,
      'message', 'Certificate not found'
    );
  end if;

  select credential_id, recipient_name, domain, level, course_title, description, completed_at
  into v_cert
  from public.certificates
  where lower(credential_id) = lower(trim(p_credential_id));

  if not found then
    return jsonb_build_object(
      'valid', false,
      'message', 'Certificate not found'
    );
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

-- 6. User Certificates Listing RPC
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

-- 7. Grant Permissions
grant select on table public.certificates to authenticated, anon;
grant execute on function public.claim_level_certificate(text, text, text) to authenticated;
grant execute on function public.verify_certificate(text) to authenticated, anon;
grant execute on function public.get_user_certificates(uuid) to authenticated;

-- 8. Backfill existing progress that meets the 20 distinct completions threshold
do $$
declare
  r record;
  v_dom text;
  v_lvl text;
  v_dom_code text;
  v_lvl_code text;
  v_cnt int;
  v_uname text;
  v_course_title text;
  v_desc text;
  v_cid text;
begin
  for r in select distinct user_id from public.progress loop
    foreach v_dom in array array['Banking', 'Healthcare', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education', 'Retail'] loop
      foreach v_lvl in array array['Beginner', 'Intermediate', 'Expert'] loop
        v_dom_code := public.get_domain_code(v_dom);
        v_lvl_code := public.get_level_code(v_lvl);

        select count(distinct scenario_id) into v_cnt
        from public.progress
        where user_id = r.user_id
          and scenario_id like (v_dom_code || '_' || v_lvl_code || '_%');

        if v_cnt >= 20 then
          select username into v_uname from public.profiles where id = r.user_id;
          if v_uname is null or trim(v_uname) = '' then
            v_uname := 'Learner';
          end if;

          case v_lvl_code
            when 'BEG' then v_course_title := 'Crack SQL: Beginner SQL Practitioner';
            when 'INT' then v_course_title := 'Crack SQL: Intermediate SQL Practitioner';
            when 'EXP' then v_course_title := 'Crack SQL: Expert SQL Practitioner';
          end case;

          v_desc := 'Successfully completed 20 scenario-based SQL challenges in ' || v_dom || '.';
          v_cid := 'D2D-CSQL-' || v_lvl_code || '-' || to_char(now(), 'YYYY') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || r.user_id::text), 1, 6));

          insert into public.certificates (
            credential_id, user_id, recipient_name, domain, level, course_title, description, completed_at
          ) values (
            v_cid, r.user_id, v_uname, v_dom, v_lvl, v_course_title, v_desc, now()
          )
          on conflict (user_id, domain, level) do nothing;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

notify pgrst, 'reload schema';
