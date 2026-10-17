// Think and Crack SQL — Curriculum & Skill Blueprint Manager
// Manages domain-specific skill blueprints, deterministic scenario variation,
// and lightweight skill tracking for adaptive learning.

export const BEGINNER_SKILL_BLUEPRINT = [
  { index: 1, name: 'Simple text filtering', concept: 'Text condition on record status', category: 'Filtering' },
  { index: 2, name: 'Numeric filtering', concept: 'Threshold comparison on record amount/value', category: 'Filtering' },
  { index: 3, name: 'Location filtering', concept: 'Text condition on master entity location/city', category: 'Filtering' },
  { index: 4, name: 'COUNT', concept: 'Counting total records in table', category: 'Aggregation' },
  { index: 5, name: 'ORDER BY', concept: 'Sorting records in descending sequence', category: 'Sorting' },
  { index: 6, name: 'DISTINCT', concept: 'Selecting unique categories from catalog', category: 'Projection' },
  { index: 7, name: 'Date filtering', concept: 'Date boundary comparison on record dates', category: 'Filtering' },
  { index: 8, name: 'Event type filtering', concept: 'Condition on event log type', category: 'Filtering' },
  { index: 9, name: 'LIMIT/TOP', concept: 'Deterministic sort and row limit', category: 'Sorting' },
  { index: 10, name: 'Range filtering', concept: 'BETWEEN boundary on numeric amounts', category: 'Filtering' },
  { index: 11, name: 'Pattern matching', concept: 'LIKE prefix matching on names', category: 'Filtering' },
  { index: 12, name: 'Multiple conditions', concept: 'IN / OR logical conditions on status', category: 'Logic' },
  { index: 13, name: 'Segment filtering', concept: 'Filtering master by tier/segment', category: 'Filtering' },
  { index: 14, name: 'Date range filtering', concept: 'BETWEEN dates on event log', category: 'Filtering' },
  { index: 15, name: 'AVG', concept: 'Average calculation across records', category: 'Aggregation' },
  { index: 16, name: 'MAX', concept: 'Maximum value aggregation on events', category: 'Aggregation' },
  { index: 17, name: 'COUNT DISTINCT', concept: 'Count of unique master cities', category: 'Aggregation' },
  { index: 18, name: 'Event status filter', concept: 'Filtering event status Completed', category: 'Filtering' },
  { index: 19, name: 'Business analysis scenario', concept: 'CASE conditional banding', category: 'Business Analysis' },
  { index: 20, name: 'Beginner mini challenge', concept: 'Combined status and numeric criteria', category: 'Synthesis' }
];

export function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Deterministically picks a variant index for a scenario and user.
 * Preserves the exact same variant across page reloads for the same user/guest.
 */
export function getVariantIndex(scenario, userId = 'guest_user') {
  if (!scenario?.variants || scenario.variants.length <= 1) return 0;
  const seed = `${userId || 'guest_user'}:${scenario.id}`;
  return hashString(seed) % scenario.variants.length;
}

/**
 * Returns the effective scenario. Variants are no longer used.
 */
export function getEffectiveScenario(scenario, userId = 'guest_user', state = null) {
  if (!scenario) return null;
  return {
    ...scenario,
    canonicalId: scenario.id
  };
}

/**
 * Lightweight skill tracking for adaptive learning.
 * Stores attempt count and pass state per skill without mutating core progress schema.
 */
export function recordSkillAttempt(state, scenario, isVerified) {
  if (!state || !scenario?.skill) return;
  state.skills = state.skills || {};
  const skillKey = scenario.skill;
  const current = state.skills[skillKey] || { attempts: 0, passed: 0, lastEvaluatedAt: 0 };
  current.attempts += 1;
  if (isVerified) current.passed += 1;
  current.lastEvaluatedAt = Date.now();
  state.skills[skillKey] = current;
}

