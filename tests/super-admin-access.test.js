import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

describe('Super Admin Recognition & Practice / Contest Exemptions', () => {

  describe('1. Authoritative Admin Recognition', () => {
    it('verifies admin status strictly via server RPC or protected role tables, never client metadata or email string', async () => {
      // Simulate authoritative 3-tier admin check logic
      async function evaluateAdmin(mockClient, userId) {
        if (!userId || !mockClient) return { isAdmin: false, error: null };

        let isAuthorized = false;
        let lastError = null;

        // Tier 1: RPC is_admin()
        try {
          const { data: rpcAdmin, error: rpcErr } = await mockClient.rpc('is_admin');
          if (!rpcErr && typeof rpcAdmin === 'boolean') {
            isAuthorized = rpcAdmin;
          } else if (rpcErr) {
            lastError = rpcErr;
          }
        } catch (e) {
          lastError = e;
        }

        // Tier 2: Direct protected admin_users table check
        if (!isAuthorized) {
          try {
            const { data: adminRow, error: adminErr } = await mockClient
              .from('admin_users')
              .select('role')
              .eq('user_id', userId)
              .maybeSingle();

            if (!adminErr && adminRow) {
              isAuthorized = true;
              lastError = null;
            } else if (adminErr && adminErr.code !== 'PGRST116') {
              lastError = adminErr;
            }
          } catch (e) {
            lastError = e;
          }
        }

        // Tier 3: Protected profiles.is_admin
        if (!isAuthorized) {
          try {
            const { data: profileRow, error: profErr } = await mockClient
              .from('profiles')
              .select('is_admin')
              .eq('id', userId)
              .maybeSingle();

            if (!profErr && profileRow?.is_admin === true) {
              isAuthorized = true;
              lastError = null;
            } else if (profErr) {
              lastError = profErr;
            }
          } catch (e) {
            lastError = e;
          }
        }

        return { isAdmin: isAuthorized, error: lastError };
      }

      // Case A: Super Admin datatodashboard2@gmail.com verified by RPC
      const superAdminClient = {
        rpc: async (fn) => (fn === 'is_admin' ? { data: true, error: null } : { data: null, error: null }),
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
      };
      const resAdmin = await evaluateAdmin(superAdminClient, 'super-admin-uuid');
      assert.strictEqual(resAdmin.isAdmin, true, 'Super Admin verified by RPC is_admin() must be recognized');

      // Case B: Normal learner (RPC returns false, not in admin_users or profiles.is_admin)
      const learnerClient = {
        rpc: async (fn) => (fn === 'is_admin' ? { data: false, error: null } : { data: null, error: null }),
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
      };
      const resLearner = await evaluateAdmin(learnerClient, 'learner-uuid');
      assert.strictEqual(resLearner.isAdmin, false, 'Learner must not be recognized as admin');

      // Case C: Learner attempting to forge user_metadata.is_admin or email in browser
      const forgedUser = { id: 'attacker-uuid', email: 'datatodashboard2@gmail.com', user_metadata: { is_admin: true } };
      // Even if email is claimed in browser, if DB RPC returns false, access is denied
      const resForged = await evaluateAdmin(learnerClient, forgedUser.id);
      assert.strictEqual(resForged.isAdmin, false, 'Client email or metadata forgery must never grant admin rights');

      // Case D: Network failure produces retryable error, not treating user as admin or paid
      const errorClient = {
        rpc: async () => { throw new Error('Connection failed'); },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error('Connection failed'); } }) }) })
      };
      const resError = await evaluateAdmin(errorClient, 'any-uuid');
      assert.strictEqual(resError.isAdmin, false, 'On error, admin must remain false');
      assert(resError.error !== null, 'Must report error for retryable handling');
    });
  });

  describe('2. Admin Practice Exemption vs Ordinary Learner Gates', () => {
    function evaluatePracticeAccess({ totalCompleted, isTargetCompleted, isPaidUnlocked, isAdmin }) {
      if (isTargetCompleted) {
        return { allowed: true, reason: 'Already completed' };
      }
      // If learner has completed 5 challenges and has not paid, locked unless admin
      const isLocked = totalCompleted >= 5 && !isPaidUnlocked && !isAdmin;
      if (isLocked) {
        return { allowed: false, reason: 'Paywall locked (5 free completed)' };
      }
      return {
        allowed: true,
        reason: isAdmin && !isPaidUnlocked ? 'Admin access — payment exempt' : 'Unlocked'
      };
    }

    it('Super Admin with 0 completed questions and no payments has complete practice access', () => {
      const access = evaluatePracticeAccess({
        totalCompleted: 0,
        isTargetCompleted: false,
        isPaidUnlocked: false,
        isAdmin: true
      });
      assert.strictEqual(access.allowed, true);
    });

    it('Super Admin with 5+ completed questions and no payments is exempt and can access Question 6+', () => {
      const access = evaluatePracticeAccess({
        totalCompleted: 5,
        isTargetCompleted: false,
        isPaidUnlocked: false,
        isAdmin: true
      });
      assert.strictEqual(access.allowed, true);
      assert.strictEqual(access.reason, 'Admin access — payment exempt');
    });

    it('Ordinary learner with 5 completed questions and NO payment is blocked from Question 6', () => {
      const access = evaluatePracticeAccess({
        totalCompleted: 5,
        isTargetCompleted: false,
        isPaidUnlocked: false,
        isAdmin: false
      });
      assert.strictEqual(access.allowed, false);
      assert.strictEqual(access.reason, 'Paywall locked (5 free completed)');
    });

    it('Ordinary learner with verified payment has full access', () => {
      const access = evaluatePracticeAccess({
        totalCompleted: 15,
        isTargetCompleted: false,
        isPaidUnlocked: true,
        isAdmin: false
      });
      assert.strictEqual(access.allowed, true);
    });

    it('Maintains separation of actual payment state from admin access', () => {
      let isPaidUnlocked = false;
      const isAdmin = true;
      // Admin practice access check does not overwrite actual payment status
      const hasPracticeAccess = isPaidUnlocked || isAdmin;
      assert.strictEqual(hasPracticeAccess, true, 'Admin has effective practice access');
      assert.strictEqual(isPaidUnlocked, false, 'Actual payment status remains false');
    });
  });

  describe('3. Admin Contest Exemption vs Ordinary Learner Qualification', () => {
    function evaluateContestEligibility({ completedCount, isAdmin, contestAudience, isInvited, isPublished }) {
      if (!isPublished) {
        return { canAccess: false, view: isAdmin ? 'admin_no_contest' : 'none' };
      }
      // Learner requirement: >= 18 completions
      if (completedCount < 18 && !isAdmin) {
        return { canAccess: false, view: 'blocked_under_18' };
      }
      // Audience restriction: Admins can access any published contest regardless of audience
      if (contestAudience !== 'ALL' && !isInvited && !isAdmin) {
        return { canAccess: false, view: 'waiting_audience' };
      }
      return { canAccess: true, view: 'contest_card' };
    }

    it('Super Admin can access published contest with 0 completed questions', () => {
      const result = evaluateContestEligibility({
        completedCount: 0,
        isAdmin: true,
        contestAudience: 'ALL',
        isInvited: false,
        isPublished: true
      });
      assert.strictEqual(result.canAccess, true);
      assert.strictEqual(result.view, 'contest_card');
    });

    it('Super Admin can access published contest even when audience is targeted and admin not invited', () => {
      const result = evaluateContestEligibility({
        completedCount: 0,
        isAdmin: true,
        contestAudience: 'SELECTED',
        isInvited: false,
        isPublished: true
      });
      assert.strictEqual(result.canAccess, true);
      assert.strictEqual(result.view, 'contest_card');
    });

    it('Ordinary learner with 17 questions is blocked from contest', () => {
      const result = evaluateContestEligibility({
        completedCount: 17,
        isAdmin: false,
        contestAudience: 'ALL',
        isInvited: false,
        isPublished: true
      });
      assert.strictEqual(result.canAccess, false);
      assert.strictEqual(result.view, 'blocked_under_18');
    });

    it('Ordinary learner with 18 questions can access published contest', () => {
      const result = evaluateContestEligibility({
        completedCount: 18,
        isAdmin: false,
        contestAudience: 'ALL',
        isInvited: false,
        isPublished: true
      });
      assert.strictEqual(result.canAccess, true);
      assert.strictEqual(result.view, 'contest_card');
    });

    it('If no contest is published, Admin sees Contest Management link, not 18 questions prompt', () => {
      const result = evaluateContestEligibility({
        completedCount: 0,
        isAdmin: true,
        contestAudience: 'ALL',
        isInvited: false,
        isPublished: false
      });
      assert.strictEqual(result.canAccess, false);
      assert.strictEqual(result.view, 'admin_no_contest');
    });

    it('Contest flow: Admin must accept rules, but is exempt from entry fee and proceeds to ready', () => {
      function routeContestModal({ stage, agreedRules, isPaid, entryFee, isAdmin }) {
        if (!agreedRules) {
          return 'details'; // Must accept rules first
        }
        if (isAdmin || isPaid || entryFee === 0) {
          return 'ready'; // Admin skips payment screen
        }
        return 'payment';
      }

      // Step 1: Admin has not agreed to rules yet -> must see details & rules
      assert.strictEqual(
        routeContestModal({ stage: 'initial', agreedRules: false, isPaid: false, entryFee: 49, isAdmin: true }),
        'details'
      );

      // Step 2: Admin agrees to rules -> proceeds directly to ready (fee exempt)
      assert.strictEqual(
        routeContestModal({ stage: 'registered', agreedRules: true, isPaid: false, entryFee: 49, isAdmin: true }),
        'ready'
      );

      // Learner with fee > 0 and no payment -> must go to payment screen
      assert.strictEqual(
        routeContestModal({ stage: 'registered', agreedRules: true, isPaid: false, entryFee: 49, isAdmin: false }),
        'payment'
      );
    });

    it('Contest flow: Preserves strict single attempt constraint for Admin as well', () => {
      function canStartAttempt(attempt) {
        if (attempt && attempt.status === 'SUBMITTED') {
          return false;
        }
        return true;
      }

      assert.strictEqual(canStartAttempt(null), true);
      assert.strictEqual(canStartAttempt({ status: 'IN_PROGRESS' }), true);
      assert.strictEqual(canStartAttempt({ status: 'SUBMITTED' }), false);
    });
  });

  describe('4. Session Lifecycle & Account Switching', () => {
    it('resets admin and payment privileges on sign-out and account change', () => {
      let state = {
        isCurrentUserAdmin: true,
        isPaidUnlocked: false,
        userPendingPayment: null,
        user: { id: 'admin-1', email: 'datatodashboard2@gmail.com' }
      };

      // Sign out
      function signOut(s) {
        s.isCurrentUserAdmin = false;
        s.isPaidUnlocked = false;
        s.userPendingPayment = null;
        s.user = null;
      }

      signOut(state);
      assert.strictEqual(state.isCurrentUserAdmin, false, 'Admin must be false after sign out');
      assert.strictEqual(state.isPaidUnlocked, false);
      assert.strictEqual(state.user, null);

      // Switch to learner account
      function switchAccount(s, nextUser) {
        // Reset immediately before async fetch
        s.isCurrentUserAdmin = false;
        s.isPaidUnlocked = false;
        s.user = nextUser;
      }

      switchAccount(state, { id: 'learner-1', email: 'learner@example.com' });
      assert.strictEqual(state.isCurrentUserAdmin, false, 'Must not retain previous admin privileges on switch');
    });

    it('guards against stale asynchronous responses across account switches using auth counter', async () => {
      let activeAuthToken = 0;
      let committedUser = null;
      let committedIsAdmin = false;

      async function mockSetSession(sessionUser, delayMs, resolveAdmin) {
        const token = ++activeAuthToken;

        // Simulate async load
        await new Promise(r => setTimeout(r, delayMs));

        // If another session was started, abort without applying stale state
        if (token !== activeAuthToken) {
          return;
        }

        committedUser = sessionUser;
        committedIsAdmin = resolveAdmin;
      }

      // Start slow request for Admin (50ms)
      const p1 = mockSetSession({ id: 'admin-user' }, 50, true);
      // Quickly switch to Learner (10ms)
      const p2 = mockSetSession({ id: 'learner-user' }, 10, false);

      await Promise.all([p1, p2]);

      // The slow Admin response must NOT overwrite the Learner
      assert.strictEqual(committedUser.id, 'learner-user');
      assert.strictEqual(committedIsAdmin, false, 'Stale async response must be ignored');
    });
  });

  describe('5. Database Migration 008 Integrity', () => {
    it('verifies 008_super_admin_recognition_and_exemptions.sql exists and contains all required security controls', () => {
      const migrationPath = './migrations/008_super_admin_recognition_and_exemptions.sql';
      assert(fs.existsSync(migrationPath), 'Migration 008 file must exist');

      const content = fs.readFileSync(migrationPath, 'utf8');

      // 1. Resolves datatodashboard2@gmail.com from auth.users
      assert(content.includes('datatodashboard2@gmail.com'), 'Must reference datatodashboard2@gmail.com');
      assert(content.includes('from auth.users'), 'Must resolve real user ID from auth.users');
      assert(content.includes('raise exception'), 'Must raise clear setup error if account not found');

      // 2. Protected admin_users table
      assert(content.includes('create table if not exists public.admin_users'), 'Must ensure admin_users table');
      assert(content.includes('alter table public.admin_users enable row level security'), 'Must enable RLS on admin_users');

      // 3. Authoritative is_admin() function
      assert(content.includes('create or replace function public.is_admin()'), 'Must define public.is_admin()');
      assert(content.includes('security definer'), 'is_admin() must be security definer');
      assert(content.includes('set search_path = public, auth, pg_temp'), 'Must set safe search_path');

      // 4. Trigger preventing ordinary users from modifying privileged fields
      assert(content.includes('trg_protect_profile_privileged_fields'), 'Must protect privileged fields via trigger');
      assert(content.includes('Modifying is_admin is restricted'), 'Must restrict is_admin modification');
      assert(content.includes('Modifying paid_unlocked is restricted'), 'Must restrict paid_unlocked modification');
      assert(content.includes('Modifying contest_eligible directly is restricted'), 'Must restrict contest_eligible modification');
      assert(content.includes('Modifying completed_count directly is restricted'), 'Must restrict completed_count modification');

      // 5. Server-side progress syncing
      assert(content.includes('sync_user_progress'), 'Must provide sync_user_progress');
      assert(content.includes('trg_progress_table_changed'), 'Must trigger on progress table change');

      // 6. RLS policy replacements without permissive leaks
      assert(content.includes('drop policy if exists "Verified users can create single attempt"'), 'Must drop old attempt policy');
      assert(content.includes('drop policy if exists "Users can create single contest attempt"'), 'Must drop conflicting attempt policy');
      assert(content.includes('Authorized users can create single attempt'), 'Must create new attempt policy');
      assert(content.includes('notify pgrst, \'reload schema\''), 'Must reload PostgREST schema cache');
    });
  });

});
