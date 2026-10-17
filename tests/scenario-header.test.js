import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getEffectiveScenario } from '../js/curriculum.js';
import { evaluateThinking } from '../js/thinking.js';

// Execute the actual rendering function with lightweight DOM/service doubles.
const source = fs.readFileSync('js/app.js', 'utf8');
const renderSource = source.slice(source.indexOf('function getPracticeQuestionPresentation('), source.indexOf('\nlet authoritativeCompletedCount'));

function harness(scenarios) {
  const nodes = new Map();
  const context = vm.createContext({
    scenarios, current: null, user: null, state: { entries: {} },
    getEffectiveScenario, evaluateThinking,
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
      assert.equal(nodes.get('title').textContent, `${scenario.domain} ${scenario.level} Question ${scenario.questionNo}`);
      assert.equal(nodes.get('scenarioId').textContent, `(${scenario.id})`);
      assert.equal((nodes.get('question').textContent + nodes.get('thinkingInstruction').textContent).trim(), (scenario.question || scenario.business_scenario).trim());
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
    sql: 'SELECT DISTINCT category FROM account_products;', completed: true, status: 'completed', attempts: 2,
    assessment: { score: 9 }, updatedAt: 12345 };
  context.state.entries[scenario.id] = structuredClone(saved);
  context.current = scenario;
  context.renderScenario();
  assert.deepEqual(context.state.entries[scenario.id], saved);
  assert.equal(nodes.get('title').textContent, 'Banking Beginner Question 6');
  assert.equal(nodes.get('scenarioId').textContent, '(BAN_BEG_006)');
  assert.equal(nodes.get('thinking').value, saved.thinking.response);
});

test('splits only recognized instructions and keeps all original text, including active variant wording', () => {
  const { context } = harness([]);
  const business = 'A bank manager is preparing a review of account products.\n\nPrepare a list of categories, once each, alphabetically. Include one empty entry last.\n\n';
  const instruction = 'How would you prepare this information? Explain your approach in your own words. You do not need to write SQL.';
  const scenario = { question: business + instruction, pseudo: 'DO NOT DISPLAY', sql: 'DO NOT DISPLAY' };
  const result = context.getPracticeQuestionPresentation(scenario);
  assert.equal(result.business, business);
  assert.equal(result.instruction, instruction);
  assert.equal(result.business + result.instruction, scenario.question);
  const variant = { question: 'Review healthcare records.\nDescribe your reasoning in your own words. No SQL is required.' };
  const selected = context.getPracticeQuestionPresentation(scenario, variant);
  assert.equal(selected.business + selected.instruction, variant.question);
  assert.equal(selected.business.trim(), 'Review healthcare records.');
  for (const question of ['An unfamiliar task. Explain how you would solve it.', instruction, 'Review records. Explain your approach in your own words. You do not need to write SQL. Also include missing values.']) {
    const fallback = context.getPracticeQuestionPresentation({ question });
    assert.equal(fallback.business, question);
    assert.equal(fallback.instruction, '');
  }
});

test('question takes priority over legacy text and answers, and stale instruction clears on navigation', () => {
  const { context, nodes } = harness([]);
  const base = { id: 'BAN_BEG_006', domain: 'Banking', level: 'Beginner', questionNo: 6,
    business_scenario: 'Wrong legacy text', pseudo: 'Wrong answer', sql: 'SELECT secret;' };
  context.current = { ...base, question: 'Review products.\nHow would you prepare this information? Explain your approach in your own words. You do not need to write SQL.' };
  context.renderScenario();
  assert.equal(nodes.get('thinkingInstructionCard').hidden, false);
  assert.equal(nodes.get('question').textContent.trim(), 'Review products.');
  context.current = { ...base, question: 'Full question without separable instruction.' };
  context.renderScenario();
  assert.equal(nodes.get('thinkingInstructionCard').hidden, true);
  assert.equal(nodes.get('thinkingInstruction').textContent, '');
  assert.equal(nodes.get('question').textContent, context.current.question);
  context.current.selectedVariant = { question: 'Selected variant question.' };
  context.renderScenario();
  assert.equal(nodes.get('question').textContent, 'Selected variant question.');
  assert.equal(nodes.get('scenarioId').textContent, '(BAN_BEG_006)');
});
