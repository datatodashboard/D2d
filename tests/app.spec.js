import { test, expect } from '@playwright/test';

test.describe('Crack SQL Web Application E2E', () => {
  test('loads home page and displays application shell', async ({ page }) => {
    await page.goto('/');

    // Verify page title
    await expect(page).toHaveTitle(/Crack SQL/);

    // Verify main content and core elements load
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // Verify scenario or ide interface container is present
    const headerOrTitle = page.locator('h1, header, .app-header, .brand, #splashScreen');
    await expect(headerOrTitle.first()).toBeAttached();
  });

  test('scenarios data endpoint is accessible', async ({ request }) => {
    const response = await request.get('/data/scenarios.json');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.scenarios).toBeInstanceOf(Array);
    expect(data.scenarios.length).toBeGreaterThan(0);
  });

  test('admin dashboard loads cleanly and handles unauthenticated state', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/admin.html');

    // Verify title
    await expect(page).toHaveTitle(/Admin/);

    // Verify gate screen is displayed
    const gate = page.locator('#gate');
    await expect(gate).toBeVisible();

    // Verify dashboard is initially hidden
    await expect(page.locator('#dashboard')).toBeHidden();

    // Verify no uncaught JavaScript exceptions during startup
    expect(pageErrors).toEqual([]);
  });
});
