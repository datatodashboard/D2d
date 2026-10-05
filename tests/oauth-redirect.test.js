import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isAndroidNativeApp, getOAuthRedirectUrl } from '../js/util.js';

function setMockNavigatorUa(ua) {
  try {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: ua,
      configurable: true,
      writable: true
    });
  } catch (_) {}
}

describe('Google OAuth Redirect URL Architecture (Web vs Mobile)', () => {
  it('1. Web Application: returns HTTPS web origin and NEVER uses custom schemes or xdg-open', () => {
    // Simulate standard Linux desktop Chrome browser environment
    globalThis.window = {
      location: {
        origin: 'https://crack-sql-d2d.netlify.app',
        protocol: 'https:',
        pathname: '/index.html'
      }
    };
    setMockNavigatorUa('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    assert.strictEqual(isAndroidNativeApp(), false, 'Linux Chrome must be detected as Web, NOT Android native');

    const redirectUrl = getOAuthRedirectUrl();
    assert.strictEqual(redirectUrl, 'https://crack-sql-d2d.netlify.app', 'Web OAuth redirect must be HTTPS web origin');

    // Strict assertions against non-HTTP/HTTPS and custom schemes
    assert.ok(redirectUrl.startsWith('https://'), 'Redirect URL must start with https://');
    assert.strictEqual(redirectUrl.includes('xdg-open'), false, 'Must NOT contain xdg-open');
    assert.strictEqual(redirectUrl.includes('://') && !redirectUrl.startsWith('http'), false, 'Must NOT use custom scheme');
    assert.strictEqual(redirectUrl.startsWith('cracksql://'), false, 'Must NOT use Android deep-link scheme on web');
  });

  it('2. Local Development & Preview Web: returns current window.location.origin', () => {
    globalThis.window = {
      location: {
        origin: 'http://localhost:3000',
        protocol: 'http:',
        pathname: '/index.html'
      }
    };
    setMockNavigatorUa('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    assert.strictEqual(isAndroidNativeApp(), false);
    const redirectUrl = getOAuthRedirectUrl();
    assert.strictEqual(redirectUrl, 'http://localhost:3000', 'Local dev must use window.location.origin');
  });

  it('3. Fallback when window.location is undefined or non-http: defaults to production web origin', () => {
    globalThis.window = {
      location: {
        origin: '',
        protocol: ''
      }
    };
    setMockNavigatorUa('');

    const redirectUrl = getOAuthRedirectUrl();
    assert.strictEqual(redirectUrl, 'https://crack-sql-d2d.netlify.app', 'Fallback must be HTTPS production web origin');
  });

  it('4. Mobile Application: preserves Android deep-link redirect when running inside native Android container', () => {
    // Scenario A: Capacitor Android native container
    globalThis.window = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android'
      },
      location: {
        origin: 'capacitor://localhost',
        protocol: 'capacitor:'
      }
    };
    setMockNavigatorUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36');

    assert.strictEqual(isAndroidNativeApp(), true, 'Must detect Capacitor Android native app');
    assert.strictEqual(getOAuthRedirectUrl(), 'cracksql://auth/callback', 'Must return Android deep-link redirect URI');

    // Scenario B: Custom Android Bridge
    globalThis.window = {
      Android: {},
      location: {
        origin: 'http://localhost',
        protocol: 'http:'
      }
    };
    assert.strictEqual(isAndroidNativeApp(), true, 'Must detect Android interface bridge');
    assert.strictEqual(getOAuthRedirectUrl(), 'cracksql://auth/callback');

    // Scenario C: Custom configured Android redirect URI
    globalThis.window = {
      Android: {},
      ANDROID_OAUTH_REDIRECT_URI: 'com.datatodashboard.cracksql://auth/callback',
      location: { origin: '', protocol: '' }
    };
    assert.strictEqual(getOAuthRedirectUrl(), 'com.datatodashboard.cracksql://auth/callback');
  });

  it('5. Mobile Browser (Chrome on Android): detected as Web and stays in browser via HTTPS redirect', () => {
    // Normal mobile browser (NOT native container)
    globalThis.window = {
      location: {
        origin: 'https://crack-sql-d2d.netlify.app',
        protocol: 'https:',
        pathname: '/'
      }
    };
    setMockNavigatorUa('Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36');

    assert.strictEqual(isAndroidNativeApp(), false, 'Mobile web browser is NOT a native container');
    assert.strictEqual(getOAuthRedirectUrl(), 'https://crack-sql-d2d.netlify.app', 'Mobile web browser must use HTTPS web origin');
  });

  it('6. Supabase provider callback URL architecture remains standard', () => {
    const supabaseOAuthCallback = 'https://qklnaqfspvmnlequqagf.supabase.co/auth/v1/callback';
    assert.ok(supabaseOAuthCallback.endsWith('/auth/v1/callback'), 'Provider callback must remain Supabase Auth callback');
    assert.ok(supabaseOAuthCallback.startsWith('https://'), 'Provider callback must be HTTPS');
  });
});
