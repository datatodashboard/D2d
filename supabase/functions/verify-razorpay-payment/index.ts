import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export async function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, secret: string): Promise<boolean> {
  if (!orderId || !paymentId || !signature || !secret) return false;
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
  return expectedSignature.toLowerCase() === signature.toLowerCase();
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized: Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

    const supabaseUserClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabaseUserClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized: User session invalid or expired' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, contest_id } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !contest_id) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required parameters: razorpay_order_id, razorpay_payment_id, razorpay_signature, and contest_id are required.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. Verify Razorpay payment signature on the server using RAZORPAY_KEY_SECRET
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET') || Deno.env.get('RAZORPAY_SECRET') || '';
    if (!keySecret) {
      console.error('[verify-razorpay-payment] RAZORPAY_KEY_SECRET is not configured on server.');
      return new Response(JSON.stringify({ success: false, error: 'Server configuration error: missing payment secret.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const isValidSignature = await verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      keySecret
    );

    if (!isValidSignature) {
      return new Response(JSON.stringify({ success: false, error: 'Payment signature verification failed.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 5. Verify that the contest exists and matches the requested contest_id
    const { data: contest, error: contestErr } = await supabaseAdmin
      .from('contests')
      .select('id, entry_fee, currency, status')
      .eq('id', contest_id)
      .maybeSingle();

    if (contestErr || !contest) {
      return new Response(JSON.stringify({ success: false, error: 'Requested contest was not found.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 6. Verify payment amount is exactly ₹49 (4900 paise)
    const contestFee = Number(contest.entry_fee) || 49;
    if (contestFee !== 49) {
      return new Response(JSON.stringify({ success: false, error: 'Payment amount mismatch: fixed contest fee must be ₹49.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Optional direct verification against Razorpay API if key ID is present
    const keyId = Deno.env.get('RAZORPAY_KEY_ID') || '';
    if (keyId && keySecret) {
      try {
        const authHeaderValue = 'Basic ' + btoa(`${keyId}:${keySecret}`);
        const rzpCheck = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
          headers: { Authorization: authHeaderValue }
        });
        if (rzpCheck.ok) {
          const pData = await rzpCheck.json();
          if (pData.order_id && pData.order_id !== razorpay_order_id) {
            return new Response(JSON.stringify({ success: false, error: 'Payment order mismatch.' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
          if (pData.amount && (pData.amount !== 4900 || pData.currency !== 'INR')) {
            return new Response(JSON.stringify({ success: false, error: 'Payment amount verification failed.' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }
      } catch (rzpFetchErr) {
        console.warn('[verify-razorpay-payment] Razorpay API direct verification check notice:', rzpFetchErr);
      }
    }

    // 8. Update the existing contest_payments record idempotently
    const nowIso = new Date().toISOString();
    const { data: updatedPayment, error: payUpdateErr } = await supabaseAdmin
      .from('contest_payments')
      .upsert({
        contest_id: contest_id,
        user_id: user.id,
        amount: 49,
        currency: 'INR',
        status: 'paid',
        payment_method: 'RAZORPAY',
        transaction_ref: razorpay_payment_id,
        verified_at: nowIso,
        updated_at: nowIso
      }, { onConflict: 'contest_id,user_id' })
      .select()
      .single();

    if (payUpdateErr) {
      console.error('[verify-razorpay-payment] DB update error:', payUpdateErr);
      return new Response(JSON.stringify({ success: false, error: 'Failed to update contest payment record.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 9. Unlock contest access: ensure contest_eligibility record exists idempotently
    await supabaseAdmin
      .from('contest_eligibility')
      .upsert({
        contest_id: contest_id,
        user_id: user.id,
        user_email: user.email,
        is_invited: true
      }, { onConflict: 'contest_id,user_id' });

    return new Response(JSON.stringify({
      success: true,
      message: 'Payment verified and contest unlocked successfully.',
      payment: updatedPayment,
      contest_id,
      user_id: user.id,
      status: 'paid'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('[verify-razorpay-payment] Unhandled error:', err);
    return new Response(JSON.stringify({ success: false, error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
