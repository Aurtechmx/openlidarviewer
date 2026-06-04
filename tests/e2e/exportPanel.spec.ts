import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * In-project Export / Convert panel — converts the open cloud to another
 * format. Needs a loaded scan (WebGL), so it runs where a GPU context exists.
 */

test('after a scan loads, the Export panel offers formats and exports a file', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // Expand it (panels mount collapsed).
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }

  // LAS active by default; LAZ honestly disabled.
  await expect(panel.locator('.olv-bc-pill.is-active', { hasText: 'LAS' })).toBeVisible();
  await expect(panel.locator('.olv-bc-pill', { hasText: 'LAZ' })).toBeDisabled();

  // Full-resolution toggle is present. The small test grid isn't reduced, so
  // the box is disabled with an honest "already full resolution" note.
  await expect(panel.locator('.olv-export-fullres-box')).toBeVisible();
  await expect(panel.locator('.olv-export-fullres-hint')).toContainText(/full resolution/i);

  // Pick XYZ (small text output) and export → a download fires.
  await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('.olv-export-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xyz$/);

  // Status confirms the export and reports points.
  await expect(panel.locator('.olv-export-status')).toContainText(/points|Exported/i);
});
