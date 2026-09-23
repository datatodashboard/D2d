// Transparent, intuitive human thinking evaluation.
export const RUBRIC_VERSION = 4;
const legacyFields = ['goal', 'sources', 'steps', 'check'];

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

export function evaluateThinking(scenario, input) {
  const response = thinkingText(input);
  const text = normalize(response);
  const rawSql = /(?:^|\n|```(?:sql)?\s*)\s*(?:select\b[^;]*\bfrom\b|with\s+\w+\s+as\s*\()/im.test(response);
  
  if (!text) {
    return {
      version: RUBRIC_VERSION,
      score: 0,
      ready: false,
      fingerprint: fingerprint(input),
      items: [
        { category: 'data', name: 'Source Table', label: `Identify data source (e.g. ${(scenario.tables || []).join(', ') || 'table'})`, passed: false, weight: 3 },
        { category: 'approach', name: 'Logic & Action', label: 'State the core action (e.g. filter, join, group, or calculate)', passed: false, weight: 4 },
        { category: 'result', name: 'Expected Result', label: 'Describe the details or result to return', passed: false, weight: 3 }
      ],
      message: 'Explain your plan in simple English: which table to use, how to filter or combine the data, and what to display.'
    };
  }

  // 1. Data Source Detection (3 pts)
  const tables = (scenario.tables || []).map(t => normalize(t));
  const tableKeywords = ['table', 'tables', 'dataset', 'data', 'entity', 'entities', ...tables];
  tables.forEach(t => {
    if (t.endsWith('s')) tableKeywords.push(t.slice(0, -1));
  });
  const sourcePassed = tableKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text)) ||
                       (scenario.rubric?.sources && matches(scenario.rubric.sources, response));

  // 2. Core Operation & Logic (4 pts)
  const isMultiTable = (scenario.tables || []).length > 1 || /JOIN\b/i.test(scenario.sql || '');
  const isFiltered = /WHERE\b/i.test(scenario.sql || '');
  const isAggregated = /GROUP BY|COUNT\(|SUM\(|AVG\(|MAX\(|MIN\(/i.test(scenario.sql || '');
  const isSorted = /ORDER BY|RANK\(\)|DENSE_RANK\(\)/i.test(scenario.sql || '');

  const filterKeywords = ['filter', 'where', 'condition', 'keep', 'matching', 'only', 'specific', 'with', 'equals?', 'greater', 'less', 'between', 'active', 'inactive', 'status'];
  const joinKeywords = ['join', 'link', 'connect', 'combine', 'merge', 'match', 'both', 'two tables', 'together', 'on'];
  const aggKeywords = ['group', 'count', 'sum', 'total', 'average', 'avg', 'max', 'min', 'aggregate', 'calculate', 'summarize', 'number of'];
  const sortKeywords = ['sort', 'order', 'rank', 'top', 'highest', 'lowest', 'descending', 'ascending', 'first', 'limit'];

  let opHits = 0;
  let opNeeded = 0;

  if (isMultiTable) {
    opNeeded++;
    if (joinKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) opHits++;
  }
  if (isFiltered) {
    opNeeded++;
    if (filterKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) opHits++;
  }
  if (isAggregated) {
    opNeeded++;
    if (aggKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) opHits++;
  }
  if (isSorted) {
    opNeeded++;
    if (sortKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) opHits++;
  }
  if (opNeeded === 0) opNeeded = 1;

  // General operations fallback
  const anyOp = ['filter', 'where', 'get', 'check', 'extract', 'select', 'find', 'calculate', 'keep', 'use', 'join', 'group', 'sort', 'condition'].some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text));
  if (opHits === 0 && anyOp) opHits = 1;

  // Also check scenario rubric steps if provided
  if (scenario.rubric?.steps) {
    const rubricStepsPassed = scenario.rubric.steps.filter(step => matches(step, response)).length;
    if (rubricStepsPassed > 0) opHits = Math.max(opHits, rubricStepsPassed);
  }

  const opRatio = Math.min(1, opHits / opNeeded);
  const opPassed = opHits > 0;
  const opWeight = opHits >= opNeeded ? 4 : (opHits > 0 ? 3 : 0);

  // 3. Expected Result / Intent (3 pts)
  const intentKeywords = ['get', 'find', 'show', 'display', 'return', 'list', 'select', 'extract', 'fetch', 'detail', 'details', 'result', 'results', 'information', 'info', 'output', 'rows', 'records', 'columns'];
  const intentPassed = intentKeywords.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text)) ||
                       (scenario.rubric?.goal && matches(scenario.rubric.goal, response));

  const items = [
    {
      category: 'data',
      name: 'Source Table',
      label: sourcePassed ? `Identified data source: ${tables.join(', ') || 'table'}` : `Specify which table to use (e.g. ${tables.join(', ')})`,
      passed: sourcePassed,
      weight: sourcePassed ? 3 : 0,
      max: 3
    },
    {
      category: 'approach',
      name: 'Logic & Action',
      label: opPassed 
        ? (isMultiTable && isFiltered ? 'Identified join and filter operations' : isMultiTable ? 'Identified table joining' : isFiltered ? 'Identified filtering condition' : isAggregated ? 'Identified aggregation/calculation' : 'Identified required action')
        : (isMultiTable && !joinKeywords.some(kw => new RegExp(kw, 'i').test(text)) ? 'Mention joining the required tables' : isFiltered ? 'Mention filtering the rows (e.g. using filter/condition)' : 'Describe the logic or action'),
      passed: opPassed,
      weight: opWeight,
      max: 4
    },
    {
      category: 'result',
      name: 'Expected Result',
      label: intentPassed ? 'Stated what data or details to retrieve' : 'Mention what result or details to display (e.g. get details / return result)',
      passed: intentPassed,
      weight: intentPassed ? 3 : 0,
      max: 3
    }
  ];

  const score = Math.min(10, Math.round(items.reduce((s, i) => s + i.weight, 0)));
  const ready = !rawSql && score >= 7;

  return {
    version: RUBRIC_VERSION,
    score,
    ready,
    fingerprint: fingerprint(input),
    items,
    message: rawSql
      ? 'Explain your plan in simple words, or click "⚡ Click here to generate the proper SQL" below.'
      : ready
      ? '✓ Great human intuition! Score: ' + score + '/10. Click below to generate the proper SQL.'
      : 'Thinking score: ' + score + '/10. Review how to think like a data engineer below, or click "⚡ Click here to generate the proper SQL".'
  };
}

export function thinkingIsReady(scenario, entry) {
  if (!entry?.thinking) return false;
  const assessment = evaluateThinking(scenario, entry.thinking);
  return assessment.ready || (entry.assessment?.score >= 7);
}
