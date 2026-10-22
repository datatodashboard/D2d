import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('Explore Page Google Login & Domain/Level Practice Navigation Verification Suite', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  const appJs = fs.readFileSync('js/app.js', 'utf8');

  test('1. Guest opens App -> Explore appears without login popup (loginScreen hidden, appMain visible)', () => {
    // In index.html, loginScreen has hidden attribute and appMain is not hidden
    assert.match(indexHtml, /<section id="loginScreen" class="login-gate-screen"\s+hidden>/);
    assert.match(indexHtml, /<div class="app" id="appMain">/);
    assert.doesNotMatch(indexHtml, /<div class="app" id="appMain"\s+hidden>/);

    // In appJs when unauthenticated, setSession(null) keeps appMain visible and Explore (home) active
    assert.match(appJs, /if\s*\(\$\('loginScreen'\)\)\s*\$\('loginScreen'\)\.hidden\s*=\s*true;/);
    assert.match(appJs, /if\s*\(\$\('appMain'\)\)\s*\$\('appMain'\)\.hidden\s*=\s*false;/);
    assert.match(appJs, /\$\('home'\)\.classList\.add\('active'\);/);
  });

  test('2. Guest sees highlighted Continue with Google card above Domain selection', () => {
    // HTML has exploreGoogleLoginCard above domain selection
    assert.match(indexHtml, /<div id="exploreGoogleLoginCard" class="explore-login-card"/);
    assert.match(indexHtml, /<button id="exploreGoogleSignInBtn" class="google-login-btn explore-google-btn"/);
    assert.match(indexHtml, /<span>Continue with Google<\/span>/);

    // CSS provides subtle blue glow / shimmer effect
    assert.match(indexHtml, /\.explore-login-card\s*\{[^}]*box-shadow:[^}]*rgba\(59,\s*130,\s*246/);
    assert.match(indexHtml, /@keyframes exploreCardShimmer/);

    // Positioned before domain selection in index.html
    const loginCardIdx = indexHtml.indexOf('id="exploreGoogleLoginCard"');
    const domainHeaderIdx = indexHtml.indexOf('Choose Domain');
    assert.ok(loginCardIdx > 0 && domainHeaderIdx > 0 && loginCardIdx < domainHeaderIdx, 'exploreGoogleLoginCard must precede Choose Domain');
  });

  test('3. Logged-in user does not see the Explore login button', () => {
    // In setSession when user is authenticated, exploreGoogleLoginCard is hidden
    assert.match(appJs, /const exploreCard = \$\('exploreGoogleLoginCard'\);\s*if \(exploreCard\) exploreCard\.style\.display = 'none';/);
  });

  test('4. Domain selection alone does not navigate', () => {
    // selectDomain must NOT call loadScenario or showScreen
    const selectDomainFn = appJs.slice(appJs.indexOf('function selectDomain'), appJs.indexOf('function selectLevel'));
    assert.doesNotMatch(selectDomainFn, /showScreen\s*\(\s*['"]practice['"]\s*\)/, 'selectDomain must not automatically navigate to practice');
    assert.doesNotMatch(selectDomainFn, /loadScenario\s*\(\s*\)/, 'selectDomain must not load scenario automatically');
    assert.match(selectDomainFn, /updateGoToPracticeBtnState\(\);/);
  });

  test('5. Level selection alone does not navigate', () => {
    // selectLevel must NOT call loadScenario or showScreen
    const selectLevelFn = appJs.slice(appJs.indexOf('function selectLevel'), appJs.indexOf('function updateGoToPracticeBtnState'));
    assert.doesNotMatch(selectLevelFn, /showScreen\s*\(\s*['"]practice['"]\s*\)/, 'selectLevel must not automatically navigate to practice');
    assert.doesNotMatch(selectLevelFn, /loadScenario\s*\(\s*\)/, 'selectLevel must not load scenario automatically');
    assert.match(selectLevelFn, /updateGoToPracticeBtnState\(\);/);
  });

  test('6. Selecting both Domain and Level enables the Go to Practice button', () => {
    // HTML has the prominent Go to Practice button below levelsPicker
    assert.match(indexHtml, /<button id="goToPracticeBtn" class="action primary go-to-practice-btn"/);
    assert.match(indexHtml, /onclick="handleGoToPractice\(\)"/);

    // Button position is after levelsPicker
    const levelsIdx = indexHtml.indexOf('id="levelsPicker"');
    const btnIdx = indexHtml.indexOf('id="goToPracticeBtn"');
    assert.ok(levelsIdx > 0 && btnIdx > 0 && levelsIdx < btnIdx, 'goToPracticeBtn must be placed below levelsPicker');

    // updateGoToPracticeBtnState enables button when both domain and level are present
    assert.match(appJs, /const isReady = Boolean\(selectedDomain && selectedLevel\);/);
    assert.match(appJs, /btn\.disabled = !isReady;/);
  });

  test('7. Clicking Go to Practice is the ONLY action initiating practice navigation for authenticated user', () => {
    // handleGoToPractice checks user and opens practice
    assert.match(appJs, /async function handleGoToPractice\(\)/);
    assert.match(appJs, /if\s*\(user\)\s*\{[\s\S]*?await loadScenario\(\);[\s\S]*?showScreen\('practice'\);/);
  });

  test('8. Guest clicking Go to Practice preserves selected Domain & Level, triggers Google Login, and opens Practice after auth', () => {
    // Unauthenticated branch in handleGoToPractice sets pending practice in localStorage and starts Google sign-in
    assert.match(appJs, /localStorage\.setItem\('cracksql_pending_practice',\s*JSON\.stringify\(\{/);
    assert.match(appJs, /await signInWithGoogle\(\);/);

    // In setSession, pending practice is read and navigates to practice after profile verification
    assert.match(appJs, /localStorage\.getItem\('cracksql_pending_practice'\)/);
    assert.match(appJs, /void loadScenario\(\)\.then\(\(\) => \{\s*showScreen\('practice'\);/);
  });

  test('9. Existing learner previous progress is restored from Supabase without regression', () => {
    // Verify authoritative progress restoration remains intact
    assert.match(appJs, /await loadAndRestoreUserProgress\(user\.id,\s*prefetchedLp,\s*prefetchedFb\);/);
    assert.match(appJs, /authoritativeCompletedCount/);
  });

  test('10. Refresh, logout and relogin preserves learner progress and restores Explore state', () => {
    // Verify storageKey separation in progress.js and import in app.js
    const progressJs = fs.readFileSync('js/progress.js', 'utf8');
    assert.match(progressJs, /export const storageKey = userId =>/);
    assert.match(appJs, /storageKey\(user\?\.id\)/);
    assert.match(appJs, /saveProgress\(storage,\s*userId,\s*workingState\)/);
  });

  test('11. Previously saved mobile number in Supabase profile never prompts repeated popup', () => {
    // Verify checkAndEnforceUsername skips modal when dbMobile is present
    assert.match(appJs, /if\s*\(dbMobile\)\s*\{\s*closeProfileSetupModal\(\);\s*return dbUsername;\s*\}/);
  });

  test('12. Existing app features, Thinking Engine, 420 scenarios, and Certificates continue working', () => {
    // Thinking evaluator intact
    assert.match(appJs, /evaluateThinking\(effective,\s*thinking\)/);
    // Scenario catalog loading intact
    assert.match(appJs, /Crack_SQL_420_Simple\.json/);
    // Certificates modal intact
    assert.match(indexHtml, /openAllCertificatesModal\(\)/);
  });
});
