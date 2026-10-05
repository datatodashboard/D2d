import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function generateCorrelationId(): string {
  return `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
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
      console.error(`[create-razorpay-order] [${correlationId}] Missing Supabase URL or anon key.`);
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

    // Require valid server-side Razorpay configuration
    const keyId = Deno.env.get('RAZORPAY_KEY_ID');
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret || keyId.trim() === '' || keySecret.trim() === '' || keyId.includes('placeholder')) {
      console.error(`[create-razorpay-order] [${correlationId}] Missing or placeholder Razorpay API credentials.`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Server configuration error: payment gateway credentials not configured',
        code: 'CONFIGURATION_ERROR',
        correlation_id: correlationId
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json().catch(() => ({}));
    const purpose = (body.contest_id && body.contest_id !== 'course_unlock' && body.contest_id !== 'premium_unlock')
      ? String(body.contest_id)
      : 'course_unlock';

    const amountPaise = 4900; // Fixed ₹49 = 4900 paise
    const currency = 'INR';
    const receipt = `rcpt_${Date.now()}_${user.id.slice(0, 6)}`;

    // Call real Razorpay API to create order
    const authHeaderVal = 'Basic ' + btoa(`${keyId}:${keySecret}`);
    let rzpRes: Response;
    try {
      rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeaderVal
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency,
          receipt,
          notes: {
            purpose,
            user_id: user.id,
            user_email: user.email || ''
          }
        })
      });
    } catch (fetchErr: any) {
      console.error(`[create-razorpay-order] [${correlationId}] Network error contacting Razorpay:`, fetchErr?.message || fetchErr);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to connect to payment provider. Please try again.',
        code: 'GATEWAY_NETWORK_ERROR',
        correlation_id: correlationId
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!rzpRes.ok) {
      const errText = await rzpRes.text().catch(() => '');
      console.error(`[create-razorpay-order] [${correlationId}] Razorpay order creation failed: HTTP ${rzpRes.status}`, errText);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment provider rejected order creation request',
        code: 'PROVIDER_ERROR',
        correlation_id: correlationId
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const rzpData = await rzpRes.json();
    const realOrderId = rzpData.id;

    if (!realOrderId || typeof realOrderId !== 'string') {
      console.error(`[create-razorpay-order] [${correlationId}] Razorpay returned invalid order payload:`, rzpData);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid order response received from payment provider',
        code: 'INVALID_PROVIDER_RESPONSE',
        correlation_id: correlationId
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Persist real order before returning it, including authenticated owner, purpose, expected amount, and currency
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const nowIso = new Date().toISOString();

    // 1. Persist in razorpay_orders
    const { error: orderDbErr } = await supabaseAdmin
      .from('razorpay_orders')
      .insert({
        id: realOrderId,
        user_id: user.id,
        user_email: user.email || '',
        purpose,
        amount: amountPaise,
        currency,
        status: 'created',
        receipt
      });

    if (orderDbErr) {
      console.warn(`[create-razorpay-order] [${correlationId}] Notice writing razorpay_orders:`, orderDbErr.message);
      // Fallback: Ensure recorded in payments / contest_payments
      if (purpose === 'course_unlock') {
        const { error: payErr } = await supabaseAdmin
          .from('payments')
          .insert({
            user_id: user.id,
            user_email: user.email || '',
            amount: 49,
            currency,
            payment_method: 'RAZORPAY',
            transaction_reference: realOrderId,
            status: 'pending',
            submitted_at: nowIso
          });
        if (payErr) {
          console.error(`[create-razorpay-order] [${correlationId}] Failed to record pending payment:`, payErr.message);
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to record payment order in database',
            code: 'DATABASE_ERROR',
            correlation_id: correlationId
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      } else {
        const { error: cpayErr } = await supabaseAdmin
          .from('contest_payments')
          .upsert({
            contest_id: purpose,
            user_id: user.id,
            amount: 49,
            currency,
            status: 'PENDING',
            payment_method: 'RAZORPAY',
            transaction_ref: realOrderId
          }, { onConflict: 'contest_id,user_id' });
        if (cpayErr) {
          console.error(`[create-razorpay-order] [${correlationId}] Failed to record contest payment:`, cpayErr.message);
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to record payment order in database',
            code: 'DATABASE_ERROR',
            correlation_id: correlationId
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }
    } else {
      // Also write pending record to payments / contest_payments for tracking
      if (purpose === 'course_unlock') {
        await supabaseAdmin
          .from('payments')
          .insert({
            user_id: user.id,
            user_email: user.email || '',
            amount: 49,
            currency,
            payment_method: 'RAZORPAY',
            transaction_reference: realOrderId,
            status: 'pending',
            submitted_at: nowIso
          });
      } else {
        await supabaseAdmin
          .from('contest_payments')
          .upsert({
            contest_id: purpose,
            user_id: user.id,
            amount: 49,
            currency,
            status: 'PENDING',
            payment_method: 'RAZORPAY',
            transaction_ref: realOrderId
          }, { onConflict: 'contest_id,user_id' });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      order_id: realOrderId,
      key_id: keyId,
      amount: amountPaise,
      currency,
      receipt,
      correlation_id: correlationId
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error(`[create-razorpay-order] [${correlationId}] Unhandled internal exception:`, err?.message || err);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred while processing order creation',
      code: 'INTERNAL_ERROR',
      correlation_id: correlationId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
