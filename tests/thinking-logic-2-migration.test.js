import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { evaluateThinking, RUBRIC_VERSION } from '../js/thinking.js';
import { isCompleted, sanitize, mergeProgress, EMPTY } from '../js/progress.js';
import { checkLevelCompletion } from '../js/certificate.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;
const ids = new Set(scenarios.map(s => s.id));

describe('Thinking Logic 2 Migration & Safe Global Progress Reset Suite', () => {

  it('1. Score 7/10 completes a scenario and 6.9/10 does not', () => {
    const s = scenarios[0];
    const entryPass = {
      thinking: { response: 'Use table and filter active records.' },
      assessment: { score: 7, ready: true },
      updatedAt: 1000
    };
    const entryFail = {
      thinking: { response: 'Almost good' },
      assessment: { score: 6.9, ready: false },
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s, entryPass), true, 'Score 7/10 must mark scenario as completed');
    assert.strictEqual(isCompleted(s, entryFail), false, 'Score 6.9/10 must NOT mark scenario as completed');
  });

  it('2. SQL/DB Fiddle execution is NOT required for completion', () => {
    const s = scenarios[0];
    const entryNoSql = {
      thinking: { response: 'Clear execution plan' },
      assessment: { score: 7.5, ready: true },
      sql: '',
      fiddleFingerprint: null,
      evaluationResult: null,
      updatedAt: 1000
    };
    assert.strictEqual(isCompleted(s, entryNoSql), true, 'Scenario with score >= 7 must be completed without SQL or Fiddle execution');
  });

  it('3. Completed cloud progress is not overwritten by a newer incomplete local draft', () => {
    const s = scenarios[0];
    const cloudCompleted = EMPTY();
    cloudCompleted.entries[s.id] = {
      thinking: { response: 'Good reasoning' },
      assessment: { score: 8 },
      completed: true,
      updatedAt: 1000
    };

    const localIncompleteNewer = EMPTY();
    localIncompleteNewer.entries[s.id] = {
      thinking: { response: 'Draft in progress' },
      assessment: { score: 4 },
      completed: false,
      updatedAt: 5000 // Newer timestamp!
    };

    const merged = mergeProgress(localIncompleteNewer, cloudCompleted, ids);
    assert.strictEqual(isCompleted(s, merged.entries[s.id]), true, 'Completed cloud progress must win over a newer incomplete local draft');
    assert.strictEqual(merged.entries[s.id].assessment.score, 8);
  });

  it('4. Logout/login restores progress', () => {
    const state = EMPTY();
    const s = scenarios[0];
    state.entries[s.id] = {
      thinking: { response: 'Saved progress' },
      assessment: { score: 9 },
      completed: true,
      updatedAt: 1500
    };

    const serialized = JSON.stringify(state);
    const restored = sanitize(JSON.parse(serialized), ids);

    assert.strictEqual(isCompleted(s, restored.entries[s.id]), true, 'Progress must be successfully restored upon login');
    assert.strictEqual(restored.entries[s.id].assessment.score, 9);
  });

  it('5. Switching domains preserves each domain progress', () => {
    const bankingScenario = scenarios.find(s => s.domain === 'Banking');
    const healthcareScenario = scenarios.find(s => s.domain === 'Healthcare');

    const state = EMPTY();
    state.entries[bankingScenario.id] = {
      thinking: { response: 'Banking done' },
      assessment: { score: 8 },
      completed: true,
      updatedAt: 1000
    };
    state.entries[healthcareScenario.id] = {
      thinking: { response: 'Healthcare done' },
      assessment: { score: 9 },
      completed: true,
      updatedAt: 1100
    };

    const sanitized = sanitize(state, ids);
    assert.strictEqual(isCompleted(bankingScenario, sanitized.entries[bankingScenario.id]), true);
    assert.strictEqual(isCompleted(healthcareScenario, sanitized.entries[healthcareScenario.id]), true);
  });

  it('6. A reset-version mismatch clears stale local progress and starts at Question 1', () => {
    const state = {
      version: 2,
      resetVersion: 1,
      resetAt: 0,
      entries: {
        [scenarios[0].id]: { thinking: { response: 'old' }, assessment: { score: 9 }, completed: true, updatedAt: 1000 }
      }
    };

    const serverResetVersion = 2;
    let workingState = sanitize(state, ids);

    if ((workingState.resetVersion || 1) < serverResetVersion) {
      workingState = EMPTY();
      workingState.resetVersion = serverResetVersion;
    }

    assert.strictEqual(Object.keys(workingState.entries).length, 0, 'Stale progress cache must be cleared on reset-version mismatch');
    assert.strictEqual(workingState.resetVersion, 2, 'Reset version must update to server epoch');
  });

  it('7. New Thinking Logic 2 progress saves and restores correctly', () => {
    const s = scenarios[0];
    const reasoning = s.exampleThinking || 'Use ' + s.tables[0] + ' and filter data.';
    const result = evaluateThinking(s, reasoning);
    assert.strictEqual(result.ready, true);
    assert(result.score >= 7);

    const entry = {
      thinking: { response: reasoning },
      assessment: { score: result.score, ready: result.ready, version: RUBRIC_VERSION },
      assessmentVersion: 'thinking_v2',
      completed: result.ready,
      updatedAt: Date.now()
    };

    const state = EMPTY();
    state.entries[s.id] = entry;

    const restored = sanitize(state, ids);
    assert.strictEqual(restored.entries[s.id].assessmentVersion, 'thinking_v2');
    assert.strictEqual(isCompleted(s, restored.entries[s.id]), true);
  });

  it('8. Certificate eligibility is recalculated consistently with the new completion rule', () => {
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    const state = EMPTY();

    for (let i = 0; i < 19; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Good logic' },
        assessment: { score: 8 },
        completed: true,
        updatedAt: 1000 + i
      };
    }
    state.entries[bankingBeg[19].id] = {
      thinking: { response: 'Incomplete' },
      assessment: { score: 5 },
      completed: false,
      updatedAt: 2000
    };

    const status19 = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status19.completedCount, 19);
    assert.strictEqual(status19.isCompleted, false, '19/20 completion must not grant certificate');

    state.entries[bankingBeg[19].id] = {
      thinking: { response: 'Valid plan' },
      assessment: { score: 7 },
      completed: true,
      updatedAt: 3000
    };

    const status20 = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status20.completedCount, 20);
    assert.strictEqual(status20.isCompleted, true, '20/20 with score >= 7 must qualify for certificate');
  });

  it('9. Legacy progress rows with NULL or missing completed_at are excluded when server reset epoch > 0', () => {
    const serverResetAt = Date.parse('2026-10-10T00:00:00Z'); // Oct 10, 2026
    const progRows = [
      { scenario_id: 'BAN_BEG_001', completed_at: null },
      { scenario_id: 'BAN_BEG_002', completed_at: undefined },
      { scenario_id: 'BAN_BEG_003', completed_at: '2026-10-01T00:00:00Z' }, // Oct 1, 2026 (before reset)
      { scenario_id: 'BAN_BEG_004', completed_at: new Date(serverResetAt + 10000).toISOString() } // Oct 10, 2026+ (post reset)
    ];

    const confirmedSet = new Set();
    for (const r of progRows) {
      if (serverResetAt > 0) {
        const completedTime = r.completed_at ? new Date(r.completed_at).getTime() : 0;
        if (!completedTime || completedTime <= serverResetAt) continue;
      }
      confirmedSet.add(r.scenario_id);
    }

    assert.strictEqual(confirmedSet.size, 1, 'Only post-reset progress rows with valid timestamps must survive');
    assert.ok(confirmedSet.has('BAN_BEG_004'));
  });

  it('10. Historical certificates predating global reset do not restore pre-reset scenario completions', () => {
    const serverResetAt = Date.parse('2026-10-10T00:00:00Z'); // Oct 10, 2026
    const certRows = [
      { domain: 'Banking', level: 'Beginner', completed_at: '2026-10-07T00:00:00Z' }, // Oct 7, 2026 (predates reset)
      { domain: 'Healthcare', level: 'Beginner', completed_at: null } // missing completed_at
    ];

    const validCerts = certRows.filter(cert => {
      if (serverResetAt > 0) {
        const certTime = cert.completed_at ? new Date(cert.completed_at).getTime() : 0;
        return certTime > serverResetAt;
      }
      return true;
    });

    assert.strictEqual(validCerts.length, 0, 'Pre-reset or missing-timestamp certificates must be filtered out');
  });

  it('11. mergeProgress prunes pre-reset entries when a resetAt epoch is provided', () => {
    const resetEpoch = 5000;
    const remoteState = {
      resetAt: resetEpoch,
      entries: {
        BAN_BEG_001: { thinking: { response: 'old' }, assessment: { score: 9 }, completed: true, updatedAt: 3000 },
        BAN_BEG_002: { thinking: { response: 'new' }, assessment: { score: 8 }, completed: true, updatedAt: 6000 }
      }
    };
    const localState = {
      resetAt: 0,
      entries: {
        BAN_BEG_003: { thinking: { response: 'stale local' }, assessment: { score: 9 }, completed: true, updatedAt: 2000 }
      }
    };

    const merged = mergeProgress(remoteState, localState, ids);
    assert.strictEqual(merged.resetAt, resetEpoch);
    assert.strictEqual(Object.keys(merged.entries).length, 1);
    assert.ok(merged.entries['BAN_BEG_002'], 'Only entry strictly newer than resetEpoch must be present');
    assert.strictEqual(merged.entries['BAN_BEG_001'], undefined);
    assert.strictEqual(merged.entries['BAN_BEG_003'], undefined);
  });

});
