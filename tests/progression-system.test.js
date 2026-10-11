import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  ORDERED_DOMAINS,
  ORDERED_LEVELS,
  isDomainUnlocked,
  isDomainCompleted,
  isLevelUnlocked,
  isLevelCompleted,
  isLevelQuestionsCompleted,
  isLevelFeedbackSubmitted,
  getFirstUnlockedLevel,
  getNextProgressionTarget,
  checkLevelCompletion
} from '../js/certificate.js';
import { EMPTY, sanitize, mergeProgress } from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Level & Domain Unlocked System', () => {

  it('keeps all domains and levels unlocked by default', () => {
    const state = EMPTY();
    for (const dom of ORDERED_DOMAINS) {
      assert.strictEqual(isDomainUnlocked(dom, scenarios, state), true, `${dom} must be unlocked`);
      for (const lvl of ORDERED_LEVELS) {
        assert.strictEqual(isLevelUnlocked(dom, lvl, scenarios, state), true, `${dom} ${lvl} must be unlocked`);
      }
    }
  });

  it('preserves levelFeedback across sanitize and mergeProgress', () => {
    const raw = {
      version: 2,
      resetAt: 0,
      entries: {},
      levelFeedback: {
        'Banking_Beginner': { submittedAt: 12345, text: 'Awesome', emoji: 'Good Challenge' }
      }
    };

    const sanitized = sanitize(raw, new Set());
    assert.ok(sanitized.levelFeedback);
    assert.strictEqual(sanitized.levelFeedback['Banking_Beginner'].text, 'Awesome');

    const incoming = {
      version: 2,
      resetAt: 0,
      entries: {},
      levelFeedback: {
        'Banking_Intermediate': { submittedAt: 67890, text: 'Super', emoji: 'Hard but Fair' }
      }
    };

    const merged = mergeProgress(sanitized, incoming, new Set());
    assert.strictEqual(merged.levelFeedback['Banking_Beginner'].text, 'Awesome');
    assert.strictEqual(merged.levelFeedback['Banking_Intermediate'].text, 'Super');
  });
});
