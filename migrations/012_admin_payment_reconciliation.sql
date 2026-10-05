-- ============================================================
-- Migration 012: Admin Payment Reconciliation, Entitlement Audit,
-- and Anti-Reuse Security Controls
-- ============================================================

-- 1. Ensure public.profiles has paid_unlocked column
alter table public.profiles
  add column if not exists paid_unlocked boolean default false;

-- 2. Ensure public.payments has audit fields
alter table public.payments
  add column if not exists verified_by text,
  add column if not exists admin_notes text;

-- 3. Stored Procedure for secure, admin-only payment reconciliation
create or replace function public.admin_reconcile_payment(
  p_payment_id text,
  p_order_id text default null,
  p_customer_email text default null,
  p_amount_paise integer default 4900,
  p_currency text default 'INR',
  p_admin_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_caller_is_admin boolean := false;
  v_matched_user_id uuid;
  v_matched_count integer := 0;
  v_matched_username text;
  v_existing_dup bigint;
  v_now timestamptz := now();
  v_existing_pay_id bigint;
begin
  -- 1. Security: Authoritatively verify caller is administrator
  v_caller_is_admin := public.is_admin();
  if not v_caller_is_admin then
    raise exception 'Unauthorized: Only authorized administrators can reconcile customer payments.';
  end if;

  -- 2. Input validation
  if p_payment_id is null or trim(p_payment_id) = '' then
    raise exception 'Payment ID is required for reconciliation.';
  end if;

  if p_amount_paise is null or p_amount_paise <> 4900 then
    raise exception 'Invalid amount: Expected 4900 paise (₹49).';
  end if;

  if p_currency is null or upper(trim(p_currency)) <> 'INR' then
    raise exception 'Invalid currency: Expected INR.';
  end if;

  -- 3. Identify exact application user in public.profiles
  if p_customer_email is not null and trim(p_customer_email) <> '' then
    select count(*), max(id), max(username)
    into v_matched_count, v_matched_user_id, v_matched_username
    from public.profiles
    where lower(email) = lower(trim(p_customer_email));
  end if;

  -- Fallback lookup via razorpay_orders if email query had no match
  if v_matched_user_id is null and p_order_id is not null and trim(p_order_id) <> '' then
    select count(distinct user_id), max(user_id)
    into v_matched_count, v_matched_user_id
    from public.razorpay_orders
    where id = trim(p_order_id);

    if v_matched_user_id is not null then
      select username into v_matched_username
      from public.profiles
      where id = v_matched_user_id;
    end if;
  end if;

  -- If no unique match exists, fail closed with "NEEDS REVIEW"
  if v_matched_count = 0 or v_matched_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'NO_USER_MATCH',
      'status', 'NEEDS REVIEW',
      'error', 'No unique matching user profile found in application. Needs review.'
    );
  end if;

  if v_matched_count > 1 then
    return jsonb_build_object(
      'success', false,
      'code', 'AMBIGUOUS_USER_MATCH',
      'status', 'NEEDS REVIEW',
      'error', 'Multiple user accounts match this identity. Needs manual review.'
    );
  end if;

  -- 4. Anti-reuse check: prevent duplicate payment ID reuse across different users
  select id into v_existing_dup
  from public.payments
  where transaction_reference = trim(p_payment_id)
    and user_id <> v_matched_user_id
    and status = 'verified'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  select id into v_existing_dup
  from public.contest_payments
  where transaction_ref = trim(p_payment_id)
    and user_id <> v_matched_user_id
    and status = 'VERIFIED'
  limit 1;

  if v_existing_dup is not null then
    raise exception 'Security violation: Payment % is already credited to another user.', p_payment_id;
  end if;

  -- 5. Idempotent payment recording in public.payments
  select id into v_existing_pay_id
  from public.payments
  where transaction_reference in (trim(p_payment_id), trim(coalesce(p_order_id, '')))
    and user_id = v_matched_user_id
  limit 1;

  if v_existing_pay_id is not null then
    update public.payments
    set status = 'verified',
        transaction_reference = trim(p_payment_id),
        verified_at = coalesce(verified_at, v_now),
        verified_by = coalesce(verified_by, auth.uid()::text),
        admin_notes = coalesce(p_admin_notes, 'Admin reconciliation verified'),
        updated_at = v_now
    where id = v_existing_pay_id;
  else
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
      verified_by,
      admin_notes,
      updated_at
    ) values (
      v_matched_user_id,
      trim(p_customer_email),
      49,
      'INR',
      'RAZORPAY',
      trim(p_payment_id),
      'verified',
      v_now,
      v_now,
      auth.uid()::text,
      coalesce(p_admin_notes, 'Admin reconciliation verified'),
      v_now
    );
  end if;

  -- Update razorpay_orders if order_id is provided
  if p_order_id is not null and trim(p_order_id) <> '' then
    update public.razorpay_orders
    set status = 'paid',
        payment_id = trim(p_payment_id),
        updated_at = v_now
    where id = trim(p_order_id);
  end if;

  -- 6. Atomically set profiles.paid_unlocked = true with trusted operation flag
  perform set_config('app.trusted_operation', 'true', true);
  update public.profiles
  set paid_unlocked = true,
      last_active = v_now
  where id = v_matched_user_id;

  return jsonb_build_object(
    'success', true,
    'status', 'verified',
    'user_id', v_matched_user_id,
    'username', v_matched_username,
    'email', trim(p_customer_email),
    'payment_id', trim(p_payment_id),
    'order_id', trim(coalesce(p_order_id, '')),
    'message', 'Payment successfully reconciled and premium access unlocked.'
  );
end;
$$;

-- Grant permissions for admin reconciliation RPC
grant execute on function public.admin_reconcile_payment(text, text, text, integer, text, text) to authenticated;

notify pgrst, 'reload schema';

