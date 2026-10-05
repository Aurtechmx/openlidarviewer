import { test, expect, type Page } from '@playwright/test';
import { openReducedLas } from './reducedLas';

/**
 * "Reload at higher density": a reduced LAS on a medium-tier device reopens
 * at a raised budget. Layer Health reports the new resident count, and a
 * measurement placed before the reload is still there after it.
 */

/** The Loading row's value, e.g. "display sample: 2,000,000 of 2,400,000 declared points resident". */
async function loadingRow(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const row of Array.from(document.querySelectorAll('.olv-layerhealth-row'))) {
      if (row.querySelector('dt')?.textContent === 'Loading') return row.querySelector('dd')?.childNodes[0]?.textContent ?? '';
    }
    return '';
  });
}

const N = 2_400_000;

test('reload raises the resident count and keeps measurements', async ({ page }) => {
  // Two decodes of 2.4 M points through a software renderer. Passing CI runs
  // took 8.5 to 13 minutes, and a 2x CPU-throttled local run 12 minutes, so the
  // budget leaves room above that. The waits below end on state, not time.
  test.setTimeout(1_200_000);
  await openReducedLas(page, N, 4);
  // The Layer Health card mounts from a lazily loaded chunk after the scan
  // opens, and on a slow software renderer that can take minutes. The Basis
  // item only reveals the card (focusLayerHealth is a no-op while the slot is
  // empty), so the poll clicks it again until the Loading row exists, within
  // the test's own budget.
  await expect.poll(async () => {
    await page.locator('.olv-ss-basis').dispatchEvent('click').catch(() => {});
    return loadingRow(page);
  }, { timeout: 0, intervals: [5_000] }).toMatch(/^display sample: [\d,]+ of 2,400,000 declared points resident$/);
  const before = Number((await loadingRow(page)).match(/^display sample: ([\d,]+)/)![1].replace(/,/g, ''));

  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureMode(on: boolean): void; setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void; finishMeasurement?(): void } }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 1, y: 1, z: 0 });
    api.placeMeasurementPoint({ x: 5, y: 5, z: 0 });
    api.finishMeasurement?.();
    api.setMeasureMode(false);
  });
  const count = () => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { getMeasurementCount(): number } }).__OLV_TEST_API__.getMeasurementCount());
  expect(await count()).toBe(1);

  const link = page.locator('.olv-ss-fullfile [data-full-file="reload"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveText('Reload all 2.4 M points');
  // A software renderer drawing millions of points rarely yields two still
  // frames, so clicks go to the elements directly.
  await link.dispatchEvent('click');
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Reload', exact: true });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Shows all 2.4 M points. Needs about')).toBeVisible();
  await confirm.dispatchEvent('click');

  // The reopen decodes 2.4 M points again. It is waited on by its outcome, the
  // Loading row reading "fully loaded", within the test's own budget rather
  // than a shorter fixed window that a slow runner can outlast.
  await expect.poll(async () => {
    await page.locator('.olv-ss-basis').dispatchEvent('click').catch(() => {});
    return loadingRow(page);
  }, { timeout: 0, intervals: [5_000] }).toBe('fully loaded');
  expect(before).toBeLessThan(N);
  expect(await page.evaluate(() => document.querySelectorAll('.olv-layerhealth-layer').length)).toBe(1);
  expect(await count()).toBe(1);
  await expect(page.locator('.olv-ss-fullfile [data-full-file]')).toHaveCount(0);
});
