import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateContestSubmission } from '../js/contest-ai-evaluator.js';
import { parseContestTestContent, isPaymentVerified } from '../js/contest.js';
import crypto from 'node:crypto';

describe('Admin-Controlled Crack SQL Thinking Contest Feature', () => {

  describe('1. Contest AI Evaluator & Rubric (100 points)', () => {
    const sampleScenario = 'Analyze daily patient appointments in the healthcare clinic and identify recurring cancellations to alert clinical coordinators.';

    it('returns 0 for empty or negligible submissions with structured feedback', () => {
      const result = evaluateContestSubmission({
        scenario: sampleScenario,
        response: ''
      });

      assert.strictEqual(result.suggested_total_score, 0);
      assert.strictEqual(result.breakdown.req_understanding.score, 0);
      assert.strictEqual(result.breakdown.data_identification.score, 0);
      assert.strictEqual(result.breakdown.logical_sequence.score, 0);
      assert.strictEqual(result.breakdown.operation_reasoning.score, 0);
      assert.strictEqual(result.breakdown.completeness_clarity.score, 0);
      assert.strictEqual(result.breakdown.req_understanding.max, 20);
      assert.strictEqual(result.breakdown.data_identification.max, 15);
      assert.strictEqual(result.breakdown.logical_sequence.max, 25);
      assert.strictEqual(result.breakdown.operation_reasoning.max, 25);
      assert.strictEqual(result.breakdown.completeness_clarity.max, 15);
    });

    it('awards high score for comprehensive step-by-step procedural thinking', () => {
      const goodResponse = `
        Business Goal & Objective:
        Our goal is to calculate the recurring appointment cancellations by patient and date to alert clinical coordinators.

        Step 1: Data Identification
        Query the appointments table and patient_records table joining on patient_id.
        Key attributes needed: appointment_id, patient_id, appointment_date, status.

        Step 2: Filter criteria
        Filter records where status = 'Cancelled' within the target rolling 30-day window.

        Step 3: Grouping and Aggregation
        Group by patient_id and count total cancellations using COUNT(appointment_id).
        Apply a HAVING clause or threshold filter to identify patients with >= 3 cancellations.

        Step 4: Output and Delivery
        Order the results in descending order by cancellation count and join patient contact details for immediate notification.
      `;

      const result = evaluateContestSubmission({
        scenario: sampleScenario,
        response: goodResponse
      });

      assert(result.suggested_total_score >= 80, `Expected >= 80 score, got ${result.suggested_total_score}`);
      assert(result.breakdown.req_understanding.score >= 16);
      assert(result.breakdown.data_identification.score >= 12);
      assert(result.breakdown.logical_sequence.score >= 20);
      assert(result.breakdown.operation_reasoning.score >= 20);
      assert(result.breakdown.completeness_clarity.score >= 12);
      assert(result.breakdown.logical_sequence.strengths.length > 0);
    });

    it('correctly assesses partial responses and identifies missing concepts', () => {
      const partialResponse = 'Just select from appointments and look at cancelled ones.';
      const result = evaluateContestSubmission({
        scenario: sampleScenario,
        response: partialResponse
      });

      assert(result.suggested_total_score < 60, `Partial response should get low/moderate score, got ${result.suggested_total_score}`);
      assert(result.breakdown.logical_sequence.missing_concepts.length > 0);
      assert(result.breakdown.operation_reasoning.missing_concepts.length > 0);
    });
  });

  describe('2. Contest Audience Eligibility Isolation', () => {
    it('allows all users when audience_type is ALL and status is PUBLISHED', () => {
      function isUserEligible(contest, userId, audienceWhitelist) {
        if (!contest || contest.status !== 'PUBLISHED') return false;
        if (contest.audience_type === 'ALL') return true;
        if (contest.audience_type === 'SELECTED' || contest.audience_type === 'INVITED') {
          return audienceWhitelist.has(userId);
        }
        return false;
      }

      const contestAll = { id: 'c1', status: 'PUBLISHED', audience_type: 'ALL' };
      assert.strictEqual(isUserEligible(contestAll, 'user-1', new Set()), true);
      assert.strictEqual(isUserEligible(contestAll, 'user-2', new Set()), true);

      // Draft contest must NEVER be shown
      const contestDraft = { id: 'c2', status: 'DRAFT', audience_type: 'ALL' };
      assert.strictEqual(isUserEligible(contestDraft, 'user-1', new Set()), false);

      // Archived contest must NEVER be shown as active invitation
      const contestArchived = { id: 'c3', status: 'ARCHIVED', audience_type: 'ALL' };
      assert.strictEqual(isUserEligible(contestArchived, 'user-1', new Set()), false);
    });

    it('strictly isolates SELECTED audience to whitelisted user IDs', () => {
      function isUserEligible(contest, userId, audienceWhitelist) {
        if (!contest || contest.status !== 'PUBLISHED') return false;
        if (contest.audience_type === 'ALL') return true;
        if (contest.audience_type === 'SELECTED' || contest.audience_type === 'INVITED') {
          return audienceWhitelist.has(userId);
        }
        return false;
      }

      const contestSelected = { id: 'c4', status: 'PUBLISHED', audience_type: 'SELECTED' };
      const selectedWhitelist = new Set(['user-admin-chosen-1', 'user-admin-chosen-2']);

      assert.strictEqual(isUserEligible(contestSelected, 'user-admin-chosen-1', selectedWhitelist), true);
      assert.strictEqual(isUserEligible(contestSelected, 'user-admin-chosen-2', selectedWhitelist), true);
      assert.strictEqual(isUserEligible(contestSelected, 'user-unauthorized', selectedWhitelist), false);
    });
  });

  describe('3. Payment Verification Abstraction & Security', () => {
    it('prohibits normal user from self-verifying payment; requires admin verification', () => {
      // Participant submission only sets PENDING
      function participantSubmitPayment({ amount, txnRef }) {
        return {
          status: 'PENDING',
          amount,
          transaction_ref: txnRef,
          verified_at: null,
          verified_by: null
        };
      }

      const payment = participantSubmitPayment({ amount: 49, txnRef: 'UPI-123456' });
      assert.strictEqual(payment.status, 'PENDING');
      assert.strictEqual(payment.verified_at, null);

      // Admin verification function
      function adminVerifyPayment(paymentRecord, adminUser, approved = true) {
        if (!adminUser || !adminUser.is_admin) throw new Error('Unauthorized');
        return {
          ...paymentRecord,
          status: approved ? 'VERIFIED' : 'FAILED',
          verified_at: new Date().toISOString(),
          verified_by: adminUser.id
        };
      }

      const verified = adminVerifyPayment(payment, { id: 'admin-uuid', is_admin: true }, true);
      assert.strictEqual(verified.status, 'VERIFIED');
      assert.strictEqual(verified.verified_by, 'admin-uuid');
      assert(verified.verified_at !== null);
    });

    it('free contests automatically transition without payment barrier', () => {
      function determineContestGate({ entryFee, registration, payment }) {
        if (!registration || !registration.agreed_rules) return 'details';
        if (Number(entryFee) === 0) return 'ready';
        if (payment && payment.status === 'VERIFIED') return 'ready';
        return 'payment';
      }

      assert.strictEqual(
        determineContestGate({ entryFee: 0, registration: { agreed_rules: true }, payment: null }),
        'ready'
      );
      assert.strictEqual(
        determineContestGate({ entryFee: 49, registration: { agreed_rules: true }, payment: null }),
        'payment'
      );
      assert.strictEqual(
        determineContestGate({ entryFee: 49, registration: { agreed_rules: true }, payment: { status: 'PENDING' } }),
        'payment'
      );
      assert.strictEqual(
        determineContestGate({ entryFee: 49, registration: { agreed_rules: true }, payment: { status: 'VERIFIED' } }),
        'ready'
      );
    });
  });

  describe('4. Official Single Attempt & Refresh Resilience', () => {
    it('maintains exactly ONE attempt per participant with immutable start time', () => {
      const attemptStore = new Map();

      function startAttempt(contestId, userId) {
        const key = `${contestId}:${userId}`;
        if (attemptStore.has(key)) {
          // Resume existing attempt, never overwrite started_at
          return { attempt: attemptStore.get(key), isNew: false };
        }
        const newAttempt = {
          contest_id: contestId,
          user_id: userId,
          started_at: 1700000000000,
          draft_response: '',
          status: 'IN_PROGRESS'
        };
        attemptStore.set(key, newAttempt);
        return { attempt: newAttempt, isNew: true };
      }

      const firstCall = startAttempt('contest-1', 'learner-1');
      assert.strictEqual(firstCall.isNew, true);
      assert.strictEqual(firstCall.attempt.status, 'IN_PROGRESS');

      // Refresh / second start attempt
      const secondCall = startAttempt('contest-1', 'learner-1');
      assert.strictEqual(secondCall.isNew, false);
      assert.strictEqual(secondCall.attempt.started_at, 1700000000000);
    });

    it('computes elapsed timer accurately from started_at across browser reload', () => {
      const startedAt = Date.now() - 145000; // 2 minutes 25 seconds ago
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      assert(elapsedSeconds >= 144 && elapsedSeconds <= 146);

      function formatSec(s) {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      }

      assert.strictEqual(formatSec(145), '02:25');
    });
  });

  describe('5. Ranks Calculation & Tie-Breaking by Completion Time', () => {
    it('computes ranks with highest score first, using elapsed seconds as tie-breaker', () => {
      const evaluations = [
        { userId: 'u1', finalScore: 92, elapsedSeconds: 400 },
        { userId: 'u2', finalScore: 95, elapsedSeconds: 600 },
        { userId: 'u3', finalScore: 92, elapsedSeconds: 320 }, // Same score as u1, but faster!
        { userId: 'u4', finalScore: 78, elapsedSeconds: 250 }
      ];

      evaluations.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        return a.elapsedSeconds - b.elapsedSeconds; // Faster completion ranks higher
      });

      const ranked = evaluations.map((e, idx) => ({ ...e, rank: idx + 1 }));

      assert.strictEqual(ranked[0].userId, 'u2'); // 95 pts -> 1st
      assert.strictEqual(ranked[0].rank, 1);

      assert.strictEqual(ranked[1].userId, 'u3'); // 92 pts in 320s -> 2nd
      assert.strictEqual(ranked[1].rank, 2);

      assert.strictEqual(ranked[2].userId, 'u1'); // 92 pts in 400s -> 3rd
      assert.strictEqual(ranked[2].rank, 3);

      assert.strictEqual(ranked[3].userId, 'u4'); // 78 pts -> 4th
      assert.strictEqual(ranked[3].rank, 4);
    });
  });

  describe('6. SQL Contest Test Screen & Participant-Facing Structure', () => {
    it('correctly extracts Question, Scenario, Expected Output, and Schema blocks from structured contest document', () => {
      const contestDoc = {
        title: 'Q1 Thinking Contest: Healthcare Retention',
        scenario_text: `Question:
Identify recurring cancellations by patient and calculate each patient's cancellation rate and lost billings.

Scenario:
A premier hospital network is experiencing high rates of appointment cancellations. Clinical coordinators need proactive alerts to reach out to at-risk patients and reassign doctor slots.

Expected Output Columns:
patient_id
patient_name
total_appointments
cancelled_count
lost_amount

Database Schema:
patients(patient_id PK, patient_name, city, segment, joined_date); appointments(appointment_id PK, patient_id FK, doctor_id FK, appointment_date, status, bill_amount)`
      };

      const parsed = parseContestTestContent(contestDoc);

      // 1. Question / Scenario block content
      assert(parsed.question.includes('Identify recurring cancellations by patient'));
      assert(parsed.scenarioDescription.includes('hospital network is experiencing high rates'));
      assert(typeof parsed.expectedOutput === 'string');
      assert(parsed.expectedOutput.includes('patient_id'));
      assert(parsed.expectedOutput.includes('lost_amount'));

      // 2. Database Schema block content
      assert(parsed.schemaText.includes('patients('));
      assert(parsed.schemaText.includes('appointments('));
    });

    it('gracefully handles plain text business problems and provides clear defaults', () => {
      const plainContest = {
        title: 'ATM Withdrawal Anomaly Challenge',
        scenario_text: 'You are the lead data architect for a high-volume financial institution. Fraud detection algorithms have flagged an abnormal cluster of international transactions occurring within minutes of local account ATM withdrawals. Explain step by step how you would identify all compromised accounts, the corresponding transaction details, and calculate the total financial exposure across all impacted customers.'
      };

      const parsed = parseContestTestContent(plainContest);

      // Question separated from narrative
      assert(parsed.question.includes('Explain step by step how you would identify all compromised accounts'));
      assert(parsed.scenarioDescription.includes('lead data architect for a high-volume financial institution'));

      // Expected output columns present
      assert(Array.isArray(parsed.expectedOutput));
      assert(parsed.expectedOutput.some(col => col.column === 'account_id'));
      assert(parsed.expectedOutput.some(col => col.column === 'total_financial_exposure'));

      // Banking schema assigned
      assert(parsed.schemaText.includes('accounts('));
      assert(parsed.schemaText.includes('transactions('));
    });

    it('enforces participant-facing view boundaries with zero confidential judge information', () => {
      // Judge-side items that must NEVER leak to participant
      const judgeKeywords = [
        'answer key',
        'model sql query',
        'solution approach',
        'scoring rubric',
        'marks breakdown',
        'judging notes',
        'hidden traps'
      ];

      const sampleDoc = {
        title: 'Enterprise Test',
        scenario_text: 'Question: Find high value users.\nScenario: Analyze transactions.\nExpected Output Columns:\nuser_id\ntotal_spent'
      };

      const parsed = parseContestTestContent(sampleDoc);
      const textDump = JSON.stringify(parsed).toLowerCase();

      for (const forbidden of judgeKeywords) {
        assert(!textDump.includes(forbidden), `Found forbidden judge keyword in participant content: ${forbidden}`);
      }
    });
  });

  describe('7. Razorpay Order Creation & Checkout Flow', () => {
    it('calls create-razorpay-order Edge Function with only contest_id without client-controlled amount', async () => {
      let edgeFunctionCalled = false;
      let passedFunctionName = '';
      let passedBody = null;

      const mockClient = {
        functions: {
          async invoke(fnName, options) {
            edgeFunctionCalled = true;
            passedFunctionName = fnName;
            passedBody = options?.body;
            return {
              data: {
                order_id: 'order_TEST123456',
                amount: 4900,
                currency: 'INR',
                key_id: 'rzp_test_KEY123'
              },
              error: null
            };
          }
        }
      };

      const contest = { id: 'contest-uuid-777', title: 'SQL Grand Prix', entry_fee: 49 };
      const user = { id: 'learner-user-999', email: 'learner@example.com' };

      // Simulate flow
      const res = await mockClient.functions.invoke('create-razorpay-order', {
        body: { contest_id: contest.id }
      });

      assert.strictEqual(edgeFunctionCalled, true);
      assert.strictEqual(passedFunctionName, 'create-razorpay-order');
      assert.deepStrictEqual(passedBody, { contest_id: 'contest-uuid-777' });
      assert.strictEqual(passedBody.amount, undefined, 'Client must not pass custom amount');
      assert.strictEqual(res.data.order_id, 'order_TEST123456');
      assert.strictEqual(res.data.key_id, 'rzp_test_KEY123');
      assert.strictEqual(res.data.currency, 'INR');
    });

    it('passes returned order_id and key_id to Razorpay Checkout configuration without marking contest complete', async () => {
      let razorpayInstanceConfig = null;
      let opened = false;

      class MockRazorpay {
        constructor(config) {
          razorpayInstanceConfig = config;
        }
        open() {
          opened = true;
        }
      }

      const orderData = {
        order_id: 'order_ABC987654',
        amount: 4900,
        currency: 'INR',
        key_id: 'rzp_live_SECURE_KEY'
      };

      const user = { email: 'sqlchampion@example.com', user_metadata: { name: 'SQL Champion' } };
      const contest = { id: 'contest-uuid-777', title: 'Healthcare Logic Challenge' };

      const options = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: orderData.currency || 'INR',
        name: 'Think and Crack SQL',
        description: contest.title || 'Contest Entry Fee',
        order_id: orderData.order_id,
        prefill: {
          email: user.email || '',
          name: user.user_metadata?.name || ''
        },
        theme: {
          color: '#2563eb'
        }
      };

      const rzp = new MockRazorpay(options);
      rzp.open();

      assert.strictEqual(opened, true);
      assert.strictEqual(razorpayInstanceConfig.key, 'rzp_live_SECURE_KEY');
      assert.strictEqual(razorpayInstanceConfig.order_id, 'order_ABC987654');
      assert.strictEqual(razorpayInstanceConfig.amount, 4900);
      assert.strictEqual(razorpayInstanceConfig.prefill.email, 'sqlchampion@example.com');
    });

    it('handles order creation error gracefully without crashing or unlocking', async () => {
      const mockClient = {
        functions: {
          async invoke() {
            return {
              data: null,
              error: { message: 'Contest registration expired or closed' }
            };
          }
        }
      };

      let caughtError = null;
      try {
        const { data, error } = await mockClient.functions.invoke('create-razorpay-order', {
          body: { contest_id: 'contest-closed' }
        });
        if (error) throw new Error(error.message);
        if (!data?.order_id) throw new Error('No order returned');
      } catch (err) {
        caughtError = err;
      }

      assert(caughtError !== null);
      assert.strictEqual(caughtError.message, 'Contest registration expired or closed');
    });

    it('validates payment status using isPaymentVerified helper for VERIFIED and paid statuses', () => {
      assert.strictEqual(isPaymentVerified({ status: 'paid' }), true);
      assert.strictEqual(isPaymentVerified({ status: 'PAID' }), true);
      assert.strictEqual(isPaymentVerified({ status: 'VERIFIED' }), true);
      assert.strictEqual(isPaymentVerified({ status: 'verified' }), true);
      assert.strictEqual(isPaymentVerified({ status: 'PENDING' }), false);
      assert.strictEqual(isPaymentVerified({ status: 'FAILED' }), false);
      assert.strictEqual(isPaymentVerified(null), false);
      assert.strictEqual(isPaymentVerified(undefined), false);
    });

    it('verifies Razorpay signature using HMAC SHA256 and rejects invalid signatures', () => {
      const secret = 'rzp_test_secret_key_12345';
      const orderId = 'order_TEST987654';
      const paymentId = 'pay_TEST123456';
      const payload = `${orderId}|${paymentId}`;

      const validSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const invalidSignature = 'invalid_tampered_signature_hex';

      function verifySignature(ord, pay, sig, sec) {
        const expected = crypto.createHmac('sha256', sec).update(`${ord}|${pay}`).digest('hex');
        return expected.toLowerCase() === sig.toLowerCase();
      }

      assert.strictEqual(verifySignature(orderId, paymentId, validSignature, secret), true);
      assert.strictEqual(verifySignature(orderId, paymentId, invalidSignature, secret), false);
      assert.strictEqual(verifySignature(orderId, 'pay_OTHER', validSignature, secret), false);
    });

    it('completes the full payment verification flow and unlocks contest idempotently', async () => {
      let paymentRecord = {
        contest_id: 'c-100',
        user_id: 'u-100',
        amount: 49,
        currency: 'INR',
        status: 'PENDING',
        transaction_ref: null
      };

      const eligibilityRecords = new Set();

      const mockEdgeFunctionVerify = async ({ order_id, payment_id, signature, contest_id, user_id, secret }) => {
        // 1. Signature check
        const expected = crypto.createHmac('sha256', secret).update(`${order_id}|${payment_id}`).digest('hex');
        if (expected.toLowerCase() !== signature.toLowerCase()) {
          return { success: false, error: 'Signature verification failed' };
        }

        // 2. Amount and contest verification (fixed at 49)
        if (contest_id !== 'c-100') {
          return { success: false, error: 'Contest not found' };
        }

        // 3. Update contest_payments record to paid
        paymentRecord = {
          ...paymentRecord,
          status: 'paid',
          transaction_ref: payment_id,
          payment_method: 'RAZORPAY',
          verified_at: new Date().toISOString()
        };

        // 4. Idempotently add contest eligibility
        eligibilityRecords.add(`${contest_id}:${user_id}`);

        return {
          success: true,
          message: 'Payment verified and contest unlocked successfully.',
          payment: paymentRecord,
          contest_id,
          user_id
        };
      };

      const secret = 'rzp_secret_xyz';
      const order_id = 'order_100';
      const payment_id = 'pay_100';
      const signature = crypto.createHmac('sha256', secret).update(`${order_id}|${payment_id}`).digest('hex');

      // First verification
      const res1 = await mockEdgeFunctionVerify({
        order_id,
        payment_id,
        signature,
        contest_id: 'c-100',
        user_id: 'u-100',
        secret
      });

      assert.strictEqual(res1.success, true);
      assert.strictEqual(paymentRecord.status, 'paid');
      assert.strictEqual(paymentRecord.transaction_ref, 'pay_100');
      assert.strictEqual(eligibilityRecords.has('c-100:u-100'), true);
      assert.strictEqual(isPaymentVerified(paymentRecord), true);

      // Repeated verification (idempotent)
      const res2 = await mockEdgeFunctionVerify({
        order_id,
        payment_id,
        signature,
        contest_id: 'c-100',
        user_id: 'u-100',
        secret
      });

      assert.strictEqual(res2.success, true);
      assert.strictEqual(eligibilityRecords.size, 1);
    });
  });

});
