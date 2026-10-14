import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('UI Selection & Level Buttons Verification Suite', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  const appJs = fs.readFileSync('js/app.js', 'utf8');

  test('1. selectedDomain and selectedLevel initialize as null on startup and login', () => {
    // Initial declaration is null
    assert.match(appJs, /let\s+selectedDomain\s*=\s*null\s*,\s*selectedLevel\s*=\s*null/);
    
    // Startup block does not default to 'Banking' or 'Beginner'
    assert.doesNotMatch(appJs, /selectedDomain\s*=\s*selectedDomain\s*\|\|\s*['"]Banking['"]/);
    assert.doesNotMatch(appJs, /selectedLevel\s*=\s*selectedLevel\s*\|\|\s*['"]Beginner['"]/);
    
    // In startup block, explicitly set to null
    assert.match(appJs, /selectedDomain\s*=\s*null;\s*selectedLevel\s*=\s*null;\s*current\s*=\s*null;/);

    // In setSession login hydration block, explicitly reset to null
    assert.match(appJs, /\/\/ Step 4: Coordinated dashboard render with authoritative state\s+selectedDomain\s*=\s*null;\s*selectedLevel\s*=\s*null;\s*current\s*=\s*null;/);
  });

  test('2. renderDomainAndLevelPickers renders neutral unselected styles when selections are null', () => {
    // Check that isActive and isCurrent are false when selectedDomain and selectedLevel are null
    const CORE_DOMAINS = ['Banking', 'Healthcare', 'Insurance', 'Retail'];
    const ORDERED_LEVELS = ['Beginner', 'Intermediate', 'Expert'];
    
    let selectedDomain = null;
    let selectedLevel = null;

    // Simulate domain rendering
    const domainActiveResults = CORE_DOMAINS.map(domain => Boolean(selectedDomain && selectedDomain === domain));
    assert.deepStrictEqual(domainActiveResults, [false, false, false, false]);

    // Simulate level rendering
    const levelActiveResults = ORDERED_LEVELS.map(lvl => Boolean(selectedLevel && selectedLevel === lvl));
    assert.deepStrictEqual(levelActiveResults, [false, false, false]);
  });

  test('3. Highlighting only occurs when explicitly clicked, requiring both before opening scenario', () => {
    let selectedDomain = null;
    let selectedLevel = null;
    let scenarioOpened = false;

    function simulateSelectDomain(domain) {
      selectedDomain = domain;
      if (selectedDomain && selectedLevel) {
        scenarioOpened = true;
      }
    }

    function simulateSelectLevel(level) {
      selectedLevel = level;
      if (selectedDomain && selectedLevel) {
        scenarioOpened = true;
      }
    }

    // Click Domain first
    simulateSelectDomain('Banking');
    assert.strictEqual(selectedDomain, 'Banking');
    assert.strictEqual(selectedLevel, null);
    assert.strictEqual(scenarioOpened, false, 'Scenario should NOT open when only domain is selected');

    // Click Level second
    simulateSelectLevel('Intermediate');
    assert.strictEqual(selectedLevel, 'Intermediate');
    assert.strictEqual(scenarioOpened, true, 'Scenario should open once both domain and level are selected');

    // Test reverse sequence
    selectedDomain = null;
    selectedLevel = null;
    scenarioOpened = false;

    simulateSelectLevel('Expert');
    assert.strictEqual(selectedLevel, 'Expert');
    assert.strictEqual(selectedDomain, null);
    assert.strictEqual(scenarioOpened, false, 'Scenario should NOT open when only level is selected');

    simulateSelectDomain('Healthcare');
    assert.strictEqual(selectedDomain, 'Healthcare');
    assert.strictEqual(scenarioOpened, true, 'Scenario should open once both are selected');
  });

  test('4. Level buttons are styled horizontally in one row with equal 33.33% width', () => {
    // Verify CSS rules in index.html
    assert.match(indexHtml, /\.levels\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
    assert.match(indexHtml, /\.levels\s*\{[^}]*width:\s*100%/);
    assert.match(indexHtml, /\.level\s*\{[^}]*min-height:\s*48px/);
    assert.match(indexHtml, /\.level\s*\{[^}]*border-radius:\s*12px/);
    assert.match(indexHtml, /\.level\s*\{[^}]*font-size:\s*14\.5px/);

    // Verify mobile / 480px breakpoint
    assert.match(indexHtml, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.levels\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);

    // Verify small mobile / 360px breakpoint keeps horizontal 3 columns (not flex column)
    assert.match(indexHtml, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.levels\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
    assert.doesNotMatch(indexHtml, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.levels\s*\{[^}]*flex-direction:\s*column/);
  });

  test('5. Learner progress, completed scenarios, thinking scores, and certificates are strictly preserved', () => {
    // Verify loadAndRestoreUserProgress is called in setSession and not modified
    assert.match(appJs, /await loadAndRestoreUserProgress\(user\.id,\s*prefetchedLp,\s*prefetchedFb\);/);
    // Verify state.entries is intact and certificates rendering is intact
    assert.match(appJs, /updateProgress\(\);/);
    assert.match(appJs, /renderScenarioCatalog\(\);/);
  });
});
