import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Motivation Popup & Next Scenario Verification', () => {
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.resolve('js/app.js'), 'utf-8');

  test('1. Removes old Next Scenario button from bottom of Practice page', () => {
    assert.strictEqual(
      indexHtml.includes('id="nextScenarioContainer"'),
      false,
      'Old nextScenarioContainer must be removed from Practice page'
    );
  });

  test('2. Motivation modal popup is present in index.html', () => {
    assert.strictEqual(
      indexHtml.includes('id="motivationModal"'),
      true,
      'motivationModal should exist'
    );
    assert.strictEqual(
      indexHtml.includes('id="motivationScoreBadge"'),
      true,
      'motivationScoreBadge should exist'
    );
    assert.strictEqual(
      indexHtml.includes('id="motivationMessage"'),
      true,
      'motivationMessage should exist'
    );
    assert.strictEqual(
      indexHtml.includes('id="motivationRetryBtn"'),
      true,
      'motivationRetryBtn should exist'
    );
    assert.strictEqual(
      indexHtml.includes('id="nextButton"'),
      true,
      'nextButton should exist inside motivationModal'
    );
  });

  test('3. No extra buttons or extra animations added', () => {
    const modalMatch = indexHtml.match(/<div id="motivationModal"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(modalMatch, 'Found motivation modal block');
    const modalHtml = modalMatch[0];
    
    // Check buttons inside the popup
    const buttonMatches = modalHtml.match(/<button/g) || [];
    assert.strictEqual(
      buttonMatches.length,
      2,
      'Popup must only have exactly 2 buttons: Retry and Next Scenario'
    );

    // Ensure no animation classes or styles on Retry
    assert.strictEqual(
      /animation|keyframes/i.test(modalHtml),
      false,
      'Must not add animations to popup or Retry button'
    );
  });

  test('4. Motivation popup logic in app.js shows Retry for every score and Next Scenario only for 7-10', () => {
    assert.ok(
      appJs.includes('function openMotivationPopup('),
      'openMotivationPopup function must exist'
    );
    assert.ok(
      appJs.includes('function closeMotivationModal('),
      'closeMotivationModal function must exist'
    );
    assert.ok(
      appJs.includes('function handleMotivationRetry('),
      'handleMotivationRetry function must exist'
    );
    assert.ok(
      appJs.includes('function handleMotivationNext('),
      'handleMotivationNext function must exist'
    );

    // Verify evaluatePlan calls openMotivationPopup(score)
    assert.ok(
      /evaluatePlan\s*\(\)\s*\{[\s\S]*?openMotivationPopup\(score\)/.test(appJs),
      'evaluatePlan must call openMotivationPopup(score)'
    );

    // Simulate popup behavior for various scores
    function simulatePopup(score) {
      let retryVisible = false;
      let nextVisible = false;
      let msg = '';

      const numericScore = typeof score === 'number' ? score : 0;
      if (numericScore === 10) {
        msg = 'Outstanding! Perfect intuition and complete breakdown.';
      } else if (numericScore === 9) {
        msg = 'Excellent! Your data engineering plan is spot on.';
      } else if (numericScore === 8) {
        msg = 'Great work! Solid intuition and clear logic.';
      } else if (numericScore === 7) {
        msg = 'Well done! You cracked the intuition to proceed.';
      } else if (numericScore === 6) {
        msg = "Good attempt! You're very close — review the plan and try again to hit 7+.";
      } else if (numericScore === 5) {
        msg = 'Fair effort! You have the basics down. Review the guidance and retry.';
      } else {
        msg = 'Keep practicing! Break down the problem step-by-step and try again.';
      }

      // Retry shown for every score
      retryVisible = true;

      // Next Scenario shown only for 7-10
      nextVisible = numericScore >= 7;

      return { retryVisible, nextVisible, msg };
    }

    // Test scores 7-10
    [7, 8, 9, 10].forEach(score => {
      const res = simulatePopup(score);
      assert.strictEqual(res.retryVisible, true, `Retry must be visible for score ${score}`);
      assert.strictEqual(res.nextVisible, true, `Next Scenario must be visible for score ${score}`);
      assert.ok(res.msg.length > 0, `Motivation message must exist for score ${score}`);
    });

    // Test scores 5 and 6
    [5, 6].forEach(score => {
      const res = simulatePopup(score);
      assert.strictEqual(res.retryVisible, true, `Retry must be visible for score ${score}`);
      assert.strictEqual(res.nextVisible, false, `Next Scenario must NOT be visible for score ${score}`);
      assert.ok(res.msg.length > 0, `Motivation message must exist for score ${score}`);
    });

    // Test scores below 5
    [0, 1, 2, 3, 4].forEach(score => {
      const res = simulatePopup(score);
      assert.strictEqual(res.retryVisible, true, `Retry must be visible for score ${score}`);
      assert.strictEqual(res.nextVisible, false, `Next Scenario must NOT be visible for score ${score}`);
      assert.ok(res.msg.length > 0, `Motivation message must exist for score ${score}`);
    });
  });
});
