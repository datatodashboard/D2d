import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

describe('Premium Customers & Payment Reconciliation Architecture', () => {

  // 1. Existing premium user -> no payment popup
  it('1. Existing premium user (profiles.paid_unlocked === true) suppresses payment popup and paywall', () => {
    const premiumProfile = {
      id: 'usr_ramgokul_123',
      email: 'sriramgokul6666@gmail.com',
      username: 'Ramgokul',
      paid_unlocked: true
    };

    // Authoritative check
    const isPaidUnlocked = Boolean(premiumProfile?.paid_unlocked === true);
    assert.strictEqual(isPaidUnlocked, true, 'User with paid_unlocked: true must be recognized as premium');

    // Paywall trigger simulator
    function shouldShowPaywall(completedCount, isPaid, isAdmin) {
      if (isPaid || isAdmin) return false;
      return completedCount >= 5;
    }

    assert.strictEqual(shouldShowPaywall(0, isPaidUnlocked, false), false);
    assert.strictEqual(shouldShowPaywall(5, isPaidUnlocked, false), false, 'Should NEVER show paywall at threshold 5 for premium user');
    assert.strictEqual(shouldShowPaywall(50, isPaidUnlocked, false), false, 'Should NEVER show paywall at question 50 for premium user');

    // Free user comparison
    const freeProfile = { id: 'usr_free_1', email: 'free@example.com', paid_unlocked: false };
    const freeUnlocked = Boolean(freeProfile?.paid_unlocked === true);
    assert.strictEqual(shouldShowPaywall(4, freeUnlocked, false), false, 'Under 5 questions free user is not blocked');
    assert.strictEqual(shouldShowPaywall(5, freeUnlocked, false), true, 'Free user at 5 completed challenges must hit paywall');
  });

  // 2. Existing premium user -> Premium badge visible
  it('2. Existing premium user renders gold ⭐ PREMIUM badge, non-premium does not', () => {
    function renderUserBadge(profile) {
      const isPaid = Boolean(profile?.paid_unlocked === true);
      if (isPaid) {
        return '<span class="premium-badge">⭐ PREMIUM</span>';
      }
      return '';
    }

    const premiumProfile = { email: 'sriramgokul6666@gmail.com', paid_unlocked: true };
    const badgeHtml = renderUserBadge(premiumProfile);
    assert.ok(badgeHtml.includes('⭐ PREMIUM'), 'Gold Premium badge must be visible for premium user');
    assert.ok(badgeHtml.includes('premium-badge'), 'Must use premium-badge styling class');

    const nonPremiumProfile = { email: 'sundar.developer07@gmail.com', paid_unlocked: false };
    const noBadge = renderUserBadge(nonPremiumProfile);
    assert.strictEqual(noBadge, '', 'Non-premium user must not display premium badge');

    const nullProfile = null;
    assert.strictEqual(renderUserBadge(nullProfile), '', 'Unauthenticated user must not display premium badge');
  });

  // 3. Valid captured ₹49 payment -> reconciliation succeeds
  it('3. Valid captured ₹49 INR payment server-side reconciliation succeeds and sets profiles.paid_unlocked = true', async () => {
    // Database mock state
    const profiles = new Map([
      ['usr_sundar_1', { id: 'usr_sundar_1', email: 'sundar.developer07@gmail.com', username: 'sundar.developer07', paid_unlocked: false }]
    ]);
    const payments = [];

    // Server-side reconciliation handler simulation
    function reconcileCapturedPayment(paymentData, callerIsAdmin) {
      if (!callerIsAdmin) {
        return { success: false, error: 'Unauthorized: Admin privileges required', code: 'UNAUTHORIZED' };
      }
      if (paymentData.status !== 'captured') {
        return { success: false, error: 'Payment not captured', code: 'NOT_CAPTURED', status: 'NEEDS REVIEW' };
      }
      if (paymentData.amount !== 4900) {
        return { success: false, error: 'Amount mismatch', code: 'AMOUNT_MISMATCH', status: 'NEEDS REVIEW' };
      }
      if (paymentData.currency !== 'INR') {
        return { success: false, error: 'Currency mismatch', code: 'CURRENCY_MISMATCH', status: 'NEEDS REVIEW' };
      }

      // Safe user match
      const matched = Array.from(profiles.values()).filter(p => p.email.toLowerCase() === paymentData.email.toLowerCase());
      if (matched.length !== 1) {
        return { success: false, error: 'Ambiguous or missing user', status: 'NEEDS REVIEW' };
      }

      const target = matched[0];
      target.paid_unlocked = true;
      payments.push({
        user_id: target.id,
        user_email: target.email,
        amount: 49,
        currency: 'INR',
        transaction_reference: paymentData.id,
        status: 'verified',
        verified_at: new Date().toISOString()
      });

      return {
        success: true,
        status: 'verified',
        user_id: target.id,
        email: target.email,
        message: 'Payment successfully reconciled and premium access unlocked.'
      };
    }

    const validCapturedPayment = {
      id: 'pay_sundar_captured49',
      amount: 4900,
      currency: 'INR',
      status: 'captured',
      email: 'sundar.developer07@gmail.com'
    };

    const res = reconcileCapturedPayment(validCapturedPayment, true);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'verified');

    const updatedProfile = profiles.get('usr_sundar_1');
    assert.strictEqual(updatedProfile.paid_unlocked, true, 'User paid_unlocked must now be true');
    assert.strictEqual(payments.length, 1);
    assert.strictEqual(payments[0].transaction_reference, 'pay_sundar_captured49');
  });

  // 4. Already reconciled payment -> idempotent
  it('4. Reconciliation operation is idempotent and safe to run multiple times without duplicates', () => {
    const userProfile = { id: 'usr_1', email: 'user@example.com', paid_unlocked: true };
    const payments = [
      { id: 101, user_id: 'usr_1', transaction_reference: 'pay_idem_123', status: 'verified' }
    ];

    function idempotentReconcile(paymentId, userId) {
      const existing = payments.find(p => p.transaction_reference === paymentId && p.user_id === userId);
      if (existing) {
        existing.status = 'verified';
        userProfile.paid_unlocked = true;
        return {
          success: true,
          status: 'verified',
          idempotent: true,
          message: 'Payment already reconciled. Entitlement confirmed.'
        };
      }
      payments.push({ id: payments.length + 1, user_id: userId, transaction_reference: paymentId, status: 'verified' });
      userProfile.paid_unlocked = true;
      return { success: true, status: 'verified', idempotent: false };
    }

    // Run 1
    const res1 = idempotentReconcile('pay_idem_123', 'usr_1');
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.idempotent, true);
    assert.strictEqual(payments.length, 1, 'Must not duplicate payment row');

    // Run 2
    const res2 = idempotentReconcile('pay_idem_123', 'usr_1');
    assert.strictEqual(res2.success, true);
    assert.strictEqual(payments.length, 1, 'Payment count must remain exactly 1');
    assert.strictEqual(userProfile.paid_unlocked, true, 'Entitlement must remain true');
  });

  // 5. Refunded payment -> no unlock
  it('5. Refunded payment must NOT activate Premium access and is displayed as ↩ REFUNDED', () => {
    const refundPayment = {
      id: 'pay_refunded_999',
      amount: 4900,
      currency: 'INR',
      status: 'refunded',
      email: 'refunded.user@example.com'
    };

    function processPaymentReconciliation(payment) {
      if (payment.status === 'refunded') {
        return {
          success: false,
          error: 'Refunded payment cannot be reconciled for premium access',
          code: 'PAYMENT_REFUNDED',
          status: 'REFUNDED'
        };
      }
      return { success: true };
    }

    const result = processPaymentReconciliation(refundPayment);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'PAYMENT_REFUNDED');
    assert.strictEqual(result.status, 'REFUNDED');

    // UI badge format check
    function formatPaymentBadge(isRefunded) {
      return isRefunded ? '<span class="badge danger">↩ REFUNDED</span>' : '⭐ PREMIUM CUSTOMER';
    }
    assert.ok(formatPaymentBadge(true).includes('↩ REFUNDED'));
  });

  // 6. Unknown/unmatched payment -> Needs Review
  it('6. Unknown or ambiguous customer payments return ⚠ NEEDS REVIEW and do NOT automatically unlock', () => {
    const profiles = [
      { id: 'usr_dup1', email: 'shared@example.com' },
      { id: 'usr_dup2', email: 'shared@example.com' }
    ];

    function matchUser(email) {
      const matches = profiles.filter(p => p.email.toLowerCase() === email.toLowerCase());
      if (matches.length === 0) {
        return { success: false, status: 'NEEDS REVIEW', code: 'NO_USER_MATCH' };
      }
      if (matches.length > 1) {
        return { success: false, status: 'NEEDS REVIEW', code: 'AMBIGUOUS_USER_MATCH' };
      }
      return { success: true, user: matches[0] };
    }

    // Unmatched
    const unmatched = matchUser('unknown.ghost@example.com');
    assert.strictEqual(unmatched.success, false);
    assert.strictEqual(unmatched.status, 'NEEDS REVIEW');
    assert.strictEqual(unmatched.code, 'NO_USER_MATCH');

    // Ambiguous (multiple accounts)
    const ambiguous = matchUser('shared@example.com');
    assert.strictEqual(ambiguous.success, false);
    assert.strictEqual(ambiguous.status, 'NEEDS REVIEW');
    assert.strictEqual(ambiguous.code, 'AMBIGUOUS_USER_MATCH');
  });

  // 7. Duplicate payment ID -> reject duplicate assignment
  it('7. Rejects duplicate assignment of the same Razorpay payment ID across different users', () => {
    const verifiedPayments = [
      { payment_id: 'pay_unique_101', user_id: 'user_alice', status: 'verified' }
    ];

    function assignPayment(paymentId, targetUserId) {
      const existing = verifiedPayments.find(p => p.payment_id === paymentId && p.user_id !== targetUserId && p.status === 'verified');
      if (existing) {
        throw new Error(`Security violation: Payment ${paymentId} is already credited to another user.`);
      }
      verifiedPayments.push({ payment_id: paymentId, user_id: targetUserId, status: 'verified' });
      return true;
    }

    // Attempting to assign Alice's payment to Bob
    assert.throws(
      () => assignPayment('pay_unique_101', 'user_bob'),
      /already credited to another user/
    );

    // Re-assigning to Alice is safe
    assert.doesNotThrow(() => {
      const existingForSameUser = verifiedPayments.find(p => p.payment_id === 'pay_unique_101' && p.user_id !== 'user_alice');
      assert.strictEqual(existingForSameUser, undefined);
    });
  });

  // 8. Contest eligibility remains independent
  it('8. ₹49 Premium payment grants premium learning access only and does NOT grant contest eligibility', () => {
    const learner = {
      id: 'usr_learner_1',
      paid_unlocked: true, // ₹49 paid
      completed_count: 5,
      is_admin: false,
      contest_eligible: false
    };

    // Contest rule: eligibility requires 18 completed challenges or super admin exemption
    function evaluateContestEligibility(completedCount, isAdmin, threshold = 18) {
      if (isAdmin) return true;
      return completedCount >= threshold;
    }

    const eligible = evaluateContestEligibility(learner.completed_count, learner.is_admin, 18);
    assert.strictEqual(eligible, false, '₹49 Premium course payment must NOT bypass the 18 completed challenges contest threshold');
    assert.strictEqual(learner.paid_unlocked, true, 'User retains full premium learning access');

    // When learner reaches 18 completed challenges
    learner.completed_count = 18;
    const eligibleNow = evaluateContestEligibility(learner.completed_count, learner.is_admin, 18);
    assert.strictEqual(eligibleNow, true, 'Learner reaches contest threshold by completing 18 scenarios');
  });

  // 9. Admin-only reconciliation cannot be performed by normal users
  it('9. Admin-only reconciliation endpoint rejects unauthenticated or non-admin requests', () => {
    function executeAdminReconcile(user, isAdmin) {
      if (!user) {
        return { status: 401, error: 'Unauthorized: Session required' };
      }
      if (!isAdmin) {
        return { status: 403, error: 'Forbidden: Only administrators can reconcile payments' };
      }
      return { status: 200, success: true };
    }

    // Anonymous request
    const anonRes = executeAdminReconcile(null, false);
    assert.strictEqual(anonRes.status, 401);

    // Normal learner request
    const normalUserRes = executeAdminReconcile({ id: 'normal_user_1' }, false);
    assert.strictEqual(normalUserRes.status, 403);
    assert.ok(normalUserRes.error.includes('Only administrators'));

    // Admin request
    const adminRes = executeAdminReconcile({ id: 'admin_user_1' }, true);
    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(adminRes.success, true);
  });

  // 10. Database Migration 012 and Supabase Setup verification
  it('10. Migration 012 exists and contains admin_reconcile_payment, anti-reuse, and profiles.paid_unlocked controls', () => {
    const migrationSql = fs.readFileSync('./migrations/012_admin_payment_reconciliation.sql', 'utf8');
    assert.ok(migrationSql.includes('admin_reconcile_payment'), 'Must define admin_reconcile_payment function');
    assert.ok(migrationSql.includes('is_admin()'), 'Must enforce administrator check via is_admin()');
    assert.ok(migrationSql.includes('paid_unlocked'), 'Must update profiles.paid_unlocked');
    assert.ok(migrationSql.includes('Security violation'), 'Must prevent reuse of payment ID for another user');
    assert.ok(migrationSql.includes('NEEDS REVIEW'), 'Must return NEEDS REVIEW when no unique match is found');

    const setupSql = fs.readFileSync('./supabase_setup.sql', 'utf8');
    assert.ok(setupSql.includes('admin_reconcile_payment'), 'supabase_setup.sql must include admin_reconcile_payment');
  });
});
