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
  ) or (
    coalesce((auth.jwt() -> 'user_metadata' ->> 'is_admin')::boolean, false) = true
  ) or (
    auth.jwt() ->> 'email' = 'datatodashboard2@gmail.com'
  );
end;
$$ language plpgsql security definer;

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
          c.audience_type = 'ALL'
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

drop policy if exists "Users can create single contest attempt" on public.contest_attempts;
create policy "Users can create single contest attempt" on public.contest_attempts for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
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
create policy "Admins have full access to contest payments" on public.contest_payments for all using (public.is_admin());

drop policy if exists "Users can view own contest payment" on public.contest_payments;
create policy "Users can view own contest payment" on public.contest_payments for select using (auth.uid() = user_id);

drop policy if exists "Users can create contest payment" on public.contest_payments;
create policy "Users can create contest payment" on public.contest_payments for insert
  with check (auth.uid() = user_id);

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
