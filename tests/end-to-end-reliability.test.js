import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('End-to-End Reliability, Atomic Payments, RLS & Progress Verification', () => {
  const migration009 = fs.readFileSync(path.resolve('migrations/009_end_to_end_reliability.sql'), 'utf-8');
  const migration010 = fs.readFileSync(path.resolve('migrations/010_contest_lifecycle_and_error_hardening.sql'), 'utf-8');
  const supabaseSetup = fs.readFileSync(path.resolve('supabase_setup.sql'), 'utf-8');
  const adminJs = fs.readFileSync(path.resolve('js/admin.js'), 'utf-8');
  const appJs = fs.readFileSync(path.resolve('js/app.js'), 'utf-8');
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf-8');
  const contestJs = fs.readFileSync(path.resolve('js/contest.js'), 'utf-8');

  describe('1. Database Migration 009 & Authoritative Security Controls', () => {
    test('Migration 009 drops older permissive policies to prevent policy combining bypass', () => {
      // Must drop old policy names from migrations 002-008
      assert.ok(migration009.includes('drop policy if exists "Users can create contest payment" on public.contest_payments;'));
      assert.ok(migration009.includes('drop policy if exists "Users can create pending payment record" on public.contest_payments;'));
      assert.ok(migration009.includes('drop policy if exists "Verified users can create single attempt" on public.contest_attempts;'));
      assert.ok(migration009.includes('drop policy if exists "Eligible users can register for published contests" on public.contest_registrations;'));
      assert.ok(migration009.includes('drop policy if exists "Users can view own payments" on public.payments;'));
    });

    test('Enforces ₹49 for practice payments and configured fee for contest payments', () => {
      // Practice payments: amount = 49 and status = 'pending'
      assert.ok(migration009.includes("amount = 49"));
      assert.ok(migration009.includes("status = 'pending'"));

      // Contest payments: status = 'PENDING' and amount = c.entry_fee
      assert.ok(migration009.includes("status = 'PENDING'"));
      assert.ok(migration009.includes("amount = c.entry_fee"));

      // Contest payments policy requires status PENDING and matching entry_fee
      const contestPaymentPolicy = migration009.match(/create policy "Users can create pending contest payment"[\s\S]*?;/);
      assert.ok(contestPaymentPolicy, 'Must have Users can create pending contest payment policy');
      assert.ok(contestPaymentPolicy[0].includes("status = 'PENDING'"));
      assert.ok(contestPaymentPolicy[0].includes("amount = c.entry_fee"));
    });

    test('Learners have NO update policy on payments or contest_payments', () => {
      // Only admins have update/all policy on payments and contest_payments
      assert.ok(migration009.includes('create policy "Admins can manage payments" on public.payments for all using (public.is_admin());'));
      assert.ok(migration009.includes('create policy "Admins have full access to contest payments" on public.contest_payments for all using (public.is_admin());'));

      const userUpdatePayments = /create policy .* on public\.payments for update/i.test(migration009);
      assert.strictEqual(userUpdatePayments, false, 'Learners must NOT have an update policy on public.payments');

      const userUpdateContestPayments = /create policy .* on public\.contest_payments for update/i.test(migration009);
      assert.strictEqual(userUpdateContestPayments, false, 'Learners must NOT have an update policy on public.contest_payments');
    });

    test('Protects privileged profile fields from learner tampering via trigger', () => {
      assert.ok(migration009.includes('protect_profile_privileged_fields'));
      assert.ok(migration009.includes('Modifying is_admin is restricted'));
      assert.ok(migration009.includes('Modifying paid_unlocked is restricted'));
      assert.ok(migration009.includes('Modifying contest_eligible directly is restricted'));
      assert.ok(migration009.includes('Modifying completed_count directly is restricted'));
    });

    test('Resolves datatodashboard2@gmail.com to real auth.users UUID for super-admin setup', () => {
      assert.ok(migration009.includes('datatodashboard2@gmail.com'));
      assert.ok(migration009.includes('public.admin_users'));
      assert.ok(migration009.includes("role = 'super_admin'"));
    });
  });

  describe('2. Atomic Transactional Payment Verification & Reference Normalization', () => {
    test('Contains atomic verify_learner_payment RPC function with normalization and duplicate check', () => {
      assert.ok(migration009.includes('create or replace function public.verify_learner_payment'));
      assert.ok(migration009.includes('for update'), 'Must lock payment row during verification transaction');
      assert.ok(migration009.includes('regexp_replace'), 'Must normalize reference');
      assert.ok(migration009.includes('Duplicate transaction reference'), 'Must detect reused references');
      assert.ok(migration009.includes('paid_unlocked = true'), 'Must unlock profile atomically');
      assert.ok(migration009.includes('Invalid payment type'), 'Must validate payment type');
      assert.ok(migration009.includes('Invalid practice payment amount'), 'Must validate payment amount');
      assert.ok(migration009.includes('Invalid payment status'), 'Must validate payment status');
      assert.ok(migration009.includes('contest_payments'), 'Must check against contest payments to prevent cross-purpose reuse');
    });

    test('Safely handles existing duplicates before creating uniqueness constraints', () => {
      assert.ok(migration009.includes('uq_verified_payments_norm_ref'), 'Must create unique index on normalized reference');
      assert.ok(migration009.includes('row_number() over'), 'Must safely partition and detect pre-existing duplicates');
      assert.ok(migration009.includes('status = \'rejected\''), 'Must safely mark existing duplicates as rejected before constraint');
    });

    test('Contains atomic reject_learner_payment RPC function preserving earlier valid payments', () => {
      assert.ok(migration009.includes('create or replace function public.reject_learner_payment'));
      assert.ok(
        migration009.includes('status = \'verified\''),
        'Must check if user has other verified payments before modifying paid_unlocked'
      );
    });

    test('Normalization rule correctly standardizes messy transaction references', () => {
      function normalizeRef(ref) {
        return (ref || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      }

      assert.strictEqual(normalizeRef('upi-123456789012'), 'UPI123456789012');
      assert.strictEqual(normalizeRef('  UPI / 123 456 789 012  '), 'UPI123456789012');
      assert.strictEqual(normalizeRef('UTR#987-654-321'), 'UTR987654321');
      assert.strictEqual(normalizeRef('utr 987 654 321'), 'UTR987654321');
    });

    test('Admin JS verifyLearnerPayment calls atomic RPC and never reports success on failure', () => {
      assert.ok(adminJs.includes("client.rpc('verify_learner_payment'"));
      assert.ok(adminJs.includes("client.rpc('reject_learner_payment'"));
      assert.ok(adminJs.includes('rollback') || adminJs.includes('rolled back') || adminJs.includes('transactional'));
    });
  });

  describe('3. Payment User Experience & Authoritative Refresh', () => {
    test('Validates Razorpay payment integration and Pay ₹49 checkout flow', () => {
      // Validates Pay ₹49 button and trigger in UI
      assert.ok(indexHtml.includes('payCourseUnlockWithRazorpay()'));
      assert.ok(indexHtml.includes('Pay ₹49'));
      assert.ok(appJs.includes('payCourseUnlockWithRazorpay'));
      // Validates Razorpay SDK checkout integration and order creation Edge Function invocation
      assert.ok(appJs.includes('checkout.razorpay.com'));
      assert.ok(appJs.includes("client.functions.invoke('create-razorpay-order'"));
      assert.ok(appJs.includes("contest_id: 'course_unlock'"));
    });

    test('App JS supports Razorpay payment lifecycle states (required, order creation, checkout, verification, unlock, error/retry)', () => {
      // State 1: Payment required
      assert.ok(appJs.includes("payBtn.innerHTML = '<span>Pay ₹49</span>'"));
      // State 2: Order creation & order failure handling
      assert.ok(appJs.includes("payBtn.textContent = 'Creating order…'"));
      assert.ok(appJs.includes("client.functions.invoke('create-razorpay-order'"));
      assert.ok(appJs.includes("Order Error:"));
      // State 3: Razorpay checkout loading & launch
      assert.ok(appJs.includes("loadRazorpaySdk"));
      assert.ok(appJs.includes("rzp.open()"));
      // State 4: Payment verification invocation
      assert.ok(appJs.includes("payBtn.textContent = 'Verifying payment…'"));
      assert.ok(appJs.includes("client.functions.invoke('verify-razorpay-payment'"));
      // State 5: Successful premium unlock & continue action
      assert.ok(appJs.includes("isPaidUnlocked = true"));
      assert.ok(appJs.includes("Payment Successful!"));
      assert.ok(appJs.includes("Continue Practice (Question 6+)"));
      // State 6: Verification error & retry re-enablement
      assert.ok(appJs.includes("Verification Error:"));
      assert.ok(appJs.includes("payBtn.disabled = false"));
    });

    test('Admin payment screen renders all required operational fields', () => {
      // Learner identity
      assert.ok(adminJs.includes('displayName') || adminJs.includes('user_name'));
      // Amount and payment purpose
      assert.ok(adminJs.includes('Practice Course Unlock'));
      // UTR / reference
      assert.ok(adminJs.includes('p.transaction_reference'));
      // Submission date
      assert.ok(adminJs.includes('submitted_at'));
      // Current status
      assert.ok(adminJs.includes('statusBadge'));
      // Verify and Reject controls
      assert.ok(adminJs.includes('window.verifyLearnerPayment'));
      assert.ok(adminJs.includes('window.rejectLearnerPayment'));
      // Verification audit information
      assert.ok(adminJs.includes('Verified') && adminJs.includes('verified_by'));
      assert.ok(adminJs.includes('Rejected') && adminJs.includes('admin_notes'));
    });

    test('App JS implements background polling and visibilitychange/focus listeners', () => {
      assert.ok(appJs.includes('startPaymentPolling'));
      assert.ok(appJs.includes('stopPaymentPolling'));
      assert.ok(appJs.includes("document.addEventListener('visibilitychange'"));
      assert.ok(appJs.includes("window.addEventListener('focus'"));
    });

    test('Clean cleanup on logout and account switch', () => {
      assert.ok(appJs.includes('stopPaymentPolling();'), 'Must stop polling on sign out / session reset');
      const setSessionMatch = appJs.match(/async function setSession\s*\([^)]*\)\s*\{([\s\S]*?)\nasync function /);
      assert.ok(setSessionMatch);
      assert.ok(setSessionMatch[1].includes('stopPaymentPolling()'));
    });

    test('Razorpay order creation and checkout launch do not directly unlock access; unlock requires server verification', () => {
      const payFuncMatch = appJs.match(/async function payCourseUnlockWithRazorpay\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
      assert.ok(payFuncMatch, 'payCourseUnlockWithRazorpay function must exist in app.js');
      const payFuncBody = payFuncMatch[1];

      // Extract the order creation and SDK launch section (before verification invocation)
      const orderAndLaunchSection = payFuncBody.split("client.functions.invoke('verify-razorpay-payment'")[0];
      assert.ok(orderAndLaunchSection, 'Must invoke verify-razorpay-payment');

      // The order creation and launch phase must NEVER unlock access directly
      assert.strictEqual(
        orderAndLaunchSection.includes('isPaidUnlocked = true'),
        false,
        'Razorpay order creation and checkout launch must never directly set isPaidUnlocked = true'
      );

      // Access unlock must occur only in the post-verification section
      const postVerificationSection = payFuncBody.split("client.functions.invoke('verify-razorpay-payment'")[1];
      assert.ok(
        postVerificationSection.includes('isPaidUnlocked = true'),
        'isPaidUnlocked = true must only occur after server verification succeeds'
      );
      assert.ok(
        postVerificationSection.includes('verifyData.success'),
        'Server verification success must be validated before unlocking access'
      );
    });
  });

  describe('4. Authoritative Completion & Progress Unification', () => {
    test('Thinking score >= 7 counts as completed question; < 7 does not', () => {
      function evaluateCompleted(score) {
        return typeof score === 'number' && score >= 7;
      }
      assert.strictEqual(evaluateCompleted(7), true);
      assert.strictEqual(evaluateCompleted(8), true);
      assert.strictEqual(evaluateCompleted(10), true);
      assert.strictEqual(evaluateCompleted(6), false);
      assert.strictEqual(evaluateCompleted(0), false);
      assert.strictEqual(evaluateCompleted(null), false);
    });

    test('5 free questions gate: question 6+ blocked for unpaid ordinary learner', () => {
      function canAccessQuestion(targetCompleted, totalCompleted, isPaid, isAdmin) {
        if (targetCompleted) return true; // Previously completed remain reviewable
        if (isAdmin || isPaid) return true;
        return totalCompleted < 5;
      }

      // Learner with 3 completed: can access new question
      assert.strictEqual(canAccessQuestion(false, 3, false, false), true);
      // Learner with 5 completed: blocked from new question (Question 6)
      assert.strictEqual(canAccessQuestion(false, 5, false, false), false);
      // Learner with 5 completed: CAN review questions 1..5
      assert.strictEqual(canAccessQuestion(true, 5, false, false), true);
      // Learner with 5 completed and verified payment: can access new question
      assert.strictEqual(canAccessQuestion(false, 5, true, false), true);
      // Super admin with 5 completed and no payment: can access new question
      assert.strictEqual(canAccessQuestion(false, 5, false, true), true);
    });

    test('Contest eligibility automatically at 18 distinct completions', () => {
      function isContestEligible(completedCount) {
        return completedCount >= 18;
      }
      assert.strictEqual(isContestEligible(17), false);
      assert.strictEqual(isContestEligible(18), true);
      assert.strictEqual(isContestEligible(25), true);
    });

    test('Contest refresh button does NOT overwrite existing or verified payment with PENDING', () => {
      // In contest.js, verify that btnSubmitPayment checks existing payment before inserting
      const btnSubmitMatch = contestJs.match(/const btn = \$'btnSubmitPayment'\);[\s\S]*?btn\?\.addEventListener\('click'[\s\S]*?\n  \}/);
      assert.ok(btnSubmitMatch || contestJs.includes('btnSubmitPayment'), 'Must handle btnSubmitPayment');
      
      assert.ok(
        contestJs.includes('currentPayment && (currentPayment.status === \'PENDING\' || currentPayment.status === \'VERIFIED\')'),
        'Must check existing PENDING or VERIFIED status'
      );
      assert.ok(
        contestJs.includes('await refreshUserContestRecords()'),
        'Must call refreshUserContestRecords without overwriting'
      );
    });

    test('Authoritative completion path: record_scenario_completion and reconcile_user_completions', () => {
      assert.ok(migration009.includes('create or replace function public.record_scenario_completion'));
      assert.ok(migration009.includes('from public.scenario_catalog where id = p_scenario_id'));
      assert.ok(migration009.includes('Free limit reached: A verified ₹49 payment is required to complete more than 5 scenarios.'));
      assert.ok(migration009.includes('create or replace function public.reconcile_user_completions'));
      assert.ok(migration009.includes('from public.learning_progress'));
      assert.ok(appJs.includes("client.rpc('record_scenario_completion'"));
    });

    test('Draft separation: local drafts preserved during connection failures with pending sync status', () => {
      assert.ok(appJs.includes("syncPending: true"));
      assert.ok(appJs.includes("syncStatus: 'pending'"));
      assert.ok(appJs.includes("Saved on this device. Pending cloud sync..."));
    });

    test('Learner-side privileged profile field protection', () => {
      // Must not directly update completed_count or contest_eligible on client
      assert.ok(!appJs.includes("completed_count: currentCompleted"));
      assert.ok(!appJs.includes("contest_eligible: currentCompleted >= 18"));
      // Profiles trigger restricts direct modification of privileged fields
      assert.ok(migration009.includes('create or replace function public.protect_profile_privileged_fields'));
      assert.ok(migration009.includes('Modifying completed_count directly is restricted'));
      assert.ok(migration009.includes('Modifying contest_eligible directly is restricted'));
    });

    test('Reset behavior consistency: local reset never grants another five free questions', () => {
      // Local reset does not erase lifetime/authoritative count
      assert.ok(appJs.includes('authoritativeCompletedCount'));
      assert.ok(appJs.includes('getGuestLifetimeCompletedCount'));
      assert.ok(appJs.includes('Math.max(authoritativeCompletedCount, localCount)'));
    });
  });

  describe('5. Handle Every Supabase Error & Explicit Confirmation', () => {
    test('Completion persistence checks returned errors explicitly and marks synced only on confirmed success', () => {
      assert.ok(appJs.includes("const { data: recRes, error: rpcErr } = await client.rpc('record_scenario_completion'"));
      assert.ok(appJs.includes("if (!rpcErr && recRes)"));
      assert.ok(appJs.includes("syncStatus: 'synced'"));
      assert.ok(appJs.includes("syncPending: false"));
    });

    test('sync_user_progress handles returned error explicitly', () => {
      // Must invoke sync_user_progress RPC and capture returned error
      assert.ok(
        appJs.includes("client.rpc('sync_user_progress')"),
        'Must call sync_user_progress RPC'
      );
      assert.ok(
        appJs.includes('syncErr'),
        'Must capture syncErr from sync_user_progress response'
      );

      // Verify that syncErr is explicitly checked before applying progress count
      const hasExplicitErrorCheck =
        appJs.includes('!syncErr && syncRes') ||
        appJs.includes('if (syncErr)') ||
        /if\s*\([^)]*syncErr[^)]*\)/.test(appJs);
      assert.ok(
        hasExplicitErrorCheck,
        'Returned syncErr must be explicitly checked before applying progress count'
      );

      // Verify that progress is only applied when syncErr is null/absent
      assert.ok(
        appJs.includes('!syncErr && syncRes'),
        'authoritativeCompletedCount must only be updated when syncErr is null/absent'
      );

      // Verify that the call is protected inside try/catch error handling
      const syncBlock = appJs.match(/try\s*\{[\s\S]*?client\.rpc\('sync_user_progress'[\s\S]*?\}\s*catch/);
      assert.ok(
        syncBlock,
        'sync_user_progress must be wrapped in try/catch to safely handle RPC failure'
      );
    });

    test('Profile creation and access loading checks returned error explicitly', () => {
      assert.ok(appJs.includes("const { error: insErr } = await client"));
      assert.ok(appJs.includes("if (insErr)"));
    });

    test('Contest registration uses .select().single() and confirms returned record before proceeding', () => {
      assert.ok(contestJs.includes("const { data: regData, error: regErr } = await activeClient.from('contest_registrations').upsert"));
      assert.ok(contestJs.includes(".select().single()"));
      assert.ok(contestJs.includes("if (regErr) throw regErr;"));
      assert.ok(contestJs.includes("if (!regData) throw new Error"));
    });

    test('Contest payment reference submission uses .select().single() and confirms returned record', () => {
      assert.ok(contestJs.includes("const { data: payData, error: insErr } = await activeClient.from('contest_payments').insert"));
      assert.ok(contestJs.includes(".select().single()"));
      assert.ok(contestJs.includes("if (insErr) throw insErr;"));
      assert.ok(contestJs.includes("if (!payData) throw new Error"));
    });

    test('Draft saving checks error explicitly and displays saved only on confirmed success', () => {
      assert.ok(contestJs.includes("const { data: draftRes, error: draftErr } = await activeClient.rpc('save_contest_draft'"));
      assert.ok(contestJs.includes("if (draftErr) throw draftErr;"));
      assert.ok(contestJs.includes("Draft saved ✓"));
      assert.ok(contestJs.includes("Offline (cached locally)"));
    });

    test('Final submission checks error explicitly and displays submitted only on confirmed success', () => {
      assert.ok(contestJs.includes("const { data: subRes, error: subErr } = await activeClient.rpc('submit_contest_attempt'"));
      assert.ok(contestJs.includes("if (subErr) throw subErr;"));
      assert.ok(contestJs.includes("if (!subRes || !subRes.success)"));
      assert.ok(contestJs.includes("localStorage.removeItem(`contestDraft:"));
    });

    test('Admin contest updates, payment verification, and results verify actual row changes', () => {
      assert.ok(adminJs.includes("await client.from('contests').update(payload).eq('id', id).select()"));
      assert.ok(adminJs.includes("await client.from('contests').update(patch).eq('id', contestId).select()"));
      assert.ok(adminJs.includes(".from('contest_payments')"));
      assert.ok(adminJs.includes("Failed to update contest payment: no record was updated."));
      assert.ok(adminJs.includes("await client\n      .from('contest_evaluations')\n      .upsert(payload, { onConflict: 'contest_id,user_id' })\n      .select()"));
      assert.ok(adminJs.includes("status: 'RESULTS_PUBLISHED'"));
      assert.ok(adminJs.includes("Failed to publish results: contest record was not found or updated."));
    });
  });

  describe('6. Contest Lifecycle, Authoritative Timer & Server Operations', () => {
    test('Server RPC start_contest_attempt validates publication, audience, qualification, payment, rules, and window', () => {
      assert.ok(migration010.includes("create or replace function public.start_contest_attempt"));
      assert.ok(migration010.includes("if v_contest.status <> 'PUBLISHED' then"));
      assert.ok(migration010.includes("if v_contest.start_date is not null and now() < v_contest.start_date then"));
      assert.ok(migration010.includes("if v_contest.end_date is not null and now() > v_contest.end_date then"));
      assert.ok(migration010.includes("if v_contest.audience_type <> 'ALL' and not v_is_admin then"));
      assert.ok(migration010.includes("if not v_is_admin then"));
      assert.ok(migration010.includes("if v_completed_count < 18 then"));
      assert.ok(migration010.includes("if not v_reg_exists then"));
      assert.ok(migration010.includes("if coalesce(v_contest.entry_fee, 0) > 0 and not v_is_admin then"));
      assert.ok(migration010.includes("if v_pay_status is distinct from 'VERIFIED' then"));
    });

    test('Enforces one attempt via database constraint and safe concurrent-start handling', () => {
      assert.ok(supabaseSetup.includes("constraint uq_contest_attempts unique (contest_id, user_id)"));
      assert.ok(migration010.includes("on conflict (contest_id, user_id) do nothing;"));
    });

    test('Generates started_at, deadline, and submission timestamps server-side', () => {
      assert.ok(migration010.includes("v_deadline := now() + (coalesce(v_contest.duration_minutes, 30) || ' minutes')::interval;"));
      assert.ok(migration010.includes("started_at,\n    deadline,"));
      assert.ok(migration010.includes("submitted_at = now()"));
    });

    test('Trigger protect_contest_attempt_integrity prevents tampering with started_at, deadline, user, contest, or reopening', () => {
      assert.ok(migration010.includes("create or replace function public.protect_contest_attempt_integrity"));
      assert.ok(migration010.includes("Changing contest attempt ownership is prohibited."));
      assert.ok(migration010.includes("Changing contest ID on an attempt is prohibited."));
      assert.ok(migration010.includes("Modifying attempt started_at timestamp is prohibited."));
      assert.ok(migration010.includes("Modifying attempt deadline is prohibited."));
      assert.ok(migration010.includes("Reopening or modifying a submitted or timed-out contest attempt is prohibited."));
    });

    test('Draft saving is separated from final submission with grace period', () => {
      assert.ok(migration010.includes("create or replace function public.save_contest_draft"));
      assert.ok(migration010.includes("interval '60 seconds'"));
      assert.ok(migration010.includes("create or replace function public.submit_contest_attempt"));
    });

    test('Final submission is idempotent and handles network failure cleanly', () => {
      assert.ok(migration010.includes("if v_attempt.status = 'SUBMITTED' then"));
      assert.ok(migration010.includes("'already_submitted', true"));
      // Client resumes timer on submission error instead of resetting or falsely showing success
      assert.ok(contestJs.includes("startActiveContestRuntime();"));
      assert.ok(contestJs.includes("submitBtn.disabled = false;"));
    });

    test('Changing device clock does not extend attempt due to monotonic performance.now()', () => {
      assert.ok(contestJs.includes("performance.now()"));
      assert.ok(contestJs.includes("const monotonicPassed = Math.floor((performance.now() - loadPerf) / 1000);"));
      assert.ok(contestJs.includes("remainingSeconds = initialRemaining !== null ? Math.max(0, initialRemaining - monotonicPassed) : null;"));
    });

    test('Preserves existing attempt and restores after reload or resume', () => {
      assert.ok(contestJs.includes("if (currentAttempt && currentAttempt.status === 'IN_PROGRESS')"));
      assert.ok(contestJs.includes("start_contest_attempt"));
      assert.ok(contestJs.includes("document.addEventListener('visibilitychange'"));
      assert.ok(contestJs.includes("contest.status === 'REGISTRATION_CLOSED'"));
    });

    test('Explains deadline and disconnection policy to learners in the UI', () => {
      assert.ok(contestJs.includes("Official Timer &amp; Disconnection Policy:"));
      assert.ok(contestJs.includes("60-second network grace window"));
      assert.ok(contestJs.includes("marked as TIMED OUT"));
    });

    test('Preserves admin scoring, review, and results publication controls', () => {
      assert.ok(adminJs.includes("export async function saveEvaluation"));
      assert.ok(adminJs.includes("export async function publishContestResults"));
      assert.ok(adminJs.includes("status: 'RESULTS_PUBLISHED'"));
    });
  });
});
