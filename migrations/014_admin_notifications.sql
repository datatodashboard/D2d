-- ============================================================
-- Migration 014: Admin Notifications & Announcements System
-- ============================================================

create table if not exists public.app_notifications (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  message text not null,
  type text not null default 'announcement', -- 'contest', 'announcement', 'update', 'certificate'
  action_target text, -- 'home', 'practice', 'progress', 'contest'
  is_active boolean default true,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.app_notifications enable row level security;

-- Read policy: Anyone can read active notifications
drop policy if exists "Anyone can read active app_notifications" on public.app_notifications;
create policy "Anyone can read active app_notifications" on public.app_notifications
  for select
  using (is_active = true or public.is_admin());

-- Write policies: Only admins can insert, update, or delete notifications
drop policy if exists "Admins can insert app_notifications" on public.app_notifications;
create policy "Admins can insert app_notifications" on public.app_notifications
  for insert
  with check (public.is_admin());

drop policy if exists "Admins can update app_notifications" on public.app_notifications;
create policy "Admins can update app_notifications" on public.app_notifications
  for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete app_notifications" on public.app_notifications;
create policy "Admins can delete app_notifications" on public.app_notifications
  for delete
  using (public.is_admin());
