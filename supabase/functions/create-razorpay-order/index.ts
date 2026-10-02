import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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
    const { contest_id } = body;

    const keyId = Deno.env.get('RAZORPAY_KEY_ID') || 'rzp_test_placeholder';
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET') || Deno.env.get('RAZORPAY_SECRET') || '';

    const amountPaise = 4900; // ₹49
    const currency = 'INR';
    const receipt = `rcpt_${Date.now()}_${user.id.slice(0, 6)}`;

    let orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    if (keyId && keySecret && !keyId.includes('placeholder')) {
      try {
        const authHeaderVal = 'Basic ' + btoa(`${keyId}:${keySecret}`);
        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
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
              contest_id: contest_id || 'premium_unlock',
              user_id: user.id,
              user_email: user.email || ''
            }
          })
        });

        if (rzpRes.ok) {
          const rzpData = await rzpRes.json();
          orderId = rzpData.id;
        } else {
          console.warn('[create-razorpay-order] Razorpay API error, falling back to simulated order:', await rzpRes.text());
        }
      } catch (rzpErr) {
        console.warn('[create-razorpay-order] Razorpay fetch failed, using generated orderId:', rzpErr);
      }
    }

    return new Response(JSON.stringify({
      order_id: orderId,
      key_id: keyId,
      amount: amountPaise,
      currency,
      receipt
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message || 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
