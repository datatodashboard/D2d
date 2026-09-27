import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { evaluateThinking, parseScenarioSchema } from '../js/thinking.js';
import { getEffectiveScenario, getVariantIndex, BEGINNER_SKILL_BLUEPRINT } from '../js/curriculum.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Domain Experience & Curriculum Regression Tests', () => {
  const targetDomains = ['Healthcare', 'Banking', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education'];

  describe('TEST 5 – Domain Experience (Distinct & Schema-Valid)', () => {
    it('verifies all 6 domains have 20 Beginner questions aligned to realistic business concepts', () => {
      for (const domain of targetDomains) {
        const domainBeg = scenarios.filter(s => s.domain === domain && s.level === 'Beginner');
        assert.strictEqual(domainBeg.length, 20, `${domain} must have exactly 20 Beginner scenarios`);

        const schema = parseScenarioSchema(domainBeg[0].schemaText);
        const schemaTableNames = Object.keys(schema);

        // Verify each question uses only tables in its schema
        domainBeg.forEach((s, idx) => {
          assert(s.tables.every(t => schemaTableNames.includes(t.toLowerCase())),
            `${s.id} references tables not in its domain schema: ${s.tables}`);
          assert(s.sql && s.sql.length > 5, `${s.id} must have valid reference SQL`);
          assert(s.skill, `${s.id} must have associated skill metadata`);
          assert(s.difficulty === 1, `${s.id} Beginner difficulty should be 1`);
        });
      }
    });

    it('verifies question 1 across domains uses distinct business narratives, not simple noun replacement', () => {
      const q1Map = {};
      for (const domain of targetDomains) {
        const s1 = scenarios.find(s => s.domain === domain && s.level === 'Beginner' && s.questionNo === 1);
        assert(s1, `Question 1 must exist for ${domain}`);
        q1Map[domain] = s1.question;
      }

      console.log('Question 1 across domains:\n', q1Map);

      // Verify questions are distinct and reflect domain topics
      assert.strictEqual(q1Map['Healthcare'], 'Return appointments with status Active.');
      assert(q1Map['Banking'].toLowerCase().includes('account') && q1Map['Banking'].toLowerCase().includes('interest'),
        'Banking should reflect deposit/account/interest business context');
      assert(q1Map['Insurance'].toLowerCase().includes('polic') && q1Map['Insurance'].toLowerCase().includes('coverage'),
        'Insurance should reflect policy/coverage business context');
      assert(q1Map['Capital Markets'].toLowerCase().includes('portfolio') || q1Map['Capital Markets'].toLowerCase().includes('holding'),
        'Capital Markets should reflect portfolio/holdings');
      assert(q1Map['Semiconductor'].toLowerCase().includes('wafer') || q1Map['Semiconductor'].toLowerCase().includes('fabrication'),
        'Semiconductor should reflect wafer fabrication');
      assert(q1Map['Education'].toLowerCase().includes('enrollment') || q1Map['Education'].toLowerCase().includes('semester'),
        'Education should reflect student enrollments');

      // Verify no two domains have identical question 1 text
      const allQ1 = Object.values(q1Map);
      const uniqueQ1 = new Set(allQ1);
      assert.strictEqual(uniqueQ1.size, allQ1.length, 'Every domain must have a distinct Question 1');
    });

    it('verifies Question 2 across domains has distinct business context', () => {
      const q2Map = {};
      for (const domain of targetDomains) {
        const s2 = scenarios.find(s => s.domain === domain && s.level === 'Beginner' && s.questionNo === 2);
        q2Map[domain] = s2.question;
      }
      const uniqueQ2 = new Set(Object.values(q2Map));
      assert.strictEqual(uniqueQ2.size, targetDomains.length, 'Question 2 must have distinct text across all domains');
    });
  });

  describe('TEST 6 – User Variation & Core Skill Blueprint Coverage', () => {
    it('provides scenario variants for different users while covering identical skills', () => {
      const heaBeg = scenarios.filter(s => s.domain === 'Healthcare' && s.level === 'Beginner');

      const userA = 'user_alice_123';
      const userB = 'user_bob_456';

      const userASession = heaBeg.map(s => getEffectiveScenario(s, userA));
      const userBSession = heaBeg.map(s => getEffectiveScenario(s, userB));

      assert.strictEqual(userASession.length, 20);
      assert.strictEqual(userBSession.length, 20);

      // Verify both sessions cover the exact same sequence of skills and difficulty
      for (let i = 0; i < 20; i++) {
        assert.strictEqual(userASession[i].skill, userBSession[i].skill,
          `Skill at index ${i} must match between users (${userASession[i].skill})`);
        assert.strictEqual(userASession[i].difficulty, userBSession[i].difficulty,
          `Difficulty at index ${i} must match`);

        // Both variants must be schema-valid
        assert(userASession[i].tables.length > 0);
        assert(userBSession[i].tables.length > 0);
      }

      // Verify that across the 20 questions, at least some variants differ between the two users
      const differentQuestions = userASession.filter((sA, idx) => sA.question !== userBSession[idx].question);
      assert(differentQuestions.length > 0,
        `Different users should receive distinct scenario variants (found ${differentQuestions.length} variations)`);
    });
  });

  describe('TEST 7 – Refresh Stability & Progress Persistence', () => {
    it('preserves the exact variant when a learner refreshes or reloads their session', () => {
      const hea1 = scenarios.find(s => s.id === 'HEA_BEG_001');
      assert(hea1, 'HEA_BEG_001 must exist');

      const userId = 'persisted_user_789';
      // First load (initial selection)
      const initialEffective = getEffectiveScenario(hea1, userId, null);

      // Simulate state where learner has drafted thinking/sql for this variant
      const state = {
        version: 2,
        resetAt: 0,
        entries: {
          'HEA_BEG_001': {
            variantIndex: initialEffective.variantIndex,
            thinking: { response: 'My draft thinking' },
            sql: 'SELECT * FROM appointments;',
            updatedAt: Date.now()
          }
        }
      };

      // Second load (simulating page reload / browser refresh)
      const reloadEffective = getEffectiveScenario(hea1, userId, state);

      assert.strictEqual(reloadEffective.variantIndex, initialEffective.variantIndex,
        'Reloaded variantIndex must match initial variantIndex');
      assert.strictEqual(reloadEffective.question, initialEffective.question,
        'Reloaded question must be identical');
      assert.strictEqual(reloadEffective.sql, initialEffective.sql,
        'Reloaded reference SQL must be identical');
    });

    it('respects explicitly saved variantIndex even if user ID changes or is guest', () => {
      const hea1 = scenarios.find(s => s.id === 'HEA_BEG_001');
      const stateWithExplicitVariant = {
        version: 2,
        resetAt: 0,
        entries: {
          'HEA_BEG_001': {
            variantIndex: 1, // Explicitly assigned variant 1
            updatedAt: Date.now()
          }
        }
      };

      const effective = getEffectiveScenario(hea1, 'different_user', stateWithExplicitVariant);
      assert.strictEqual(effective.variantIndex, 1, 'Must strictly respect saved state variantIndex');
    });
  });

  describe('TEST 1-4 – Schema Validation & Thinking Score on Canonical & Variants', () => {
    const hea1 = scenarios.find(s => s.id === 'HEA_BEG_001');

    it('TEST 1: caps score at <= 5 when learner mentions accounts for HEA_BEG_001', () => {
      const res = evaluateThinking(hea1, 'I need data from accounts and filter account status Active.');
      assert(res.score <= 5, `Expected score <= 5, got ${res.score}`);
      assert.strictEqual(res.ready, false);
      assert(res.message.includes('accounts'));
    });

    it('TEST 2: awards high score for correct natural reasoning', () => {
      const res = evaluateThinking(hea1, 'I would use the appointments data and keep only appointments that are currently active.');
      assert(res.score >= 8, `Expected high score >= 8, got ${res.score}`);
      assert.strictEqual(res.ready, true);
    });

    it('TEST 3: awards reasonable score for correct concept without explicit table name', () => {
      const res = evaluateThinking(hea1, 'I would filter the records based on their status and keep the active ones.');
      assert(res.score >= 7, `Expected reasonable score >= 7, got ${res.score}`);
      assert.strictEqual(res.ready, true);
    });

    it('TEST 4: awards low score for completely unrelated reasoning', () => {
      const res = evaluateThinking(hea1, 'I like to play basketball on sunny afternoons.');
      assert(res.score <= 2, `Expected low score <= 2, got ${res.score}`);
      assert.strictEqual(res.ready, false);
    });
  });
});
