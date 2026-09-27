-- ============================================================
-- Migration 005: Admin-Controlled Crack SQL Thinking Contest
-- Tables: contests, contest_eligibility, contest_registrations,
--         contest_payments, contest_attempts, contest_evaluations
-- ============================================================

-- 1. Contests Table
create table if not exists public.contests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  instructions text,
  rules text,
  scenario_text text not null,
  scenario_id text,
  entry_fee numeric not null default 49,
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

-- 2. Contest Eligibility Table (for SELECTED / INVITED audiences)
create table if not exists public.contest_eligibility (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  is_invited boolean not null default true,
  created_at timestamptz not null default now(),
  constraint uq_contest_eligibility unique (contest_id, user_id)
);

-- 3. Contest Registrations Table
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

-- 4. Contest Payments Table
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

-- 5. Contest Attempts Table (One official attempt per user per contest)
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

-- 6. Contest Evaluations Table
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

-- ============================================================
-- Enable Row Level Security
-- ============================================================
alter table public.contests enable row level security;
alter table public.contest_eligibility enable row level security;
alter table public.contest_registrations enable row level security;
alter table public.contest_payments enable row level security;
alter table public.contest_attempts enable row level security;
alter table public.contest_evaluations enable row level security;

-- Helper to check if caller is admin
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
    auth.email() = 'datatodashboard2@gmail.com'
  );
end;
$$ language plpgsql security definer;

-- ------------------------------------------------------------
-- Contests Policies
-- ------------------------------------------------------------
-- Admins can do anything on contests
create policy "Admins have full access to contests"
  on public.contests for all
  using (public.is_admin());

-- Eligible users can view active / published contests
create policy "Eligible users can view active contests"
  on public.contests for select
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

-- ------------------------------------------------------------
-- Contest Eligibility Policies
-- ------------------------------------------------------------
create policy "Admins have full access to contest eligibility"
  on public.contest_eligibility for all
  using (public.is_admin());

create policy "Users can view own eligibility"
  on public.contest_eligibility for select
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Contest Registrations Policies
-- ------------------------------------------------------------
create policy "Admins have full access to contest registrations"
  on public.contest_registrations for all
  using (public.is_admin());

create policy "Users can view own contest registration"
  on public.contest_registrations for select
  using (auth.uid() = user_id);

create policy "Eligible users can register for published contests"
  on public.contest_registrations for insert
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
            where e.contest_id = c.id
              and e.user_id = auth.uid()
          )
        )
    )
  );

-- ------------------------------------------------------------
-- Contest Payments Policies
-- ------------------------------------------------------------
create policy "Admins have full access to contest payments"
  on public.contest_payments for all
  using (public.is_admin());

create policy "Users can view own contest payment"
  on public.contest_payments for select
  using (auth.uid() = user_id);

create policy "Users can create pending payment record"
  on public.contest_payments for insert
  with check (
    auth.uid() = user_id
    and (
      -- If contest is free (fee = 0), allow status VERIFIED
      (status = 'VERIFIED' and exists (
        select 1 from public.contests c where c.id = contest_id and c.entry_fee = 0
      ))
      -- Otherwise user can only create PENDING
      or status = 'PENDING'
    )
  );

-- ------------------------------------------------------------
-- Contest Attempts Policies
-- ------------------------------------------------------------
create policy "Admins have full access to contest attempts"
  on public.contest_attempts for all
  using (public.is_admin());

create policy "Users can view own contest attempt"
  on public.contest_attempts for select
  using (auth.uid() = user_id);

create policy "Verified users can create single attempt"
  on public.contest_attempts for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'PUBLISHED'
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
  );

create policy "Users can update own in-progress attempt draft"
  on public.contest_attempts for update
  using (
    auth.uid() = user_id
    and status = 'IN_PROGRESS'
  );

-- ------------------------------------------------------------
-- Contest Evaluations Policies
-- ------------------------------------------------------------
create policy "Admins have full access to contest evaluations"
  on public.contest_evaluations for all
  using (public.is_admin());

create policy "Users can view own evaluation when results published"
  on public.contest_evaluations for select
  using (
    auth.uid() = user_id
    and evaluation_status = 'FINALIZED'
    and exists (
      select 1 from public.contests c
      where c.id = contest_id
        and c.status = 'RESULTS_PUBLISHED'
    )
  );
