import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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
    return expectedSignature.toLowerCase() === signature.toLowerCase();
  } catch (err) {
    console.error('[razorpay-webhook] Signature computation error:', err);
    return false;
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    let eventData: any = {};
    try {
      eventData = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Webhook signature verification
    const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ||
                          Deno.env.get('RAZORPAY_KEY_SECRET') ||
                          Deno.env.get('RAZORPAY_SECRET') || '';

    const razorpaySignature = req.headers.get('x-razorpay-signature') || req.headers.get('X-Razorpay-Signature') || '';

    if (webhookSecret && razorpaySignature) {
      const isValid = await verifyWebhookSignature(rawBody, razorpaySignature, webhookSecret);
      if (!isValid) {
        console.warn('[razorpay-webhook] Signature verification failed.');
        return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const event = eventData.event || '';
    console.log(`[razorpay-webhook] Received event: ${event}`);

    // Process only payment/order success events
    const isPaymentSuccess = event === 'payment.captured' ||
                             event === 'payment.authorized' ||
                             event === 'order.paid' ||
                             event === 'payment_intent.succeeded' ||
                             !event; // fallback if direct payload test

    if (!isPaymentSuccess) {
      return new Response(JSON.stringify({ received: true, ignored: true, event }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = eventData.payload || {};
    const paymentEntity = payload.payment?.entity || eventData.payment || {};
    const orderEntity = payload.order?.entity || eventData.order || {};

    const orderId = paymentEntity.order_id || orderEntity.id || eventData.order_id || '';
    const paymentId = paymentEntity.id || eventData.payment_id || '';
    const notes = paymentEntity.notes || orderEntity.notes || eventData.notes || {};

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const nowIso = new Date().toISOString();

    // 1. Find contest_payments using transaction_ref (matching order ID or payment ID)
    let matchedPayment: any = null;

    if (orderId) {
      const { data: payByOrder, error: errByOrder } = await supabaseAdmin
        .from('contest_payments')
        .select('*')
        .eq('transaction_ref', orderId)
        .maybeSingle();

      if (!errByOrder && payByOrder) {
        matchedPayment = payByOrder;
      }
    }

    if (!matchedPayment && paymentId) {
      const { data: payByPaymentId, error: errByPayId } = await supabaseAdmin
        .from('contest_payments')
        .select('*')
        .eq('transaction_ref', paymentId)
        .maybeSingle();

      if (!errByPayId && payByPaymentId) {
        matchedPayment = payByPaymentId;
      }
    }

    // Fallback: If not found by transaction_ref, check by contest_id and user_id from notes
    if (!matchedPayment && notes.contest_id && notes.user_id && notes.contest_id !== 'course_unlock' && notes.contest_id !== 'premium_unlock') {
      const { data: payByNotes } = await supabaseAdmin
        .from('contest_payments')
        .select('*')
        .eq('contest_id', notes.contest_id)
        .eq('user_id', notes.user_id)
        .maybeSingle();

      if (payByNotes) {
        matchedPayment = payByNotes;
      }
    }

    // Handle Contest Payment Unlock
    if (matchedPayment || (notes.contest_id && notes.user_id && notes.contest_id !== 'course_unlock' && notes.contest_id !== 'premium_unlock')) {
      const contestId = matchedPayment?.contest_id || notes.contest_id;
      const userId = matchedPayment?.user_id || notes.user_id;
      const userEmail = notes.user_email || matchedPayment?.user_email || '';

      // 2. Mark payment as verified/paid in contest_payments
      const { data: updatedPayment, error: updateErr } = await supabaseAdmin
        .from('contest_payments')
        .upsert({
          contest_id: contestId,
          user_id: userId,
          amount: 49,
          currency: 'INR',
          status: 'paid',
          payment_method: 'RAZORPAY',
          transaction_ref: paymentId || orderId || matchedPayment?.transaction_ref,
          verified_at: nowIso,
          updated_at: nowIso
        }, { onConflict: 'contest_id,user_id' })
        .select()
        .single();

      if (updateErr) {
        console.error('[razorpay-webhook] Error updating contest_payments:', updateErr);
      }

      // 3. Unlock the contest for that user in contest_eligibility
      await supabaseAdmin
        .from('contest_eligibility')
        .upsert({
          contest_id: contestId,
          user_id: userId,
          user_email: userEmail,
          is_invited: true
        }, { onConflict: 'contest_id,user_id' });

      console.log(`[razorpay-webhook] Contest ${contestId} unlocked for user ${userId}`);

      return new Response(JSON.stringify({
        success: true,
        event,
        contest_id: contestId,
        user_id: userId,
        status: 'paid',
        payment: updatedPayment
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Handle Course / Premium Lifetime Access Unlock if applicable
    if (notes.user_id && (notes.contest_id === 'course_unlock' || notes.contest_id === 'premium_unlock' || !notes.contest_id)) {
      await supabaseAdmin
        .from('profiles')
        .update({ paid_unlocked: true })
        .eq('id', notes.user_id);

      await supabaseAdmin
        .from('payments')
        .insert({
          user_id: notes.user_id,
          user_email: notes.user_email || '',
          amount: 49,
          currency: 'INR',
          payment_method: 'RAZORPAY',
          transaction_reference: paymentId || orderId,
          status: 'approved',
          submitted_at: nowIso,
          verified_at: nowIso
        });

      console.log(`[razorpay-webhook] Premium course access unlocked for user ${notes.user_id}`);

      return new Response(JSON.stringify({
        success: true,
        event,
        user_id: notes.user_id,
        status: 'paid'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Webhook processed',
      order_id: orderId,
      payment_id: paymentId
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('[razorpay-webhook] Unhandled error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Internal webhook error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
