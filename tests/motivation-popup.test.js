import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Thinking Score Result Popup (6 States & Visual Style Verification)', () => {
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.resolve('js/app.js'), 'utf-8');

  test('1. Removes old Next Scenario button from bottom of Practice page', () => {
    assert.strictEqual(
      indexHtml.includes('id="nextScenarioContainer"'),
      false,
      'Old nextScenarioContainer must be removed from Practice page'
    );
  });

  test('2. Motivation modal popup structure matches reference image layout', () => {
    assert.strictEqual(indexHtml.includes('id="motivationModal"'), true, 'motivationModal should exist');
    assert.strictEqual(indexHtml.includes('id="motivationCard"'), true, 'motivationCard should exist');
    assert.strictEqual(indexHtml.includes('id="motivationMascot"'), true, 'motivationMascot container should exist');
    assert.strictEqual(indexHtml.includes('id="motivationScoreNum"'), true, 'motivationScoreNum should exist');
    assert.strictEqual(indexHtml.includes('id="motivationTitle"'), true, 'motivationTitle should exist');
    assert.strictEqual(indexHtml.includes('id="motivationSubtitle"'), true, 'motivationSubtitle should exist');
    assert.strictEqual(indexHtml.includes('id="motivationTipBox"'), true, 'motivationTipBox should exist');
    assert.strictEqual(indexHtml.includes('id="motivationTipText"'), true, 'motivationTipText should exist');
    assert.strictEqual(indexHtml.includes('id="motivationStarsLayer"'), true, 'motivationStarsLayer should exist');
    assert.strictEqual(indexHtml.includes('id="motivationRetryBtn"'), true, 'motivationRetryBtn should exist');
    assert.strictEqual(indexHtml.includes('id="nextButton"'), true, 'nextButton should exist inside modal');
    assert.strictEqual(indexHtml.includes('thinking-modal-close'), true, 'Close button should exist');
  });

  test('3. Entrance animation and visual style present', () => {
    assert.strictEqual(indexHtml.includes('@keyframes popupEntrance'), true, 'Entrance animation keyframes must exist');
    assert.strictEqual(indexHtml.includes('thinking-modal-dialog'), true, 'thinking-modal-dialog class must exist');
    assert.strictEqual(indexHtml.includes('thinking-retry-btn'), true, 'Simple thinking-retry-btn class must exist');
    assert.strictEqual(indexHtml.includes('thinking-next-btn'), true, 'Normal thinking-next-btn class must exist');
  });

  test('4. Configures 6 score-based popup states with exact messages', () => {
    // Check MOTIVATION_STATES in app.js
    assert.ok(appJs.includes('MOTIVATION_STATES ='), 'MOTIVATION_STATES must be defined in app.js');

    // 5/10: "Keep Going!"
    assert.ok(appJs.includes("'Keep Going!'"), '5/10 title must be Keep Going!');
    // 6/10: "Getting Better!"
    assert.ok(appJs.includes("'Getting Better!'"), '6/10 title must be Getting Better!');
    // 7/10: "Good Job!"
    assert.ok(appJs.includes("'Good Job!'"), '7/10 title must be Good Job!');
    // 8/10: "Great Thinking!"
    assert.ok(appJs.includes("'Great Thinking!'"), '8/10 title must be Great Thinking!');
    // 9/10: "Excellent Work!"
    assert.ok(appJs.includes("'Excellent Work!'"), '9/10 title must be Excellent Work!');
    // 10/10: "Perfect!"
    assert.ok(appJs.includes("'Perfect!'"), '10/10 title must be Perfect!');
  });

  test('5. Button logic: Retry appears for 5-10, Next Scenario only for 7-10', () => {
    // Test scores 5 and 6
    [5, 6].forEach(score => {
      // In MOTIVATION_STATES, showNext should be false
      const match = appJs.match(new RegExp(`${score}:\\s*\\{[\\s\\S]*?showNext:\\s*(true|false)`));
      assert.ok(match, `Found state for score ${score}`);
      assert.strictEqual(match[1], 'false', `Score ${score} must have showNext: false`);
    });

    // Test scores 7, 8, 9, 10
    [7, 8, 9, 10].forEach(score => {
      const match = appJs.match(new RegExp(`${score}:\\s*\\{[\\s\\S]*?showNext:\\s*(true|false)`));
      assert.ok(match, `Found state for score ${score}`);
      assert.strictEqual(match[1], 'true', `Score ${score} must have showNext: true`);
    });
  });

  test('6. Mascot SVGs and decorative stars/confetti functions exist', () => {
    assert.ok(appJs.includes('function getMotivationMascotSvg('), 'getMotivationMascotSvg must exist');
    assert.ok(appJs.includes('function getPopupStarsHtml('), 'getPopupStarsHtml must exist');
  });
});
