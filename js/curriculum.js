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
 * Returns the effective scenario for the current user and state.
 * If the user has already started this scenario, the variant chosen in state.entries is preserved.
 * Otherwise, a deterministic variant is assigned based on userId/sessionId.
 */
export function getEffectiveScenario(scenario, userId = 'guest_user', state = null) {
  if (!scenario) return null;
  if (!scenario.variants || scenario.variants.length <= 1) {
    return {
      ...scenario,
      canonicalId: scenario.id,
      variantIndex: 0
    };
  }

  const entry = state?.entries?.[scenario.id];
  let vIndex = (entry && typeof entry.variantIndex === 'number')
    ? entry.variantIndex
    : getVariantIndex(scenario, userId);

  if (vIndex < 0 || vIndex >= scenario.variants.length) vIndex = 0;

  const variant = scenario.variants[vIndex];
  return {
    ...scenario,
    ...variant,
    id: scenario.id,
    canonicalId: scenario.id,
    variantIndex: vIndex,
    requiredTables: variant.requiredTables || variant.tables || scenario.requiredTables || scenario.tables,
    relevantColumns: variant.relevantColumns || scenario.relevantColumns || [],
    concepts: variant.concepts || scenario.concepts || [],
    thinkingExpectations: variant.thinkingExpectations || scenario.thinkingExpectations || []
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
