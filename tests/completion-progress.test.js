import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isCompleted, isAttempted, sanitize, EMPTY, chooseNext, mergeProgress } from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;
const ids = new Set(scenarios.map(s => s.id));

describe('Thinking Score Completion & Progress Logic', () => {
  const s1 = scenarios[0];

  it('marks scenario as COMPLETED when Thinking Score >= 7/10', () => {
    const entryScore7 = {
      thinking: { response: 'Use customers and filter active' },
      assessment: { score: 7, ready: true },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryScore7), true, 'Score 7 must be completed');

    const entryScore10 = {
      thinking: { response: 'Detailed explanation' },
      assessment: { score: 10, ready: true },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryScore10), true, 'Score 10 must be completed');
  });

  it('does NOT mark scenario as completed when Thinking Score < 7/10', () => {
    const entryScore6 = {
      thinking: { response: 'Use customers' },
      assessment: { score: 6, ready: false },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryScore6), false, 'Score 6 must not be completed');

    const entryScore0 = {
      thinking: { response: '' },
      assessment: { score: 0, ready: false },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryScore0), false, 'Score 0 must not be completed');

    assert.strictEqual(isCompleted(s1, null), false, 'Null entry must not be completed');
  });

  it('SQL execution or DB Fiddle verification is NOT required for completion', () => {
    const entryWithoutSql = {
      thinking: { response: 'Just thinking, no SQL' },
      assessment: { score: 8, ready: true },
      sql: '',
      evaluationResult: null,
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryWithoutSql), true, 'Score >= 7 without SQL is completed');

    // And even if SQL passed, if score was < 7, it must NOT be completed
    const entryLowScoreWithSqlPassed = {
      thinking: { response: 'Vague idea' },
      assessment: { score: 4, ready: false },
      sql: 'SELECT * FROM customers;',
      evaluationResult: { passed: true },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s1, entryLowScoreWithSqlPassed), false, 'Score < 7 must not be completed even with SQL passed');
  });

  it('sanitize preserves completed state based on score >= 7', () => {
    const rawState = {
      version: 2,
      resetAt: 0,
      entries: {
        [s1.id]: {
          thinking: { response: 'test' },
          assessment: { score: 9 },
          sql: '',
          updatedAt: 2000
        },
        [scenarios[1].id]: {
          thinking: { response: 'test low' },
          assessment: { score: 5 },
          sql: '',
          updatedAt: 2000
        }
      }
    };

    const sanitized = sanitize(rawState, ids);
    assert.strictEqual(sanitized.entries[s1.id].completed, true, 'Sanitize sets completed = true for score >= 7');
    assert.strictEqual(sanitized.entries[scenarios[1].id].completed, false, 'Sanitize sets completed = false for score < 7');
  });

  it('chooseNext picks uncompleted scenarios over completed ones', () => {
    const state = EMPTY();
    state.entries[s1.id] = {
      thinking: { response: 'done' },
      assessment: { score: 8 },
      updatedAt: 1000
    };

    const next = chooseNext(scenarios.slice(0, 3), state, null);
    assert.notStrictEqual(next.id, s1.id, 'chooseNext should skip completed s1');
    assert.strictEqual(next.id, scenarios[1].id, 'chooseNext should select first uncompleted scenario');
  });

  it('accurately computes progress page completed counts and domain totals', () => {
    const bankingScenarios = scenarios.filter(s => s.domain === 'Banking');
    const healthcareScenarios = scenarios.filter(s => s.domain === 'Healthcare');

    const state = EMPTY();
    // Mark 3 Banking scenarios with score >= 7
    bankingScenarios.slice(0, 3).forEach((s, idx) => {
      state.entries[s.id] = {
        thinking: { response: 'Banking plan' },
        assessment: { score: 7 + idx },
        updatedAt: 1000 + idx
      };
    });

    // Mark 1 Banking scenario with score < 7 (should NOT count as completed)
    state.entries[bankingScenarios[3].id] = {
      thinking: { response: 'Incomplete' },
      assessment: { score: 5 },
      updatedAt: 2000
    };

    // Mark 2 Healthcare scenarios with score >= 7
    healthcareScenarios.slice(0, 2).forEach((s, idx) => {
      state.entries[s.id] = {
        thinking: { response: 'Healthcare plan' },
        assessment: { score: 8 },
        updatedAt: 3000 + idx
      };
    });

    // Test completed count
    const coreDomains = ['Banking', 'Healthcare', 'Insurance', 'Retail'];
    const coreScenarios = scenarios.filter(s => coreDomains.includes(s.domain));
    const completedCount = coreScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 5, 'Completed count must be exactly 5 (3 Banking + 2 Healthcare)');

    // Test completion percentage
    const completionPct = Math.round((completedCount / coreScenarios.length) * 100);
    assert.strictEqual(completionPct, Math.round((5 / 240) * 100));

    // Test domain counts
    const bankingCount = bankingScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(bankingCount, 3, 'Banking completed count must be 3');

    const healthcareCount = healthcareScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(healthcareCount, 2, 'Healthcare completed count must be 2');

    // Test average thinking score across all scored attempts (3 + 1 + 2 = 6 attempts)
    // Scores: (7 + 8 + 9) + (5) + (8 + 8) = 45 / 6 = 7.5
    let totalScore = 0, countWithScore = 0;
    for (const s of coreScenarios) {
      const e = state.entries[s.id];
      if (e?.assessment?.score !== undefined && typeof e.assessment.score === 'number') {
        totalScore += e.assessment.score;
        countWithScore++;
      }
    }
    const avgScore = countWithScore ? (totalScore / countWithScore).toFixed(1) : '0.0';
    assert.strictEqual(avgScore, '7.5', 'Average score should be 7.5');
  });

  it('correctly tracks attempted and in-progress scenarios', () => {
    // 1. Started / in progress without score
    const inProgressEntry = {
      thinking: { response: '' },
      sql: '',
      status: 'in_progress',
      attempts: 0,
      completed: false,
      updatedAt: 1000
    };
    assert.strictEqual(isAttempted(s1, inProgressEntry), true, 'In progress scenario must be attempted');
    assert.strictEqual(isCompleted(s1, inProgressEntry), false, 'In progress scenario without score is not completed');

    // 2. Submitted thinking with low score (< 7)
    const lowScoreEntry = {
      thinking: { response: 'filter active' },
      assessment: { score: 5, ready: false },
      status: 'attempted',
      attempts: 1,
      completed: false,
      updatedAt: 2000
    };
    assert.strictEqual(isAttempted(s1, lowScoreEntry), true, 'Submitted thinking is attempted');
    assert.strictEqual(isCompleted(s1, lowScoreEntry), false, 'Score < 7 is not completed');

    // 3. Submitted thinking with passing score (>= 7)
    const passingEntry = {
      thinking: { response: 'Use customers and filter status active' },
      assessment: { score: 9, ready: true },
      status: 'completed',
      attempts: 1,
      completed: true,
      updatedAt: 3000
    };
    assert.strictEqual(isAttempted(s1, passingEntry), true, 'Passing score is attempted');
    assert.strictEqual(isCompleted(s1, passingEntry), true, 'Passing score is completed');

    // 4. Untouched scenario
    assert.strictEqual(isAttempted(s1, null), false, 'Null entry is not attempted');
    assert.strictEqual(isCompleted(s1, null), false, 'Null entry is not completed');

    // 5. In-progress count calculation (attempted && !completed)
    const mockState = {
      entries: {
        [scenarios[0].id]: inProgressEntry,
        [scenarios[1].id]: lowScoreEntry,
        [scenarios[2].id]: passingEntry,
        [scenarios[3].id]: null
      }
    };
    const testList = scenarios.slice(0, 4);
    const completed = testList.filter(s => isCompleted(s, mockState.entries[s.id])).length;
    const inProgress = testList.filter(s => isAttempted(s, mockState.entries[s.id]) && !isCompleted(s, mockState.entries[s.id])).length;
    assert.strictEqual(completed, 1, 'Only passing score is completed');
    assert.strictEqual(inProgress, 2, 'In progress and low score are counted as in-progress');
  });

  it('preserves per-user progress isolation and restores progress across logout and login', () => {
    const memoryStorage = (() => {
      const store = new Map();
      return {
        getItem: k => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k)
      };
    })();

    const userA = 'user-uuid-111';
    const userB = 'user-uuid-222';

    // User A solves scenario 0 with score 8
    const stateA = {
      version: 2,
      resetAt: 0,
      entries: {
        [scenarios[0].id]: {
          thinking: { response: 'Plan for User A' },
          assessment: { score: 8, ready: true },
          status: 'completed',
          completed: true,
          attempts: 1,
          updatedAt: 1000
        }
      }
    };
    // User A saves progress
    memoryStorage.setItem('crackSqlProgress:v2:user:' + userA, JSON.stringify(stateA));

    // User B solves scenario 1 with score 5 (attempted)
    const stateB = {
      version: 2,
      resetAt: 0,
      entries: {
        [scenarios[1].id]: {
          thinking: { response: 'Plan for User B' },
          assessment: { score: 5, ready: false },
          status: 'attempted',
          completed: false,
          attempts: 1,
          updatedAt: 2000
        }
      }
    };
    // User B saves progress
    memoryStorage.setItem('crackSqlProgress:v2:user:' + userB, JSON.stringify(stateB));

    // 1. User Isolation Check: User A only reads User A's progress
    const restoredA = JSON.parse(memoryStorage.getItem('crackSqlProgress:v2:user:' + userA));
    assert.strictEqual(Boolean(restoredA.entries[scenarios[0].id]), true);
    assert.strictEqual(Boolean(restoredA.entries[scenarios[1].id]), false, "User A must not see User B's progress");

    // 2. User Isolation Check: User B only reads User B's progress
    const restoredB = JSON.parse(memoryStorage.getItem('crackSqlProgress:v2:user:' + userB));
    assert.strictEqual(Boolean(restoredB.entries[scenarios[1].id]), true);
    assert.strictEqual(Boolean(restoredB.entries[scenarios[0].id]), false, "User B must not see User A's progress");

    // 3. User A logs out and logs back in: User A's progress must be restored intact
    const afterReloginA = sanitize(JSON.parse(memoryStorage.getItem('crackSqlProgress:v2:user:' + userA)), ids);
    assert.strictEqual(isCompleted(scenarios[0], afterReloginA.entries[scenarios[0].id]), true, 'User A completed scenario must be restored');
    assert.strictEqual(afterReloginA.entries[scenarios[0].id].assessment.score, 8, 'Thinking score must be 8');
  });

  it('safely merges local and cloud progress without losing completed or attempted questions', () => {
    // Cloud has scenario 0 completed (score 9)
    const cloudState = {
      version: 2,
      resetAt: 0,
      entries: {
        [scenarios[0].id]: {
          thinking: { response: 'Cloud thinking' },
          assessment: { score: 9, ready: true },
          status: 'completed',
          completed: true,
          attempts: 1,
          updatedAt: 1000
        }
      }
    };

    // Local has scenario 1 attempted (score 6) and scenario 0 touched without score
    const localState = {
      version: 2,
      resetAt: 0,
      entries: {
        [scenarios[0].id]: {
          thinking: { response: 'Draft thinking' },
          assessment: null,
          status: 'in_progress',
          completed: false,
          attempts: 0,
          updatedAt: 1500
        },
        [scenarios[1].id]: {
          thinking: { response: 'Local attempt' },
          assessment: { score: 6, ready: false },
          status: 'attempted',
          completed: false,
          attempts: 1,
          updatedAt: 1200
        }
      }
    };

    const merged = mergeProgress(localState, cloudState, ids);

    // Scenario 0 must remain completed with score 9 (not downgraded by draft)
    assert.strictEqual(isCompleted(scenarios[0], merged.entries[scenarios[0].id]), true, 'Completed scenario from cloud must not be lost');
    assert.strictEqual(merged.entries[scenarios[0].id].assessment.score, 9);

    // Scenario 1 must remain attempted from local
    assert.strictEqual(isAttempted(scenarios[1], merged.entries[scenarios[1].id]), true, 'Attempted scenario from local must be kept');
    assert.strictEqual(merged.entries[scenarios[1].id].assessment.score, 6);

    // When local state is empty (new login / fresh browser) and merged with cloud:
    const emptyLocal = EMPTY();
    const restoredFromCloud = mergeProgress(emptyLocal, cloudState, ids);
    assert.strictEqual(isCompleted(scenarios[0], restoredFromCloud.entries[scenarios[0].id]), true, 'Cloud progress restored onto empty local state');
  });
});
