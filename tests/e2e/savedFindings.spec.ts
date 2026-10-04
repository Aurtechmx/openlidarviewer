import { test, expect } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode, placeTestDistance, openToolPage } from './helpers';

/**
 * Saved findings in the Export panel: Clear all offers an inline Undo that
 * restores the list, and exporting the report reports a started download.
 */
test('saved findings: Clear all can be undone and the report export says it started', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openToolPage(page, 'Measure');
  await placeTestDistance(page);

  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }

  const findings = panel.locator('.olv-findings-panel');
  await expect(findings).toBeVisible({ timeout: 20_000 });
  const rows = findings.locator('.olv-findings-row');
  const status = findings.locator('.olv-findings-status');

  await findings.locator('.olv-findings-add').click();
  await expect(rows).toHaveCount(1, { timeout: 10_000 });

  await findings.locator('.olv-findings-clear').click();
  await expect(rows).toHaveCount(0);
  await expect(findings.locator('.olv-findings-empty')).toBeVisible();
  const undo = status.locator('.olv-findings-undo');
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(rows).toHaveCount(1);
  await expect(status).toContainText('Restored 1 finding(s).');

  const downloadPromise = page.waitForEvent('download');
  await findings.locator('.olv-findings-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  await expect(status).toHaveText('Report download started.');
  await expect(rows).toHaveCount(1);
});
