import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Page Scroll Position Bug Fix Verification', () => {
  const appJs = fs.readFileSync(path.resolve('js/app.js'), 'utf-8');

  test('1. Uses window.scrollTo(0, 0) in showScreen for Dashboard, Explore, and Practice', () => {
    // Check showScreen contains window.scrollTo(0, 0)
    const showScreenMatch = appJs.match(/function showScreen\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(showScreenMatch, 'showScreen must exist');
    const showScreenBody = showScreenMatch[1];
    
    assert.ok(
      showScreenBody.includes('window.scrollTo(0, 0);'),
      'showScreen must call window.scrollTo(0, 0);'
    );
    assert.strictEqual(
      showScreenBody.includes('smooth'),
      false,
      'showScreen must not use slow smooth scroll behavior'
    );
  });

  test('2. Uses window.scrollTo(0, 0) when switching scenarios in nextScenario', () => {
    const nextScenarioMatch = appJs.match(/function nextScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(nextScenarioMatch, 'nextScenario must exist');
    assert.ok(
      nextScenarioMatch[1].includes('window.scrollTo(0, 0);'),
      'nextScenario must call window.scrollTo(0, 0);'
    );
  });

  test('3. Uses window.scrollTo(0, 0) when loading and opening scenarios', () => {
    const openScenarioMatch = appJs.match(/function openScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(openScenarioMatch, 'openScenario must exist');
    assert.ok(
      openScenarioMatch[1].includes('window.scrollTo(0, 0);'),
      'openScenario must call window.scrollTo(0, 0);'
    );

    const loadScenarioMatch = appJs.match(/function loadScenario\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction /);
    assert.ok(loadScenarioMatch, 'loadScenario must exist');
    assert.ok(
      loadScenarioMatch[1].includes('window.scrollTo(0, 0);'),
      'loadScenario must call window.scrollTo(0, 0);'
    );
  });
});
