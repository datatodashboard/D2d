-- Migration 007: Add permanent username column to public.profiles
-- Supports permanent first-time username creation for Google-authenticated users

alter table public.profiles
  add column if not exists username text;

create unique index if not exists idx_profiles_username on public.profiles (lower(trim(username))) where username is not null;

notify pgrst, 'reload schema';
