// Transparent, deterministic human thinking evaluation with dynamic schema validation.
export const RUBRIC_VERSION = 5;
const legacyFields = ['goal', 'sources', 'steps', 'check'];

// All known domain table names across the curriculum (Healthcare, Banking, Insurance, Capital Markets, Semiconductor, Education, Retail)
const ALL_CURRICULUM_TABLES = [
  'customers', 'account_products', 'accounts', 'transactions',
  'patients', 'doctors', 'appointments', 'visits',
  'insurance_products', 'policies', 'claims',
  'investors', 'securities', 'holdings', 'trades',
  'clients', 'chip_products', 'production_batches', 'test_results',
  'students', 'courses', 'enrollments', 'assessments',
  'products', 'orders', 'order_items'
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'data', 'dataset', 'records', 'rows', 'columns',
  'details', 'result', 'results', 'output', 'information', 'here', 'where', 'each',
  'all', 'only', 'both', 'table', 'tables', 'scratch', 'above', 'below', 'it', 'them',
  'my', 'our', 'what', 'which', 'to', 'for', 'with', 'by', 'as', 'and', 'or', 'in', 'on',
  'filter', 'select', 'need', 'want', 'should', 'have', 'from', 'into', 'join', 'like', 'keep', 'using'
]);

export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1').replaceAll('_', ' ').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
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

function extractMentionedTables(normText, schemaTableNames) {
  const found = new Set();
  const allCandidateTables = new Set([...ALL_CURRICULUM_TABLES, ...schemaTableNames]);

  // 1. Direct table matches (singular and plural)
  for (const t of allCandidateTables) {
    const tNorm = t.toLowerCase().replaceAll('_', ' ');
    const tSingular = tNorm.endsWith('s') ? tNorm.slice(0, -1) : tNorm;

    if (tNorm === 'orders' || tSingular === 'order') {
      if (/\b(?:orders?\s+table|from\s+orders?|orders?\s+dataset)\b/i.test(normText)) {
        found.add('orders');
      }
      continue;
    }

    const re = new RegExp('\\b(' + tNorm + '|' + tSingular + ')(?:s)?\\b', 'i');
    if (re.test(normText)) {
      found.add(t.toLowerCase());
    }
  }

  // 2. Syntactic patterns: 'from X', 'use X', 'X table', 'in X'
  const p1 = /\b(?:from|into|join|update|use|query|access|in)\s+(?:the\s+)?([a-z_][a-z0-9_]*)\b/gi;
  let m;
  while ((m = p1.exec(normText)) !== null) {
    const w = m[1].toLowerCase();
    if (!STOP_WORDS.has(w) && w.length > 2) found.add(w);
  }

  const p2 = /\b([a-z_][a-z0-9_]*)\s+(?:table|tables|dataset|entity|entities)\b/gi;
  while ((m = p2.exec(normText)) !== null) {
    const w = m[1].toLowerCase();
    if (!STOP_WORDS.has(w) && w.length > 2) found.add(w);
  }

  return [...found];
}

