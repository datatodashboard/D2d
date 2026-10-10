// Thinking Engine 2.0 – Human-Like Business Reasoning Evaluation
export const RUBRIC_VERSION = 6;
export const PASS_THRESHOLD = 7;
const legacyFields = ['goal', 'sources', 'steps', 'check'];

// All known domain table names across the curriculum (Healthcare, Banking, Insurance, Capital Markets, Semiconductor, Education, Retail)
const ALL_CURRICULUM_TABLES = [
  'account_products', 'insurance_products', 'chip_products', 'production_batches', 'test_results', 'order_items',
  'customers', 'accounts', 'transactions',
  'patients', 'doctors', 'appointments', 'visits',
  'policies', 'claims',
  'investors', 'securities', 'holdings', 'trades',
  'clients',
  'students', 'courses', 'enrollments', 'assessments',
  'products', 'orders'
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'data', 'dataset', 'records', 'rows', 'columns',
  'details', 'result', 'results', 'output', 'information', 'here', 'where', 'each',
  'all', 'only', 'both', 'table', 'tables', 'scratch', 'above', 'below', 'it', 'them',
  'my', 'our', 'what', 'which', 'to', 'for', 'with', 'by', 'as', 'and', 'or', 'in', 'on',
  'filter', 'select', 'need', 'want', 'should', 'have', 'from', 'into', 'join', 'like', 'keep', 'using',
  'one', 'two', 'three', 'four', 'five', 'multiple', 'several', 'different', 'related', 'these', 'those', 'given', 'either', 'such', 'other', 'another', 'same',
  'having', 'group', 'order', 'limit', 'distinct', 'count', 'sum', 'avg', 'min', 'max',
  'case', 'when', 'then', 'else', 'end', 'cte', 'partition', 'over', 'lag', 'rank',
  'dense_rank', 'row_number', 'coalesce', 'nullif', 'round', 'date_trunc', 'exists', 'between',
  'null', 'not', 'desc', 'asc', 'any', 'window', 'windowed', 'descending', 'ascending',
  'required', 'target', 'appropriate', 'matching', 'main', 'source', 'primary', 'base', 'specific',
  'conditional', 'aggregated', 'aggregation', 'subquery', 'condition', 'conditions', 'clause'
]);

export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replaceAll('_', ' ')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function thinkingText(input) {
  if (typeof input === 'string') return input;
  if (input?.response) return String(input.response);
  return legacyFields.map(key => String(input?.[key] || '')).filter(Boolean).join('\n');
}

export function fingerprint(input) {
  return normalize(thinkingText(input));
}

function sentences(text) {
  return normalize(text).split(/[.!?;]\s+|\n+/).filter(Boolean);
}

function matches(criterion, text) {
  if (!criterion) return false;
  const whole = normalize(text);
  if (!whole) return false;
  if (criterion.forbidden?.some(p => new RegExp(p, 'i').test(whole))) return false;
  
  if (criterion.groups) {
    const matchesWhole = criterion.groups.every(pattern => new RegExp(pattern, 'i').test(whole));
    if (matchesWhole) return true;
    const allSentences = sentences(text);
    return allSentences.some(sentence => criterion.groups.every(pattern => new RegExp(pattern, 'i').test(sentence)));
  }
  return false;
}

export function parseScenarioSchema(schemaText) {
  const schemaTables = {};
  if (!schemaText) return schemaTables;
  const chunks = schemaText.split(';').map(s => s.trim()).filter(Boolean);
  chunks.forEach(chunk => {
    const m = chunk.match(/^(\w+)\((.*)\)$/);
    if (!m) return;
    const tname = m[1].toLowerCase();
    const cols = m[2].split(',').map(c => {
      const parts = c.trim().split(/\s+/);
      if (parts[parts.length - 1] === 'PK' || parts[parts.length - 1] === 'FK') parts.pop();
      return parts.join(' ').toLowerCase();
    }).filter(Boolean);
    schemaTables[tname] = cols;
  });
  return schemaTables;
}

