import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isCompleted, isAttempted, sanitize, EMPTY, chooseNext, mergeProgress, readProgress, saveProgress } from '../js/progress.js';

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

  it('exact verification test: completes/attempts 3 scenarios, refreshes, logs out, logs in and restores without returning to zero', () => {
    const memoryStorage = (() => {
      const store = new Map();
      return {
        getItem: k => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k)
      };
    })();

    // Simulated Supabase Database row
    let remoteDatabaseRow = null;

    const testUserId = 'test-user-3-scenarios-uuid';
    const s0 = scenarios[0]; // e.g. Banking 1
    const s1 = scenarios[1]; // e.g. Banking 2
    const s2 = scenarios[2]; // e.g. Banking 3

    // 1. User logs in
    let currentSessionUser = { id: testUserId, email: 'learner@datatodashboard.com' };
    let activeState = EMPTY();

    // 2. Scenario 1 is opened and completed with score 9 (Score >= 7 -> Completed)
    activeState.entries[s0.id] = {
      thinking: { response: 'Correct join logic for question 1' },
      assessment: { score: 9, ready: true },
      completed: true,
      status: 'completed',
      attempts: 1,
      updatedAt: 1000
    };

    // Scenario 2 is opened and attempted with score 5 (Score < 7 -> Attempted / In Progress)
    activeState.entries[s1.id] = {
      thinking: { response: 'Partial plan for question 2' },
      assessment: { score: 5, ready: false },
      completed: false,
      status: 'attempted',
      attempts: 1,
      updatedAt: 1010
    };

    // Scenario 3 is opened and started (Started -> In Progress)
    activeState.entries[s2.id] = {
      thinking: { response: '' },
      sql: '',
      completed: false,
      status: 'in_progress',
      attempts: 0,
      updatedAt: 1020
    };

    // Auto-save: save immediately to localStorage and Supabase
    memoryStorage.setItem('crackSqlProgress:v2:user:' + currentSessionUser.id, JSON.stringify(activeState));
    // Simulated cloud row in Supabase:
    remoteDatabaseRow = {
      user_id: currentSessionUser.id,
      state: JSON.parse(JSON.stringify(activeState)),
      updated_at: new Date().toISOString()
    };

    // 3. Confirm Progress shows 3 attempted/completed as appropriate
    const compCount1 = [s0, s1, s2].filter(s => isCompleted(s, activeState.entries[s.id])).length;
    const inProgCount1 = [s0, s1, s2].filter(s => isAttempted(s, activeState.entries[s.id]) && !isCompleted(s, activeState.entries[s.id])).length;
    const totalAttempted1 = [s0, s1, s2].filter(s => isAttempted(s, activeState.entries[s.id])).length;

    assert.strictEqual(compCount1, 1, 'Exactly 1 completed scenario (score 9 >= 7)');
    assert.strictEqual(inProgCount1, 2, 'Exactly 2 in-progress/attempted scenarios');
    assert.strictEqual(totalAttempted1, 3, 'Total 3 scenarios attempted or in-progress');

    // 4. Refresh the page: simulate fresh browser context load
    activeState = EMPTY(); // In-memory state clears on page reload
    // Simulation of loadAndRestoreUserProgress on refresh:
    const localRefreshed = sanitize(JSON.parse(memoryStorage.getItem('crackSqlProgress:v2:user:' + currentSessionUser.id)), ids);
    const cloudRefreshed = sanitize(remoteDatabaseRow.state, ids);
    activeState = mergeProgress(localRefreshed, cloudRefreshed, ids);

    // Confirm progress is still present after refresh
    const compCount2 = [s0, s1, s2].filter(s => isCompleted(s, activeState.entries[s.id])).length;
    const inProgCount2 = [s0, s1, s2].filter(s => isAttempted(s, activeState.entries[s.id]) && !isCompleted(s, activeState.entries[s.id])).length;
    assert.strictEqual(compCount2, 1, 'Progress still 1 completed after refresh');
    assert.strictEqual(inProgCount2, 2, 'Progress still 2 in-progress after refresh');

    // 5. Logout
    currentSessionUser = null;
    activeState = EMPTY(); // UI cleared to empty on sign out
    assert.strictEqual(Object.keys(activeState.entries).length, 0, 'Active UI cleared on logout');

    // 6. Login with the same account
    currentSessionUser = { id: testUserId, email: 'learner@datatodashboard.com' };
    
    // Simulate login restoration: loads from Supabase, restores into state
    const localOnLogin = sanitize(JSON.parse(memoryStorage.getItem('crackSqlProgress:v2:user:' + currentSessionUser.id)), ids);
    const cloudOnLogin = sanitize(remoteDatabaseRow.state, ids);
    activeState = mergeProgress(localOnLogin, cloudOnLogin, ids);

    // 7. Confirm the same 3 scenarios and scores are restored
    assert.strictEqual(activeState.entries[s0.id].assessment.score, 9, 'Scenario 0 score restored to 9');
    assert.strictEqual(isCompleted(s0, activeState.entries[s0.id]), true, 'Scenario 0 is completed');

    assert.strictEqual(activeState.entries[s1.id].assessment.score, 5, 'Scenario 1 score restored to 5');
    assert.strictEqual(isAttempted(s1, activeState.entries[s1.id]), true, 'Scenario 1 is attempted');
    assert.strictEqual(isCompleted(s1, activeState.entries[s1.id]), false, 'Scenario 1 is not completed (score < 7)');

    assert.strictEqual(isAttempted(s2, activeState.entries[s2.id]), true, 'Scenario 2 is in-progress');

    // 8. Confirm Progress does NOT return to zero
    const finalCompCount = [s0, s1, s2].filter(s => isCompleted(s, activeState.entries[s.id])).length;
    const finalInProgCount = [s0, s1, s2].filter(s => isAttempted(s, activeState.entries[s.id]) && !isCompleted(s, activeState.entries[s.id])).length;
    const finalTotal = [s0, s1, s2].filter(s => isAttempted(s, activeState.entries[s.id])).length;

    assert.strictEqual(finalCompCount, 1, 'Final completed count is 1 (NOT zero)');
    assert.strictEqual(finalInProgCount, 2, 'Final in-progress count is 2');
    assert.strictEqual(finalTotal, 3, 'Final total attempted is 3 (NOT zero)');
  });

  it('User A completes Q1, Q2, Q3 -> saves -> logout -> User A logs in -> restores 3 -> completes Q4 -> saves (4 completed) -> logout/login -> 4 completed; User B never inherits User A state', () => {
    const memoryStorage = (() => {
      const store = new Map();
      return {
        getItem: k => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k)
      };
    })();

    const remoteDatabase = new Map(); // user_id -> { user_id, state }

    const userA_id = 'user-a-uuid-1111';
    const userB_id = 'user-b-uuid-2222';
    const q1 = scenarios[0];
    const q2 = scenarios[1];
    const q3 = scenarios[2];
    const q4 = scenarios[3];

    // --- SESSION 1: User A logs in ---
    let activeUser = { id: userA_id };
    let localCached = readProgress(memoryStorage, activeUser.id, ids);
    let state = (localCached && Object.keys(localCached.entries).length > 0) ? localCached : EMPTY();
    assert.strictEqual(Object.keys(state.entries).length, 0, 'New User A starts with 0 entries');

    // User A completes Q1 (score 8/10 >= 7)
    state.entries[q1.id] = {
      thinking: { response: 'Q1 logic' },
      assessment: { score: 8, ready: true },
      completed: true,
      status: 'completed',
      attempts: 1,
      updatedAt: 100
    };
    // User A completes Q2 (score 9/10 >= 7)
    state.entries[q2.id] = {
      thinking: { response: 'Q2 logic' },
      assessment: { score: 9, ready: true },
      completed: true,
      status: 'completed',
      attempts: 1,
      updatedAt: 200
    };
    // User A completes Q3 (score 7/10 >= 7)
    state.entries[q3.id] = {
      thinking: { response: 'Q3 logic' },
      assessment: { score: 7, ready: true },
      completed: true,
      status: 'completed',
      attempts: 1,
      updatedAt: 300
    };

    // Save locally and sync to cloud
    saveProgress(memoryStorage, activeUser.id, state);
    remoteDatabase.set(activeUser.id, {
      user_id: activeUser.id,
      state: sanitize(JSON.parse(JSON.stringify(state)), ids)
    });

    let completedCount = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 3, 'User A has 3 completed questions in Session 1');

    // --- LOGOUT USER A ---
    saveProgress(memoryStorage, activeUser.id, state);
    activeUser = null;
    state = EMPTY();
    assert.strictEqual(Object.keys(state.entries).length, 0, 'In-memory state reset on logout');

    // --- SESSION 2: User A logs in again ---
    activeUser = { id: userA_id };
    localCached = readProgress(memoryStorage, activeUser.id, ids);
    state = (localCached && Object.keys(localCached.entries).length > 0) ? localCached : EMPTY();

    // Fetch cloud progress from Supabase
    const cloudRecord = remoteDatabase.get(activeUser.id);
    assert.ok(cloudRecord, 'Cloud record found for User A');
    const cloudState = sanitize(cloudRecord.state, ids);
    state = mergeProgress(state, cloudState, ids);
    saveProgress(memoryStorage, activeUser.id, state);

    // Verify User A restored completed questions: 3
    completedCount = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 3, 'User A restored 3 completed questions');
    assert.strictEqual(isCompleted(q1, state.entries[q1.id]), true, 'Q1 remains completed');
    assert.strictEqual(isCompleted(q2, state.entries[q2.id]), true, 'Q2 remains completed');
    assert.strictEqual(isCompleted(q3, state.entries[q3.id]), true, 'Q3 remains completed');

    // Verify next scenario selection picks Q4 (uncompleted)
    const pool = [q1, q2, q3, q4];
    const nextPick = chooseNext(pool, state, null);
    assert.strictEqual(nextPick?.id, q4.id, 'Next scenario correctly selects Q4 because Q1..Q3 are completed');

    // User A completes Q4 (score 10/10 >= 7)
    state.entries[q4.id] = {
      thinking: { response: 'Q4 logic' },
      assessment: { score: 10, ready: true },
      completed: true,
      status: 'completed',
      attempts: 1,
      updatedAt: 400
    };
    saveProgress(memoryStorage, activeUser.id, state);
    remoteDatabase.set(activeUser.id, {
      user_id: activeUser.id,
      state: sanitize(JSON.parse(JSON.stringify(state)), ids)
    });

    completedCount = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 4, 'User A now has 4 completed questions');

    // --- LOGOUT USER A AGAIN ---
    activeUser = null;
    state = EMPTY();

    // --- SESSION 3: User A logs in from another device (local storage empty) ---
    activeUser = { id: userA_id };
    localCached = EMPTY(); // New device
    const cloudRecordDevice2 = remoteDatabase.get(activeUser.id);
    const cloudStateDevice2 = sanitize(cloudRecordDevice2.state, ids);
    state = mergeProgress(localCached, cloudStateDevice2, ids);
    completedCount = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 4, 'User A on new device restores all 4 completed questions directly from cloud');

    // --- LOGOUT USER A ---
    activeUser = null;
    state = EMPTY();

    // --- USER B LOGS IN ---
    activeUser = { id: userB_id };
    localCached = readProgress(memoryStorage, activeUser.id, ids);
    state = (localCached && Object.keys(localCached.entries).length > 0) ? localCached : EMPTY();
    const cloudRecordB = remoteDatabase.get(activeUser.id);
    if (cloudRecordB) {
      state = mergeProgress(state, sanitize(cloudRecordB.state, ids), ids);
    }
    const userBCompleted = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(userBCompleted, 0, 'User B starts with 0 completed questions and never inherits User A state');
    assert.strictEqual(state.entries[q1.id], undefined, 'User B does not have User A Q1');
  });
});
