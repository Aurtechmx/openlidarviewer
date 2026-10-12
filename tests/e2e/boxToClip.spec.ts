import { test, expect } from '@playwright/test';
import { dropDenseGridPly, openToolPage } from './helpers';

/**
 * A completed Box measurement becomes the clipping region from its row in the
 * Measurements panel: the Clip page opens with the box's bounds, enabled,
 * keeping the inside, and the kept count settles.
 */
test('Box measurement → Use as clipping region → the Clip page shows its bounds', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openToolPage(page, 'Measure');
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: {
      setMeasureMode: (on: boolean) => void;
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
      getMeasurementCount: () => number;
    } }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('box');
    api.placeMeasurementPoint({ x: 2, y: 2, z: 2 });
    api.placeMeasurementPoint({ x: -2, y: -2, z: -2 });
    if (api.getMeasurementCount() !== 1) throw new Error(`box not committed: ${api.getMeasurementCount()}`);
  });

  const action = page.locator('.olv-mp-use-clip');
  await expect(action).toHaveCount(1, { timeout: 10_000 });
  await action.click();

  const clip = page.locator('.olv-clip-panel');
  await expect(clip).toBeVisible({ timeout: 10_000 });
  await clip.locator('summary', { hasText: 'Advanced' }).click();
  const nums = clip.locator('input.olv-clip-num');
  await expect(nums.nth(0)).toBeVisible();
  await expect(nums.nth(0)).toHaveValue('-2');
  await expect(nums.nth(1)).toHaveValue('2');
  await expect(nums.nth(5)).toHaveValue('2');
  await expect(clip.locator('.olv-clip-enable input')).toBeChecked();
  await expect(clip.locator('.olv-bc-pill', { hasText: 'Inside' })).toHaveAttribute('aria-pressed', 'true');
  await expect(clip.locator('[role="status"]')).toContainText(/of 3,600 points kept/);
});
