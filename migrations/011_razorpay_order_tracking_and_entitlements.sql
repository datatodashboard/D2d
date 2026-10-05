-- ============================================================
-- Migration 011: Razorpay Order Tracking, Explicit Entitlements,
-- and Atomic Payment Finalization
-- ============================================================

-- 1. Create table for persisting server-side Razorpay orders
create table if not exists public.razorpay_orders (
  id text primary key, -- Razorpay order_id, e.g. order_xxx
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  purpose text not null default 'course_unlock', -- 'course_unlock' or contest UUID
  amount integer not null default 4900, -- amount in paise (₹49 = 4900 paise)
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created', 'attempted', 'paid', 'failed')),
  receipt text,
  payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.razorpay_orders enable row level security;

drop policy if exists "Users can view own razorpay orders" on public.razorpay_orders;
create policy "Users can view own razorpay orders"
  on public.razorpay_orders for select
  using (auth.uid() = user_id);

drop policy if exists "Admins have full access to razorpay orders" on public.razorpay_orders;
create policy "Admins have full access to razorpay orders"
  on public.razorpay_orders for all
  using (public.is_admin());

-- 2. Ensure profiles has paid_unlocked column if missing in live environment
alter table public.profiles
  add column if not exists paid_unlocked boolean default false;

-- 3. Stored Procedure for atomic, transactional payment finalization
create or replace function public.finalize_razorpay_payment(
  p_order_id text,
  p_payment_id text,
  p_user_id uuid,
  p_user_email text,
  p_purpose text default 'course_unlock',
  p_amount_paise integer default 4900,
  p_currency text default 'INR'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_existing_dup bigint;
  v_now timestamptz := now();
  v_is_contest boolean := false;
  v_contest_uuid uuid;
begin
  if p_user_id is null then
    raise exception 'User ID is required for payment finalization.';
  end if;

  if p_payment_id is null or trim(p_payment_id) = '' then
    raise exception 'Payment ID is required for payment finalization.';
  end if;

  -- 1. Anti-reuse check: verify payment_id was not credited to a different user
  select id into v_existing_dup
  from public.payments
  where transaction_reference = p_payment_id
    and user_id <> p_user_id
    and status = 'verified'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  -- Check contest_payments as well
  select id into v_existing_dup
  from public.contest_payments
  where transaction_ref = p_payment_id
    and user_id <> p_user_id
    and status = 'VERIFIED'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  -- 2. Update razorpay_orders if order exists
  if p_order_id is not null and trim(p_order_id) <> '' then
    update public.razorpay_orders
    set status = 'paid',
        payment_id = p_payment_id,
        updated_at = v_now
    where id = p_order_id;
  end if;

  -- 3. Determine if purpose is a valid contest UUID
  if p_purpose is not null and p_purpose <> 'course_unlock' and p_purpose <> 'premium_unlock' then
    begin
      v_contest_uuid := p_purpose::uuid;
      v_is_contest := true;
    exception when others then
      v_is_contest := false;
    end;
  end if;

  if v_is_contest then
    -- Contest payment: update/insert in contest_payments
    insert into public.contest_payments (
      contest_id,
      user_id,
      amount,
      currency,
      status,
      payment_method,
      transaction_ref,
      verified_at,
      updated_at
    )
    values (
      v_contest_uuid,
      p_user_id,
      round(p_amount_paise / 100.0, 2),
      p_currency,
      'VERIFIED',
      'RAZORPAY',
      p_payment_id,
      v_now,
      v_now
    )
    on conflict (contest_id, user_id) do update
    set status = 'VERIFIED',
        transaction_ref = excluded.transaction_ref,
        payment_method = 'RAZORPAY',
        verified_at = v_now,
        updated_at = v_now;
  else
    -- Course unlock: update/insert in payments
    update public.payments
    set status = 'verified',
        transaction_reference = p_payment_id,
        verified_at = v_now,
        updated_at = v_now
    where transaction_reference in (p_payment_id, p_order_id)
      and user_id = p_user_id;

    if not found then
      insert into public.payments (
        user_id,
        user_email,
        amount,
        currency,
        payment_method,
        transaction_reference,
        status,
        submitted_at,
        verified_at,
        updated_at
      )
      values (
        p_user_id,
        p_user_email,
        round(p_amount_paise / 100.0, 2),
        p_currency,
        'RAZORPAY',
        p_payment_id,
        'verified',
        v_now,
        v_now,
        v_now
      );
    end if;

    -- Also update profile paid_unlocked safely if column exists
    begin
      perform set_config('app.trusted_operation', 'true', true);
      update public.profiles
      set paid_unlocked = true,
          last_active = v_now
      where id = p_user_id;
    exception when others then
      -- Safe fallback if column doesn't exist
      null;
    end;
  end if;

  return jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'payment_id', p_payment_id,
    'order_id', p_order_id,
    'purpose', coalesce(p_purpose, 'course_unlock'),
    'status', 'verified'
  );
end;
$$;
