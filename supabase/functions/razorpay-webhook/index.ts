import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { finalizePayment } from '../_shared/payment-finalization.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function generateCorrelationId(): string {
  return `wbk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyWebhookSignature(bodyRaw: string, signature: string, secret: string): Promise<boolean> {
  if (!bodyRaw || !signature || !secret) return false;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(bodyRaw);
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
    // Webhook authentication: Use ONLY RAZORPAY_WEBHOOK_SECRET, no API secret fallbacks
    const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET');
    if (!webhookSecret || webhookSecret.trim() === '') {
      console.error(`[razorpay-webhook] [${correlationId}] RAZORPAY_WEBHOOK_SECRET is not configured on the server.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Webhook configuration error: webhook secret not configured',
        code: 'CONFIGURATION_ERROR',
        correlation_id: correlationId
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Require X-Razorpay-Signature
    const razorpaySignature = req.headers.get('x-razorpay-signature') || req.headers.get('X-Razorpay-Signature');
    if (!razorpaySignature || razorpaySignature.trim() === '') {
      console.warn(`[razorpay-webhook] [${correlationId}] Missing required X-Razorpay-Signature header.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required webhook signature header',
        code: 'MISSING_SIGNATURE',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const rawBody = await req.text();
    if (!rawBody || rawBody.trim() === '') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Empty webhook payload received',
        code: 'EMPTY_PAYLOAD',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify HMAC-SHA256 signature against exact raw request body using timing-safe comparison
    const isValidSignature = await verifyWebhookSignature(rawBody, razorpaySignature, webhookSecret);
    if (!isValidSignature) {
      console.warn(`[razorpay-webhook] [${correlationId}] Signature verification failed.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid Razorpay webhook signature',
        code: 'INVALID_SIGNATURE',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Perform NO database writes before signature verification is passed
    let eventData: any = {};
    try {
      eventData = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid JSON payload format',
        code: 'INVALID_JSON',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const event = eventData.event;
    if (!event || typeof event !== 'string') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing event field in webhook payload',
        code: 'MISSING_EVENT',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[razorpay-webhook] [${correlationId}] Verified webhook event: ${event}`);

    // Only valid captured/paid events may grant access.
    // Strictly reject payment.authorized, unrelated events, or missing events.
    const isPaymentCaptured = event === 'payment.captured' || event === 'order.paid';

    if (!isPaymentCaptured) {
      console.log(`[razorpay-webhook] [${correlationId}] Non-capture event ignored safely: ${event}`);
      return new Response(JSON.stringify({
        success: true,
        received: true,
        ignored: true,
        event,
        correlation_id: correlationId
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = eventData.payload || {};
    const paymentEntity = payload.payment?.entity || {};
    const orderEntity = payload.order?.entity || {};

    const orderId = paymentEntity.order_id || orderEntity.id || '';
    const paymentId = paymentEntity.id || '';
    const notes = paymentEntity.notes || orderEntity.notes || {};

    const paymentAmount = paymentEntity.amount;
    const paymentCurrency = paymentEntity.currency;
    const paymentStatus = paymentEntity.status;

    // Validate that payment is captured and has correct amount/currency
    if (paymentStatus && paymentStatus !== 'captured') {
      console.warn(`[razorpay-webhook] [${correlationId}] Payment entity status is not captured: ${paymentStatus}`);
      return new Response(JSON.stringify({
        success: true,
        received: true,
        ignored: true,
        reason: 'Payment status not captured',
        correlation_id: correlationId
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (paymentAmount && (paymentAmount !== 4900 || (paymentCurrency && paymentCurrency !== 'INR'))) {
      console.warn(`[razorpay-webhook] [${correlationId}] Amount or currency mismatch: ${paymentAmount} ${paymentCurrency}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment amount or currency mismatch',
        code: 'AMOUNT_MISMATCH',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const nowIso = new Date().toISOString();

    // Look up order to determine authenticated owner and purpose
    let matchedOrder: any = null;

    if (orderId) {
      const { data: ord } = await supabaseAdmin
        .from('razorpay_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();

      if (ord) matchedOrder = ord;
    }

    const targetUserId = matchedOrder?.user_id || notes.user_id;
    const targetEmail = matchedOrder?.user_email || notes.user_email || '';
    const targetPurpose = matchedOrder?.purpose || notes.purpose || notes.contest_id || 'course_unlock';

    if (!targetUserId) {
      console.error(`[razorpay-webhook] [${correlationId}] Could not resolve user_id from order or notes.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to resolve target user for payment',
        code: 'USER_NOT_FOUND',
        correlation_id: correlationId
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Prevent reuse of payment_id by a different user
    if (paymentId) {
      const { data: existingPay } = await supabaseAdmin
        .from('payments')
        .select('id, user_id, status')
        .eq('transaction_reference', paymentId)
        .neq('user_id', targetUserId)
        .eq('status', 'verified')
        .maybeSingle();

      if (existingPay) {
        console.error(`[razorpay-webhook] [${correlationId}] Payment ${paymentId} already credited to different user ${existingPay.user_id}`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Security violation: Payment already credited to another user',
          code: 'PAYMENT_ALREADY_USED',
          correlation_id: correlationId
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Finalize payment through the shared, atomic payment finalization path.
    await finalizePayment({
      orderId: orderId || null,
      paymentId: paymentId || orderId,
      userId: targetUserId,
      userEmail: targetEmail,
      purpose: targetPurpose,
      amountPaise: 4900,
      currency: 'INR',
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Webhook processed successfully',
      event,
      user_id: targetUserId,
      correlation_id: correlationId
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error(`[razorpay-webhook] [${correlationId}] Unhandled internal exception:`, err?.message || err);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal webhook error occurred',
      code: 'INTERNAL_ERROR',
      correlation_id: correlationId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
