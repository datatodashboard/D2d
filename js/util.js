export function escapeHtml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

/**
 * Detect whether the app is executing inside a native Android mobile container
 * (e.g. Capacitor, Cordova, Android WebView interface, or custom mobile scheme)
 * versus a standard web browser.
 */
export function isAndroidNativeApp() {
  if (typeof window === 'undefined') return false;

  // 1. Android native container bridges / interfaces
  if (window.Android || window.AndroidBridge || window.AndroidInterface) return true;
  if (window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'android') return true;
  if (window.cordova && window.cordova?.platformId === 'android') return true;
  if (window.ReactNativeWebView) return true;

  // 2. Custom mobile scheme protocol (not http or https)
  if (window.location && window.location.protocol && !window.location.protocol.startsWith('http')) {
    return true;
  }

  // 3. Android WebView with embedded container flag
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Android.*wv/.test(ua) && window.isNativeApp) {
    return true;
  }

  return false;
}

/**
 * Returns the authoritative OAuth post-login redirect URL based on runtime platform.
 * - WEB: Always returns an HTTPS (or current origin HTTP) web URL (window.location.origin)
 *        Never returns xdg-open, custom desktop schemes, or Android deep links in web browsers.
 * - MOBILE: Returns the existing Android deep-link redirect URI when running in a native Android container.
 */
export function getOAuthRedirectUrl() {
  // MOBILE: Native Android container
  if (isAndroidNativeApp()) {
    return (typeof window !== 'undefined' && window.ANDROID_OAUTH_REDIRECT_URI) || 'cracksql://auth/callback';
  }

  // WEB APP: Normal web browser (Linux desktop, Windows, macOS, Mobile Web)
  if (typeof window !== 'undefined' && window.location) {
    const origin = window.location.origin;
    if (origin && (origin.startsWith('https://') || origin.startsWith('http://'))) {
      return origin;
    }
  }

  // Fallback to configured production web origin
  return 'https://crack-sql-d2d.netlify.app';
}

/**
 * Validates and formats Indian mobile numbers.
 * Requires 10 digits, saved in +91 format (e.g., +919876543210).
 */
export function validateAndFormatIndianMobile(mobileStr) {
  if (mobileStr === null || mobileStr === undefined) {
    return { isValid: false, formatted: '', error: 'Mobile number is required.' };
  }
  const str = String(mobileStr).trim();
  if (!str) {
    return { isValid: false, formatted: '', error: 'Mobile number is required.' };
  }

  // Remove spaces, hyphens, brackets, dots
  let cleaned = str.replace(/[\s\-\(\)\.]/g, '');

  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }

  if (/^[6-9]\d{9}$/.test(cleaned) || /^\d{10}$/.test(cleaned)) {
    return { isValid: true, formatted: `+91${cleaned}`, error: null };
  }

  return { isValid: false, formatted: '', error: 'Please enter a valid 10-digit Indian mobile number.' };
}

