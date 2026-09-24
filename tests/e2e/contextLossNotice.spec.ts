import { test, expect } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * WebGL context loss and restore reach the user through the status toast. The
 * loss is forced with WEBGL_lose_context on the viewer canvas, which only works
 * on the WebGL 2 backend; on a runner whose adapter gives WebGPU the test skips.
 *
 * The scene does not redraw after the restore (the renderer keeps its lost
 * state; GPU resources are not rebuilt), which is why the restore notice asks
 * for a reload rather than promising a redraw.
 */
test('a lost WebGL context shows a notice, and its restore shows another', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);

  const canvas = page.locator('.olv-canvas');
  const hasWebgl = await canvas.evaluate((c) => {
    const gl = (c as HTMLCanvasElement).getContext('webgl2');
    return !!gl?.getExtension('WEBGL_lose_context');
  });
  test.skip(!hasWebgl, 'viewer is not on a WebGL 2 context with WEBGL_lose_context');

  await canvas.evaluate((c) => {
    const gl = (c as HTMLCanvasElement).getContext('webgl2')!;
    (window as unknown as { __olvLose: WEBGL_lose_context }).__olvLose = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as { __olvLose: WEBGL_lose_context }).__olvLose.loseContext();
  });
  const toast = page.locator('.olv-toast-text');
  await expect(toast).toHaveText(
    'Graphics context lost. Your project is unchanged. Save the session, then reload the page to see the scan again.',
    { timeout: 5_000 },
  );

  await page.evaluate(() => (window as unknown as { __olvLose: WEBGL_lose_context }).__olvLose.restoreContext());
  await expect(toast).toHaveText(
    'Graphics context restored, but the view cannot redraw yet. Your project is unchanged. Save the session, then reload the page to see the scan again.',
    { timeout: 5_000 },
  );
});
