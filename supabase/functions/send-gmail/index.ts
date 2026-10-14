import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function bufferToBase64Url(buffer: Uint8Array): string {
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stringToBase64Url(str: string): string {
  const encoder = new TextEncoder();
  return bufferToBase64Url(encoder.encode(str));
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized: Missing authorization header',
        code: 'UNAUTHORIZED'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Server configuration error: database connection not configured',
        code: 'CONFIGURATION_ERROR'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 1. Authenticate calling user
    const supabaseUserClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabaseUserClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized: User session invalid or expired',
        code: 'UNAUTHORIZED'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Authoritative server-side admin privilege check
    let isCallerAdmin = false;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    try {
      const { data: adminRow } = await supabaseAdmin
        .from('admin_users')
        .select('id')
        .or(`user_id.eq.${user.id},email.eq.${user.email || ''}`)
        .maybeSingle();

      if (adminRow) {
        isCallerAdmin = true;
      } else {
        const { data: profRow } = await supabaseAdmin
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .maybeSingle();

        if (profRow?.is_admin === true) {
          isCallerAdmin = true;
        } else if (user.email === 'datatodashboard2@gmail.com') {
          isCallerAdmin = true;
        }
      }
    } catch (checkErr) {
      console.warn('[send-gmail] Admin verification check warning:', checkErr);
      if (user.email === 'datatodashboard2@gmail.com') {
        isCallerAdmin = true;
      }
    }

    if (!isCallerAdmin) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Forbidden: Only verified administrators can access the Gmail Sender service.',
        code: 'FORBIDDEN'
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const { action, to, subject, message, testMode } = body;

    // Read secure server-side secrets (never exposed to frontend)
    const clientId = Deno.env.get('GMAIL_CLIENT_ID');
    const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
    const refreshToken = Deno.env.get('GMAIL_REFRESH_TOKEN');
    const senderEmail = Deno.env.get('GMAIL_SENDER_EMAIL') || 'datatodashboard2@gmail.com';

    const missingSecrets: string[] = [];
    if (!clientId || clientId.trim() === '' || clientId.includes('placeholder')) missingSecrets.push('GMAIL_CLIENT_ID');
    if (!clientSecret || clientSecret.trim() === '' || clientSecret.includes('placeholder')) missingSecrets.push('GMAIL_CLIENT_SECRET');
    if (!refreshToken || refreshToken.trim() === '' || refreshToken.includes('placeholder')) missingSecrets.push('GMAIL_REFRESH_TOKEN');

    const setupSteps = [
      '1. In Google Cloud Console, enable Gmail API and configure an OAuth 2.0 Web Client ID.',
      '2. Authorize scope "https://www.googleapis.com/auth/gmail.send".',
      '3. Generate an authorized OAuth refresh token for datatodashboard2@gmail.com.',
      '4. Store credentials securely in Supabase Secrets using the Supabase CLI:',
      '   supabase secrets set GMAIL_CLIENT_ID="<client_id>" GMAIL_CLIENT_SECRET="<client_secret>" GMAIL_REFRESH_TOKEN="<refresh_token>" GMAIL_SENDER_EMAIL="datatodashboard2@gmail.com"',
      '5. Once configured, test delivery with your own email before broadcasting to learners.'
    ];

    // Status check action
    if (action === 'status') {
      const isConfigured = missingSecrets.length === 0;
      return new Response(JSON.stringify({
        success: true,
        configured: isConfigured,
        senderEmail,
        missingSecrets,
        setupSteps: isConfigured ? [] : setupSteps
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify secrets configuration before proceeding with real delivery
    if (missingSecrets.length > 0) {
      console.warn(`[send-gmail] Missing server-side secrets: ${missingSecrets.join(', ')}`);
      return new Response(JSON.stringify({
        success: false,
        configured: false,
        code: 'GMAIL_CONFIG_MISSING',
        error: `Gmail API credentials not fully configured. Missing secrets: ${missingSecrets.join(', ')}.`,
        missingSecrets,
        setupSteps
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate recipient
    if (!to || typeof to !== 'string' || !to.includes('@') || to.trim().length < 5) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid recipient email address.',
        code: 'INVALID_RECIPIENT'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate subject & message
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email subject is required.',
        code: 'INVALID_SUBJECT'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email message content is required.',
        code: 'INVALID_MESSAGE'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Step A: Refresh Google OAuth Access Token
    console.log(`[send-gmail] Refreshing access token for sender: ${senderEmail}`);
    const tokenParams = new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken!,
      grant_type: 'refresh_token'
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });

    if (!tokenRes.ok) {
      const tokenErr = await tokenRes.json().catch(() => ({}));
      console.error('[send-gmail] Google OAuth token refresh failed:', tokenErr);
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to refresh Gmail OAuth access token: ${tokenErr.error_description || tokenErr.error || 'Invalid credentials'}`,
        code: 'TOKEN_REFRESH_FAILED',
        setupSteps
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to obtain access token from Google OAuth endpoint',
        code: 'TOKEN_REFRESH_EMPTY'
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Step B: Build RFC 2822 / MIME Email Package
    const trimmedTo = to.trim();
    const trimmedSubject = subject.trim();
    const trimmedMessage = message.trim();

    // UTF-8 subject header encoding: =?utf-8?B?...?=
    const utf8Subject = `=?utf-8?B?${btoa(unescape(encodeURIComponent(trimmedSubject)))}?=`;

    const mimeLines = [
      `From: "Crack SQL (Data2Dashboard)" <${senderEmail}>`,
      `To: <${trimmedTo}>`,
      `Subject: ${utf8Subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      btoa(unescape(encodeURIComponent(trimmedMessage)))
    ];

    const rawMime = mimeLines.join('\r\n');
    const rawSafeBase64 = stringToBase64Url(rawMime);

    // Step C: Dispatch to official Gmail API
    console.log(`[send-gmail] Sending message via Gmail API to ${trimmedTo}`);
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: rawSafeBase64 })
    });

    if (!gmailRes.ok) {
      const gmailErr = await gmailRes.json().catch(() => ({}));
      console.error('[send-gmail] Gmail API send failed:', gmailErr);
      return new Response(JSON.stringify({
        success: false,
        error: `Gmail API delivery rejected: ${gmailErr.error?.message || 'Unknown Gmail API error'}`,
        code: 'GMAIL_API_ERROR',
        details: gmailErr.error
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const gmailData = await gmailRes.json();
    console.log(`[send-gmail] Successfully delivered message id: ${gmailData.id} to ${trimmedTo}`);

    return new Response(JSON.stringify({
      success: true,
      messageId: gmailData.id,
      threadId: gmailData.threadId,
      recipient: trimmedTo,
      sender: senderEmail,
      sentAt: new Date().toISOString()
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('[send-gmail] Unhandled exception:', err);
    return new Response(JSON.stringify({
      success: false,
      error: `Internal server error: ${err.message || 'Unknown error'}`,
      code: 'INTERNAL_ERROR'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
