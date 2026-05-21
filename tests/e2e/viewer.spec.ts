import { test, expect } from '@playwright/test';

/**
 * Drop-and-render coverage. The sample buttons load the bundled fixture
 * scans (a local fetch — no upload), exercising the same
 * load → render → validate path a dropped file takes.
 */

test('loads a drone survey sample and shows the scan report', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  await page.getByText('Drone survey').click();

  // The empty state gives way to the rendered cloud.
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);
  // The Scan Report (Health Check + Scan Report rows) is populated.
  await expect(page.locator('.olv-report-row').first()).toBeVisible();
});

test('loads a second scan as a separate layer', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey').click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.getByText('Phone scan').click();
  await expect(page.locator('.olv-layer')).toHaveCount(2);
});

test('embed mode strips the top bar', async ({ page }) => {
  await page.goto('/?embed=1');
  await expect(page.locator('.olv-topbar')).toHaveCount(0);
  await expect(page.locator('.olv-canvas')).toBeVisible();
});
