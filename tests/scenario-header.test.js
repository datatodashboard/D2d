import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getEffectiveScenario } from '../js/curriculum.js';

// Execute the actual rendering function with lightweight DOM/service doubles.
const source = fs.readFileSync('js/app.js', 'utf8');
const renderSource = source.slice(source.indexOf('function renderScenario() {'), source.indexOf('\nlet authoritativeCompletedCount'));

function harness(scenarios) {
  const nodes = new Map();
  const context = vm.createContext({
    scenarios, current: null, user: null, state: { entries: {} },
    getEffectiveScenario,
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { add() {}, remove() {} } });
      return nodes.get(id);
    },
    nextTimestamp: () => 1, persist() {}, renderSchemaCards() {},
    setSchemaTab() {}, renderAssessment() {}, updateProgress() {}, updateGates() {},
    thinkingText: thinking => thinking.response || '', currentSampleTable: null,
  });
  context.entry = () => context.state.entries[context.current.id];
  vm.runInContext(renderSource, context);
  return { context, nodes };
}

for (const file of ['Crack_SQL_420_Simple.json', 'Crack_SQL_420_Student_Business_Scenarios.json', 'scenarios.json']) {
  test(`renders heading, exact ID and business question for all scenarios in ${file}`, () => {
    const data = JSON.parse(fs.readFileSync(`data/${file}`, 'utf8'));
    const scenarios = (Array.isArray(data) ? data : data.scenarios).map(s => ({
      ...s, questionNo: s.questionNo ?? Number(s.id.slice(-3)),
    }));
    const { context, nodes } = harness(scenarios);
    for (const scenario of scenarios) {
      context.current = scenario;
      context.renderScenario();
      assert.equal(nodes.get('title').textContent, `Business Scenario • ${scenario.id}`);
      assert.equal(nodes.get('question').textContent, (scenario.business_scenario || scenario.question).trim());
      assert.equal(nodes.get('qno').textContent, `Exercise ${scenario.questionNo} / 20`);
      assert.equal(context.state.entries[scenario.id].status, 'in_progress');
    }
  });
}

test('reopening a completed scenario preserves answers, score and completion', () => {
  const scenario = { id: 'BAN_BEG_006', domain: 'Banking', level: 'Beginner', questionNo: 6,
    business_scenario: 'List distinct account product categories available in the banking portfolio.' };
  const { context, nodes } = harness([scenario]);
  const saved = { thinking: { response: 'Use DISTINCT category from account_products' },
    sql: 'SELECT DISTINCT category FROM account_products;', completed: true, status: 'completed', attempts: 2 };
  context.state.entries[scenario.id] = structuredClone(saved);
  context.current = scenario;
  context.renderScenario();
  assert.deepEqual(context.state.entries[scenario.id], saved);
  assert.equal(nodes.get('title').textContent, 'Business Scenario • BAN_BEG_006');
  assert.equal(nodes.get('thinking').value, saved.thinking.response);
});
