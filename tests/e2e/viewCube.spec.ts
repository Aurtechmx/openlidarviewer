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

test('while orbiting, every shown cube target hit-tests to itself (no face under an edge, no edge under an edge)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?test=1&viewcube=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-viewcube')).toBeVisible({ timeout: 20_000 });
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const covered = (): Promise<string[]> => page.evaluate(() => {
    const out: string[] = [];
    for (const b of document.querySelectorAll<HTMLElement>('.olv-viewcube button')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(b).visibility === 'hidden' || b.hidden) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && !b.contains(hit)) out.push(`${b.getAttribute('data-testid')} under ${(hit as HTMLElement).getAttribute('data-testid') ?? hit.className}`);
    }
    return out;
  });
  expect(await covered()).toEqual([]);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + i * 0.025), box.y + box.height * (0.5 + Math.sin(i / 3) * 0.2), { steps: 3 });
    await page.waitForTimeout(60);
    expect(await covered(), `step ${i}`).toEqual([]);
  }
  await page.mouse.up();
});
