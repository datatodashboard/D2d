import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { stage, workFingerprint } from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenariosMap = new Map(data.scenarios.map(s => [s.id, s]));

describe('Admin Dashboard Progress Evaluation', () => {
  it('correctly maps scenarios and parses learner entries from learning_progress state', () => {
    assert(scenariosMap.size >= 420, 'Should load all 420 scenarios');

    const s1 = scenariosMap.get('HEA_BEG_001');
    assert(s1, 'HEA_BEG_001 should exist');

    // Verified entry
    const verifiedEntry = {
      thinking: { response: 'Use appointments and filter status Active.' },
      assessment: { score: 10, ready: true, fingerprint: 'use appointments and filter status active.' },
      sql: "SELECT * FROM appointments WHERE status = 'Active';",
      evaluationFingerprint: JSON.stringify(['use appointments and filter status active.', "SELECT * FROM appointments WHERE status = 'Active';"]),
      evaluationResult: { passed: true },
      updatedAt: 1700000000000
    };

    assert.strictEqual(stage(s1, verifiedEntry), 'verified', 'Should identify verified entry as verified');

    // Thinking in progress entry
    const thinkingEntry = {
      thinking: { response: 'Looking at data' },
      assessment: { score: 3, ready: false },
      updatedAt: 1700000001000
    };
    assert.strictEqual(stage(s1, thinkingEntry), 'thinking', 'Should identify thinking stage');

    // Unattempted scenario
    assert.strictEqual(stage(s1, null), 'not_started', 'Should identify unattempted as not_started');
  });

  it('correctly distinguishes solved vs attempted scenarios and computes top domains', () => {
    const s1 = scenariosMap.get('HEA_BEG_001');
    const s2 = scenariosMap.get('BAN_BEG_001');
    const s3 = scenariosMap.get('INS_BEG_001');

    const mockLearningState = {
      version: 2,
      resetAt: 0,
      entries: {
        'HEA_BEG_001': {
          thinking: { response: 'appointments Active' },
          assessment: { score: 10, ready: true, fingerprint: 'appointments active' },
          sql: "SELECT * FROM appointments WHERE status = 'Active';",
          evaluationFingerprint: JSON.stringify(['appointments active', "SELECT * FROM appointments WHERE status = 'Active';"]),
          evaluationResult: { passed: true },
          evaluationAt: 1700000000000,
          updatedAt: 1700000000000
        },
        'BAN_BEG_001': {
          thinking: { response: 'Use accounts and filter status Active.' },
          assessment: { score: 10, ready: true, fingerprint: 'use accounts and filter status active.' },
          sql: "SELECT * FROM accounts WHERE status = 'Active';",
          evaluationFingerprint: JSON.stringify(['use accounts and filter status active.', "SELECT * FROM accounts WHERE status = 'Active';"]),
          evaluationResult: { passed: true },
          evaluationAt: 1700000005000,
          updatedAt: 1700000005000
        },
        'INS_BEG_001': {
          thinking: { response: 'Looking at policies' },
          sql: '',
          attempts: 1,
          updatedAt: 1700000010000
        }
      }
    };

    let solvedCount = 0;
    let attemptedCount = 0;
    const domainSolved = {};
    const domainAttempted = {};
    const solvedTimestamps = [];

    for (const [id, entry] of Object.entries(mockLearningState.entries)) {
      const scenario = scenariosMap.get(id);
      const domain = scenario?.domain || 'General SQL';
      const stg = stage(scenario, entry);

      const isSolved = (stg === 'verified');
      const isAttempted = isSolved ||
        ['thinking', 'thinking_ready', 'sql_written', 'fiddle_opened', 'answer_viewed'].includes(stg) ||
        (entry.attempts && entry.attempts > 0);

      if (isAttempted) {
        attemptedCount++;
        domainAttempted[domain] = (domainAttempted[domain] || 0) + 1;
      }
      if (isSolved) {
        solvedCount++;
        domainSolved[domain] = (domainSolved[domain] || 0) + 1;
        solvedTimestamps.push(entry.evaluationAt || entry.updatedAt);
      }
    }

    assert.strictEqual(solvedCount, 2, 'Should have exactly 2 solved scenarios');
    assert.strictEqual(attemptedCount, 3, 'Should have 3 attempted scenarios');
    assert.strictEqual(domainSolved['Healthcare'], 1);
    assert.strictEqual(domainSolved['Banking'], 1);
    assert.strictEqual(domainAttempted['Insurance'], 1);

    // Contest threshold calculation
    solvedTimestamps.sort((a, b) => a - b);
    const threshold = 2;
    const reachedAt = solvedCount >= threshold ? solvedTimestamps[threshold - 1] : null;
    assert.strictEqual(reachedAt, 1700000005000, 'Should accurately determine reachedAt timestamp for threshold');
  });

  it('handles empty progress state without crashing and preserves clean 0 metrics', () => {
    const emptyState = { version: 2, resetAt: 0, entries: {} };
    let solvedCount = 0;
    let attemptedCount = 0;

    for (const [id, entry] of Object.entries(emptyState.entries)) {
      const scenario = scenariosMap.get(id);
      const stg = stage(scenario, entry);
      if (stg === 'verified') solvedCount++;
      else if (stg !== 'not_started') attemptedCount++;
    }

    assert.strictEqual(solvedCount, 0);
    assert.strictEqual(attemptedCount, 0);
  });
});
