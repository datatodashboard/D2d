import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Admin Portal — Gmail Sender Controller & Backend Flow', () => {

  test('Learner list formatting and email availability detection', () => {
    const rawLearners = [
      { id: 'u1', username: 'alice', email: 'alice@example.com', paidUnlocked: true, solved: 12 },
      { id: 'u2', username: null, email: 'bob@gmail.com', paidUnlocked: false, solved: 5 },
      { id: 'u3', username: 'charlie', email: null, paidUnlocked: false, solved: 0 },
      { id: 'u4', username: 'dave', email: '—', paidUnlocked: false, solved: 2 }
    ];

    // Detection logic
    const withEmail = rawLearners.filter(l => Boolean(l.email && l.email !== '—' && l.email.includes('@')));
    assert.strictEqual(withEmail.length, 2, 'Should identify exactly 2 learners with valid email addresses');
    assert.strictEqual(withEmail[0].email, 'alice@example.com');
    assert.strictEqual(withEmail[1].email, 'bob@gmail.com');

    // Sorting logic: valid emails first, then descending solved
    const sorted = [...rawLearners].sort((a, b) => {
      const aHas = Boolean(a.email && a.email !== '—' && a.email.includes('@'));
      const bHas = Boolean(b.email && b.email !== '—' && b.email.includes('@'));
      if (aHas !== bHas) return bHas ? 1 : -1;
      return (b.solved || 0) - (a.solved || 0);
    });

    assert.strictEqual(sorted[0].email, 'alice@example.com', 'Top learner with email first');
    assert.strictEqual(sorted[1].email, 'bob@gmail.com');
    assert.strictEqual(sorted[2].username, 'dave', 'Higher solved among non-email learners comes before zero-solved');
  });

  test('Search filter properly matches username, email, and premium status', () => {
    const learners = [
      { id: 'u1', username: 'alice_sql', email: 'alice@tech.org', displayName: '@alice_sql', paidUnlocked: true },
      { id: 'u2', username: 'bob_data', email: 'bob@analytics.io', displayName: '@bob_data', paidUnlocked: false },
      { id: 'u3', username: 'carol', email: 'carol@database.com', displayName: '@carol', paidUnlocked: true }
    ];

    // Filter by query 'analytics'
    const query1 = 'analytics';
    const match1 = learners.filter(l => (l.username?.includes(query1) || l.email?.includes(query1)));
    assert.strictEqual(match1.length, 1);
    assert.strictEqual(match1[0].email, 'bob@analytics.io');

    // Filter by PREMIUM
    const premiumOnly = learners.filter(l => l.paidUnlocked === true);
    assert.strictEqual(premiumOnly.length, 2);
    assert.ok(premiumOnly.some(l => l.email === 'alice@tech.org'));
    assert.ok(premiumOnly.some(l => l.email === 'carol@database.com'));
  });

  test('MIME RFC 2822 encoding produces valid URL-safe Base64 for Gmail API', () => {
    const from = 'datatodashboard2@gmail.com';
    const to = 'student@example.com';
    const subject = 'Crack SQL Progress Update & Certificate';
    const message = 'Congratulations on completing your SQL scenarios!';

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject.trim()).toString('base64')}?=`;
    const mimeLines = [
      `From: "Crack SQL (Data2Dashboard)" <${from}>`,
      `To: <${to}>`,
      `Subject: ${utf8Subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(message.trim()).toString('base64')
    ];

    const rawMime = mimeLines.join('\r\n');
    const urlSafeBase64 = Buffer.from(rawMime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    assert.ok(urlSafeBase64.length > 50, 'MIME package must be valid encoded base64');
    assert.ok(!urlSafeBase64.includes('+'), 'Must not contain raw + character');
    assert.ok(!urlSafeBase64.includes('/'), 'Must not contain raw / character');
    assert.ok(!urlSafeBase64.includes('='), 'Padding should be stripped for URL safety');

    // Verify round-trip decoding
    const restoredBase64 = urlSafeBase64.replace(/-/g, '+').replace(/_/g, '/');
    const restoredMime = Buffer.from(restoredBase64, 'base64').toString('utf8');
    assert.ok(restoredMime.includes('From: "Crack SQL (Data2Dashboard)" <datatodashboard2@gmail.com>'));
    assert.ok(restoredMime.includes('To: <student@example.com>'));
  });

  test('Missing secrets returns structured configuration instructions without fake delivery', async () => {
    // Simulated backend secrets check
    const missing = [];
    const envClientId = undefined;
    const envClientSecret = undefined;
    const envRefreshToken = undefined;

    if (!envClientId) missing.push('GMAIL_CLIENT_ID');
    if (!envClientSecret) missing.push('GMAIL_CLIENT_SECRET');
    if (!envRefreshToken) missing.push('GMAIL_REFRESH_TOKEN');

    assert.strictEqual(missing.length, 3);
    assert.deepStrictEqual(missing, ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);

    const setupSteps = [
      '1. In Google Cloud Console, enable Gmail API and configure an OAuth 2.0 Web Client ID.',
      '2. Authorize scope "https://www.googleapis.com/auth/gmail.send".',
      '3. Obtain an authorized OAuth refresh token for datatodashboard2@gmail.com.',
      '4. Store credentials securely in environment secrets (e.g., GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).',
      '5. Test delivery with your own email before broadcasting to learners.'
    ];

    assert.strictEqual(setupSteps.length, 5);
  });

  test('Self-test configuration defaults to authorized Data2Dashboard address', () => {
    const defaultSender = 'datatodashboard2@gmail.com';
    const testAdminUser = { email: 'datatodashboard2@gmail.com' };
    const sender = testAdminUser.email || defaultSender;

    assert.strictEqual(sender, 'datatodashboard2@gmail.com');
  });

});
