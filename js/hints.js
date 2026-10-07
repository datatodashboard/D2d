// Think and Crack SQL — Animated Progressive Hints Engine
// Data2Dashboard (D2D) • Crack SQL Learning Platform

import { escapeHtml } from './util.js';

let activeHintScenarioId = null;
let activeHintLevel = 1;
let hintPulseTimer = null;
let onTryAgainCallback = null;
let isContestActive = false;

/**
 * Derives three progressive hints for any scenario from its metadata
 */
export function getScenarioHints(scenario) {
  if (!scenario) {
    return {
      hint1: 'Read the business question carefully and identify what record you need to find.',
      hint2: 'Check the schema overview to see which tables contain the necessary fields.',
      hint3: 'Draft a plan: choose the base table, apply filters, and decide on grouping or sorting.'
    };
  }

  // If authored hints already exist in scenarios.json, use them
  if (Array.isArray(scenario.hints) && scenario.hints.length >= 3) {
    return {
      hint1: scenario.hints[0],
      hint2: scenario.hints[1],
      hint3: scenario.hints[2]
    };
  }

  // Derive Hint 1: Business Clue
  const question = scenario.question || '';
  let hint1 = `Business Goal: You need to ${question.charAt(0).toLowerCase() + question.slice(1)}`;
  if (!hint1.endsWith('.')) hint1 += '.';
  hint1 += ' Think about what real-world outcome the business stakeholder is asking to see.';

  // Derive Hint 2: Data Clue
  const tables = Array.isArray(scenario.requiredTables) && scenario.requiredTables.length > 0
    ? scenario.requiredTables.join(' and ')
    : 'the relevant tables';
  const cols = Array.isArray(scenario.relevantColumns) && scenario.relevantColumns.length > 0
    ? scenario.relevantColumns.slice(0, 4).join(', ')
    : 'identifying columns';
  let hint2 = `Data Sources: Look at table(s) "${tables}". Focus on key columns like ${cols} to identify or connect the records.`;

  // Derive Hint 3: SQL Concept / Reasoning Approach
  const concepts = Array.isArray(scenario.concepts) && scenario.concepts.length > 0
    ? scenario.concepts.join(', ')
    : 'filtering and aggregation';
  const expectations = scenario.thinkingExpectations || {};
  const filterDesc = expectations.comparisons || expectations.filters ? 'apply specific filter conditions' : 'inspect row criteria';
  const groupDesc = expectations.groups ? ', group by appropriate categories' : '';
  const sortDesc = expectations.sorts ? ', and order the results' : '';
  let hint3 = `Reasoning Approach: This challenge exercises ${concepts}. In your plan, explain how to select from ${tables}, ${filterDesc}${groupDesc}${sortDesc}.`;

  return { hint1, hint2, hint3 };
}

/**
 * Initializes hint listeners and timers for current scenario
 */
export function initScenarioHints({
  scenario,
  entry,
  containerEl,
  onHintRevealed,
  onTryAgain,
  contestMode = false
}) {
  isContestActive = Boolean(contestMode);
  clearTimeout(hintPulseTimer);

  const hintBtn = document.getElementById('hintBtn');
  const hintCard = document.getElementById('hintCard');

  if (isContestActive) {
    if (hintBtn) hintBtn.hidden = true;
    if (hintCard) hintCard.hidden = true;
    return;
  }

  if (hintBtn) hintBtn.hidden = false;
  activeHintScenarioId = scenario?.id || null;
  onTryAgainCallback = onTryAgain || null;

  // Determine highest previously revealed hint level from entry
  const revealedLevels = Array.isArray(entry?.hintsRevealed) ? entry.hintsRevealed : [];
  activeHintLevel = revealedLevels.length > 0 ? Math.max(...revealedLevels) : 1;

  // Start gentle bulb glow timer after 35 seconds of inactivity
  hintPulseTimer = setTimeout(() => {
    triggerHintPulse();
  }, 35000);
}

/**
 * Triggers the gentle bulb pulse animation
 */
export function triggerHintPulse() {
  if (isContestActive) return;
  const hintBtn = document.getElementById('hintBtn');
  if (hintBtn && !hintBtn.hidden) {
    hintBtn.classList.add('hint-pulse');
  }
}

/**
 * Clears the bulb pulse animation
 */
export function clearHintPulse() {
  clearTimeout(hintPulseTimer);
  const hintBtn = document.getElementById('hintBtn');
  if (hintBtn) {
    hintBtn.classList.remove('hint-pulse');
  }
}

/**
 * Toggles or opens the hint card modal/panel
 */
export function toggleHintCard(scenario, entry, onHintRecorded) {
  if (isContestActive) return;
  clearHintPulse();
  const hintCard = document.getElementById('hintCard');
  if (!hintCard) return;

  const isHidden = hintCard.hidden;
  if (isHidden) {
    openHintCard(scenario, entry, onHintRecorded);
  } else {
    hintCard.hidden = true;
  }
}

/**
 * Opens and renders the progressive hint card
 */