export const CANONICAL_DOMAINS = [
  'Banking',
  'Healthcare',
  'Insurance',
  'Capital Markets',
  'Semiconductor',
  'Education',
  'Retail'
];

export const CANONICAL_LEVELS = ['Beginner', 'Intermediate', 'Expert'];

/**
 * Resolves any scenario alias or variant key to its canonical parent scenario ID.
 */
export function resolveCanonicalScenarioId(id, aliasesMap = null) {
  if (!id || typeof id !== 'string') return id;
  const cleanId = String(id).trim();

  if (aliasesMap && typeof aliasesMap === 'object' && aliasesMap[cleanId]) {
    return String(aliasesMap[cleanId]).trim();
  }

  // Handle variant IDs (e.g., BAN_BEG_001_v1 -> BAN_BEG_001)
  const variantMatch = cleanId.match(/^([A-Z]{3}_[A-Z]{3}_\d{3})_v\d+$/i);
  if (variantMatch) {
    return variantMatch[1].toUpperCase();
  }

  return cleanId;
}

/**
 * Parses and validates scenario data at the application data-loading boundary.
 * Throws a clear Error if malformed; does not silently fall back.
 */
export function validateScenariosData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Scenario validation failed: root must be a valid JSON object.');
  }

  if (!Array.isArray(data.scenarios)) {
    throw new Error('Scenario validation failed: missing "scenarios" array.');
  }

  if (data.scenarios.length !== 420) {
    throw new Error(`Scenario validation failed: expected 420 canonical scenarios, found ${data.scenarios.length}.`);
  }

  const seenIds = new Set();
  const domainLevelCounts = {};

  for (const [idx, s] of data.scenarios.entries()) {
    if (!s || typeof s !== 'object') {
      throw new Error(`Scenario validation failed at index ${idx}: scenario must be an object.`);
    }
    if (!s.id || typeof s.id !== 'string') {
      throw new Error(`Scenario validation failed at index ${idx}: missing valid scenario "id".`);
    }
    if (seenIds.has(s.id)) {
      throw new Error(`Scenario validation failed: duplicate scenario ID "${s.id}".`);
    }
    seenIds.add(s.id);

    if (!s.domain || !CANONICAL_DOMAINS.includes(s.domain)) {
      throw new Error(`Scenario validation failed for ${s.id}: unrecognized domain "${s.domain}".`);
    }
    if (!s.level || !CANONICAL_LEVELS.includes(s.level)) {
      throw new Error(`Scenario validation failed for ${s.id}: unrecognized level "${s.level}".`);
    }
    if (typeof s.questionNo !== 'number' || s.questionNo < 1 || s.questionNo > 20) {
      throw new Error(`Scenario validation failed for ${s.id}: questionNo must be an integer between 1 and 20.`);
    }
    if (!s.question || typeof s.question !== 'string' || s.question.trim().length === 0) {
      throw new Error(`Scenario validation failed for ${s.id}: missing question text.`);
    }
    if (!s.sql || typeof s.sql !== 'string' || s.sql.trim().length === 0) {
      throw new Error(`Scenario validation failed for ${s.id}: missing reference sql.`);
    }

    const key = `${s.domain}_${s.level}`;
    domainLevelCounts[key] = (domainLevelCounts[key] || 0) + 1;
  }

  // Verify all 7 domains and 3 levels each have exactly 20 scenarios (7 * 3 * 20 = 420)
  for (const domain of CANONICAL_DOMAINS) {
    for (const level of CANONICAL_LEVELS) {
      const key = `${domain}_${level}`;
      const count = domainLevelCounts[key] || 0;
      if (count !== 20) {
        throw new Error(`Scenario validation failed: ${domain} ${level} has ${count} scenarios, expected 20.`);
      }
    }
  }

  // Ensure requiredDomains safely includes Retail if present
  if (Array.isArray(data.requiredDomains) && !data.requiredDomains.includes('Retail')) {
    data.requiredDomains.push('Retail');
  }

  return true;
}

