// Contest AI-Assisted Evaluation Engine
// Evaluates participant procedural thinking across the 5 structured criteria (100 pts)
// Business Requirement Understanding (20), Data Identification (15),
// Logical Sequence (25), Data Operation Reasoning (25), Completeness & Clarity (15)

export function evaluateContestSubmission({ scenario, response }) {
  const text = String(response || '').trim();
  const scenarioText = String(scenario || '').toLowerCase();
  const lower = text.toLowerCase();

  // If empty or negligible
  if (!text || text.length < 20) {
    return {
      suggested_total_score: 0,
      breakdown: {
        req_understanding: {
          score: 0,
          max: 20,
          reason: 'No meaningful procedural approach provided.',
          strengths: 'None',
          missing_concepts: 'Understanding of business goal and objectives.'
        },
        data_identification: {
          score: 0,
          max: 15,
          reason: 'No data tables or entities identified.',
          strengths: 'None',
          missing_concepts: 'Source entities, tables, or attributes.'
        },
        logical_sequence: {
          score: 0,
          max: 25,
          reason: 'No procedural sequence demonstrated.',
          strengths: 'None',
          missing_concepts: 'Step-by-step logical workflow.'
        },
        operation_reasoning: {
          score: 0,
          max: 25,
          reason: 'No operations (filters, joins, aggregations) described.',
          strengths: 'None',
          missing_concepts: 'Filtering criteria, join keys, groupings, aggregations.'
        },
        completeness_clarity: {
          score: 0,
          max: 15,
          reason: 'Empty submission.',
          strengths: 'None',
          missing_concepts: 'End-to-end plan clarity.'
        }
      }
    };
  }

  // 1. Business Requirement Understanding (max 20)
  // Check if participant addresses the problem's objective, target output, and context
  let reqScore = 10;
  const reqStrengths = [];
  const reqMissing = [];

  const goalWords = ['goal', 'objective', 'calculate', 'find', 'determine', 'identify', 'report', 'metric', 'output', 'result'];
  const hasGoalRef = goalWords.some(w => lower.includes(w));
  if (hasGoalRef) {
    reqScore += 5;
    reqStrengths.push('Articulates the core business objective and desired outcome.');
  } else {
    reqMissing.push('Explicitly state the business goal before diving into steps.');
  }

  // Checks scenario keywords in response
  const scenarioTokens = scenarioText.match(/[a-z]{4,}/g) || [];
  const matchedTokens = scenarioTokens.filter(t => lower.includes(t));
  const tokenCoverage = scenarioTokens.length ? (matchedTokens.length / scenarioTokens.length) : 0;
  if (tokenCoverage > 0.3) {
    reqScore += 5;
    reqStrengths.push('Demonstrates strong contextual grasp of domain-specific business terminology.');
  } else {
    reqScore += 2;
    reqMissing.push('Incorporate more domain context and edge case handling.');
  }
  reqScore = Math.min(20, Math.max(0, reqScore));

  // 2. Data / Table Identification (max 15)
  // Check mention of tables, entities, keys, columns, datasets
  let dataScore = 6;
  const dataStrengths = [];
  const dataMissing = [];

  const dataKeywords = ['table', 'tables', 'dataset', 'entity', 'column', 'columns', 'field', 'attribute', 'id', 'key', 'records', 'data'];
  const hasDataRef = dataKeywords.some(w => lower.includes(w));
  if (hasDataRef) {
    dataScore += 4;
    dataStrengths.push('Identifies key data entities and fields required for the solution.');
  } else {
    dataMissing.push('Specify explicit tables or source entities.');
  }

  // Check specific table / source mentions
  const tableMatches = lower.match(/(?:from|table|in|entity|dataset)\s+([a-z_]{3,})/g);
  if (tableMatches && tableMatches.length >= 1) {
    dataScore += 5;
    dataStrengths.push('Pinpoints candidate tables and attributes relevant to the question.');
  } else {
    dataMissing.push('Detail which specific tables or sources hold the respective attributes.');
  }
  dataScore = Math.min(15, Math.max(0, dataScore));

  // 3. Logical Sequence (max 25)
  // Check step-by-step procedural structure: 1., 2., 3., first, then, next, finally, step
  let seqScore = 10;
  const seqStrengths = [];
  const seqMissing = [];

  const hasNumberedSteps = (text.match(/^\s*(?:\d+[\.\)]|step\s*\d+)/gmi) || []).length >= 2;
  const hasSequentialWords = ['first', 'then', 'next', 'after', 'subsequently', 'finally', 'lastly'].filter(w => lower.includes(w)).length >= 2;

  if (hasNumberedSteps || hasSequentialWords) {
    seqScore += 10;
    seqStrengths.push('Organizes the approach into a clear, orderly procedural hierarchy.');
  } else {
    seqMissing.push('Structure reasoning with clear sequential numbered steps (e.g. Step 1, Step 2).');
  }

  // Logical depth based on word count & structure
  if (text.split(/\s+/).length > 80) {
    seqScore += 5;
    seqStrengths.push('Thorough workflow walkthrough with good procedural depth.');
  } else {
    seqScore += 2;
    seqMissing.push('Elaborate more on the intermediate transition between steps.');
  }
  seqScore = Math.min(25, Math.max(0, seqScore));

  // 4. Data Operation Reasoning (max 25)
  // Evaluate reasoning for: Filters, Joins, Grouping, Aggregation, Calculations
  let opScore = 8;
  const opStrengths = [];
  const opMissing = [];

  const filterKeywords = ['filter', 'where', 'active', 'date', 'exclude', 'only', 'condition', 'status'];
  const joinKeywords = ['join', 'link', 'match', 'combine', 'merge', 'connect', 'relationship', 'on key', 'foreign key'];
  const groupKeywords = ['group', 'by', 'aggregate', 'sum', 'count', 'avg', 'average', 'max', 'min', 'total'];
  const sortKeywords = ['order', 'sort', 'rank', 'top', 'limit', 'descending', 'ascending'];

  const hasFilter = filterKeywords.some(w => lower.includes(w));
  const hasJoin = joinKeywords.some(w => lower.includes(w));
  const hasGroup = groupKeywords.some(w => lower.includes(w));
  const hasSort = sortKeywords.some(w => lower.includes(w));

  let opsCount = 0;
  if (hasFilter) { opsCount++; opStrengths.push('Clear filtering criteria & condition reasoning.'); } else { opMissing.push('Explain record filtering conditions.'); }
  if (hasJoin) { opsCount++; opStrengths.push('Identifies relationship / join logic between entities.'); } else { opMissing.push('Clarify join keys / relationship mapping.'); }
  if (hasGroup) { opsCount++; opStrengths.push('Applies appropriate aggregation and grouping logic.'); } else { opMissing.push('Include aggregation / grouping reasoning.'); }
  if (hasSort) { opsCount++; opStrengths.push('Addresses ranking or sorting requirements.'); }

  opScore += Math.min(17, opsCount * 4.5);
  opScore = Math.min(25, Math.max(0, Math.round(opScore)));

  // 5. Completeness & Clarity (max 15)
  // Word count, language clarity, absence of raw code dump
  let clarScore = 7;
  const clarStrengths = [];
  const clarMissing = [];

  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 60) {
    clarScore += 5;
    clarStrengths.push('Well-developed explanation with thorough coverage of problem nuances.');
  } else if (wordCount >= 30) {
    clarScore += 3;
    clarStrengths.push('Concise logic.');
    clarMissing.push('Provide more detailed operational explanations.');
  } else {
    clarMissing.push('Response is too brief; elaborate each step.');
  }

  // Bonus for clean procedural English rather than just raw SQL code
  if (!lower.includes('select ') || lower.includes('step')) {
    clarScore += 3;
    clarStrengths.push('Maintains procedural English focus without relying purely on SQL syntax.');
  }
  clarScore = Math.min(15, Math.max(0, clarScore));

  const total = Math.min(100, Math.max(0, reqScore + dataScore + seqScore + opScore + clarScore));

  return {
    suggested_total_score: total,
    breakdown: {
      req_understanding: {
        score: reqScore,
        max: 20,
        reason: reqStrengths[0] || 'Adequate general grasp of requirements.',
        strengths: reqStrengths.join(' ') || 'Understands business context.',
        missing_concepts: reqMissing.join(' ') || 'None noted.'
      },
      data_identification: {
        score: dataScore,
        max: 15,
        reason: dataStrengths[0] || 'Basic data references present.',
        strengths: dataStrengths.join(' ') || 'Basic identification.',
        missing_concepts: dataMissing.join(' ') || 'Consider clarifying primary/foreign keys.'
      },
      logical_sequence: {
        score: seqScore,
        max: 25,
        reason: seqStrengths[0] || 'Steps flow in a reasonable order.',
        strengths: seqStrengths.join(' ') || 'Sequential steps.',
        missing_concepts: seqMissing.join(' ') || 'None noted.'
      },
      operation_reasoning: {
        score: opScore,
        max: 25,
        reason: opStrengths.length ? `Covers ${opStrengths.length} core database operations.` : 'Basic operations identified.',
        strengths: opStrengths.join(' ') || 'Basic operation reasoning.',
        missing_concepts: opMissing.join(' ') || 'Consider edge-case handling.'
      },
      completeness_clarity: {
        score: clarScore,
        max: 15,
        reason: clarStrengths[0] || 'Clear presentation.',
        strengths: clarStrengths.join(' ') || 'Legible writing.',
        missing_concepts: clarMissing.join(' ') || 'None noted.'
      }
    }
  };
}
