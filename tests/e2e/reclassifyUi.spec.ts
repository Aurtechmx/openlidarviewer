import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * Reclassify control panel — the visible class-picker + undo/redo, driven as a
 * user would: the lazy panel mounts when a classification exists, the arm button
 * toggles, and the real Undo/Redo buttons revert and re-apply an edit. The
 * lasso-draw itself is covered by reclassify.spec (engine seam); here we drive
 * the actual DOM controls bound to the Viewer history.
 */
test('the reclassify panel mounts and its undo/redo buttons drive class edits', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // A classification now exists; mount + show the (lazy) reclassify panel.
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __OLV_TEST_API__: {
          seedUniformClass: (cls: number) => number;
          showReclassify: () => Promise<void>;
        };
      }
    ).__OLV_TEST_API__;
    api.seedUniformClass(1);
    await api.showReclassify();
  });

  const armBtn = page.locator('[data-testid="reclass-arm"]');
  const undoBtn = page.locator('[data-testid="reclass-undo"]');
  const redoBtn = page.locator('[data-testid="reclass-redo"]');
  // The lazy panel mounted with its picker + buttons bound to the Viewer.
  await expect(armBtn).toBeAttached({ timeout: 10_000 });
  await expect(page.locator('[data-testid="reclass-class"]')).toBeAttached();

  // No edits yet → undo and redo are disabled (state bound to the history).
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  // Make an edit through the engine seam, then refresh the panel: undo enables.
  const afterEdit = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __OLV_TEST_API__: {
          reclassifyLasso: (l: ReadonlyArray<{ x: number; y: number }>, c: number) => number;
          refreshReclassify: () => void;
          classAt: (i: number) => number;
        };
      }
    ).__OLV_TEST_API__;
    api.reclassifyLasso(
      [
        { x: 0, y: 0 },
        { x: 5000, y: 0 },
        { x: 5000, y: 5000 },
        { x: 0, y: 5000 },
      ],
      6,
    );
    api.refreshReclassify();
    return api.classAt(0);
  });
  expect(afterEdit).toBe(6);
  await expect(undoBtn).toBeEnabled();

  // Click the REAL Undo button → class reverts, redo enables.
  await undoBtn.click({ force: true });
  expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { classAt: (i: number) => number } }).__OLV_TEST_API__.classAt(0))).toBe(1);
  await expect(redoBtn).toBeEnabled();

  // Click the REAL Redo button → class re-applied.
  await redoBtn.click({ force: true });
  expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { classAt: (i: number) => number } }).__OLV_TEST_API__.classAt(0))).toBe(6);
});