function extractMentionedTables(normText, schemaTableNames, allSchemaColumns = new Set()) {
  const found = new Set();
  const allCandidateTables = new Set([...ALL_CURRICULUM_TABLES, ...schemaTableNames]);
  const sortedCandidates = [...allCandidateTables].sort((a, b) => b.length - a.length);

  let workingText = normText;
  allSchemaColumns.forEach(col => {
    const colSpace = col.toLowerCase().replaceAll('_', ' ');
    if (colSpace.includes(' ') || colSpace.endsWith(' id') || colSpace.endsWith(' date') || colSpace.endsWith(' type') || colSpace.endsWith(' name') || colSpace.endsWith(' cost') || colSpace.endsWith(' fee') || colSpace.endsWith(' total') || colSpace.endsWith(' amount') || colSpace.endsWith(' value') || colSpace.endsWith(' band')) {
      const re = new RegExp('\\b' + colSpace + '\\b', 'gi');
      workingText = workingText.replace(re, ' ');
    }
  });

  workingText = workingText.replace(/\b[a-z_]+\s+id\b/gi, ' ');

  for (const t of sortedCandidates) {
    const tNorm = t.toLowerCase().replaceAll('_', ' ');
    let tSingular;
    if (tNorm.endsWith('ies')) {
      tSingular = tNorm.slice(0, -3) + 'y';
    } else if (tNorm.endsWith('es') && (tNorm.endsWith('ches') || tNorm.endsWith('shes') || tNorm.endsWith('sses') || tNorm.endsWith('xes'))) {
      tSingular = tNorm.slice(0, -2);
    } else if (tNorm.endsWith('s')) {
      tSingular = tNorm.slice(0, -1);
    } else {
      tSingular = tNorm;
    }

    if (tNorm === 'orders' || tSingular === 'order') {
      if (/\b(?:orders?\s+tables?|from\s+orders?|orders?\s+dataset|in\s+orders?|join\s+(?:the\s+)?orders?|use\s+(?:the\s+)?orders?|orders\b(?!\s+(?:by|to|total|date|item)))\b/i.test(workingText)) {
        found.add('orders');
        workingText = workingText.replace(/\borders\b/gi, ' ');
      }
      continue;
    }

    const forms = new Set([tNorm, tSingular, t.toLowerCase()]);
    if (t === 'policies') { forms.add('policy'); forms.add('policyholder'); forms.add('policyholders'); }
    if (t === 'securities') { forms.add('security'); }
    if (t === 'production_batches') { forms.add('production batch'); forms.add('production batches'); forms.add('wafer batches'); forms.add('wafer batch'); forms.add('batches'); forms.add('batch'); }
    if (t === 'chip_products') { forms.add('chip product'); forms.add('chip products'); forms.add('chips'); forms.add('chip'); }
    if (t === 'account_products') { forms.add('account product'); forms.add('account products'); }
    if (t === 'insurance_products') { forms.add('insurance product'); forms.add('insurance products'); }
    if (t === 'order_items') { forms.add('order item'); forms.add('order items'); }
    if (t === 'test_results') { forms.add('test result'); forms.add('test results'); }

    for (const f of forms) {
      const re = new RegExp('\\b' + f + '(?:s)?\\b', 'i');
      if (re.test(workingText)) {
        found.add(t.toLowerCase());
        workingText = workingText.replace(new RegExp('\\b' + f + '(?:s)?\\b', 'gi'), ' ');
        break;
      }
    }
  }

  const p2 = /\b([a-z_][a-z0-9_]*)\s+(?:table|tables|dataset|datasets|entity|entities)\b/gi;
  let m;
  while ((m = p2.exec(workingText)) !== null) {
    const w = m[1].toLowerCase();
    if (!STOP_WORDS.has(w) && w.length > 2) found.add(w);
  }

  return [...found];
}

