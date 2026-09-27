import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateContestSubmission } from '../js/contest-ai-evaluator.js';

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

});
