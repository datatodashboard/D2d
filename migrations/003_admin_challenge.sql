-- ============================================================
-- Migration 003: Admin Challenge & Evaluation Logging
-- ============================================================

create table if not exists public.sql_challenge_attempts (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete set null,
  scenario_id text not null,
  domain text not null,
  level text not null,
  thinking_text text,
  thinking_score numeric,
  submitted_sql text,
  is_verified boolean default false,
  created_at timestamptz default now()
);

alter table public.sql_challenge_attempts enable row level security;

create policy "Users can view own attempts"
  on public.sql_challenge_attempts for select
  using (auth.uid() = user_id);

create policy "Users can insert own attempts"
  on public.sql_challenge_attempts for insert
  with check (auth.uid() = user_id or user_id is null);