function extractMentionedColumns(normText, allSchemaColumns) {
  const mentioned = new Set();
  const wrong = new Set();

  function checkCol(col) {
    const colNorm = col.trim().replace(/^(?:and|or|the|a|an)\s+/i, '').toLowerCase();
    if (!colNorm || STOP_WORDS.has(colNorm)) return;
    const colUnderscore = colNorm.replaceAll(' ', '_');
    const colSingular = colNorm.endsWith('s') ? colNorm.slice(0, -1) : colNorm;
    const colSingularUnderscore = colSingular.replaceAll(' ', '_');
    const colStemmed = colNorm.replace(/ing\b/g, '').replace(/s\b/g, '').replaceAll(' ', '_');
    const colStemmedWithUnderscore = colNorm.replace(/ing\b/g, '').replace(/s\b/g, '').trim().replaceAll(' ', '_');

    if (allSchemaColumns.has(colNorm) || allSchemaColumns.has(colUnderscore)) {
      mentioned.add(colUnderscore);
    } else if (allSchemaColumns.has(colSingular) || allSchemaColumns.has(colSingularUnderscore)) {
      mentioned.add(colSingularUnderscore);
    } else if (allSchemaColumns.has(colStemmed) || allSchemaColumns.has(colStemmedWithUnderscore)) {
      mentioned.add(allSchemaColumns.has(colStemmed) ? colStemmed : colStemmedWithUnderscore);
    } else if (colNorm.includes('bill') && (allSchemaColumns.has('bill_amount') || allSchemaColumns.has('bill amount'))) {
      mentioned.add('bill_amount');
    } else if (colNorm.includes('cost') && (allSchemaColumns.has('batch_cost') || allSchemaColumns.has('batch cost'))) {
      mentioned.add('batch_cost');
    } else if (colNorm.includes('fee') && (allSchemaColumns.has('course_fee') || allSchemaColumns.has('course fee'))) {
      mentioned.add('course_fee');
    } else if (colNorm.includes('premium') && (allSchemaColumns.has('premium_amount') || allSchemaColumns.has('premium amount'))) {
      mentioned.add('premium_amount');
    } else if (colNorm.includes('market') && (allSchemaColumns.has('market_value') || allSchemaColumns.has('market value'))) {
      mentioned.add('market_value');
    } else if (colNorm.includes('total') && (allSchemaColumns.has('order_total') || allSchemaColumns.has('order total'))) {
      mentioned.add('order_total');
    } else if (colNorm.includes('balance') && allSchemaColumns.has('balance')) {
      mentioned.add('balance');
    } else {
      wrong.add(colNorm);
    }
  }

  const p1 = /\b(?:where|filter(?:ed)?\s+by|condition|having|with)\s+(?:the\s+)?([a-z_]+(?:\s+[a-z_]+)?)\s+(?:is|=|equals|equal|like|in|between|>|<)\b/gi;
  let m;
  while ((m = p1.exec(normText)) !== null) {
    checkCol(m[1]);
  }

  const p2 = /\b([a-z_]+(?:\s+[a-z_]+)?)\s+(?:column|field)\b/gi;
  while ((m = p2.exec(normText)) !== null) {
    checkCol(m[1]);
  }

  if (/\baccount\s+status\b|\baccount_status\b/i.test(normText)) {
    if (!allSchemaColumns.has('account status') && !allSchemaColumns.has('account_status')) {
      wrong.add('account status');
    }
  }

  allSchemaColumns.forEach(c => {
    const re = new RegExp('\\b' + c + '(?:s)?\\b', 'i');
    if (re.test(normText)) {
      if (!wrong.has('account status') || c !== 'status') {
        mentioned.add(c.replaceAll(' ', '_'));
      }
    }
  });

  return { mentioned: [...mentioned], wrong: [...wrong] };
}

// Thinking Engine 2.0 Critical Condition & Contradiction Detection
function detectCriticalContradictions(normText, scenarioSql) {
  if (!scenarioSql) return false;
  const sql = scenarioSql.toLowerCase();

  const isScenarioGreater = />/.test(sql) || /\b(?:greater|more|above|exceeds|higher)\b/i.test(sql);
  const isScenarioLess = /</.test(sql) || /\b(?:less|below|under|fewer|smaller)\b/i.test(sql);

  const isLearnerGreater = /\b(?:greater|more|above|exceeds|higher|top|over|after)\b/i.test(normText) && !/\bnot\s+greater\b/i.test(normText);
  const isLearnerLess = /\b(?:less|below|under|fewer|smaller|lower|before)\b/i.test(normText) && !/\bnot\s+less\b/i.test(normText);

  if (isScenarioGreater && isLearnerLess && !isLearnerGreater) {
    return true;
  }
  if (isScenarioLess && isLearnerGreater && !isLearnerLess) {
    return true;
  }

  return false;
}

