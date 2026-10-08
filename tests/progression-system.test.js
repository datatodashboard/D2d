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

describe('Level Lock & Domain Progression System', () => {

  // 1. Initial State
  it('initially unlocks Beginner and locks Intermediate and Expert for Domain 1 (Banking)', () => {
    const state = EMPTY();
    assert.strictEqual(isDomainUnlocked('Banking', scenarios, state), true, 'Domain 1 must be unlocked initially');
    assert.strictEqual(isLevelUnlocked('Banking', 'Beginner', scenarios, state), true, 'Beginner must be unlocked');
    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), false, 'Intermediate must be locked initially');
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), false, 'Expert must be locked initially');
  });

  it('initially locks all subsequent domains (Healthcare, Insurance, Retail, etc.)', () => {
    const state = EMPTY();
    for (let i = 1; i < ORDERED_DOMAINS.length; i++) {
      const dom = ORDERED_DOMAINS[i];
      assert.strictEqual(isDomainUnlocked(dom, scenarios, state), false, `${dom} must be locked initially`);
      assert.strictEqual(isLevelUnlocked(dom, 'Beginner', scenarios, state), false, `${dom} Beginner must be locked while domain is locked`);
    }
  });

  // 2. Beginner Completion requires both 20 questions AND mandatory feedback
  it('does NOT unlock Intermediate if 20/20 questions completed but feedback is NOT submitted', () => {
    const state = EMPTY();
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    assert.strictEqual(bankingBeg.length, 20);

    // Complete all 20 questions
    for (const s of bankingBeg) {
      state.entries[s.id] = { completed: true, assessment: { score: 9 }, updatedAt: 1000 };
    }

    assert.strictEqual(isLevelQuestionsCompleted('Banking', 'Beginner', scenarios, state), true);
    assert.strictEqual(isLevelFeedbackSubmitted('Banking', 'Beginner', state), false);
    assert.strictEqual(isLevelCompleted('Banking', 'Beginner', scenarios, state), false, 'Level is NOT completed until feedback submitted');
    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), false, 'Intermediate must REMAIN LOCKED until feedback submitted');
  });

  it('unlocks Intermediate only after mandatory feedback is submitted for Beginner', () => {
    const state = EMPTY();
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');

    for (const s of bankingBeg) {
      state.entries[s.id] = { completed: true, assessment: { score: 9 }, updatedAt: 1000 };
    }

    // Submit feedback
    state.levelFeedback = {
      'Banking_Beginner': {
        submittedAt: Date.now(),
        text: 'Great fundamentals and clear scenarios!',
        emoji: 'Good Challenge'
      }
    };

    assert.strictEqual(isLevelFeedbackSubmitted('Banking', 'Beginner', state), true);
    assert.strictEqual(isLevelCompleted('Banking', 'Beginner', scenarios, state), true);
    assert.strictEqual(isLevelUnlocked('Banking', 'Intermediate', scenarios, state), true, 'Intermediate must UNLOCK after feedback submission');
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), false, 'Expert must still be locked');
  });

  // 3. Intermediate Completion unlocks Expert
  it('unlocks Expert only after 20 questions completed AND mandatory feedback submitted for Intermediate', () => {
    const state = EMPTY();
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    const bankingInt = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Intermediate');

    // Beginner completed + feedback
    for (const s of bankingBeg) {
      state.entries[s.id] = { completed: true, assessment: { score: 9 }, updatedAt: 1000 };
    }
    state.levelFeedback = {
      'Banking_Beginner': { submittedAt: Date.now(), text: 'Beginner feedback', emoji: 'Good Challenge' }
    };

    // Intermediate 20 questions completed
    for (const s of bankingInt) {
      state.entries[s.id] = { completed: true, assessment: { score: 8 }, updatedAt: 2000 };
    }

    // Before feedback: Expert is locked
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), false);

    // After feedback: Expert is unlocked
    state.levelFeedback['Banking_Intermediate'] = {
      submittedAt: Date.now(),
      text: 'Intermediate joins and aggregations were challenging!',
      emoji: 'Hard but Fair'
    };

    assert.strictEqual(isLevelCompleted('Banking', 'Intermediate', scenarios, state), true);
    assert.strictEqual(isLevelUnlocked('Banking', 'Expert', scenarios, state), true, 'Expert must be unlocked');
  });

  // 4. Expert Completion and Domain Progression
  it('completes Domain 1 and unlocks Domain 2 only after all 3 levels (Beginner, Intermediate, Expert) and feedbacks are complete', () => {
    const state = EMPTY();
    state.levelFeedback = {
      'Banking_Beginner': { submittedAt: 1000, text: 'Beg done', emoji: 'Good Challenge' },
      'Banking_Intermediate': { submittedAt: 2000, text: 'Int done', emoji: 'Good Challenge' }
    };

    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    const bankingInt = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Intermediate');
    const bankingExp = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Expert');

    for (const s of [...bankingBeg, ...bankingInt, ...bankingExp]) {
      state.entries[s.id] = { completed: true, assessment: { score: 8 }, updatedAt: 1500 };
    }

    // Expert questions done, but Expert feedback not yet submitted
    assert.strictEqual(isDomainCompleted('Banking', scenarios, state), false);
    assert.strictEqual(isDomainUnlocked('Healthcare', scenarios, state), false, 'Healthcare must remain locked');

    // Submit Expert feedback
    state.levelFeedback['Banking_Expert'] = {
      submittedAt: 3000,
      text: 'Window functions and complex analytics mastered!',
      emoji: 'Hard but Fair'
    };

    assert.strictEqual(isLevelCompleted('Banking', 'Expert', scenarios, state), true);
    assert.strictEqual(isDomainCompleted('Banking', scenarios, state), true, 'Banking must now be completed');

    // Domain 2 (Healthcare) is unlocked!
    assert.strictEqual(isDomainUnlocked('Healthcare', scenarios, state), true, 'Healthcare must now be unlocked');
    assert.strictEqual(isLevelUnlocked('Healthcare', 'Beginner', scenarios, state), true, 'Healthcare Beginner is unlocked');
    assert.strictEqual(isLevelUnlocked('Healthcare', 'Intermediate', scenarios, state), false, 'Healthcare Intermediate is locked');
    assert.strictEqual(isLevelUnlocked('Healthcare', 'Expert', scenarios, state), false, 'Healthcare Expert is locked');

    // Domain 3 (Insurance) remains locked
    assert.strictEqual(isDomainUnlocked('Insurance', scenarios, state), false, 'Insurance must remain locked until Healthcare complete');
  });

  // 5. Progression Targets
  it('returns correct progression target for each level', () => {
    const begTarget = getNextProgressionTarget('Banking', 'Beginner');
    assert.strictEqual(begTarget.nextLevel, 'Intermediate');

    const intTarget = getNextProgressionTarget('Banking', 'Intermediate');
    assert.strictEqual(intTarget.nextLevel, 'Expert');

    const expTarget = getNextProgressionTarget('Banking', 'Expert');
    assert.strictEqual(expTarget.type, 'domain');
    assert.strictEqual(expTarget.nextDomain, 'Healthcare');
    assert.strictEqual(expTarget.nextLevel, 'Beginner');
  });

  // 6. Persistence across sanitize and mergeProgress
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
