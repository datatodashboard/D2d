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

  it('3. handles variants with variant-specific question and matching reference SQL', () => {
    const scenarioWithVariants = data.scenarios.find(s => s.variants && s.variants.length > 1);
    assert(scenarioWithVariants, 'Should find a scenario with variants');

    const v1 = scenarioWithVariants.variants[0];
    const v2 = scenarioWithVariants.variants[1];

    const effectiveV1 = { ...scenarioWithVariants, ...v1 };
    const effectiveV2 = { ...scenarioWithVariants, ...v2 };

    const pkgV1 = buildFiddlePracticePackage(effectiveV1, data.assets[effectiveV1.domain]);
    const pkgV2 = buildFiddlePracticePackage(effectiveV2, data.assets[effectiveV2.domain]);

    assert(pkgV1.includes(v1.sql), 'Package for variant 1 must include variant 1 SQL');
    assert(pkgV2.includes(v2.sql), 'Package for variant 2 must include variant 2 SQL');
    assert(pkgV1.includes(v1.question), 'Package for variant 1 must include variant 1 question');
    assert(pkgV2.includes(v2.question), 'Package for variant 2 must include variant 2 question');
  });

  it('4. packages execute successfully in PostgreSQL (PGlite) engine matching DB Fiddle', async () => {
    const sampleScenarios = [
      data.scenarios.find(s => s.domain === 'Banking' && s.level === 'Beginner'),
      data.scenarios.find(s => s.domain === 'Healthcare' && s.level === 'Intermediate'),
      data.scenarios.find(s => s.domain === 'Insurance' && s.level === 'Advanced'),
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

  it('5. validates all 420 scenarios and all variants have non-empty reference answers', () => {
    const missingAnswers = [];

    for (const s of data.scenarios) {
      if (!s.sql || typeof s.sql !== 'string' || !s.sql.trim()) {
        missingAnswers.push({ id: s.id, reason: 'missing scenario.sql' });
      }
      if (s.variants) {
        for (const v of s.variants) {
          if (!v.sql || typeof v.sql !== 'string' || !v.sql.trim()) {
            missingAnswers.push({ id: s.id, variantId: v.variantId, reason: 'missing variant.sql' });
          }
        }
      }
    }

    assert.strictEqual(
      missingAnswers.length,
      0,
      `All scenarios and variants must have validated reference SQL answers. Missing: ${JSON.stringify(missingAnswers)}`
    );
  });
});
