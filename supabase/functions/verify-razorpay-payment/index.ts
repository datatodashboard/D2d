import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { finalizePayment } from '../_shared/payment-finalization.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function generateCorrelationId(): string {
  return `ver_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, secret: string): Promise<boolean> {
  if (!orderId || !paymentId || !signature || !secret) return false;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${orderId}|${paymentId}`);
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, data);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const expectedSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqual(expectedSignature.toLowerCase(), signature.trim().toLowerCase());
  } catch (err) {
    return false;
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const correlationId = generateCorrelationId();

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized: Missing authorization header',
        code: 'UNAUTHORIZED',
        correlation_id: correlationId
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error(`[verify-razorpay-payment] [${correlationId}] Missing Supabase URL or anon key.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Server configuration error: database connection not configured',
        code: 'CONFIGURATION_ERROR',
        correlation_id: correlationId
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUserClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabaseUserClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized: User session invalid or expired',
        code: 'UNAUTHORIZED',
        correlation_id: correlationId
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, contest_id } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required parameters: razorpay_order_id, razorpay_payment_id, and razorpay_signature are required',
        code: 'MISSING_PARAMETERS',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Checkout verification requires RAZORPAY_KEY_SECRET (never RAZORPAY_WEBHOOK_SECRET)
    const keyId = Deno.env.get('RAZORPAY_KEY_ID');
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret || keyId.trim() === '' || keySecret.trim() === '' || keyId.includes('placeholder')) {
      console.error(`[verify-razorpay-payment] [${correlationId}] Missing or placeholder Razorpay API credentials.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Server configuration error: payment gateway secret not configured',
        code: 'CONFIGURATION_ERROR',
        correlation_id: correlationId
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Look up the server-persisted order and verify ownership and purpose
    let persistedOrder: any = null;

    // Check razorpay_orders table
    const { data: orderData, error: orderErr } = await supabaseAdmin
      .from('razorpay_orders')
      .select('*')
      .eq('id', razorpay_order_id)
      .maybeSingle();

    if (!orderErr && orderData) {
      persistedOrder = orderData;
    } else {
      // Fallback: check payments or contest_payments where transaction_reference matches order ID
      const { data: payByOrder } = await supabaseAdmin
        .from('payments')
        .select('*')
        .eq('transaction_reference', razorpay_order_id)
        .maybeSingle();

      if (payByOrder) {
        persistedOrder = {
          id: razorpay_order_id,
          user_id: payByOrder.user_id,
          purpose: 'course_unlock',
          amount: 4900,
          currency: 'INR'
        };
      } else {
        const { data: cpayByOrder } = await supabaseAdmin
          .from('contest_payments')
          .select('*')
          .eq('transaction_ref', razorpay_order_id)
          .maybeSingle();

        if (cpayByOrder) {
          persistedOrder = {
            id: razorpay_order_id,
            user_id: cpayByOrder.user_id,
            purpose: cpayByOrder.contest_id,
            amount: 4900,
            currency: 'INR'
          };
        }
      }
    }

    if (!persistedOrder) {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Order not found: ${razorpay_order_id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Order record was not found or was not created by this application',
        code: 'ORDER_NOT_FOUND',
        correlation_id: correlationId
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify ownership: authenticated user must match the user who created the order
    if (persistedOrder.user_id !== user.id) {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Ownership mismatch for order ${razorpay_order_id}: expected ${persistedOrder.user_id}, got ${user.id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Forbidden: You do not have permission to verify this order',
        code: 'ORDER_OWNERSHIP_MISMATCH',
        correlation_id: correlationId
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify purpose matches if contest_id specified
    const expectedPurpose = (contest_id && contest_id !== 'course_unlock' && contest_id !== 'premium_unlock')
      ? String(contest_id)
      : 'course_unlock';

    if (persistedOrder.purpose && persistedOrder.purpose !== 'course_unlock' && persistedOrder.purpose !== expectedPurpose) {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Purpose mismatch for order ${razorpay_order_id}: order is ${persistedOrder.purpose}, requested ${expectedPurpose}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment purpose mismatch between order and verification request',
        code: 'PURPOSE_MISMATCH',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify checkout signature using server-stored order ID + "|" + razorpay_payment_id with RAZORPAY_KEY_SECRET
    const isValidSignature = await verifyRazorpaySignature(
      persistedOrder.id,
      razorpay_payment_id,
      razorpay_signature,
      keySecret
    );

    if (!isValidSignature) {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Signature verification failed for order ${persistedOrder.id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment signature verification failed. Please contact support if your payment was deducted.',
        code: 'INVALID_SIGNATURE',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch and validate the Razorpay payment server-side
    const authHeaderValue = 'Basic ' + btoa(`${keyId}:${keySecret}`);
    let rzpCheck: Response;
    try {
      rzpCheck = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
        headers: { Authorization: authHeaderValue }
      });
    } catch (fetchErr: any) {
      console.error(`[verify-razorpay-payment] [${correlationId}] Network error looking up payment ${razorpay_payment_id}:`, fetchErr?.message || fetchErr);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to verify payment with provider due to a network error. Verification pending.',
        code: 'PROVIDER_LOOKUP_FAILED',
        correlation_id: correlationId
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!rzpCheck.ok) {
      const errText = await rzpCheck.text().catch(() => '');
      console.error(`[verify-razorpay-payment] [${correlationId}] Razorpay payment lookup failed: HTTP ${rzpCheck.status}`, errText);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment provider rejected payment lookup. Verification pending.',
        code: 'PROVIDER_LOOKUP_FAILED',
        correlation_id: correlationId
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const pData = await rzpCheck.json();

    // Require correct order, amount, currency, and captured status before granting access
    if (pData.order_id && pData.order_id !== persistedOrder.id) {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Payment order mismatch: ${pData.order_id} vs ${persistedOrder.id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment order ID mismatch with provider records',
        code: 'ORDER_MISMATCH',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (pData.amount !== 4900 || pData.currency !== 'INR') {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Amount or currency mismatch: ${pData.amount} ${pData.currency}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment amount or currency verification failed',
        code: 'AMOUNT_MISMATCH',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (pData.status !== 'captured') {
      console.warn(`[verify-razorpay-payment] [${correlationId}] Payment is not captured: status is ${pData.status}`);
      return new Response(JSON.stringify({
        success: false,
        error: `Payment is not in captured state (current status: ${pData.status}). Verification pending.`,
        code: 'PAYMENT_NOT_CAPTURED',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Prevent reuse of another user's payment
    const { data: existingPayForOtherUser } = await supabaseAdmin
      .from('payments')
      .select('id, user_id, status')
      .eq('transaction_reference', razorpay_payment_id)
      .neq('user_id', user.id)
      .eq('status', 'verified')
      .maybeSingle();

    if (existingPayForOtherUser) {
      console.error(`[verify-razorpay-payment] [${correlationId}] Payment ${razorpay_payment_id} already credited to different user ${existingPayForOtherUser.user_id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Security violation: This payment has already been credited to another account',
        code: 'PAYMENT_ALREADY_USED',
        correlation_id: correlationId
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: existingCpayForOtherUser } = await supabaseAdmin
      .from('contest_payments')
      .select('id, user_id, status')
      .eq('transaction_ref', razorpay_payment_id)
      .neq('user_id', user.id)
      .eq('status', 'VERIFIED')
      .maybeSingle();

    if (existingCpayForOtherUser) {
      console.error(`[verify-razorpay-payment] [${correlationId}] Contest payment ${razorpay_payment_id} already credited to different user ${existingCpayForOtherUser.user_id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Security violation: This payment has already been credited to another account',
        code: 'PAYMENT_ALREADY_USED',
        correlation_id: correlationId
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Finalize payment through the shared, atomic payment finalization path.
    await finalizePayment({
      orderId: persistedOrder.id,
      paymentId: razorpay_payment_id,
      userId: user.id,
      userEmail: user.email || '',
      purpose: expectedPurpose,
      amountPaise: 4900,
      currency: 'INR',
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Payment verified and access unlocked successfully.',
      status: 'verified',
      user_id: user.id,
      correlation_id: correlationId
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error(`[verify-razorpay-payment] [${correlationId}] Unhandled internal exception:`, err?.message || err);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal server error occurred while verifying payment',
      code: 'INTERNAL_ERROR',
      correlation_id: correlationId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
