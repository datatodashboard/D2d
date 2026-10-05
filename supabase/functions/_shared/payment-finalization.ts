export type FinalizePaymentInput = {
  orderId: string | null;
  paymentId: string;
  userId: string;
  userEmail: string;
  purpose?: string | null;
  amountPaise?: number;
  currency?: string;
};

export type FinalizePaymentResult = {
  success: boolean;
  user_id: string;
  payment_id: string;
  order_id: string | null;
  purpose: string;
  status: string;
};

export async function finalizePayment(
  input: FinalizePaymentInput,
): Promise<FinalizePaymentResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase server configuration is missing.');
  }

  if (!input.userId) {
    throw new Error('User ID is required.');
  }

  if (!input.paymentId || input.paymentId.trim() === '') {
    throw new Error('Payment ID is required.');
  }

  const amountPaise = input.amountPaise ?? 4900;
  const currency = (input.currency ?? 'INR').toUpperCase();

  if (amountPaise !== 4900) {
    throw new Error('Invalid payment amount.');
  }

  if (currency !== 'INR') {
    throw new Error('Invalid payment currency.');
  }

  const purpose =
    input.purpose &&
    input.purpose !== 'course_unlock' &&
    input.purpose !== 'premium_unlock'
      ? input.purpose
      : 'course_unlock';

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/finalize_razorpay_payment`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_order_id: input.orderId || null,
        p_payment_id: input.paymentId,
        p_user_id: input.userId,
        p_user_email: input.userEmail || '',
        p_purpose: purpose,
        p_amount_paise: amountPaise,
        p_currency: currency,
      }),
    },
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Payment finalization RPC failed (${response.status}): ${responseText}`,
    );
  }

  let data: any;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error('Payment finalization returned invalid JSON.');
  }

  if (!data || data.success !== true) {
    throw new Error('Payment finalization did not succeed.');
  }

  return {
    success: true,
    user_id: data.user_id ?? input.userId,
    payment_id: data.payment_id ?? input.paymentId,
    order_id: data.order_id ?? input.orderId ?? null,
    purpose: data.purpose ?? purpose,
    status: data.status ?? 'verified',
  };
}
