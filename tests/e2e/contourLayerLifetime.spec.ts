/**
 * The contours derived layer must not outlive the scan it was drawn from.
 * Regression for a leak where nothing outside `contourLayerService.ts` ever
 * called its teardown: closing the scan left the contour LineSegments
 * attached and visible over the empty state, and loading a different scan
 * left the old contours drawn over it with no "Derived layers" / "Contours
 * in 3D" control to hide them (`clearForScan`/`dispose` existed but were
 * dead code from the caller's side).
 *
 * `terrainAnalysisRunner.ts`'s `abortAndClearCache()` now also calls the
 * contour layer service's `clearAll()`, mirroring how it already calls
 * `invalidateFlowOverlay()` for the Flow Pulse Lab's persisted overlay.
 *
 * Uses the derived-layers list DOM (`.olv-analyse-layer-controls`) as the
 * scene observable: `ContourOverlay.dispose()` removes the drawn
 * LineSegments from the viewer host, and the list hides itself the instant
 * the backing `DerivedLayerStore` has no more contour records — so an empty,
 * hidden list is proof the geometry is gone, not just that a panel toggled.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

const MULTICHUNK = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

test.describe('contour derived-layer lifetime', () => {
  test.slow();

  async function runAnalysisAndWaitForContours(page: import('@playwright/test').Page): Promise<void> {
    await showWorkspaceMode(page, 'analyse');
    const panel = page.locator('.olv-analyse-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
      await panel.locator('.olv-panel-head').click();
    }
    await page.locator('.olv-analyse-run').click();
    // The run completes and draws the contour layer without further input;
    // the launcher action only reveals the export surface. Two elements share
    // the `.olv-analyse-layer-controls` class — the per-layer "Contours in 3D"
    // toggle row and the generic derived-layers list — so scope to the one
    // carrying the "Derived layers" header.
    const derivedList = page.locator('.olv-analyse-layer-controls', { hasText: 'Derived layers' });
    await expect(derivedList).not.toHaveClass(/olv-hidden/, { timeout: 20_000 });
    await expect(derivedList.locator('.olv-analyse-layer-head')).toContainText('Derived layers');
  }

  test('closing the scan removes the drawn contours and the layer control', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await runAnalysisAndWaitForContours(page);

    await page.locator('.olv-tool-close').click();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });

    // Every "Contours in 3D" / "Derived layers" control must be gone — a
    // contour LineSegments left attached to the empty-state scene is exactly
    // the bug, and the DOM tracks the backing store one-to-one.
    const layerControls = page.locator('.olv-analyse-layer-controls');
    const count = await layerControls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(layerControls.nth(i)).toHaveClass(/olv-hidden/);
    }
  });

  test('loading a different scan leaves no stale contour layer or control', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await runAnalysisAndWaitForContours(page);

    // Close, then open an unrelated scan through the empty state's own
    // picker — the exact repro: a scan closed while its contours were drawn,
    // then a different scan opened into what looked like a clean session.
    await page.locator('.olv-tool-close').click();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
    await page.locator('.olv-empty .olv-file-input').setInputFiles(MULTICHUNK);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });

    // The new scan has run no analysis of its own: the Analyse panel must show
    // no leftover "Derived layers" / "Contours in 3D" control from the closed
    // scan for the user to have to find and hide.
    await showWorkspaceMode(page, 'analyse');
    const layerControls = page.locator('.olv-analyse-layer-controls');
    const count = await layerControls.count();
    for (let i = 0; i < count; i++) {
      await expect(layerControls.nth(i)).toHaveClass(/olv-hidden/);
    }
  });
});
