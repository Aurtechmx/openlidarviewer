import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * v0.5.3 — the on-canvas compass. It is opt-in (off by default) because the
 * app's left and right edges are full-height panel columns, so a persistent
 * gizmo has no free corner; the user enables it from the command palette
 * ("Toggle compass") or with `?viewcube=1`. These prove the enabled path on the
 * served build (mounts, exposes its standard-view snaps) and that it stays
 * hidden by default. The rose geometry is covered by the viewCubeMath unit tests.
 */

test('with ?viewcube=1 the compass mounts and exposes the view snaps', async ({ page }) => {
  await page.goto('/?test=1&viewcube=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const cube = page.locator('.olv-viewcube');
  await expect(cube).toBeVisible({ timeout: 20_000 });
  await expect(cube.locator('[data-testid="viewcube-n"]')).toBeVisible();
  await expect(cube.locator('[data-testid="viewcube-top"]')).toBeVisible();
  // Snapping to a standard view must not raise a page error.
  await cube.locator('[data-testid="viewcube-n"]').click();
});

test('the compass is hidden by default (opt-in)', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0);
});
