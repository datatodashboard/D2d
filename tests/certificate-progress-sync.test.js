import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  CERTIFICATE_DOMAINS,
  CERTIFICATE_LEVELS,
  checkLevelCompletion,
  getEarnedCertificates,
  getAllCertificatesStatus,
  isLevelUnlocked,
  isLevelCompleted,
  isDomainUnlocked
} from '../js/certificate.js';
import {
  EMPTY,
  sanitize,
  mergeProgress,
  chooseNext,
  isCompleted,
  isAttempted
} from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;
const ids = new Set(scenarios.map(s => s.id));

describe('Certificate Page Progress Sync & Eligibility System', () => {

  // 1. Accurate Progress: Unique completed scenarios per domain and level
  it('accurately counts unique qualifying completed scenarios per domain and level', () => {
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    assert.strictEqual(bankingBeg.length, 20);

    const state = EMPTY();

    // Complete 5 scenarios with passing scores (>= 7)
    for (let i = 0; i < 5; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Valid logic plan' },
        assessment: { score: 8, ready: true },
        completed: true,
        updatedAt: 1000 + i
      };
    }

    // Attempt 3 scenarios with failing scores (< 7)
    for (let i = 5; i < 8; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Partial draft plan' },
        assessment: { score: 5, ready: false },
        completed: false,
        attempts: 2,
        updatedAt: 1000 + i
      };
    }

    const status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.completedCount, 5, 'Should count exactly 5 completed scenarios');
    assert.strictEqual(status.totalCount, 20);
    assert.strictEqual(status.isCompleted, false, '5/20 must NOT be eligible for certificate');
  });

  // 2. Resume Progress: 5/20 completed resumes at question 6, never restarts from question 1
  it('resumes from next incomplete scenario when 5/20 completed, never restarting at question 1', () => {
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    const state = EMPTY();

    // Mark first 5 scenarios as completed
    for (let i = 0; i < 5; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Good query logic' },
        assessment: { score: 9, ready: true },
        completed: true,
        updatedAt: 1000 + i
      };
    }

    const next = chooseNext(bankingBeg, state, null);
    assert.ok(next, 'Must select next scenario');
    assert.strictEqual(next.id, bankingBeg[5].id, 'Must resume at scenario 6 (index 5), NOT question 1');
    assert.notStrictEqual(next.id, bankingBeg[0].id, 'Must NEVER restart from question 1');

    // When 0 completed, chooseNext returns question 1
    const emptyState = EMPTY();
    const firstScenario = chooseNext(bankingBeg, emptyState, null);
    assert.strictEqual(firstScenario.id, bankingBeg[0].id, 'When 0 progress, starts from question 1');
  });

  // 3. Certificate Eligibility: Requires all 20 qualifying completed scenarios
  it('requires all 20 qualifying scenarios before certificate is claimable; attempted questions do not qualify', () => {
    const healthcareBeg = scenarios.filter(s => s.domain === 'Healthcare' && s.level === 'Beginner');
    assert.strictEqual(healthcareBeg.length, 20);

    const state = EMPTY();

    // 19 completed + 1 attempted (score 6)
    for (let i = 0; i < 19; i++) {
      state.entries[healthcareBeg[i].id] = {
        assessment: { score: 8 },
        completed: true,
        updatedAt: 1000 + i
      };
    }
    state.entries[healthcareBeg[19].id] = {
      assessment: { score: 6 },
      completed: false,
      attempts: 4,
      updatedAt: 2000
    };

    let status = checkLevelCompletion('Healthcare', 'Beginner', scenarios, state);
    assert.strictEqual(status.completedCount, 19);
    assert.strictEqual(status.isCompleted, false, 'Score 6 attempt does not satisfy certificate requirement');
    assert.strictEqual(status.completionDate, null);

    // Solve 20th scenario with score 7
    state.entries[healthcareBeg[19].id] = {
      assessment: { score: 7 },
      completed: true,
      updatedAt: 2500
    };

    status = checkLevelCompletion('Healthcare', 'Beginner', scenarios, state);
    assert.strictEqual(status.completedCount, 20);
    assert.strictEqual(status.isCompleted, true, '20/20 completed qualifies for certificate');
    assert.ok(status.completionDate);
  });

  // 4. Level Locking: Intermediate and Expert locked until progression satisfied
  it('keeps Intermediate and Expert locked until 20 questions + mandatory feedback completed', () => {
    const state = EMPTY();

    // Initially: Beginner is unlocked, Intermediate & Expert are locked
    assert.strictEqual(isLevelUnlocked('Banking', 'Beginner', scenarios, state), true);
    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), false);
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), false);

    // Complete 20 questions in Beginner without feedback
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    for (const s of bankingBeg) {
      state.entries[s.id] = { assessment: { score: 10 }, completed: true, updatedAt: 1000 };
    }

    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), false, 'Intermediate must remain locked without feedback');

    // Submit mandatory feedback
    state.levelFeedback = {
      'Banking_Beginner': { submittedAt: Date.now(), text: 'Excellent foundation!' }
    };

    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), true, 'Intermediate unlocks after feedback');
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), false, 'Expert remains locked');

    // Complete Intermediate 20 questions + feedback
    const bankingInt = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Intermediate');
    for (const s of bankingInt) {
      state.entries[s.id] = { assessment: { score: 9 }, completed: true, updatedAt: 2000 };
    }
    state.levelFeedback['Banking_Intermediate'] = { submittedAt: Date.now(), text: 'Challenging joins!' };

    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), true, 'Expert unlocks after Intermediate feedback');
  });

  // 5. Reliable Cloud Sync: Stale localStorage data never overrides or wipes Supabase progress
  it('prevents stale localStorage data from overriding or lagging behind Supabase authoritative progress', () => {
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');

    // Stale local cache has only 2 completed and 1 low score attempt
    const staleLocal = EMPTY();
    staleLocal.entries[bankingBeg[0].id] = { assessment: { score: 8 }, completed: true, updatedAt: 1000 };
    staleLocal.entries[bankingBeg[1].id] = { assessment: { score: 8 }, completed: true, updatedAt: 1001 };
    staleLocal.entries[bankingBeg[2].id] = { assessment: { score: 5 }, completed: false, attempts: 2, updatedAt: 1002 };

    // Supabase cloud progress has 5 confirmed completed scenarios
    const authoritativeCloud = EMPTY();
    for (let i = 0; i < 5; i++) {
      authoritativeCloud.entries[bankingBeg[i].id] = {
        thinking: { response: 'Passed solution' },
        assessment: { score: 9, ready: true },
        completed: true,
        updatedAt: 5000 + i
      };
    }

    // Merge: Authoritative cloud state is primary, merged with local
    const merged = mergeProgress(authoritativeCloud, staleLocal, ids);

    // Verify all 5 completions from cloud are preserved
    for (let i = 0; i < 5; i++) {
      const entry = merged.entries[bankingBeg[i].id];
      assert.ok(entry, `Scenario ${i} must exist in merged state`);
      assert.strictEqual(isCompleted(bankingBeg[i], entry), true, `Scenario ${i} must remain completed`);
    }

    // Authoritative check on level completion status
    const status = checkLevelCompletion('Banking', 'Beginner', scenarios, merged);
    assert.strictEqual(status.completedCount, 5, 'Must reflect 5 completed scenarios from Supabase');

    // Verify sanitize does not wipe completed status when assessment score exists
    const sanitized = sanitize(merged, ids);
    assert.strictEqual(sanitized.entries[bankingBeg[2].id].completed, true, 'Sanitize must not wipe completed status');
  });

  // 6. All Certificates Status accurately reflects locked, in-progress, and completed states
  it('returns accurate isUnlocked, isCompleted, and completedCount in getAllCertificatesStatus', () => {
    const state = EMPTY();
    const user = { user_metadata: { full_name: 'Sundar V' }, email: 'sundar@example.com' };

    // 5 completed in Banking Beginner
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    for (let i = 0; i < 5; i++) {
      state.entries[bankingBeg[i].id] = { assessment: { score: 8 }, completed: true, updatedAt: 1000 + i };
    }

    const allStatuses = getAllCertificatesStatus(scenarios, state, user, 'sundar');
    assert.strictEqual(allStatuses.length, 21);

    const banBeg = allStatuses.find(c => c.domain === 'Banking' && c.level === 'Beginner');
    assert.ok(banBeg);
    assert.strictEqual(banBeg.isUnlocked, true, 'Banking Beginner is unlocked');
    assert.strictEqual(banBeg.isCompleted, false, 'Banking Beginner is not completed yet (5/20)');
    assert.strictEqual(banBeg.completedCount, 5);

    const banInt = allStatuses.find(c => c.domain === 'Banking' && c.level === 'Intermediate');
    assert.ok(banInt);
    assert.strictEqual(banInt.isUnlocked, false, 'Banking Intermediate is locked');
    assert.strictEqual(banInt.isCompleted, false);
    assert.strictEqual(banInt.completedCount, 0);

    const heaBeg = allStatuses.find(c => c.domain === 'Healthcare' && c.level === 'Beginner');
    assert.ok(heaBeg);
    assert.strictEqual(heaBeg.isUnlocked, false, 'Healthcare Beginner is locked');
  });
});
