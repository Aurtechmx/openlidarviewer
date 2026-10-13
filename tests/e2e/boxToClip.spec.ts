import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, openToolPage } from './helpers';

type Point = { x: number; y: number; z: number };

/** Load the dense grid, open Measure and commit one Box from corner `a` to corner `b`. */
async function drawBox(page: Page, a: Point, b: Point): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openToolPage(page, 'Measure');
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  await page.evaluate(([p, q]) => {
    const api = (window as unknown as { __OLV_TEST_API__: {
      setMeasureMode: (on: boolean) => void;
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
      getMeasurementCount: () => number;
    } }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('box');
    api.placeMeasurementPoint(p);
    api.placeMeasurementPoint(q);
    if (api.getMeasurementCount() !== 1) throw new Error(`box not committed: ${api.getMeasurementCount()}`);
  }, [a, b] as const);
}

/**
 * A completed Box measurement becomes the clipping region from its row in the
 * Measurements panel: the Clip page opens with the box's bounds, enabled,
 * keeping the inside, and the kept count settles.
 */
test('Box measurement → Use as clipping region → the Clip page shows its bounds', async ({ page }) => {
  await drawBox(page, { x: 2, y: 2, z: 2 }, { x: -2, y: -2, z: -2 });

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

/**
 * The box label drawn in the scene uses the scan's unit status, as the panel
 * does: a cloud with no CRS reads source units marked unverified, never m,
 * cm or dm³.
 */
test('Box measurement on a no-CRS cloud → the scene label reads unit unverified', async ({ page }) => {
  await drawBox(page, { x: 1.5, y: 0.5, z: 0.002 }, { x: -1.5, y: -0.5, z: -0.002 });

  const label = page.locator('text.olv-m-label-primary');
  await expect(label).toHaveCount(1, { timeout: 10_000 });
  const text = (await label.textContent()) ?? '';
  expect(text).toContain('(unit unverified)');
  expect(text).not.toMatch(/ m\b|m³|cm|dm³/);
  await expect(page.locator('.olv-mp-value').first()).toHaveText(text);
});
