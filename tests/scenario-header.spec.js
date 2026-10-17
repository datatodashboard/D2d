import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const catalog = JSON.parse(fs.readFileSync('data/Crack_SQL_420_Simple.json', 'utf8'));
const instruction = 'How would you prepare this information? Explain your approach in your own words. You do not need to write SQL.';
const business = 'A bank manager is preparing a review of account products.\n\nPrepare a list of the different category values found in the account products records. Include each value once and arrange the list alphabetically. If a value is missing, include one empty entry at the end.';
async function openApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.openScenario === 'function');
  await expect(page.locator('.domain').first()).toBeAttached();
}
async function isolateRenderedCard(page) {
  // Layout fixture without live Google authentication. Preserve actual DOM and CSS scope.
  await page.evaluate(() => {
    const card = document.querySelector('#practice .scenario-head').closest('.card').cloneNode(true);
    const practice = document.createElement('section');
    practice.id = 'practice'; practice.className = 'active'; practice.append(card);
    document.body.replaceChildren(practice);
  });
}
for (const width of [1280, 768, 390]) {
  test(`actual Banking, Healthcare and Insurance questions render at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openApp(page);
    for (const id of ['HEA_BEG_002', 'INS_INT_008', 'BAN_BEG_006']) {
      const s = catalog.find(s => s.id === id);
      await page.evaluate(id => window.openScenario(id), id);
      await expect(page.locator('#title')).toHaveText(`${s.domain} ${s.level} Question ${Number(id.slice(-3))}`);
      await expect(page.locator('#scenarioId')).toHaveText(`(${id})`);
      await expect(page.locator('#qno')).toHaveText(`Exercise ${Number(id.slice(-3))} / 20`);
      const original = s.question || s.business_scenario;
      const hasInstruction = original.endsWith(instruction);
      await expect(page.locator('#question')).toHaveText(hasInstruction ? original.slice(0, -instruction.length).trim() : original);
      await expect(page.locator('#thinkingInstruction')).toHaveText(hasInstruction ? instruction : '');
      if (!hasInstruction) await expect(page.locator('#thinkingInstructionCard')).toBeHidden();
    }
    await isolateRenderedCard(page);
    await expect(page.locator('#title')).toBeVisible();
    await expect(page.locator('#question')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test(`long question separates instruction without duplication at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    // Exercise question-field-only content through the real loader without editing production JSON.
    await page.route('**/data/Crack_SQL_420_Simple.json', async route => {
      const fixture = structuredClone(catalog);
      const s = fixture.find(s => s.id === 'BAN_BEG_006');
      delete s.business_scenario;
      s.question = business + '\n\n' + instruction;
      s.pseudo = 'ANSWER MUST NOT APPEAR';
      await route.fulfill({ json: fixture });
    });
    await openApp(page);
    await page.evaluate(() => window.openScenario('BAN_BEG_006'));
    await expect(page.locator('#question')).toHaveText(business);
    await expect(page.locator('#thinkingInstruction')).toHaveText(instruction);
    await expect(page.locator('#scenarioId')).toHaveText('(BAN_BEG_006)');
    await isolateRenderedCard(page);
    await expect(page.locator('#thinkingInstructionCard')).toBeVisible();
    await expect(page.locator('#question')).not.toContainText(instruction);
    await expect(page.locator('#question')).not.toContainText('ANSWER MUST NOT APPEAR');
    const scenarioBox = await page.locator('#question').boundingBox();
    const thinkingBox = await page.locator('#thinkingInstructionCard').boundingBox();
    expect(thinkingBox.y).toBeGreaterThan(scenarioBox.y + scenarioBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `../../practice-ui-${width}.png`, fullPage: true });
  });
}
