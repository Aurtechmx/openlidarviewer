import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * v0.5.3 — the on-canvas compass, promoted from the v0.5.2 opt-in to a default
 * control. These prove the promotion end-to-end on the served build: the gizmo
 * mounts by default once the viewer is ready, exposes its standard-view snaps,
 * and the `?viewcube=0` escape hatch hides it. The rose geometry itself is
 * covered by the viewCubeMath unit tests.
 */

test('the compass mounts by default and exposes the view snaps', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const cube = page.locator('.olv-viewcube');
  await expect(cube).toBeVisible({ timeout: 20_000 });
  // North marker plus the centre Top snap are present and clickable.
  await expect(cube.locator('[data-testid="viewcube-n"]')).toBeVisible();
  await expect(cube.locator('[data-testid="viewcube-top"]')).toBeVisible();
  // Snapping to a standard view must not raise a page error.
  await cube.locator('[data-testid="viewcube-top"]').click();
});

test('?viewcube=0 keeps the compass hidden', async ({ page }) => {
  await page.goto('/?test=1&viewcube=0');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Give the viewer-ready hook time to (not) mount the gizmo.
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0);
});
