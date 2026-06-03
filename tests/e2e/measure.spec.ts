import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, dropDenseGridPly } from './helpers';

/**
 * Measurement toolkit coverage — the toolbar, kind picker, and units toggle
 * (DOM-driven, deterministic), plus a full placement round-trip for the
 * distance tool. The placement test also guards the v0.1.0 straight-line
 * distance measurement against regression.
 */

/** Load a tiny scan and enter measurement mode. */
async function loadSampleAndMeasure(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so canvas clicks land on the cloud.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}

/**
 * Variant of `loadSampleAndMeasure` that uses a 900-point grid instead of
 * the 10-point `tiny.ply`. Used by the programmatic measurement seam
 * spec (the dense fixture gives the addPoint world-coords something to
 * be inside).
 */
async function loadDenseSampleAndMeasure(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}
// Mark the helper as used regardless of how the spec body evolves —
// the dense-grid fixture is the only place it's referenced today.
void loadDenseSampleAndMeasure;

test('the measurement toolbar shows the full kind picker', async ({ page }) => {
  await loadSampleAndMeasure(page);
  // Nine measurement kinds: distance, polyline, area, height, angle,
  // slope, profile, volume (cut/fill), box. Volume + box landed in
  // v0.3.7 Stream B. The v0.3.8 Lasso button sits in the kind row as
  // a sub-action of Volume (class `olv-mkind olv-mkind-aux`) — exclude
  // it from the kind count since it's a different input method, not a
  // tenth measurement kind.
  await expect(page.locator('.olv-mkind:not(.olv-mkind-aux)')).toHaveCount(9);
  await expect(page.locator('.olv-mkind-active')).toHaveText('Distance');
});

test('the kind picker includes the new Profile kind', async ({ page }) => {
  await loadSampleAndMeasure(page);
  await expect(page.locator('.olv-mkind', { hasText: 'Profile' })).toBeVisible();
  await page.locator('.olv-mkind', { hasText: 'Profile' }).click();
  await expect(page.locator('.olv-mkind-active')).toHaveText('Profile');
});

test('selecting a kind highlights it', async ({ page }) => {
  await loadSampleAndMeasure(page);
  await page.locator('.olv-mkind', { hasText: 'Area' }).click();
  await expect(page.locator('.olv-mkind-active')).toHaveText('Area');
});

test('the units toggle flips between metric and imperial', async ({ page }) => {
  await loadSampleAndMeasure(page);
  const toggle = page.locator('.olv-units-toggle');
  await expect(toggle).toHaveText('Metric');
  await toggle.click();
  await expect(toggle).toHaveText('Imperial');
  await toggle.click();
  await expect(toggle).toHaveText('Metric');
});

// v0.3.10 trust-pass — the canvas-click → ray-pick → measurement-commit path is
// flaky on headless WebGL 2, which is why this used to be `test.fixme`. The fix
// is a programmatic placement seam: `window.__OLV_TEST_API__.placeMeasurementPoint`
// is mounted when the page is opened with `?test=1` and bypasses the raycast,
// pushing a world-space point directly into MeasureController.addPoint. The
// canvas-click path is still hand-tested via the live demo before each release;
// this spec covers the measurement-commit / list-render / Clear-all round-trip
// deterministically.
test(
  'placing a distance measurement programmatically lists it, and Clear all removes it',
  async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(500); // let the test API mount on viewerLoaded
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();

    // Place a distance measurement (kind defaults to 'distance' after the
    // measure tool arms). Two world-space points: a synthetic 0→1 metre on
    // the X axis. The dense grid fixture spans roughly [-5, +5] on each
    // axis, so these coordinates are well inside it.
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__?: {
        setMeasureKind: (k: string) => void;
        placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
      } }).__OLV_TEST_API__;
      if (!api) throw new Error('__OLV_TEST_API__ not mounted — was ?test=1 set?');
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
    });

    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

    await page.locator('.olv-measure-clear').click();
    await expect(page.locator('.olv-mp-row')).toHaveCount(0);
  },
);

test('exporting produces a session download', async ({ page }) => {
  await loadSampleAndMeasure(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.olv-mp-action', { hasText: 'Export' }).click(),
  ]);
  // The export uses the current scan's name with an `.olvsession` suffix —
  // the canonical v3 session-file extension.
  expect(download.suggestedFilename()).toMatch(/\.olvsession$/);
});
