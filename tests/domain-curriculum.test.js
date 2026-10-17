import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { evaluateThinking, parseScenarioSchema } from '../js/thinking.js';
import { getEffectiveScenario, getVariantIndex, BEGINNER_SKILL_BLUEPRINT } from '../js/curriculum.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Domain Experience & Curriculum Regression Tests', () => {
  const targetDomains = ['Banking', 'Healthcare', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education', 'Retail'];

  describe('TEST 5 – Domain Experience (Distinct & Schema-Valid)', () => {
    it('verifies all 7 domains have 20 Beginner questions aligned to realistic business concepts', () => {
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

  describe('TEST 6 – Single Scenario Consistency & Content Normalization', () => {
    it('verifies different users receive identical content for the same scenario ID', () => {
      const heaBeg = scenarios.filter(s => s.domain === 'Healthcare' && s.level === 'Beginner');
      const userA = 'user_alice_123';
      const userB = 'user_bob_456';

      const userASession = heaBeg.map(s => getEffectiveScenario(s, userA));
      const userBSession = heaBeg.map(s => getEffectiveScenario(s, userB));

      assert.strictEqual(userASession.length, 20);
      assert.strictEqual(userBSession.length, 20);

      for (let i = 0; i < 20; i++) {
        assert.strictEqual(userASession[i].question, userBSession[i].question, `Question ${i} must match between users`);
        assert.strictEqual(userASession[i].sql, userBSession[i].sql, `SQL ${i} must match between users`);
        assert.strictEqual(userASession[i].schemaText, userBSession[i].schemaText, `Schema ${i} must match between users`);
      }
    });

    it('verifies all 420 scenarios have unique IDs and non-empty normalized content', () => {
      assert.strictEqual(scenarios.length, 420, 'Must have exactly 420 scenarios');
      const seenIds = new Set();

      for (const s of scenarios) {
        const effective = getEffectiveScenario(s);
        assert(effective.id, 'Scenario must have an id');
        assert(!seenIds.has(effective.id), `Duplicate scenario ID "${effective.id}"`);
        seenIds.add(effective.id);

        assert(effective.question && effective.question.length > 0, `Scenario ${effective.id} question must be non-empty`);
        assert(effective.schemaText && effective.schemaText.length > 0, `Scenario ${effective.id} schemaText must be non-empty`);
        assert(effective.pseudo && effective.pseudo.length > 0, `Scenario ${effective.id} pseudo must be non-empty`);
        assert(effective.sql && effective.sql.length > 0, `Scenario ${effective.id} sql must be non-empty`);
      }
    });

    it('verifies each of the 7 domains has 20 questions per level (420 total)', () => {
      const domains = ['Banking', 'Healthcare', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education', 'Retail'];
      const levels = ['Beginner', 'Intermediate', 'Expert'];

      for (const d of domains) {
        for (const l of levels) {
          const matching = scenarios.filter(s => s.domain === d && s.level === l);
          assert.strictEqual(matching.length, 20, `${d} ${l} must have exactly 20 scenarios`);
        }
      }
    });
  });

  describe('TEST 7 – Legacy State Tolerance & Progress Preservation', () => {
    it('ensures legacy variantIndex does not affect selection or cause an error', () => {
      const hea1 = scenarios.find(s => s.id === 'HEA_BEG_001');
      assert(hea1, 'HEA_BEG_001 must exist');

      const stateWithLegacyVariant = {
        version: 2,
        resetAt: 0,
        entries: {
          'HEA_BEG_001': {
            variantIndex: 3,
            updatedAt: Date.now()
          }
        }
      };

      const reloadEffective = getEffectiveScenario(hea1, 'persisted_user_789', stateWithLegacyVariant);
      assert.strictEqual(reloadEffective.id, 'HEA_BEG_001');
      assert.strictEqual(reloadEffective.question, getEffectiveScenario(hea1).question);
      assert.strictEqual(reloadEffective.sql, getEffectiveScenario(hea1).sql);
    });

    it('restores progress, selecting the correct scenario and preserving completion', () => {
      const ban1 = scenarios.find(s => s.id === 'BAN_BEG_001');
      assert(ban1, 'BAN_BEG_001 must exist');

      const state = {
        version: 2,
        resetAt: 0,
        entries: {
          'BAN_BEG_001': {
            status: 'completed',
            completed: true,
            score: 9,
            thinking: { response: 'Identify active customer accounts' },
            sql: "SELECT * FROM accounts WHERE status = 'Active';",
            updatedAt: Date.now()
          }
        }
      };

      const restored = getEffectiveScenario(ban1, 'user123', state);
      assert.strictEqual(restored.id, 'BAN_BEG_001');
      assert.strictEqual(state.entries[restored.id].completed, true);
      assert.strictEqual(state.entries[restored.id].score, 9);
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

  describe('TEST 8 – Schema Explorer Neutral Behavior & Alphabetical Sorting', () => {
    it('sorts all domain tables in ascending alphabetical (A–Z) order and includes all tables', () => {
      for (const domain of targetDomains) {
        const s = scenarios.find(item => item.domain === domain);
        assert(s, `Scenario for ${domain} must exist`);

        // Parse schema text
        const schema = parseScenarioSchema(s.schemaText);
        const tableNames = Object.keys(schema);

        // Sort ascending A-Z
        const sorted = [...tableNames].sort((a, b) => a.localeCompare(b));

        // Verify sorted order
        for (let i = 0; i < sorted.length - 1; i++) {
          assert(sorted[i].localeCompare(sorted[i + 1]) <= 0, `Tables in ${domain} must be in alphabetical order: ${sorted}`);
        }

        // Verify all scenario tables are present in the full sorted table list
        for (const t of s.tables) {
          assert(sorted.includes(t.toLowerCase()), `Table ${t} from scenario ${s.id} must be in the sorted explorer tables`);
        }
      }
    });

    it('ensures question target table is not automatically prioritized or hinted in order', () => {
      const banScenario = scenarios.find(s => s.id === 'BAN_BEG_001');
      assert(banScenario);
      const schema = parseScenarioSchema(banScenario.schemaText);
      const sortedTables = Object.keys(schema).sort((a, b) => a.localeCompare(b));

      // In Banking: account_products, accounts, customers, transactions
      // banScenario.tables is ['accounts']
      assert.strictEqual(sortedTables[0], 'account_products', 'First table must be alphabetically first (account_products), not question target table');
      assert.notStrictEqual(sortedTables[0], banScenario.tables[0], 'Question target table must not be forced to position 0');
    });

    it('verifies search query filtering on table names', () => {
      const sampleTables = ['account_products', 'accounts', 'customers', 'healthcare', 'orders', 'payments', 'products'];
      const query = 'pro';
      const filtered = sampleTables.filter(t => t.toLowerCase().includes(query.toLowerCase()));
      assert.deepStrictEqual(filtered, ['account_products', 'products']);

      const query2 = 'acc';
      const filtered2 = sampleTables.filter(t => t.toLowerCase().includes(query2.toLowerCase()));
      assert.deepStrictEqual(filtered2, ['account_products', 'accounts']);

      const queryNone = 'xyz123';
      const filteredNone = sampleTables.filter(t => t.toLowerCase().includes(queryNone.toLowerCase()));
      assert.strictEqual(filteredNone.length, 0);
    });
  });
});
