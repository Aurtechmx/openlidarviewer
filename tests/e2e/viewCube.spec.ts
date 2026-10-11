import { test, expect } from '@playwright/test';
import { dropDenseGridPly, closeScanFromDock } from './helpers';

/**
 * The on-canvas ViewCube on the served build: on by default once a scan is
 * open, honest labels on a local scan, every face / edge / corner target
 * present, an explicit stored OFF (or `?viewcube=0`) respected, and nothing on
 * the empty startup screen. The geometry is covered by the viewCubeMath unit
 * tests; the full interaction journey by viewCubeJourney.spec.ts.
 */

test('the cube is on by default with a scan open, and not on the empty screen', async ({ page }) => {
  await page.goto('/?test=1');
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0);
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const cube = page.locator('.olv-viewcube');
  await expect(cube).toBeVisible({ timeout: 20_000 });
  await expect(cube).toHaveCount(1);
  // Six faces, and the dense grid is a local (no-CRS) scan: its north-facing
  // face reads the truthful view name, never a fabricated cardinal.
  await expect(cube.locator('.olv-viewcube-face')).toHaveCount(6);
  const front = cube.locator('[data-testid="viewcube-front"]');
  await expect(front).toHaveText('Front');
  await expect(cube.locator('.olv-viewcube-face', { hasText: /^[NESW]$/ })).toHaveCount(0);
  // Twelve edges and eight corners exist; only the near side is shown.
  await expect(cube.locator('.olv-viewcube-spot')).toHaveCount(20);
  await expect(cube.locator('[data-testid="viewcube-home"]')).toBeVisible();
});

test('?viewcube=0 keeps it off', async ({ page }) => {
  await page.goto('/?test=1&viewcube=0');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0);
});

test('an explicit stored OFF is respected', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('olv.compass', 'off'));
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0);
  // The six axis views stay reachable without the cube.
  await page.locator('.olv-nav-more').click();
  await expect(page.locator('.olv-nav-more-views .olv-cam-chip')).toHaveCount(6);
});

test('closing the scan takes the cube down; reopening mounts exactly one', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-viewcube')).toBeVisible({ timeout: 20_000 });
  await closeScanFromDock(page);
  await expect(page.locator('.olv-viewcube')).toHaveCount(0, { timeout: 10_000 });
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-viewcube')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.olv-viewcube')).toHaveCount(1);
});
