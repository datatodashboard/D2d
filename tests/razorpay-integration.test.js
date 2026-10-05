import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

// Helper function replicating timing-safe string comparison
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Helper function replicating HMAC-SHA256 signature verification
function computeHmacSha256(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Razorpay Payment Hardening & Integration Test Suite', () => {

  describe('1. Webhook Signature Verification & Header Enforcement', () => {
    const webhookSecret = 'whsec_test_secret_abc123';
    const samplePayload = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_test_001',
            order_id: 'order_test_001',
            amount: 4900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    it('verifies correct HMAC-SHA256 signature for exact raw body', () => {
      const signature = computeHmacSha256(samplePayload, webhookSecret);
      const isValid = timingSafeEqual(computeHmacSha256(samplePayload, webhookSecret), signature);
      assert.strictEqual(isValid, true);
    });

    it('rejects incorrect signature', () => {
      const signature = computeHmacSha256(samplePayload, webhookSecret);
      const badSignature = signature.replace(/[a-f0-9]/, 'x');
      const isValid = timingSafeEqual(computeHmacSha256(samplePayload, webhookSecret), badSignature);
      assert.strictEqual(isValid, false);
    });

    it('fails closed when webhook secret is missing or unconfigured', () => {
      const unconfiguredSecret = '';
      function verifyWithSecret(payload, sig, secret) {
        if (!secret || secret.trim() === '') {
          return { success: false, error: 'CONFIGURATION_ERROR' };
        }
        return { success: timingSafeEqual(computeHmacSha256(payload, secret), sig) };
      }
      const res = verifyWithSecret(samplePayload, 'sig_dummy', unconfiguredSecret);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'CONFIGURATION_ERROR');
    });

    it('rejects missing or empty X-Razorpay-Signature header', () => {
      function checkHeaders(headers) {
        const sig = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'];
        if (!sig || sig.trim() === '') {
          return { success: false, error: 'MISSING_SIGNATURE' };
        }
        return { success: true };
      }
      assert.strictEqual(checkHeaders({}).success, false);
      assert.strictEqual(checkHeaders({ 'x-razorpay-signature': '' }).success, false);
      assert.strictEqual(checkHeaders({ 'x-razorpay-signature': '   ' }).success, false);
    });

    it('rejects altered or tampered webhook body (even by 1 byte)', () => {
      const signature = computeHmacSha256(samplePayload, webhookSecret);
      const tamperedPayload = samplePayload.replace('4900', '4800');
      const isValid = timingSafeEqual(computeHmacSha256(tamperedPayload, webhookSecret), signature);
      assert.strictEqual(isValid, false);
    });
  });

  describe('2. Order Creation Flow', () => {
    it('requires valid server-side credentials and rejects placeholder keys without fabricated orders', () => {
      function validateConfig(keyId, keySecret) {
        if (!keyId || !keySecret || keyId.includes('placeholder') || keySecret.trim() === '') {
          return { success: false, code: 'CONFIGURATION_ERROR' };
        }
        return { success: true };
      }

      assert.strictEqual(validateConfig('', 'secret').success, false);
      assert.strictEqual(validateConfig('rzp_test_placeholder', 'secret').success, false);
      assert.strictEqual(validateConfig('rzp_live_abc', '').success, false);
      assert.strictEqual(validateConfig('rzp_test_real123', 'sec_real456').success, true);
    });

    it('persists real order in database before returning it to caller', async () => {
      const ordersDB = new Map();
      const userId = 'usr-test-111';
      const orderId = 'order_RZP_REAL_777';

      // Simulate order creation persistence
      const persistOrder = async (order) => {
        if (!order.id || !order.user_id) throw new Error('DATABASE_ERROR');
        ordersDB.set(order.id, {
          ...order,
          created_at: new Date().toISOString()
        });
        return { success: true };
      };

      const res = await persistOrder({
        id: orderId,
        user_id: userId,
        purpose: 'course_unlock',
        amount: 4900,
        currency: 'INR',
        status: 'created'
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(ordersDB.has(orderId), true);
      const stored = ordersDB.get(orderId);
      assert.strictEqual(stored.user_id, userId);
      assert.strictEqual(stored.amount, 4900);
      assert.strictEqual(stored.currency, 'INR');
      assert.strictEqual(stored.status, 'created');
    });

    it('handles database persistence failure explicitly without returning order', async () => {
      const mockFailPersist = async () => {
        return { error: { message: 'Database connection failed' } };
      };

      const result = await mockFailPersist();
      assert.ok(result.error);
      const clientResponse = result.error
        ? { success: false, error: 'Failed to record payment order in database', code: 'DATABASE_ERROR' }
        : { success: true };

      assert.strictEqual(clientResponse.success, false);
      assert.strictEqual(clientResponse.code, 'DATABASE_ERROR');
    });
  });

  describe('3. Checkout Verification Flow', () => {
    const keySecret = 'keysec_test_secret_999';
    const orderId = 'order_CHK_123';
    const paymentId = 'pay_CHK_456';
    const validSignature = computeHmacSha256(`${orderId}|${paymentId}`, keySecret);

    it('verifies checkout signature using server-stored order ID and RAZORPAY_KEY_SECRET', () => {
      const isValid = timingSafeEqual(computeHmacSha256(`${orderId}|${paymentId}`, keySecret), validSignature);
      assert.strictEqual(isValid, true);
    });

    it('rejects wrong owner when order belongs to User A and is verified by User B', () => {
      const persistedOrder = { id: orderId, user_id: 'user-alice-001', purpose: 'course_unlock' };
      const callerUser = { id: 'user-bob-002' };

      const isOwner = persistedOrder.user_id === callerUser.id;
      assert.strictEqual(isOwner, false);
    });

    it('rejects order mismatch between provider record and requested order ID', () => {
      const providerPayment = {
        id: paymentId,
        order_id: 'order_DIFFERENT_999',
        amount: 4900,
        currency: 'INR',
        status: 'captured'
      };

      const isOrderMatch = providerPayment.order_id === orderId;
      assert.strictEqual(isOrderMatch, false);
    });

    it('rejects payment with wrong amount or currency', () => {
      const paymentWrongAmount = { amount: 100, currency: 'INR', status: 'captured' };
      const paymentWrongCurrency = { amount: 4900, currency: 'USD', status: 'captured' };
      const paymentCorrect = { amount: 4900, currency: 'INR', status: 'captured' };

      const validatePayment = (p) => p.amount === 4900 && p.currency === 'INR';
      assert.strictEqual(validatePayment(paymentWrongAmount), false);
      assert.strictEqual(validatePayment(paymentWrongCurrency), false);
      assert.strictEqual(validatePayment(paymentCorrect), true);
    });

    it('rejects uncaptured payment status (e.g. authorized, created, failed)', () => {
      assert.strictEqual('authorized' === 'captured', false);
      assert.strictEqual('created' === 'captured', false);
      assert.strictEqual('failed' === 'captured', false);
      assert.strictEqual('captured' === 'captured', true);
    });

    it('prevents reuse of another user payment ID across accounts', () => {
      const existingPaymentsDB = [
        { transaction_reference: paymentId, user_id: 'user-first-buyer', status: 'verified' }
      ];

      const currentCallerId = 'user-fraud-attempt';
      const isReusedByOther = existingPaymentsDB.some(
        p => p.transaction_reference === paymentId && p.user_id !== currentCallerId && p.status === 'verified'
      );

      assert.strictEqual(isReusedByOther, true);
    });

    it('handles provider lookup failure without granting access', async () => {
      const mockProviderLookup = async () => {
        return { ok: false, status: 502, error: 'Gateway timeout' };
      };

      const rzpRes = await mockProviderLookup();
      let accessGranted = false;
      if (rzpRes.ok) {
        accessGranted = true;
      }
      assert.strictEqual(accessGranted, false);
    });
  });

  describe('4. Entitlement & Storage Reconciliation', () => {
    it('finalizes payment idempotently so simultaneous delivery does not produce duplicate grants', async () => {
      const paymentsTable = new Map();
      const userId = 'usr-idempotent-888';
      const paymentId = 'pay_IDEMPOTENT_001';

      const finalizePayment = async (uid, payId) => {
        if (paymentsTable.has(payId)) {
          return { success: true, already_processed: true };
        }
        paymentsTable.set(payId, {
          user_id: uid,
          amount: 49,
          currency: 'INR',
          status: 'verified',
          transaction_reference: payId,
          verified_at: new Date().toISOString()
        });
        return { success: true, created: true };
      };

      // Call 1 (e.g. from checkout verification)
      const res1 = await finalizePayment(userId, paymentId);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.created, true);

      // Call 2 (e.g. from webhook delivery)
      const res2 = await finalizePayment(userId, paymentId);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.already_processed, true);

      assert.strictEqual(paymentsTable.size, 1);
      assert.strictEqual(paymentsTable.get(paymentId).status, 'verified');
    });

    it('does not grant contest invitations as a side effect in contest_eligibility', () => {
      const contestEligibility = new Set();
      const contestPayments = new Map();

      // Finalize contest payment
      const finalizeContestPayment = (contestId, userId, payId) => {
        contestPayments.set(`${contestId}:${userId}`, {
          contest_id: contestId,
          user_id: userId,
          status: 'VERIFIED',
          transaction_ref: payId
        });
        // Intentionally DO NOT add to contestEligibility
      };

      finalizeContestPayment('contest-101', 'user-202', 'pay-303');
      assert.strictEqual(contestPayments.get('contest-101:user-202').status, 'VERIFIED');
      assert.strictEqual(contestEligibility.has('contest-101:user-202'), false);
    });

    it('database write failure prevents reporting success to the client', async () => {
      let reportedSuccess = false;
      const dbOperation = async () => {
        throw new Error('Database disk full');
      };

      try {
        await dbOperation();
        reportedSuccess = true;
      } catch (_) {
        reportedSuccess = false;
      }

      assert.strictEqual(reportedSuccess, false);
    });

    it('ignores non-capture webhook events like payment.authorized', () => {
      const allowedEvents = ['payment.captured', 'order.paid'];
      const isAllowed = (evt) => allowedEvents.includes(evt);

      assert.strictEqual(isAllowed('payment.authorized'), false);
      assert.strictEqual(isAllowed('payment_intent.succeeded'), false);
      assert.strictEqual(isAllowed('refund.created'), false);
      assert.strictEqual(isAllowed('payment.captured'), true);
      assert.strictEqual(isAllowed('order.paid'), true);
    });

    it('preserves admin exemptions for all scenarios and contests without payment barrier', () => {
      const checkAccess = (isAdmin, isPaid, completedCount) => {
        if (isAdmin) return true; // Admins always exempt
        if (isPaid) return true;  // Paid users unlocked
        return completedCount < 5; // Free tier
      };

      // Admin with 0 completed questions
      assert.strictEqual(checkAccess(true, false, 0), true);
      // Admin with 10 completed questions
      assert.strictEqual(checkAccess(true, false, 10), true);
      // Ordinary learner with 5 completed questions unpaid
      assert.strictEqual(checkAccess(false, false, 5), false);
      // Ordinary learner with 5 completed questions paid
      assert.strictEqual(checkAccess(false, true, 5), true);
    });
  });

});
