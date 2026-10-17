import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`scenario heading and padded ID survive question navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.waitForFunction(() => typeof window.openScenario === 'function');
    await expect(page.locator('.domain').first()).toBeAttached();
    for (const suffix of ['001', '002', '006']) {
      await page.evaluate(id => window.openScenario(id), `BAN_BEG_${suffix}`);
      await expect(page.locator('#title')).toHaveText(`Business Scenario • BAN_BEG_${suffix}`);
      await expect(page.locator('#qno')).toHaveText(`Exercise ${Number(suffix)} / 20`);
    }
    await expect(page.locator('#question')).toHaveText('List distinct account product categories available in the banking portfolio.');
    // Isolate the rendered card for layout checks without a live Google login.
    // The real app renderer and stylesheet above are used unchanged.
    await page.evaluate(() => {
      const card = document.querySelector('#practice .scenario-head').closest('.card').cloneNode(true);
      document.body.replaceChildren(card);
    });
    await expect(page.locator('#title')).toBeVisible();
    await expect(page.locator('#question')).toBeVisible();
    const heading = await page.locator('#title').boundingBox();
    const badge = await page.locator('#qno').boundingBox();
    expect(heading.x + heading.width).toBeLessThanOrEqual(badge.x);
  });
}