function extractMentionedColumns(normText, allSchemaColumns) {
  const mentioned = new Set();
  const wrong = new Set();

  // Pattern 1: [where|filter by] [the] <col> [is|=|equals|equal]
  const p1 = /\b(?:where|filter(?:ed)?\s+by|condition|having|with)\s+(?:the\s+)?([a-z_]+(?:\s+[a-z_]+)?)\s+(?:is|=|equals|equal|like|in|between|>|<)\b/gi;
  let m;
  while ((m = p1.exec(normText)) !== null) {
    const col = m[1].trim();
    if (!STOP_WORDS.has(col)) {
      if (allSchemaColumns.has(col) || allSchemaColumns.has(col.replaceAll(' ', '_'))) {
        mentioned.add(col.replaceAll(' ', '_'));
      } else {
        wrong.add(col);
      }
    }
  }

  // Pattern 2: <col> [column|field]
  const p2 = /\b([a-z_]+(?:\s+[a-z_]+)?)\s+(?:column|field)\b/gi;
  while ((m = p2.exec(normText)) !== null) {
    const col = m[1].trim();
    if (!STOP_WORDS.has(col)) {
      if (allSchemaColumns.has(col) || allSchemaColumns.has(col.replaceAll(' ', '_'))) {
        mentioned.add(col.replaceAll(' ', '_'));
      } else {
        wrong.add(col);
      }
    }
  }

  // Pattern 3: Specific cross-domain / invalid column patterns like 'account status'
  if (/\baccount\s+status\b|\baccount_status\b/i.test(normText)) {
    if (!allSchemaColumns.has('account status') && !allSchemaColumns.has('account_status')) {
      wrong.add('account status');
    }
  }

  // Pattern 4: Direct schema column presence
  allSchemaColumns.forEach(c => {
    const re = new RegExp('\\b' + c + '\\b', 'i');
    if (re.test(normText)) {
      if (!wrong.has('account status') || c !== 'status') {
        mentioned.add(c.replaceAll(' ', '_'));
      }
    }
  });

  return { mentioned: [...mentioned], wrong: [...wrong] };
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

  const requiredTables = (scenario?.tables || []).map(t => t.toLowerCase());
  const requiredColumns = new Set();
  requiredTables.forEach(t => {
    (schemaTables[t] || []).forEach(c => {
      requiredColumns.add(c.toLowerCase());
      requiredColumns.add(c.toLowerCase().replaceAll('_', ' '));
    });
  });

  // Extract columns and values from scenario SQL
  const sqlColumns = new Set();
  const sqlValues = new Set();
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
        { category: 'data', name: 'Source Table', label: `Identify data source (e.g. ${requiredTables.join(', ') || 'table'})`, passed: false, weight: 0, max: 3 },
        { category: 'columns', name: 'Target Columns', label: 'Identify relevant column(s)', passed: false, weight: 0, max: 2 },
        { category: 'approach', name: 'Logic & Action', label: 'State the core action (e.g. filter, join, group, or calculate)', passed: false, weight: 0, max: 2 },
        { category: 'result', name: 'Scenario Objective', label: 'Describe the details or result to return', passed: false, weight: 0, max: 2 },
        { category: 'clarity', name: 'Logical Explanation', label: 'Explain your plan in simple English', passed: false, weight: 0, max: 1 }
      ],
      message: 'Explain your plan in simple English: which table to use, how to filter or combine the data, and what to display.'
    };
  }

  // 2. Extract Mentioned Tables and Classify
  const candidateTables = extractMentionedTables(normText, schemaTableNames);
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

  // 3. Extract Mentioned Columns and Classify
  const { mentioned: mentionedCols, wrong: explicitWrongColumns } = extractMentionedColumns(normText, allSchemaColumns);
  const hasWrongColumn = explicitWrongColumns.length > 0;

  // 4. Calculate Points (10 Points Model)

  // (A) 3 Points – Correct table/source identification
  let tablePts = 0;
  if (hasWrongTable) {
    tablePts = 0;
  } else if (correctTables.length >= requiredTables.length && requiredTables.length > 0) {
    tablePts = 3;
  } else if (correctTables.length > 0) {
    tablePts = 2;
  } else if (candidateTables.length === 0) {
    // Table not explicitly named, but no wrong table mentioned (implicit reference)
    const mentionsDataOrRecords = /\b(?:records?|data|rows?|appointments?|details?)\b/i.test(normText) ||
                                  (scenario?.rubric?.sources && matches(scenario.rubric.sources, rawText));
    tablePts = mentionsDataOrRecords ? 2 : 1;
  }

  // (B) 2 Points – Correct column(s)
  let colPts = 0;
  if (hasWrongColumn) {
    colPts = 0;
  } else {
    let colMatchesExpected = false;
    for (const c of mentionedCols) {
      if (sqlColumns.has(c) || requiredColumns.has(c)) {
        colMatchesExpected = true;
        break;
      }
    }

    let valueMentioned = false;
    for (const val of sqlValues) {
      if (new RegExp('\\b' + val + '\\b', 'i').test(normText)) {
        valueMentioned = true;
        break;
      }
    }

    if (colMatchesExpected || valueMentioned) {
      colPts = 2;
    } else if (sqlColumns.size === 0) {
      colPts = 2;
    } else {
      colPts = 1;
    }
  }

  // (C) 2 Points – Correct condition/filter/join/aggregation logic
  const isMultiTable = requiredTables.length > 1 || /JOIN\b/i.test(scenario?.sql || '');
  const isFiltered = /WHERE\b/i.test(scenario?.sql || '');
  const isAggregated = /GROUP BY|COUNT\(|SUM\(|AVG\(|MAX\(|MIN\(/i.test(scenario?.sql || '');
  const isSorted = /ORDER BY/i.test(scenario?.sql || '');

  const filterKeywords = ['filter', 'where', 'condition', 'keep', 'matching', 'only', 'specific', 'with', 'equals?', 'greater', 'less', 'between', 'active', 'inactive', 'status'];
  const joinKeywords = ['join', 'link', 'connect', 'combine', 'merge', 'match', 'both', 'two tables', 'together', 'on'];
  const aggKeywords = ['group', 'count', 'sum', 'total', 'average', 'avg', 'max', 'min', 'aggregate', 'calculate', 'summarize', 'number of'];
  const sortKeywords = ['sort', 'order', 'rank', 'top', 'highest', 'lowest', 'descending', 'ascending', 'first', 'limit'];

  let logicMatches = 0;
  let logicNeeded = 0;

  if (isMultiTable) {
    logicNeeded++;
    if (joinKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) logicMatches++;
  }
  if (isFiltered) {
    logicNeeded++;
    if (filterKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) logicMatches++;
  }
  if (isAggregated) {
    logicNeeded++;
    if (aggKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) logicMatches++;
  }
  if (isSorted) {
    logicNeeded++;
    if (sortKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText))) logicMatches++;
  }
  if (logicNeeded === 0) logicNeeded = 1;

  if (scenario?.rubric?.steps) {
    const rubricStepsPassed = scenario.rubric.steps.filter(step => matches(step, rawText)).length;
    if (rubricStepsPassed > 0) logicMatches = Math.max(logicMatches, rubricStepsPassed);
  }

  let logicPts = 0;
  if (logicMatches >= logicNeeded) logicPts = 2;
  else if (logicMatches > 0) logicPts = 1;

  // (D) 2 Points – Scenario Objective / Understanding
  const intentKeywords = ['get', 'find', 'show', 'display', 'return', 'list', 'select', 'extract', 'fetch', 'need', 'want', 'identify', 'calculate'];
  const hasIntent = intentKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(normText));

  const questionWords = normalize(scenario?.question || '').split(' ')
    .filter(w => !STOP_WORDS.has(w) && w.length > 3);
  const topicMatch = questionWords.some(w => normText.includes(w)) ||
                     (scenario?.rubric?.goal && matches(scenario.rubric.goal, rawText));

  let objPts = 0;
  if (hasIntent && topicMatch) objPts = 2;
  else if (hasIntent || topicMatch) objPts = 1;

  // (E) 1 Point – Clear Logical Explanation
  const wordCount = normText.split(/\s+/).filter(Boolean).length;
  const isOffTopic = !hasIntent && !topicMatch && logicMatches === 0 && correctTables.length === 0;
  const clarityPts = (wordCount >= 3 && !rawSql && !isOffTopic) ? 1 : 0;

  // 5. Total Raw Score and Enforce Schema Capping Rules
  let rawScore = tablePts + colPts + logicPts + objPts + clarityPts;

  if (hasWrongTable && hasWrongColumn) {
    rawScore = Math.min(rawScore, 4);
  } else if (hasWrongTable) {
    rawScore = Math.min(rawScore, 5);
  } else if (hasWrongColumn) {
    rawScore = Math.min(rawScore, 6);
  }

  const finalScore = Math.min(10, Math.max(0, rawScore));
  const ready = !rawSql && finalScore >= 7;

  // 6. Dynamic, Constructive Feedback Messages
  let feedback = '';
  if (explicitWrongSchemaTables.length > 0) {
    const wrong = explicitWrongSchemaTables[0];
    feedback = `Your filtering idea is on the right track, but \`${wrong}\` is not part of this scenario. Review the schema and identify the table containing the required data.`;
  } else if (explicitWrongScenarioTables.length > 0) {
    const wrong = explicitWrongScenarioTables[0];
    feedback = `Your reasoning mentions \`${wrong}\`, but this question requires data from the \`${requiredTables.join(', ')}\` table. Review which table holds the target records.`;
  } else if (explicitWrongColumns.length > 0) {
    feedback = `Check your column references: \`${explicitWrongColumns[0]}\` does not exist in the target schema.`;
  } else if (rawSql) {
    feedback = 'Explain your plan in simple words, or click "⚡ Click here to generate the proper SQL" below.';
  } else if (ready) {
    feedback = `✓ Great human intuition! Score: ${finalScore}/10. Click below to generate the proper SQL.`;
  } else {
    feedback = `Thinking score: ${finalScore}/10. Review how to think like a data engineer below, or click "⚡ Click here to generate the proper SQL".`;
  }

  const items = [
    {
      category: 'data',
      name: 'Source Table',
      label: explicitWrongSchemaTables.length > 0
        ? `Table \`${explicitWrongSchemaTables[0]}\` is not part of this schema. Required: ${requiredTables.join(', ')}`
        : explicitWrongScenarioTables.length > 0
        ? `Table \`${explicitWrongScenarioTables[0]}\` is not the target table for this question. Required: ${requiredTables.join(', ')}`
        : tablePts >= 2
        ? `Identified data source: ${correctTables.join(', ') || requiredTables.join(', ')}`
        : `Specify which table to use (e.g. ${requiredTables.join(', ')})`,
      passed: tablePts >= 2,
      weight: tablePts,
      max: 3
    },
    {
      category: 'columns',
      name: 'Target Columns',
      label: explicitWrongColumns.length > 0
        ? `Column \`${explicitWrongColumns[0]}\` does not exist in the referenced schema.`
        : colPts >= 2
        ? `Identified relevant columns / criteria: ${[...mentionedCols].join(', ') || 'status / target columns'}`
        : `Identify the relevant column(s) (e.g. ${[...sqlColumns].slice(0, 3).join(', ') || 'target attributes'})`,
      passed: colPts >= 2,
      weight: colPts,
      max: 2
    },
    {
      category: 'approach',
      name: 'Logic & Action',
      label: logicPts >= 2
        ? 'Identified required condition/filter/join/aggregation logic'
        : 'Describe the logic or action (e.g. filter, join, or aggregation)',
      passed: logicPts >= 2,
      weight: logicPts,
      max: 2
    },
    {
      category: 'result',
      name: 'Scenario Objective',
      label: objPts >= 2
        ? 'Clear understanding of the business objective'
        : 'State what data or details to retrieve for the business goal',
      passed: objPts >= 2,
      weight: objPts,
      max: 2
    },
    {
      category: 'clarity',
      name: 'Logical Explanation',
      label: clarityPts >= 1
        ? 'Clear and coherent logical explanation'
        : 'Provide a coherent explanation in simple English without raw SQL',
      passed: clarityPts >= 1,
      weight: clarityPts,
      max: 1
    }
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
  return assessment.ready || (entry.assessment?.score >= 7);
}
