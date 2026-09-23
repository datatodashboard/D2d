import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { evaluateThinking } from '../js/thinking.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));

describe('Thinking Evaluation', () => {
  it('awards full pass to layman single-table filter explanation', () => {
    const single = data.scenarios.find(s => s.domain === 'Banking' && s.level === 'Beginner');
    assert(single, 'Scenario should exist');
    
    const userText = 'from the customers table, I have to use filter to get the detail';
    const result = evaluateThinking(single, userText);
    
    assert.strictEqual(result.ready, true, 'User should be marked ready');
    assert(result.score >= 7, `Score should be >= 7, got ${result.score}`);
  });

  it('awards full pass to layman multi-table join explanation', () => {
    const multi = data.scenarios.find(s => s.tables.length > 1);
    assert(multi, 'Multi-table scenario should exist');
    
    const userText = `join two tables and filter the data from ${multi.tables.join(' and ')} to show the result`;
    const result = evaluateThinking(multi, userText);
    
    assert.strictEqual(result.ready, true, 'Multi-table join should be marked ready');
    assert(result.score >= 7, `Score should be >= 7, got ${result.score}`);
  });

  it('all 4 core domains are present with 60 scenarios each', () => {
    const coreDomains = ['Banking', 'Healthcare', 'Insurance', 'Retail'];
    for (const domain of coreDomains) {
      const count = data.scenarios.filter(s => s.domain === domain).length;
      assert.strictEqual(count, 60, `Domain ${domain} should have 60 scenarios, found ${count}`);
    }
  });

  it('every scenario has schemaText, tables, and valid reference sql', () => {
    for (const s of data.scenarios) {
      assert(s.id, 'Scenario must have id');
      assert(s.schemaText && s.schemaText.length > 0, `${s.id} must have schemaText`);
      assert(s.tables && s.tables.length > 0, `${s.id} must have tables`);
      assert(s.sql && s.sql.length > 0, `${s.id} must have reference SQL`);
    }
  });
});
