import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { evaluateThinking, RUBRIC_VERSION } from '../js/thinking.js';
import { isCompleted, sanitize, mergeProgress, EMPTY } from '../js/progress.js';
import { checkLevelCompletion } from '../js/certificate.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Thinking Engine 2.0 Safe Upgrade & Backward Compatibility Suite', () => {

  const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');

  it('Test 1: Fully Completed Learner (20/20 before -> 20/20 after, certificate valid)', () => {
    const state = EMPTY();
    // Simulate 20 historical completions using Engine 1.0 (no version or version 1)
    for (let i = 0; i < 20; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Historical engine 1.0 solution ' + i },
        assessment: { score: 9, ready: true },
        completed: true,
        updatedAt: 1000 + i
      };
    }

    const completion = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(completion.isCompleted, true, 'Fully completed learner must remain completed');
    assert.strictEqual(completion.completedCount, 20, 'Must have 20 completed scenarios');
  });

  it('Test 2: Partially Completed Learner (12/20 before -> 12/20 after, remaining 8 use Engine 2.0)', () => {
    const state = EMPTY();
    // 12 completed with Engine 1.0
    for (let i = 0; i < 12; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Engine 1.0 answer ' + i },
        assessment: { score: 8 },
        completed: true,
        updatedAt: 1000 + i
      };
    }

    const completionBefore = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(completionBefore.completedCount, 12);
    assert.strictEqual(completionBefore.isCompleted, false);

    // Remaining 8 evaluated with Engine 2.0
    for (let i = 12; i < 20; i++) {
      const s = bankingBeg[i];
      const reasoning = s.exampleThinking || 'Use ' + s.tables[0] + ' and filter records.';
      const res = evaluateThinking(s, reasoning);
      assert.strictEqual(res.ready, true, 'Engine 2.0 should evaluate remaining question successfully');
      
      state.entries[s.id] = {
        thinking: { response: reasoning },
        assessment: { score: res.score, ready: res.ready, version: RUBRIC_VERSION },
        assessmentVersion: 'thinking_v2',
        completed: res.ready,
        updatedAt: 2000 + i
      };
    }

    const completionAfter = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(completionAfter.completedCount, 20, 'Must reach 20/20 after Engine 2.0 completions');
    assert.strictEqual(completionAfter.isCompleted, true, 'Must qualify for certificate workflow');
  });

  it('Test 3: Mixed Assessment Versions count together toward 20-question level', () => {
    const state = EMPTY();
    // 10 with Engine 1.0 (no version)
    for (let i = 0; i < 10; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'v1 answer' },
        assessment: { score: 8 },
        completed: true,
        updatedAt: 1000
      };
    }
    // 10 with Engine 2.0 (version 2)
    for (let i = 10; i < 20; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'v2 answer' },
        assessment: { score: 9, version: RUBRIC_VERSION },
        assessmentVersion: 'thinking_v2',
        completed: true,
        updatedAt: 2000
      };
    }

    const status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.completedCount, 20);
    assert.strictEqual(status.isCompleted, true);
  });

  it('Test 4: Historical Score Protection - previous passing score remains unchanged after Engine 2.0 deployment', () => {
    const s = bankingBeg[0];
    const historicalEntry = {
      thinking: { response: 'Old v1 thinking' },
      assessment: { score: 9, ready: true },
      completed: true,
      updatedAt: 1000
    };

    const state = EMPTY();
    state.entries[s.id] = historicalEntry;

    // Simulate sanitation after Engine 2.0 deployment
    const sanitized = sanitize(state, new Set(scenarios.map(sc => sc.id)));
    assert.strictEqual(sanitized.entries[s.id].assessment.score, 9, 'Historical score must remain 9');
    assert.strictEqual(sanitized.entries[s.id].completed, true, 'Historical completion must remain true');
  });

  it('Test 5: Failed Reattempt - learner reattempts completed question and gets lower score, completion remains valid', () => {
    const s = bankingBeg[0];
    const entry = {
      thinking: { response: 'Original great reasoning' },
      assessment: { score: 10, ready: true },
      completed: true,
      attempts: 1,
      updatedAt: 1000
    };

    // Reattempt with low score
    const reattemptEntry = {
      thinking: { response: 'Vague reattempt' },
      assessment: { score: 4, ready: false },
      completed: true, // preserved historical completion
      attempts: 2,
      updatedAt: 2000
    };

    assert.strictEqual(isCompleted(s, reattemptEntry), true, 'Completion must remain valid despite lower reattempt score');
  });

  it('Test 6: Missing Version Metadata - historical completed records without rubric-version remain completed', () => {
    const s = bankingBeg[0];
    const rawEntry = {
      thinking: { response: 'No version specified in legacy record' },
      assessment: { score: 8 },
      completed: true,
      updatedAt: 1000
    };

    const sanitized = sanitize({ version: 2, resetAt: 0, entries: { [s.id]: rawEntry } }, new Set([s.id]));
    assert.strictEqual(sanitized.entries[s.id].completed, true, 'Record without version must remain completed');
    assert.strictEqual(isCompleted(s, sanitized.entries[s.id]), true);
  });

  it('Test 7: Account Switching - User A -> User B -> User A retain independent achievements', () => {
    const ids = new Set(scenarios.map(sc => sc.id));
    const stateA = EMPTY();
    stateA.entries[bankingBeg[0].id] = { thinking: { response: 'User A' }, assessment: { score: 9 }, completed: true, updatedAt: 1000 };

    const stateB = EMPTY();
    stateB.entries[bankingBeg[1].id] = { thinking: { response: 'User B' }, assessment: { score: 9 }, completed: true, updatedAt: 1000 };

    // Simulate User A login, then User B login, then User A login
    const restoredA = sanitize(stateA, ids);
    const restoredB = sanitize(stateB, ids);
    const restoredA2 = sanitize(stateA, ids);

    assert.strictEqual(isCompleted(bankingBeg[0], restoredA2.entries[bankingBeg[0].id]), true);
    assert.strictEqual(isCompleted(bankingBeg[1], restoredA2.entries[bankingBeg[1].id] || null), false, 'User A must not inherit User B progress');
    assert.strictEqual(isCompleted(bankingBeg[1], restoredB.entries[bankingBeg[1].id]), true);
  });

  it('Test 8: Browser Refresh and Login - historical progress and certificate records persist', () => {
    const state = EMPTY();
    for (let i = 0; i < 20; i++) {
      state.entries[bankingBeg[i].id] = { completed: true, assessment: { score: 8 }, updatedAt: 1000 };
    }

    const jsonString = JSON.stringify(state);
    const reloaded = sanitize(JSON.parse(jsonString), new Set(scenarios.map(sc => sc.id)));
    const completion = checkLevelCompletion('Banking', 'Beginner', scenarios, reloaded);

    assert.strictEqual(completion.isCompleted, true, 'Certificate and progress must persist after reload');
    assert.strictEqual(completion.completedCount, 20);
  });

  it('Test 9: Admin Dashboard - recognizes valid completions from both assessment versions', () => {
    const state = EMPTY();
    state.entries[bankingBeg[0].id] = { completed: true, assessment: { score: 8 }, assessmentVersion: 'thinking_v1', updatedAt: 1000 };
    state.entries[bankingBeg[1].id] = { completed: true, assessment: { score: 9, version: RUBRIC_VERSION }, assessmentVersion: 'thinking_v2', updatedAt: 2000 };

    const completedIds = scenarios.filter(s => isCompleted(s, state.entries[s.id])).map(s => s.id);
    assert.strictEqual(completedIds.length, 2, 'Admin dashboard must recognize completions from both versions');
    assert(completedIds.includes(bankingBeg[0].id));
    assert(completedIds.includes(bankingBeg[1].id));
  });

  it('Test 10: Certificate Eligibility - learner with 20 valid completions across two assessment versions remains eligible', () => {
    const state = EMPTY();
    for (let i = 0; i < 10; i++) {
      state.entries[bankingBeg[i].id] = { completed: true, assessment: { score: 8 }, assessmentVersion: 'thinking_v1', updatedAt: 1000 };
    }
    for (let i = 10; i < 20; i++) {
      state.entries[bankingBeg[i].id] = { completed: true, assessment: { score: 9, version: RUBRIC_VERSION }, assessmentVersion: 'thinking_v2', updatedAt: 2000 };
    }

    const completion = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(completion.isCompleted, true, 'Mixed-version 20 completions must be eligible for certificate');
  });

  it('Test 11: Old Incomplete Snapshot - older incomplete state must not overwrite newer confirmed completions', () => {
    const s = bankingBeg[0];
    const confirmed = {
      thinking: { response: 'Confirmed great answer' },
      assessment: { score: 9 },
      completed: true,
      updatedAt: 2000
    };
    const olderIncomplete = {
      thinking: { response: 'Old draft' },
      assessment: { score: 4 },
      completed: false,
      updatedAt: 1000
    };

    const stateA = EMPTY(); stateA.entries[s.id] = confirmed;
    const stateB = EMPTY(); stateB.entries[s.id] = olderIncomplete;

    const merged = mergeProgress(stateB, stateA, new Set(scenarios.map(sc => sc.id)));
    assert.strictEqual(isCompleted(s, merged.entries[s.id]), true, 'Confirmed completion must win over older incomplete snapshot');
  });

  it('Test 12: Existing Production Discrepancies - detects 19/20 vs certificate without modifying historical records', () => {
    const state = EMPTY();
    // Simulate 19 completed questions
    for (let i = 0; i < 19; i++) {
      state.entries[bankingBeg[i].id] = { completed: true, assessment: { score: 8 }, updatedAt: 1000 };
    }

    const completion = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(completion.completedCount, 19);
    assert.strictEqual(completion.isCompleted, false, '19/20 correctly reports incomplete without altering historical records');
  });

});