export function openHintCard(scenario, entry, onHintRecorded) {
  if (isContestActive || !scenario) return;
  clearHintPulse();
  const hintCard = document.getElementById('hintCard');
  if (!hintCard) return;

  const hints = getScenarioHints(scenario);
  const revealedLevels = Array.isArray(entry?.hintsRevealed) ? [...entry.hintsRevealed] : [];
  if (!revealedLevels.includes(activeHintLevel)) {
    revealedLevels.push(activeHintLevel);
    if (typeof onHintRecorded === 'function') {
      onHintRecorded(scenario.id, activeHintLevel, revealedLevels);
    }
  }

  hintCard.hidden = false;
  hintCard.innerHTML = `
    <div class="hint-card-header">
      <div class="hint-card-title">
        <span class="hint-bulb-icon">💡</span>
        <span>Progressive Hint (Level ${activeHintLevel} of 3)</span>
      </div>
      <button class="hint-close-btn" onclick="window.closeHintCard()" aria-label="Close Hint">✕</button>
    </div>

    <!-- Hint Level Tabs -->
    <div class="hint-tabs">
      <button class="hint-tab-btn ${activeHintLevel === 1 ? 'active' : ''}" onclick="window.switchHintLevel(1)">
        1. Business Clue
      </button>
      <button class="hint-tab-btn ${activeHintLevel === 2 ? 'active' : ''} ${!revealedLevels.includes(2) ? 'locked' : ''}" onclick="window.switchHintLevel(2)">
        2. Data Clue ${!revealedLevels.includes(2) ? '🔒' : ''}
      </button>
      <button class="hint-tab-btn ${activeHintLevel === 3 ? 'active' : ''} ${!revealedLevels.includes(3) ? 'locked' : ''}" onclick="window.switchHintLevel(3)">
        3. SQL Reasoning ${!revealedLevels.includes(3) ? '🔒' : ''}
      </button>
    </div>

    <!-- Active Hint Body -->
    <div class="hint-body">
      ${activeHintLevel === 1 ? `
        <div class="hint-step-content">
          <div class="hint-step-label">🎯 Business Clue:</div>
          <p class="hint-text">${escapeHtml(hints.hint1)}</p>
        </div>
      ` : ''}

      ${activeHintLevel === 2 ? `
        <div class="hint-step-content">
          <div class="hint-step-label">📊 Data & Schema Clue:</div>
          <p class="hint-text">${escapeHtml(hints.hint2)}</p>
        </div>
      ` : ''}

      ${activeHintLevel === 3 ? `
        <div class="hint-step-content">
          <div class="hint-step-label">🧠 SQL Concept Approach:</div>
          <p class="hint-text">${escapeHtml(hints.hint3)}</p>
        </div>
      ` : ''}
    </div>

    <!-- Actions Row -->
    <div class="hint-actions">
      <button class="hint-try-btn" onclick="window.tryAgainFromHint()">
        ✏️ Try Again (Keep Text)
      </button>
      ${activeHintLevel < 3 ? `
        <button class="hint-next-btn" onclick="window.revealNextHint()">
          Next Hint (${activeHintLevel + 1}/3) ➔
        </button>
      ` : `
        <span class="hint-all-revealed">All 3 hints revealed</span>
      `}
    </div>
  `;
}

/**
 * Switches to a specific hint level
 */
export function setHintLevel(level, scenario, entry, onHintRecorded) {
  activeHintLevel = Math.max(1, Math.min(3, level));
  openHintCard(scenario, entry, onHintRecorded);
}

/**
 * Focuses the thinking box without clearing user's draft text
 */
export function tryAgainFromHint() {
  const hintCard = document.getElementById('hintCard');
  if (hintCard) hintCard.hidden = true;
  const thinkingArea = document.getElementById('thinking');
  if (thinkingArea) {
    thinkingArea.focus();
    // Scroll smoothly to thinking box
    thinkingArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (typeof onTryAgainCallback === 'function') {
    onTryAgainCallback();
  }
}

/**
 * Calculates assistance metrics from progress entries
 */
export function calculateAssistanceMetrics(scenarios, state) {
  let independentSolves = 0;
  let assistedSolves = 0;
  let totalThinkingScore = 0;
  let scoredCount = 0;

  for (const s of scenarios) {
    const entry = state?.entries?.[s.id];
    if (!entry) continue;

    const score = entry.assessment?.score;
    if (typeof score === 'number') {
      totalThinkingScore += score;
      scoredCount++;
    }

    const isCompleted = (score >= 7) || (entry.completed === true);
    if (isCompleted) {
      const hadHints = Array.isArray(entry.hintsRevealed) && entry.hintsRevealed.length > 0;
      if (hadHints) {
        assistedSolves++;
      } else {
        independentSolves++;
      }
    }
  }

  const avgScore = scoredCount > 0 ? (totalThinkingScore / scoredCount).toFixed(1) : '0.0';

  return {
    independentSolves,
    assistedSolves,
    averageThinkingScore: avgScore,
    totalScored: scoredCount
  };
}
