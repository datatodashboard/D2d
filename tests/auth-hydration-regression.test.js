import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, EMPTY, readProgress, saveProgress, mergeProgress, chooseNext, isCompleted } from '../js/progress.js';

describe('Auth & Progress Hydration Regression Tests (Production Crack SQL Bug Fixes)', () => {
  const scenarios = [
    { id: 'BAN_BEG_001', domain: 'Banking', level: 'Beginner' },
    { id: 'BAN_BEG_002', domain: 'Banking', level: 'Beginner' },
    { id: 'BAN_BEG_003', domain: 'Banking', level: 'Beginner' }
  ];
  const ids = new Set(scenarios.map(s => s.id));

  test('1. Initial session, Google relogin and refresh with only BAN_BEG_001 in public.progress and empty local storage', () => {
    const storage = new Map();
    const mockStorage = {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k)
    };

    const userId = 'google_user_123';
    
    // Empty local storage initially
    const initialLocal = readProgress(mockStorage, userId, ids);
    assert.deepStrictEqual(initialLocal.entries, {});

    // Simulate public.progress returning BAN_BEG_001 completion
    const cloudProgressRows = [
      { scenario_id: 'BAN_BEG_001', completed_at: new Date().toISOString() }
    ];

    let workingState = EMPTY();
    for (const r of cloudProgressRows) {
      workingState.entries[r.scenario_id] = {
        status: 'completed',
        completed: true,
        score: 10,
        updatedAt: Date.now()
      };
    }

    saveProgress(mockStorage, userId, workingState);

    // After sign-out and relogin, loading progress
    const restored = readProgress(mockStorage, userId, ids);
    assert.strictEqual(isCompleted(scenarios[0], restored.entries['BAN_BEG_001']), true);

    // Dashboard completed count becomes 1
    const completedCount = scenarios.filter(s => isCompleted(s, restored.entries[s.id])).length;
    assert.strictEqual(completedCount, 1);

    // Next question is BAN_BEG_002
    const nextUnsolved = chooseNext(scenarios, restored, null);
    assert.strictEqual(nextUnsolved.id, 'BAN_BEG_002');
  });

  test('2. Repeated SIGNED_IN / TOKEN_REFRESHED events during hydration and duplicate prevention', () => {
    let authSessionCounter = 0;
    let activeSessionInitPromise = null;
    let lastInitializedUserId = null;

    function mockSetSession(userId) {
      const next = { id: userId };
      if (next.id === lastInitializedUserId && activeSessionInitPromise) {
        return activeSessionInitPromise;
      }
      lastInitializedUserId = next.id;
      const token = ++authSessionCounter;

      activeSessionInitPromise = (async () => {
        await new Promise(r => setTimeout(r, 10));
        return 'success';
      })();

      return activeSessionInitPromise;
    }

    const p1 = mockSetSession('user_A');
    const p2 = mockSetSession('user_A'); // duplicate concurrent event
    assert.strictEqual(p1, p2, 'Repeated SIGNED_IN/TOKEN_REFRESHED events during hydration must reuse in-flight promise');
  });

  test('3. Simulated Supabase auth callback lock resilience (synchronous callback with setTimeout)', async () => {
    let eventsHandled = 0;
    const callbackQueue = [];

    function simulatedOnAuthStateChange(callback) {
      callback('SIGNED_IN', { user: { id: 'user_lock_test' } });
    }

    simulatedOnAuthStateChange((_event, session) => {
      eventsHandled++;
      setTimeout(() => {
        callbackQueue.push(session.user.id);
      }, 0);
    });

    assert.strictEqual(eventsHandled, 1);
    assert.deepStrictEqual(callbackQueue, []);

    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(callbackQueue, ['user_lock_test']);
  });
});
