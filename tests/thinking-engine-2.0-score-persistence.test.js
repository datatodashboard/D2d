import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isCompleted, isAttempted, sanitize, EMPTY, chooseNext, mergeProgress, storageKey } from '../js/progress.js';
import { evaluateThinking } from '../js/thinking.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;
const ids = new Set(scenarios.map(s => s.id));

describe('Thinking Engine 2.0 — Score Persistence & Synchronization Acceptance Suite', () => {
  const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
  const q1 = bankingBeg[0]; // BAN_BEG_001
  const q2 = bankingBeg[1]; // BAN_BEG_002
  const q3 = bankingBeg[2]; // BAN_BEG_003

  it('Step 1 & 2: Complete Banking Beginner Question 1 and verify numerical score and feedback persist', () => {
    const thinkingInput = { response: 'From accounts table filter status equals Active and return the accounts' };
    const assessment = evaluateThinking(q1, thinkingInput);
    
    assert.ok(typeof assessment.score === 'number', 'Must calculate numerical score');
    assert.ok(assessment.score >= 7, 'Must pass threshold for valid reasoning');
    assert.ok(typeof assessment.message === 'string' && assessment.message.length > 0, 'Must have feedback message');

    const entry = {
      thinking: thinkingInput,
      score: assessment.score,
      thinkingScore: assessment.score,
      feedback: assessment.message,
      evaluation: assessment,
      assessment,
      completed: assessment.score >= 7,
      status: assessment.score >= 7 ? 'completed' : 'attempted',
      attempts: 1,
      variantIndex: 0,
      skill: q1.skill,
      updatedAt: 1000
    };

    const rawState = {
      version: 2,
      resetAt: 0,
      entries: { [q1.id]: entry }
    };

    const sanitized = sanitize(rawState, ids);
    const q1Sanitized = sanitized.entries[q1.id];

    assert.ok(q1Sanitized, 'Q1 entry must be preserved');
    assert.strictEqual(q1Sanitized.score, assessment.score, 'Top-level score must exist');
    assert.strictEqual(q1Sanitized.thinkingScore, assessment.score, 'Top-level thinkingScore must exist');
    assert.strictEqual(q1Sanitized.feedback, assessment.message, 'Top-level feedback must exist');
    assert.ok(q1Sanitized.evaluation, 'Top-level evaluation must exist');
    assert.strictEqual(q1Sanitized.completed, true, 'Completed flag must be true');
    assert.strictEqual(q1Sanitized.status, 'completed', 'Status must be completed');
    assert.strictEqual(isCompleted(q1, q1Sanitized), true, 'isCompleted must return true');
  });

  it('Step 3: Complete Question 2 and verify both records persist with scores', () => {
    const thinkingInput2 = { response: 'From accounts table check checking accounts with balance over 5000' };
    const assessment2 = evaluateThinking(q2, thinkingInput2);

    const rawState = {
      version: 2,
      resetAt: 0,
      entries: {
        [q1.id]: {
          thinking: { response: 'From accounts table filter status equals Active' },
          score: 8,
          thinkingScore: 8,
          feedback: 'Great thinking!',
          evaluation: { score: 8, message: 'Great thinking!' },
          assessment: { score: 8, message: 'Great thinking!' },
          completed: true,
          status: 'completed',
          updatedAt: 1000
        },
        [q2.id]: {
          thinking: thinkingInput2,
          score: assessment2.score,
          thinkingScore: assessment2.score,
          feedback: assessment2.message,
          evaluation: assessment2,
          assessment: assessment2,
          completed: true,
          status: 'completed',
          updatedAt: 1005
        }
      }
    };

    const sanitized = sanitize(rawState, ids);
    assert.strictEqual(sanitized.entries[q1.id].completed, true);
    assert.strictEqual(sanitized.entries[q1.id].score, 8);
    assert.strictEqual(sanitized.entries[q2.id].completed, true);
    assert.strictEqual(sanitized.entries[q2.id].score, assessment2.score);
  });

  it('Step 4 & 5: Sign out and sign back in -> restore scores and advance to Question 3', () => {
    const userAId = 'user-uuid-111';
    const mockStorage = new Map();

    // User A solves Q1 and Q2
    const userAState = {
      version: 2,
      resetAt: 0,
      entries: {
        [q1.id]: {
          thinking: { response: 'Accounts filter active' },
          score: 9,
          thinkingScore: 9,
          feedback: 'Excellent reasoning',
          assessment: { score: 9 },
          completed: true,
          status: 'completed',
          updatedAt: 1000
        },
        [q2.id]: {
          thinking: { response: 'Accounts filter checking' },
          score: 8,
          thinkingScore: 8,
          feedback: 'Well planned',
          assessment: { score: 8 },
          completed: true,
          status: 'completed',
          updatedAt: 1005
        }
      }
    };

    mockStorage.set(storageKey(userAId), JSON.stringify(userAState));

    // Sign out: in-memory state is emptied
    let activeState = EMPTY();
    assert.strictEqual(Object.keys(activeState.entries).length, 0, 'Active state reset on logout');

    // Sign back in as User A: hydrate from storage / cloud
    const loadedRaw = JSON.parse(mockStorage.get(storageKey(userAId)));
    activeState = sanitize(loadedRaw, ids);

    // Verify scores and completed status are restored
    assert.strictEqual(activeState.entries[q1.id].score, 9, 'Q1 score restored');
    assert.strictEqual(activeState.entries[q1.id].completed, true, 'Q1 completed restored');
    assert.strictEqual(activeState.entries[q2.id].score, 8, 'Q2 score restored');
    assert.strictEqual(activeState.entries[q2.id].completed, true, 'Q2 completed restored');

    // Verify next unsolved scenario is Question 3, NEVER Question 1
    const nextScenario = chooseNext(bankingBeg, activeState, null);
    assert.ok(nextScenario, 'Next scenario must be selected');
    assert.strictEqual(nextScenario.id, q3.id, 'Must select Question 3 (BAN_BEG_003)');
    assert.notStrictEqual(nextScenario.id, q1.id, 'Must NEVER return to Question 1');
  });

  it('Step 6 & 7: Refresh and Second Device Simulation', () => {
    const userAId = 'user-uuid-device-2';

    // Cloud has Q1 and Q2 completed
    const cloudSnapshot = {
      version: 2,
      resetAt: 0,
      entries: {
        [q1.id]: {
          thinking: { response: 'Valid reasoning' },
          score: 10,
          status: 'completed',
          completed: true,
          updatedAt: 2000
        },
        [q2.id]: {
          thinking: { response: 'Valid reasoning 2' },
          score: 8,
          status: 'completed',
          completed: true,
          updatedAt: 2005
        }
      }
    };

    // Device 2 starts with fresh empty local storage
    const device2InitialLocal = EMPTY();

    // Cloud hydration on device 2
    const device2Hydrated = mergeProgress(cloudSnapshot, device2InitialLocal, ids);

    assert.strictEqual(device2Hydrated.entries[q1.id].completed, true, 'Q1 completed on Device 2');
    assert.strictEqual(device2Hydrated.entries[q1.id].score, 10, 'Q1 score on Device 2');
    assert.strictEqual(device2Hydrated.entries[q2.id].completed, true, 'Q2 completed on Device 2');
    assert.strictEqual(device2Hydrated.entries[q2.id].score, 8, 'Q2 score on Device 2');

    // Device 2 picks Question 3
    const nextOnDevice2 = chooseNext(bankingBeg, device2Hydrated, null);
    assert.strictEqual(nextOnDevice2.id, q3.id, 'Device 2 resumes directly at Question 3');
  });

  it('Step 8: Existing progress for other users is unaffected and isolated', () => {
    const userAId = 'user-A';
    const userBId = 'user-B';

    const userAState = sanitize({
      version: 2,
      resetAt: 0,
      entries: {
        [q1.id]: { score: 9, completed: true, updatedAt: 1000 },
        [q2.id]: { score: 9, completed: true, updatedAt: 1005 }
      }
    }, ids);

    const userBState = sanitize({
      version: 2,
      resetAt: 0,
      entries: {
        [q1.id]: { score: 5, completed: false, status: 'attempted', updatedAt: 1002 }
      }
    }, ids);

    assert.strictEqual(isCompleted(q1, userAState.entries[q1.id]), true);
    assert.strictEqual(isCompleted(q1, userBState.entries[q1.id]), false);

    const userANext = chooseNext(bankingBeg, userAState, null);
    const userBNext = chooseNext(bankingBeg, userBState, null);

    assert.strictEqual(userANext.id, q3.id, 'User A is on Question 3');
    assert.strictEqual(userBNext.id, q1.id, 'User B remains on Question 1');
  });
});
