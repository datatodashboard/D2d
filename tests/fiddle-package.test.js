import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildFiddlePracticePackage } from '../js/schema.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));

describe('DB Fiddle Practice Package Preparation & Verification', () => {
  it('1. builds complete SQL practice package with schema, sample data, and reference answer', () => {
    const scenario = data.scenarios.find(s => s.id === 'BAN_BEG_001');
    const asset = data.assets[scenario.domain];

    const pkg = buildFiddlePracticePackage(scenario, asset);

    assert(typeof pkg === 'string' && pkg.length > 0, 'Package should be a non-empty string');
    assert(pkg.includes('CRACK SQL PRACTICE PACKAGE'), 'Package should have header');
    assert(pkg.includes('BAN_BEG_001'), 'Package should mention scenario ID');
    assert(pkg.includes('1. TABLE SCHEMA (CREATE TABLE STATEMENTS)'), 'Package should have schema section comment');
    assert(pkg.includes('2. SAMPLE DATA (INSERT STATEMENTS)'), 'Package should have sample data section comment');
    assert(pkg.includes('3. REFERENCE SQL QUERY (CORRECT ANSWER)'), 'Package should have reference answer section comment');
    assert(pkg.includes('CREATE TABLE accounts'), 'Package should contain CREATE TABLE statements');
    assert(pkg.includes('INSERT INTO accounts'), 'Package should contain INSERT statements');
    assert(pkg.includes(scenario.sql), 'Package should include the scenario reference query');
  });

  it('2. includes scenario-specific question and distinct reference SQL across domains', () => {
    const bankingScenario = data.scenarios.find(s => s.domain === 'Banking' && s.level === 'Beginner');
    const healthcareScenario = data.scenarios.find(s => s.domain === 'Healthcare' && s.level === 'Beginner');
    const retailScenario = data.scenarios.find(s => s.domain === 'Retail' && s.level === 'Beginner');

    const pkgBanking = buildFiddlePracticePackage(bankingScenario, data.assets.Banking);
    const pkgHealthcare = buildFiddlePracticePackage(healthcareScenario, data.assets.Healthcare);
    const pkgRetail = buildFiddlePracticePackage(retailScenario, data.assets.Retail);

    assert(pkgBanking.includes(bankingScenario.sql), 'Banking package should include Banking SQL answer');
    assert(pkgHealthcare.includes(healthcareScenario.sql), 'Healthcare package should include Healthcare SQL answer');
    assert(pkgRetail.includes(retailScenario.sql), 'Retail package should include Retail SQL answer');

    assert.notStrictEqual(bankingScenario.sql, healthcareScenario.sql, 'Answers should not be generic identical queries');
    assert.notStrictEqual(healthcareScenario.sql, retailScenario.sql, 'Answers should not be generic identical queries');
  });

  it('3. packages scenarios with scenario question and matching reference SQL', () => {
    const s1 = data.scenarios[0];
    const s2 = data.scenarios[1];

    const pkg1 = buildFiddlePracticePackage(s1, data.assets[s1.domain]);
    const pkg2 = buildFiddlePracticePackage(s2, data.assets[s2.domain]);

    assert(pkg1.includes(s1.sql || s1.answer_sql), 'Package 1 must include reference SQL');
    assert(pkg2.includes(s2.sql || s2.answer_sql), 'Package 2 must include reference SQL');
    assert(pkg1.includes(s1.question || s1.business_scenario), 'Package 1 must include question text');
    assert(pkg2.includes(s2.question || s2.business_scenario), 'Package 2 must include question text');
  });

  it('4. packages execute successfully in PostgreSQL (PGlite) engine matching DB Fiddle', async () => {
    const sampleScenarios = [
      data.scenarios.find(s => s.domain === 'Banking' && s.level === 'Beginner'),
      data.scenarios.find(s => s.domain === 'Healthcare' && s.level === 'Intermediate'),
      data.scenarios.find(s => s.domain === 'Insurance' && (s.level === 'Expert' || s.level === 'Advanced')),
      data.scenarios.find(s => s.domain === 'Capital Markets' && s.level === 'Beginner'),
      data.scenarios.find(s => s.domain === 'Education' && s.level === 'Intermediate')
    ].filter(Boolean);

    for (const scenario of sampleScenarios) {
      const asset = data.assets[scenario.domain];
      const pkg = buildFiddlePracticePackage(scenario, asset);

      const db = new PGlite();
      try {
        const res = await db.exec(pkg);
        assert(Array.isArray(res) && res.length > 0, `Package for ${scenario.id} should execute in PGlite`);
        const last = res[res.length - 1];
        assert(last && Array.isArray(last.rows), `Final query in package for ${scenario.id} should return rows`);
      } finally {
        await db.close();
      }
    }
  });

  it('5. validates all 420 scenarios have non-empty reference answers', () => {
    const missingAnswers = [];

    for (const s of data.scenarios) {
      const sql = s.answer_sql || s.sql;
      if (!sql || typeof sql !== 'string' || !sql.trim()) {
        missingAnswers.push({ id: s.id, reason: 'missing scenario.sql' });
      }
    }

    assert.strictEqual(
      missingAnswers.length,
      0,
      `All scenarios must have validated reference SQL answers. Missing: ${JSON.stringify(missingAnswers)}`
    );
  });
});
