/**
 * webgl2Path.spec.ts — the WebGL 2 floor, forced.
 *
 * `?backend=webgl2` pins the renderer to WebGL 2 even where a WebGPU adapter is
 * usable, so the fallback path every browser without WebGPU takes is exercised
 * on any runner. The backend is read back from the app itself (the tool dock's
 * backend label, set from `Viewer.activeBackend()`), never assumed from the flag.
 */

import { test, expect } from '@playwright/test';
import {
  bootAndOpenTiny,
  collectPageErrors,
  expectDrawn,
  expectOrbitMovesCamera,
  reportedBackend,
} from './viewerFloor';

test.describe('forced WebGL 2 backend', () => {
  test('boots on WebGL 2, draws a scan, orbits, and records a measurement', async ({ page }) => {
    const errors = collectPageErrors(page);
    await bootAndOpenTiny(page, '&backend=webgl2');

    expect(await reportedBackend(page)).toBe('WebGL 2');
    await expectDrawn(page);
    await expectOrbitMovesCamera(page);

    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__?: {
        setMeasureKind: (k: string) => void;
        placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
        getMeasurementCount: () => number;
      } }).__OLV_TEST_API__;
      if (!api) throw new Error('__OLV_TEST_API__ not mounted');
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
    });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

    expect(errors).toEqual([]);
  });
});
