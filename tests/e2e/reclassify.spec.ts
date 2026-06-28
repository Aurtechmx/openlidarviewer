import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * Lasso reclassify tool — the manual classification-edit flow, end to end in a
 * real browser: seed a uniform class, reclassify the points inside a screen
 * lasso to a new class, then undo and redo. Asserts the live classification
 * buffer changes (and reverts) exactly. Drives the editor through the same
 * Viewer path the UI tool will use; the visible class-picker widget is a
 * follow-up that reuses this engine.
 */
test('reclassify a lasso, then undo and redo, changes the live classification', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const result = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __OLV_TEST_API__: {
          seedUniformClass: (cls: number) => number;
          reclassifyLasso: (lasso: ReadonlyArray<{ x: number; y: number }>, cls: number) => number;
          undoClass: () => boolean;
          redoClass: () => boolean;
          classAt: (i: number) => number;
        };
      }
    ).__OLV_TEST_API__;

    // Every point starts as class 1 (unclassified).
    const n = api.seedUniformClass(1);
    const before = api.classAt(0);

    // A lasso that covers the whole canvas selects every visible point.
    const fullScreen = [
      { x: 0, y: 0 },
      { x: 5000, y: 0 },
      { x: 5000, y: 5000 },
      { x: 0, y: 5000 },
    ];
    const changed = api.reclassifyLasso(fullScreen, 6); // → class 6 (building)
    const afterEdit = api.classAt(0);

    const undone = api.undoClass();
    const afterUndo = api.classAt(0);

    const redone = api.redoClass();
    const afterRedo = api.classAt(0);

    return { n, before, changed, afterEdit, undone, afterUndo, redone, afterRedo };
  });

  expect(result.n).toBeGreaterThan(0);
  expect(result.before).toBe(1);
  expect(result.changed).toBeGreaterThan(0); // points were reclassified
  expect(result.afterEdit).toBe(6);
  expect(result.undone).toBe(true);
  expect(result.afterUndo).toBe(1); // undo reverted the edit exactly
  expect(result.redone).toBe(true);
  expect(result.afterRedo).toBe(6); // redo re-applied it
});