export function evaluateThinking(scenario, input) {
  const rawText = thinkingText(input);
  const normText = normalize(rawText);
  const rawSql = /(?:^|\n|```(?:sql)?\s*)\s*(?:select\b[^;]*\bfrom\b|with\s+\w+\s+as\s*\()/im.test(rawText);

  // 1. Dynamic Schema & Scenario Metadata Extraction
  const schemaTables = parseScenarioSchema(scenario?.schemaText || '');
  const schemaTableNames = Object.keys(schemaTables);
  const allSchemaColumns = new Set();
  Object.values(schemaTables).forEach(cols => cols.forEach(c => {
    allSchemaColumns.add(c.toLowerCase());
    allSchemaColumns.add(c.toLowerCase().replaceAll('_', ' '));
  }));

  const requiredTables = (scenario?.requiredTables || scenario?.tables || []).map(t => t.toLowerCase());
  const requiredColumns = new Set();
  requiredTables.forEach(t => {
    (schemaTables[t] || []).forEach(c => {
      requiredColumns.add(c.toLowerCase());
      requiredColumns.add(c.toLowerCase().replaceAll('_', ' '));
    });
  });

  const sqlColumns = new Set();
  const sqlValues = new Set();
  if (Array.isArray(scenario?.relevantColumns)) {
    scenario.relevantColumns.forEach(c => {
      const colNorm = c.toLowerCase().replaceAll(' ', '_');
      sqlColumns.add(colNorm);
      requiredColumns.add(c.toLowerCase());
      requiredColumns.add(colNorm);
    });
  }
  if (scenario?.sql) {
    const valMatches = scenario.sql.match(/'([^']+)'/g);
    if (valMatches) valMatches.forEach(v => sqlValues.add(v.replace(/'/g, '').toLowerCase()));

    requiredColumns.forEach(col => {
      const colNorm = col.replaceAll(' ', '_');
      const re = new RegExp('\\b' + colNorm + '\\b', 'i');
      if (re.test(scenario.sql)) sqlColumns.add(colNorm);
    });
  }

  if (!normText || normText.length < 3) {
    return {
      version: RUBRIC_VERSION,
      score: 0,
      ready: false,
      fingerprint: fingerprint(input),
      items: [
        { category: 'data', name: 'Source Table', label: `Identify data source (e.g. ${requiredTables.join(', ') || 'table'})`, passed: false, weight: 0, max: 2 },
        { category: 'understanding', name: 'Business Understanding', label: 'Describe the business objective', passed: false, weight: 0, max: 2 },
        { category: 'conditions', name: 'Business Conditions', label: 'State relevant conditions or filters', passed: false, weight: 0, max: 3 },
        { category: 'approach', name: 'Solution Approach', label: 'State core actions (join, filter, or aggregate)', passed: false, weight: 0, max: 2 },
        { category: 'result', name: 'Expected Result', label: 'Describe what information to return', passed: false, weight: 0, max: 1 }
      ],
      message: 'Explain your business plan in simple English: which data to use, what conditions to apply, and what result to return.'
    };
  }

  // 2. Extract Mentioned Tables and Classify
  const candidateTables = extractMentionedTables(normText, schemaTableNames, allSchemaColumns);
  const explicitWrongSchemaTables = [];
  const explicitWrongScenarioTables = [];
  const correctTables = [];

  candidateTables.forEach(t => {
    if (!schemaTableNames.includes(t)) {
      explicitWrongSchemaTables.push(t);
    } else if (!requiredTables.includes(t)) {
      explicitWrongScenarioTables.push(t);
    } else {
      correctTables.push(t);
    }
  });

  const hasWrongTable = explicitWrongSchemaTables.length > 0 || explicitWrongScenarioTables.length > 0;
  const hasCriticalContradiction = detectCriticalContradictions(normText, scenario?.sql);

  // Check off-topic / unrelated reasoning (only if no known curriculum/schema tables mentioned and no intent)
  const intentKeywords = ['get', 'find', 'show', 'display', 'return', 'list', 'select', 'extract', 'fetch', 'need', 'want', 'identify', 'calculate'];
  const hasIntent = intentKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText));
  const isOffTopic = candidateTables.length === 0 && !hasIntent && !/\b(?:data|records|rows|table|columns|filter|join|group)\b/i.test(normText);

  if (isOffTopic) {
    return {
      version: RUBRIC_VERSION,
      score: 1,
      ready: false,
      fingerprint: fingerprint(input),
      items: [
        { category: 'data', name: 'Source Table', label: 'Identify correct data source and tables', passed: false, weight: 0, max: 2 },
        { category: 'understanding', name: 'Business Understanding', label: 'Understand business objective', passed: false, weight: 0, max: 2 },
        { category: 'conditions', name: 'Business Conditions', label: 'State relevant conditions and filters', passed: false, weight: 0, max: 3 },
        { category: 'approach', name: 'Solution Approach', label: 'Explain solution approach', passed: false, weight: 0, max: 2 },
        { category: 'result', name: 'Expected Result', label: 'Describe expected result', passed: false, weight: 0, max: 1 }
      ],
      message: 'Your reasoning does not appear related to the business scenario. Please describe which table to use and what conditions to apply.'
    };
  }

  // 3. Extract Mentioned Columns and Classify
  const { mentioned: mentionedCols, wrong: explicitWrongColumns } = extractMentionedColumns(normText, allSchemaColumns);
  const hasWrongColumn = explicitWrongColumns.length > 0;

  // 4. Thinking Engine 2.0 Rubric Scoring Breakdown (10 Marks Total)
  const isMultiTable = requiredTables.length > 1 || /JOIN\b/i.test(scenario?.sql || '');

  // (A) Data Identification (2 Marks)
  let dataPts = 0;
  if (hasWrongTable) {
    dataPts = 0;
  } else if (correctTables.length >= requiredTables.length && requiredTables.length > 0) {
    dataPts = 2;
  } else if (correctTables.length > 0) {
    dataPts = 2;
  } else {
    const mentionsDataOrRecords = /\b(?:records?|data|rows?|appointments?|details?|items?)\b/i.test(normText) ||
                                  (scenario?.rubric?.sources && matches(scenario.rubric.sources, rawText));
    dataPts = (!isMultiTable && mentionsDataOrRecords) ? 2 : 1;
  }

  // (B) Business Understanding (2 Marks)
  const questionWords = normalize(scenario?.question || '').split(' ')
    .filter(w => !STOP_WORDS.has(w) && w.length > 3);
  const topicMatch = questionWords.some(w => normText.includes(w)) ||
                     (scenario?.rubric?.goal && matches(scenario.rubric.goal, rawText));
  let understandingPts = (hasIntent && topicMatch) ? 2 : (hasIntent || topicMatch ? 1 : 1);

  // (C) Business Conditions (3 Marks)
  const isFiltered = /WHERE|HAVING\b/i.test(scenario?.sql || '');
  const filterKeywords = ['filter', 'where', 'having', 'condition', 'keep', 'matching', 'only', 'specific', 'with', 'equals', 'greater', 'less', 'between', 'active', 'inactive', 'status', 'above', 'below', 'more', 'over', 'under'];
  let filterMatches = filterKeywords.filter(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText)).length;
  
  let conditionsPts = 3;
  if (hasWrongColumn || hasCriticalContradiction) {
    conditionsPts = 1;
  } else if (isFiltered && filterMatches === 0 && scenario?.sql && !scenario.sql.includes('WHERE') && !scenario.sql.includes('HAVING')) {
    conditionsPts = 1;
  } else if (filterMatches >= 1 || !isFiltered) {
    conditionsPts = 3;
  } else {
    conditionsPts = 2;
  }

  // (D) Solution Approach (2 Marks)
  const isAggregated = /GROUP BY|COUNT\(|SUM\(|AVG\(|MAX\(|MIN\(/i.test(scenario?.sql || '');
  const isSorted = /ORDER BY/i.test(scenario?.sql || '');
  const joinKeywords = ['join', 'link', 'connect', 'combine', 'merge', 'match', 'both', 'together', 'on'];
  const aggKeywords = ['group', 'count', 'sum', 'total', 'average', 'avg', 'max', 'min', 'aggregate', 'calculate', 'summarize'];
  const sortKeywords = ['sort', 'order', 'rank', 'top', 'highest', 'lowest', 'descending', 'ascending', 'limit'];

  let approachMatches = 0;
  let approachNeeded = 0;
  if (isMultiTable) { approachNeeded++; if (joinKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) approachMatches++; }
  if (isAggregated) { approachNeeded++; if (aggKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) approachMatches++; }
  if (isSorted) { approachNeeded++; if (sortKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) approachMatches++; }
  if (!isMultiTable && !isAggregated && !isSorted) { approachNeeded = 1; approachMatches = 1; }
  if (approachNeeded === 0) approachNeeded = 1;

  let approachPts = (approachMatches >= approachNeeded || approachNeeded === 1) ? 2 : 1;

  // (E) Expected Result (1 Mark)
  const wordCount = normText.split(/\s+/).filter(Boolean).length;
  const resultPts = (wordCount >= 3 && !rawSql) ? 1 : 0;

  // 5. Total Raw Score & Contradiction / Schema Capping
  let rawScore = dataPts + understandingPts + conditionsPts + approachPts + resultPts;

  if (hasCriticalContradiction) {
    rawScore = Math.min(rawScore, 4);
  } else if (hasWrongTable && hasWrongColumn) {
    rawScore = Math.min(rawScore, 4);
  } else if (hasWrongTable || explicitWrongSchemaTables.length > 0) {
    rawScore = Math.min(rawScore, 5);
  } else if (hasWrongColumn) {
    rawScore = Math.min(rawScore, 6);
  }

  const finalScore = Math.min(10, Math.max(0, rawScore));
  const ready = !rawSql && finalScore >= PASS_THRESHOLD && !hasCriticalContradiction;

  // 6. Human-Like Trainer Feedback Generation
  let feedback = '';
  if (hasCriticalContradiction) {
    feedback = 'You have identified the relevant data, but your comparison does not match the business requirement. Review whether the requested values should be higher or lower.';
  } else if (explicitWrongSchemaTables.length > 0) {
    feedback = `Your reasoning is on the right track, but \`${explicitWrongSchemaTables[0]}\` is not part of this scenario. Review the schema and identify the table containing the required data.`;
  } else if (explicitWrongScenarioTables.length > 0) {
    feedback = `Your reasoning mentions \`${explicitWrongScenarioTables[0]}\`, but this question requires data from the \`${requiredTables.join(', ')}\` table. Review which table holds the target records.`;
  } else if (explicitWrongColumns.length > 0) {
    feedback = `Check your column references: \`${explicitWrongColumns[0]}\` does not exist in the target schema.`;
  } else if (rawSql) {
    feedback = 'Explain your plan in simple English: Table → What to do → Expected result.';
  } else if (ready) {
    if (finalScore === 10) {
      feedback = 'Excellent! You identified the correct data and business condition. Your approach will return the required results. Ready to write SQL!';
    } else {
      feedback = `✓ Great thinking! You scored ${finalScore}/10. Your business reasoning is solid and ready to write SQL.`;
    }
  } else {
    feedback = `Good start! You identified the correct data source. Think about which condition must be applied to get the required records. (Score: ${finalScore}/10)`;
  }

  const items = [
    { category: 'data', name: 'Data Identification', label: 'Identify correct data source and tables', passed: dataPts >= 2, weight: dataPts, max: 2 },
    { category: 'understanding', name: 'Business Understanding', label: 'Understand business objective', passed: understandingPts >= 1, weight: understandingPts, max: 2 },
    { category: 'conditions', name: 'Business Conditions', label: 'State relevant conditions and filters', passed: conditionsPts >= 2, weight: conditionsPts, max: 3 },
    { category: 'approach', name: 'Solution Approach', label: 'Explain solution approach', passed: approachPts >= 1, weight: approachPts, max: 2 },
    { category: 'result', name: 'Expected Result', label: 'Describe expected result', passed: resultPts >= 1, weight: resultPts, max: 1 }
  ];

  return {
    version: RUBRIC_VERSION,
    score: finalScore,
    ready,
    fingerprint: fingerprint(input),
    items,
    message: feedback
  };
}

export function thinkingIsReady(scenario, entry) {
  if (!entry?.thinking) return false;
  const assessment = evaluateThinking(scenario, entry.thinking);
  return assessment.ready || (entry.assessment?.score >= PASS_THRESHOLD);
}
