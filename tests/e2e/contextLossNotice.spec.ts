import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * WebGL context loss and restore. The loss is forced with WEBGL_lose_context on
 * the viewer canvas, which only works on the WebGL 2 backend; on a runner whose
 * adapter gives WebGPU the test skips.
 *
 * After the restore the viewer rebuilds its renderer on the same canvas
 * (`contextRecovery.ts`): draw calls resume, the scan is visible again, and the
 * camera and the measurement are the ones from before the loss.
 */

type TestApi = {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
  getCameraPose: () => unknown;
};
type Win = { __OLV_TEST_API__: TestApi; __olvLose: WEBGL_lose_context; __olvDraws: number };

/** Pixels in the canvas screenshot that differ from its corner (background) colour. */
async function litPixels(page: Page): Promise<number> {
  const png = (await page.locator('.olv-canvas').screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r0, g0, b0] = [d[0], d[1], d[2]];
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 60) lit++;
    }
    return lit;
  }, png);
}

const draws = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Win).__olvDraws);

test('a lost WebGL context is rebuilt on restore: the scan redraws with camera and measurement intact', async ({ page }) => {
  // Count every WebGL 2 draw call the page issues.
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    w.__olvDraws = 0;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[name];
      proto[name] = function (this: unknown, ...a: unknown[]) {
        w.__olvDraws++;
        return orig.apply(this, a);
      };
    }
  });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);

  const canvas = page.locator('.olv-canvas');
  const hasWebgl = await canvas.evaluate((c) => {
    const gl = (c as HTMLCanvasElement).getContext('webgl2');
    return !!gl?.getExtension('WEBGL_lose_context');
  });
  test.skip(!hasWebgl, 'viewer is not on a WebGL 2 context with WEBGL_lose_context');

  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as Win).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
  const litBefore = await litPixels(page);
  expect(litBefore).toBeGreaterThan(500);
  const poseBefore = await page.evaluate(() => (window as unknown as Win).__OLV_TEST_API__.getCameraPose());

  await canvas.evaluate((c) => {
    const gl = (c as HTMLCanvasElement).getContext('webgl2')!;
    (window as unknown as Win).__olvLose = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as Win).__olvLose.loseContext();
  });
  const toast = page.locator('.olv-toast-text');
  await expect(toast).toHaveText(
    'Graphics context lost. Your project is unchanged. If the view does not redraw, save the session and reload the page.',
    { timeout: 5_000 },
  );

  const drawsAtRestore = await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__olvLose.restoreContext();
    return w.__olvDraws;
  });
  await expect(toast).toHaveText('Graphics context restored; the view has been redrawn.', { timeout: 10_000 });

  // Draw calls resume without any interaction, and the scan is on screen.
  await expect.poll(() => draws(page), { timeout: 10_000 }).toBeGreaterThan(drawsAtRestore);
  await expect.poll(() => litPixels(page), { timeout: 10_000 }).toBeGreaterThan(litBefore * 0.8);

  // Nothing the user had changed is lost: the camera pose and the measurement.
  expect(await page.evaluate(() => (window as unknown as Win).__OLV_TEST_API__.getCameraPose())).toEqual(poseBefore);
  expect(await page.evaluate(() => (window as unknown as Win).__OLV_TEST_API__.getMeasurementCount())).toBe(1);
  await expect(page.locator('.olv-mp-row')).toHaveCount(1);

  // Interaction keeps drawing on the new renderer.
  const drawsBeforeOrbit = await draws(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => draws(page), { timeout: 5_000 }).toBeGreaterThan(drawsBeforeOrbit);
});
