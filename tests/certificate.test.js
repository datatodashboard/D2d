import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  CERTIFICATE_DOMAINS,
  CERTIFICATE_LEVELS,
  checkLevelCompletion,
  getEarnedCertificates,
  getAllCertificatesStatus,
  generateCertificateSvg,
  getLearnerDisplayName,
  formatCertificateLevel,
  formatCertificateDomain,
  formatCompletionDate
} from '../js/certificate.js';
import { isCompleted, EMPTY } from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Crack SQL Certificate of Completion System', () => {

  // 1. Structure & Domain/Level Coverage (21 Combinations)
  it('covers all 7 domains and 3 levels totaling 21 distinct certificates', () => {
    assert.strictEqual(CERTIFICATE_DOMAINS.length, 7, 'Must have 7 domains');
    const expectedDomains = [
      'Banking',
      'Healthcare',
      'Insurance',
      'Retail',
      'Capital Markets',
      'Semiconductor',
      'Education'
    ];
    assert.deepStrictEqual(CERTIFICATE_DOMAINS, expectedDomains);

    assert.strictEqual(CERTIFICATE_LEVELS.length, 3, 'Must have 3 levels');
    assert.deepStrictEqual(CERTIFICATE_LEVELS, ['Beginner', 'Intermediate', 'Expert']);

    // Check that scenarios.json contains exactly 20 scenarios for each of the 21 combinations (420 total)
    let totalCombinations = 0;
    for (const d of CERTIFICATE_DOMAINS) {
      for (const l of CERTIFICATE_LEVELS) {
        const pool = scenarios.filter(s => s.domain === d && s.level === l);
        assert.strictEqual(pool.length, 20, `${d} ${l} must contain exactly 20 distinct scenarios`);
        const uniqueIds = new Set(pool.map(s => s.id));
        assert.strictEqual(uniqueIds.size, 20, `${d} ${l} scenario IDs must all be distinct`);
        totalCombinations++;
      }
    }
    assert.strictEqual(totalCombinations, 21, 'Must have exactly 21 combinations');
    assert.strictEqual(scenarios.length, 420, 'Curriculum must contain 420 total scenarios');
  });

  // 2. Strict 20/20 Completion Rule
  it('requires all 20 valid scenarios to be completed before issuing certificate', () => {
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    assert.strictEqual(bankingBeg.length, 20);

    const state = EMPTY();

    // 0 / 20 completed
    let status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.isCompleted, false);
    assert.strictEqual(status.completedCount, 0);
    assert.strictEqual(status.totalCount, 20);
    assert.strictEqual(status.completionDate, null);

    // 19 / 20 completed (score >= 7)
    for (let i = 0; i < 19; i++) {
      state.entries[bankingBeg[i].id] = {
        thinking: { response: 'Good solution logic' },
        assessment: { score: 8, ready: true },
        completed: true,
        updatedAt: 1000 + i
      };
    }

    status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.isCompleted, false, '19/20 completed must NOT issue certificate');
    assert.strictEqual(status.completedCount, 19);

    // Scenario 20 attempted with low score (6/10) - must NOT count as completed
    state.entries[bankingBeg[19].id] = {
      thinking: { response: 'Incomplete logic' },
      assessment: { score: 6, ready: false },
      completed: false,
      updatedAt: 1020
    };

    status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.isCompleted, false, 'Score 6/10 on 20th question must NOT issue certificate');
    assert.strictEqual(status.completedCount, 19);

    // Scenario 20 successfully completed (score 9/10 >= 7)
    state.entries[bankingBeg[19].id] = {
      thinking: { response: 'Comprehensive and clear reasoning' },
      assessment: { score: 9, ready: true },
      completed: true,
      updatedAt: 1500
    };

    status = checkLevelCompletion('Banking', 'Beginner', scenarios, state);
    assert.strictEqual(status.isCompleted, true, '20/20 completed must issue certificate');
    assert.strictEqual(status.completedCount, 20);
    assert.ok(status.completionDate, 'Must have completion date');
    assert.strictEqual(status.completedScenarioIds.length, 20);
  });

  // 3. Counting each scenario once even after retries and repeated submissions
  it('counts each scenario once regardless of retries or repeat submissions', () => {
    const healthcareInt = scenarios.filter(s => s.domain === 'Healthcare' && s.level === 'Intermediate');
    const state = EMPTY();

    // Complete scenario 1 with 5 repeated attempts / retries
    state.entries[healthcareInt[0].id] = {
      thinking: { response: 'Attempt 5 passed' },
      assessment: { score: 10, ready: true },
      completed: true,
      attempts: 5,
      updatedAt: 2000
    };

    let status = checkLevelCompletion('Healthcare', 'Intermediate', scenarios, state);
    assert.strictEqual(status.completedCount, 1, 'Only counts as 1 completed scenario despite 5 attempts');
  });

  // 4. Multiple domains and levels are separate certificates
  it('tracks certificates independently across domains and levels', () => {
    const state = EMPTY();
    const user = {
      user_metadata: { full_name: 'Sundar V' },
      email: 'sundar.developer07@gmail.com'
    };

    // Complete 20 in Banking Beginner
    const banBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    banBeg.forEach((s, idx) => {
      state.entries[s.id] = { assessment: { score: 8 }, completed: true, updatedAt: 1000 + idx };
    });

    // Complete 20 in Retail Intermediate
    const retInt = scenarios.filter(s => s.domain === 'Retail' && s.level === 'Intermediate');
    retInt.forEach((s, idx) => {
      state.entries[s.id] = { assessment: { score: 9 }, completed: true, updatedAt: 2000 + idx };
    });

    const earned = getEarnedCertificates(scenarios, state, user, 'sundar07');
    assert.strictEqual(earned.length, 2, 'Must have exactly 2 earned certificates');

    const banBegCert = earned.find(c => c.domain === 'Banking' && c.level === 'Beginner');
    assert.ok(banBegCert, 'Banking Beginner certificate earned');
    assert.strictEqual(banBegCert.learnerName, 'Sundar V');

    const retIntCert = earned.find(c => c.domain === 'Retail' && c.level === 'Intermediate');
    assert.ok(retIntCert, 'Retail Intermediate certificate earned');
    assert.strictEqual(retIntCert.learnerName, 'Sundar V');

    // Check all status list returns 21 items with 2 completed and 19 pending
    const allStatus = getAllCertificatesStatus(scenarios, state, user, 'sundar07');
    assert.strictEqual(allStatus.length, 21);
    const completedCount = allStatus.filter(c => c.isCompleted).length;
    assert.strictEqual(completedCount, 2);
  });

  // 5. Dynamic Learner Name extraction
  it('correctly derives learner name from profile metadata and username with graceful fallback', () => {
    // 1. Google OAuth full_name
    assert.strictEqual(
      getLearnerDisplayName({ user_metadata: { full_name: 'Ramgokul' } }, 'ramgokul'),
      'Ramgokul'
    );

    // 2. Google OAuth name
    assert.strictEqual(
      getLearnerDisplayName({ user_metadata: { name: 'Dr. Jane Watson' } }, null),
      'Dr. Jane Watson'
    );

    // 3. Saved username
    assert.strictEqual(
      getLearnerDisplayName({ user_metadata: {} }, 'datadeveloper'),
      'datadeveloper'
    );

    // 4. Email prefix fallback
    assert.strictEqual(
      getLearnerDisplayName({ user_metadata: {}, email: 'alexander@example.com' }, null),
      'Alexander'
    );

    // 5. Unauthenticated guest fallback
    assert.strictEqual(
      getLearnerDisplayName(null, null),
      'Guest Learner'
    );
  });

  // 6. Certificate Design and Exact Content Structure
  it('generates Certificate SVG with exact content structure 1-10 matching image.png', () => {
    const certSvg = generateCertificateSvg({
      userName: 'Sundararajan V',
      level: 'BEGINNER',
      domain: 'Banking',
      completionDate: 'October 7, 2026'
    });

    // 1. Top: Crack SQL
    assert.ok(certSvg.includes('Crack '), 'Must include Crack');
    assert.ok(certSvg.includes('SQL'), 'Must include SQL');

    // 2. Main heading: CERTIFICATE OF COMPLETION
    assert.ok(certSvg.includes('CERTIFICATE OF COMPLETION'), 'Must include CERTIFICATE OF COMPLETION');

    // 3. Presentation text: This certificate is proudly presented to
    assert.ok(certSvg.includes('This certificate is proudly presented to'), 'Must include presentation text');

    // 4. Dynamic learner name
    assert.ok(certSvg.includes('Sundararajan V'), 'Must include learner name');

    // 5. Completion text: for successfully completing
    assert.ok(certSvg.includes('for successfully completing'), 'Must include completion text');

    // 6. Dynamic level: [LEVEL] LEVEL (Pill)
    assert.ok(certSvg.includes('BEGINNER LEVEL'), 'Must include BEGINNER LEVEL');

    // 7. Domain: in [DOMAIN]
    assert.ok(/>\s*in\s*</.test(certSvg), 'Must include in');
    assert.ok(certSvg.includes('BANKING'), 'Must include BANKING');

    // 8. Completion statement
    assert.ok(certSvg.includes('The learner has successfully completed 20 SQL scenarios'), 'Must include scenarios statement');
    assert.ok(certSvg.includes('and demonstrated the required SQL thinking skills for this level.'), 'Must include thinking statement');

    // 9. Completion date: Completion Date & [COMPLETION DATE]
    assert.ok(certSvg.includes('Completion Date'), 'Must include Completion Date label');
    assert.ok(certSvg.includes('October 7, 2026'), 'Must include formatted completion date');

    // 10. Footer: Powered by Data to Dashboard
    assert.ok(certSvg.includes('Powered by '), 'Must include Powered by');
    assert.ok(certSvg.includes('Data to Dashboard'), 'Must include Data to Dashboard');

    // Strict Negative Constraints:
    // - Do not add extra sections, signatures, certificate IDs, QR codes, logos, scores, or unnecessary information.
    assert.strictEqual(certSvg.includes('Signature'), false, 'Must NOT contain signature');
    assert.strictEqual(certSvg.includes('Credential ID'), false, 'Must NOT contain credential ID');
    assert.strictEqual(certSvg.includes('Certificate ID'), false, 'Must NOT contain certificate ID');
    assert.strictEqual(certSvg.includes('QR code'), false, 'Must NOT contain QR code');
    assert.strictEqual(certSvg.includes('qrcode'), false, 'Must NOT contain QR code');
    assert.strictEqual(certSvg.includes('/ 10'), false, 'Must NOT contain score');
  });

  // 7. Long Learner Name Fitting and XML Safety
  it('escapes special characters and supports long user names without syntax errors', () => {
    const longName = 'Dr. Alexander Bartholomew Christopher Montgomery & Sons';
    const certSvg = generateCertificateSvg({
      userName: longName,
      level: 'Expert',
      domain: 'Capital Markets',
      completionDate: 'October 7, 2026'
    });

    // Special XML char & must be escaped as &amp;
    assert.ok(certSvg.includes('&amp;'), 'Ampersand must be XML-escaped');
    assert.ok(!certSvg.includes('Montgomery & Sons'), 'Unescaped & must not appear in raw XML');
    assert.ok(certSvg.includes('EXPERT LEVEL'), 'Level must be EXPERT LEVEL');
    assert.ok(certSvg.includes('CAPITAL MARKETS'), 'Domain must be CAPITAL MARKETS');
  });

  // 8. Level Completion Wrap-around Prevention in app.js
  it('verifies app.js prevents question 20 wrap-around and triggers level completion modal', () => {
    const appJsContent = fs.readFileSync('./js/app.js', 'utf8');

    // Must not contain the old silent wraparound fallback: next = pool[(currentIndex + 1) % pool.length];
    assert.ok(
      appJsContent.includes('openLevelCompletionModal'),
      'app.js must call openLevelCompletionModal on 20/20 completion'
    );

    // Must check allCompleted
    assert.ok(
      appJsContent.includes('allCompleted = pool.every'),
      'app.js must check allCompleted when no next uncompleted scenario is found'
    );

    // Must export certificate handlers on window
    assert.ok(appJsContent.includes('openCertificateModal'), 'app.js must provide openCertificateModal');
    assert.ok(appJsContent.includes('downloadCertificateImage'), 'app.js must provide downloadCertificateImage');
    assert.ok(appJsContent.includes('renderCertificatesSection'), 'app.js must provide renderCertificatesSection');
  });

  // 9. Index.html DOM Integration
  it('verifies index.html contains certificate modal, level completion modal, and My Certificates card', () => {
    const indexHtml = fs.readFileSync('./index.html', 'utf8');

    assert.ok(indexHtml.includes('id="certificateModal"'), 'index.html must have certificateModal');
    assert.ok(indexHtml.includes('id="levelCompletionModal"'), 'index.html must have levelCompletionModal');
    assert.ok(indexHtml.includes('id="progressCertificatesCard"'), 'index.html must have progressCertificatesCard');
    assert.ok(indexHtml.includes('id="certificatesGrid"'), 'index.html must have certificatesGrid');
    assert.ok(indexHtml.includes('id="modalProfileCertificates"'), 'index.html must have modalProfileCertificates');
  });
});
