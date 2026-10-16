import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { validateScenariosData, resolveCanonicalScenarioId } from '../js/curriculum.js';
import { isCompleted, sanitize, EMPTY, mergeProgress } from '../js/progress.js';

describe('Crack SQL 420 Scenarios & Progress System Verification', () => {
  const rawJson = fs.readFileSync('./data/Crack_SQL_420_Student_Business_Scenarios.json', 'utf8');
  const data = JSON.parse(rawJson);

  it('validates JSON loads exactly 420 canonical scenarios and 7 domains with 20 per domain/level', () => {
    assert.doesNotThrow(() => validateScenariosData(data));
    assert.strictEqual(data.scenarios.length, 420, 'Must have exactly 420 scenarios');
    assert(data.requiredDomains.includes('Retail'), 'requiredDomains must include Retail');

    const domains = ['Banking', 'Healthcare', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education', 'Retail'];
    const levels = ['Beginner', 'Intermediate', 'Expert'];

    for (const d of domains) {
      for (const l of levels) {
        const matching = data.scenarios.filter(s => s.domain === d && s.level === l);
        assert.strictEqual(matching.length, 20, `${d} ${l} must have exactly 20 scenarios`);
      }
    }
  });

  it('rejects malformed scenario data clearly in validateScenariosData', () => {
    const badData = { scenarios: [{ id: 'BAD_1' }] };
    assert.throws(() => validateScenariosData(badData), /Scenario validation failed/);
  });

  it('resolves every alias or variant to its canonical scenario ID without inflating progress', () => {
    assert.strictEqual(resolveCanonicalScenarioId('BAN_BEG_001_v1'), 'BAN_BEG_001');
    assert.strictEqual(resolveCanonicalScenarioId('BAN_BEG_001'), 'BAN_BEG_001');

    const aliases = { 'ALT_001': 'BAN_BEG_001' };
    assert.strictEqual(resolveCanonicalScenarioId('ALT_001', aliases), 'BAN_BEG_001');
  });

  it('ensures a new user sees 0/420 and 0/60 by domain', () => {
    const ids = new Set(data.scenarios.map(s => s.id));
    const state = sanitize(EMPTY(), ids);
    const completedCount = data.scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(completedCount, 0, 'New user completed count must be 0');

    const bankingScenarios = data.scenarios.filter(s => s.domain === 'Banking');
    const bankingCompleted = bankingScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    assert.strictEqual(bankingCompleted, 0, 'New user Banking completed count must be 0/60');
  });

  it('counts a canonical question once as completed even if retried or opened via variant/alias', () => {
    const ids = new Set(data.scenarios.map(s => s.id));
    const state = EMPTY();
    const sId = 'BAN_BEG_001';

    // First completion
    state.entries[sId] = {
      completed: true,
      status: 'completed',
      assessment: { score: 10 },
      updatedAt: 1000
    };

    // Retry / variant entry with alias key
    state.entries['BAN_BEG_001_v2'] = {
      completed: true,
      status: 'completed',
      assessment: { score: 9 },
      updatedAt: 2000
    };

    const sanitized = sanitize(state, ids);
    const completedList = data.scenarios.filter(s => isCompleted(s, sanitized.entries[s.id]));
    assert.strictEqual(completedList.length, 1, 'Canonical question must be counted exactly once');
    assert.strictEqual(sanitized.entries[sId].completed, true);
  });

  it('preserves existing progress and scores without overwriting on load or login sync', () => {
    const ids = new Set(data.scenarios.map(s => s.id));
    const localState = EMPTY();
    localState.entries['BAN_BEG_001'] = {
      completed: true,
      assessment: { score: 10 },
      updatedAt: 5000
    };

    const remoteState = EMPTY();
    // Older remote state
    remoteState.entries['BAN_BEG_001'] = {
      completed: false,
      assessment: { score: 4 },
      updatedAt: 1000
    };

    const merged = mergeProgress(localState, remoteState, ids);
    assert.strictEqual(isCompleted(null, merged.entries['BAN_BEG_001']), true, 'Newer completed progress must win over older remote state');
    assert.strictEqual(merged.entries['BAN_BEG_001'].assessment.score, 10);
  });
});
