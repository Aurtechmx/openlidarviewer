import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openExpandedPanel, showWorkspaceMode } from './helpers';

/**
 * An active clip box shows outside the Clip page: on the state strip, in the
 * Export panel's scope and summary, and in the exported file's provenance.
 * The export keeps writing only the clipped points; this spec checks that it
 * says so.
 */
test('an active clip is stated on the strip, in Export and in the written file', async ({ page }) => {
  const panel = await openExpandedPanel(page, 'work', '.olv-clip-panel');
  await panel.locator('label', { hasText: 'Clip the scan to this box' }).click();
  const xMax = panel.locator('input.olv-clip-num').nth(1);
  await xMax.fill('0');
  const kept = panel.locator('[role="status"]');
  await expect(kept).toContainText(/of 3,600 points kept/);
  await expect(kept).not.toContainText(/^3,600 of/);
  const keptCount = (await kept.textContent())!.match(/^([\d,]+) of/)![1];
  const scope = `Clipped: ${keptCount} of 3,600 points`;

  await expect(page.locator('.olv-ss-clip')).toContainText(scope);
  await expect(xMax).toHaveAccessibleName('X max');

  await showWorkspaceMode(page, 'output');
  const exp = page.locator('.olv-export-panel');
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if (await exp.evaluate((el) => el.classList.contains('olv-collapsed'))) await exp.locator('.olv-panel-head').click();
  await expect(exp.locator('.olv-health-row', { hasText: 'Scan scope' })).toContainText(scope);
  await expect(exp.locator('.olv-export-summary')).toContainText(`${keptCount} points`);

  await exp.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  const downloadPromise = page.waitForEvent('download');
  await exp.locator('.olv-bc-convert').click();
  const path = await (await downloadPromise).path();
  expect(readFileSync(path!, 'utf8')).toContain(`# ${scope}\n`);
  await expect(exp.locator('.olv-export-status')).toContainText(`Exported ${keptCount} points · ${scope}`);
});
