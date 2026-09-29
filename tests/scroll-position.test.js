import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Progress Scroll-to-Top and Page Scroll Preservation', () => {
  const appJs = fs.readFileSync(path.resolve('js/app.js'), 'utf-8');

  test('1. Applies scroll-to-top ONLY to the Progress page in showScreen', () => {
    const showScreenMatch = appJs.match(/function showScreen\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(showScreenMatch, 'showScreen must exist');
    const showScreenBody = showScreenMatch[1];
    
    // Check that window.scrollTo(0, 0) is inside if (isProgress) block
    assert.ok(
      /if\s*\(\s*isProgress\s*\)\s*\{\s*window\.scrollTo\(0,\s*0\);/m.test(showScreenBody),
      'window.scrollTo(0, 0) must be called only when isProgress is true'
    );

    // Check that other pages restore saved scroll position
    assert.ok(
      showScreenBody.includes('pageScrollPositions[targetScreen]'),
      'Must restore saved scroll position for other pages'
    );
  });

  test('2. Preserves scroll position when leaving and returning to Practice page', () => {
    // Check that current scroll position is recorded before switching
    assert.ok(
      /pageScrollPositions\[currentActiveScreen\]\s*=\s*window\.scrollY/m.test(appJs),
      'Must record window.scrollY of the screen before navigating away'
    );
    // Check that returning to Practice / non-progress restores saved scroll position
    assert.ok(
      /window\.scrollTo\(0,\s*savedPos\)/m.test(appJs),
      'Must restore savedPos for non-progress screens'
    );
  });

  test('3. Does NOT force scroll-to-top in nextScenario, loadScenario, or openScenario', () => {
    const nextScenarioMatch = appJs.match(/function nextScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(nextScenarioMatch, 'nextScenario must exist');
    assert.strictEqual(
      nextScenarioMatch[1].includes('window.scrollTo(0, 0)'),
      false,
      'nextScenario must not force scroll-to-top'
    );

    const loadScenarioMatch = appJs.match(/function loadScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(loadScenarioMatch, 'loadScenario must exist');
    assert.strictEqual(
      loadScenarioMatch[1].includes('window.scrollTo(0, 0)'),
      false,
      'loadScenario must not force scroll-to-top'
    );

    const openScenarioMatch = appJs.match(/function openScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(openScenarioMatch, 'openScenario must exist');
    assert.strictEqual(
      openScenarioMatch[1].includes('window.scrollTo(0, 0)'),
      false,
      'openScenario must not force scroll-to-top'
    );
  });
});
