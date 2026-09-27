import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isCompleted, isAttempted, sanitize, EMPTY, chooseNext } from '../js/progress.js';

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
});
