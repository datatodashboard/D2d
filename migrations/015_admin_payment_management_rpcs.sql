-- ============================================================
-- Migration 015: Admin Payment Verification and Rejection RPCs
-- ============================================================

-- Ensure verify_learner_payment RPC function exists with exact signature expected by js/admin.js
create or replace function public.verify_learner_payment(p_payment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_norm_ref text;
  v_dup_id bigint;
  v_contest_dup_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Permission denied: Administrator privileges required.';
  end if;

  if p_payment_id is null then
    raise exception 'Payment ID is required.';
  end if;

  -- Lock payment row for atomic transaction
  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Payment record % not found.', p_payment_id;
  end if;

  -- Validate payment status
  if v_payment.status not in ('pending', 'verified', 'rejected') then
    raise exception 'Invalid payment status: %.', v_payment.status;
  end if;

  -- Validate reference if present
  if trim(coalesce(v_payment.transaction_reference, '')) <> '' then
    v_norm_ref := upper(regexp_replace(trim(v_payment.transaction_reference), '[^A-Za-z0-9]', '', 'g'));

    if length(v_norm_ref) >= 4 then
      -- Check for duplicate reference already credited to another verified payment
      select id into v_dup_id
      from public.payments
      where id <> p_payment_id
        and status = 'verified'
        and upper(regexp_replace(trim(transaction_reference), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
      limit 1;

      if v_dup_id is not null then
        raise exception 'Duplicate transaction reference: reference % is already verified on practice payment #%.', v_payment.transaction_reference, v_dup_id;
      end if;

      -- Prevent the same actual payment being credited to multiple payment purposes
      select id into v_contest_dup_id
      from public.contest_payments
      where status = 'VERIFIED'
        and upper(regexp_replace(trim(coalesce(transaction_ref, '')), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
      limit 1;

      if v_contest_dup_id is not null then
        raise exception 'Duplicate transaction reference: reference % is already credited to contest payment #%.', v_payment.transaction_reference, v_contest_dup_id;
      end if;
    end if;
  end if;

  -- Update payment to verified (idempotent for repeated verification)
  update public.payments
  set status = 'verified',
      verified_at = coalesce(v_payment.verified_at, now()),
      verified_by = coalesce(v_payment.verified_by, auth.uid()::text),
      updated_at = now()
  where id = p_payment_id;

  -- Atomically unlock learner profile
  perform set_config('app.trusted_operation', 'true', true);

  update public.profiles
  set paid_unlocked = true,
      last_active = now()
  where id = v_payment.user_id;

  -- Return confirmed authoritative access state
  return jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'user_id', v_payment.user_id,
    'status', 'verified',
    'paid_unlocked', true,
    'verified_at', coalesce(v_payment.verified_at, now()),
    'verified_by', coalesce(v_payment.verified_by, auth.uid()::text)
  );
end;
$$;

-- Ensure reject_learner_payment RPC function exists with exact signature expected by js/admin.js
create or replace function public.reject_learner_payment(p_payment_id bigint, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_has_other_verified boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Permission denied: Administrator privileges required.';
  end if;

  if p_payment_id is null then
    raise exception 'Payment ID is required.';
  end if;

  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Payment record % not found.', p_payment_id;
  end if;

  update public.payments
  set status = 'rejected',
      admin_notes = coalesce(p_reason, admin_notes),
      verified_at = now(),
      verified_by = auth.uid()::text,
      updated_at = now()
  where id = p_payment_id;

  -- Crucial Rule: Rejecting a duplicate pending request must not revoke access granted by an earlier valid payment
  select exists (
    select 1 from public.payments
    where user_id = v_payment.user_id
      and id <> p_payment_id
      and status = 'verified'
  ) into v_has_other_verified;

  if not v_has_other_verified then
    select exists (
      select 1 from public.razorpay_orders
      where user_id = v_payment.user_id
        and status = 'paid'
    ) into v_has_other_verified;
  end if;

  if not v_has_other_verified then
    perform set_config('app.trusted_operation', 'true', true);
    update public.profiles
    set paid_unlocked = false,
        last_active = now()
    where id = v_payment.user_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'user_id', v_payment.user_id,
    'status', 'rejected',
    'paid_unlocked', v_has_other_verified,
    'admin_notes', coalesce(p_reason, v_payment.admin_notes)
  );
end;
$$;

-- Grant permissions for payment verification and rejection RPCs
grant execute on function public.verify_learner_payment(bigint) to authenticated;
grant execute on function public.reject_learner_payment(bigint, text) to authenticated;

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
