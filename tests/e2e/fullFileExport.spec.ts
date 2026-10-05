import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openReducedLas } from './reducedLas';

/**
 * "Export all N points": a LAS file large enough that the loader reduces it
 * for display offers the action beside the sample notices. The action opens
 * Export with full resolution ticked, and the written file holds every point
 * the header declared, with a "full file" provenance line.
 *
 * The device reports 2 GB so the render budget is the low tier's; the file is
 * built here, a little over that budget, so the load is reduced.
 */

const N = 1_500_000;

test('the sample notice offers Export all N points and the file holds every declared point', async ({ page }) => {
  test.setTimeout(480_000);
  await openReducedLas(page, N, 2);

  const link = page.locator('.olv-ss-fullfile [data-full-file="export"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveText(/^Export all 1\.5 M points$/);
  await link.dispatchEvent('click');

  const panel = page.locator('.olv-export-panel');
  // The action itself navigates to Output. A software renderer drawing a
  // million points rarely yields two still frames, so clicks below go to the
  // elements directly rather than waiting for layout stability.
  await expect(panel).toBeVisible({ timeout: 120_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').dispatchEvent('click');
  }
  await expect(panel.getByRole('checkbox', { name: 'Convert at full resolution' })).toBeChecked();
  await expect(panel.locator('.olv-export-summary')).toContainText('Point basis: full file (1,500,000 points)');

  const download = page.waitForEvent('download');
  await panel.locator('.olv-bc-convert').dispatchEvent('click');
  const confirm = page.getByRole('button', { name: 'Export anyway' });
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.dispatchEvent('click');
  const file = await download;
  const bytes = readFileSync((await file.path())!);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = v.getUint8(24), minor = v.getUint8(25);
  const count = minor >= 4 && major === 1 ? Number(v.getBigUint64(247, true)) : v.getUint32(107, true);
  expect(count).toBe(N);
  expect(file.suggestedFilename()).not.toContain('-sample');
  expect(bytes.toString('latin1')).toContain('Point basis: full file (1,500,000 points)');
});
