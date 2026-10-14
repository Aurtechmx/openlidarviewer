import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, waitForCameraSettled } from './helpers';

/**
 * Keyboard access to the ViewCube on the served build: Tab enters the cube's
 * toolbar, the arrow keys reach all 26 targets in a fixed order from the
 * default orientation (including ones hidden for pointers), and Enter on a
 * hidden corner turns the camera to that corner and announces it.
 */

interface Pose { position: number[]; target: number[] }

async function pose(page: Page): Promise<Pose> {
  return page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { getCameraPose: () => Pose } }).__OLV_TEST_API__;
    return api.getCameraPose();
  });
}

const focusedTestId = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');

test('every cube view is reachable and usable from the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  const cube = page.locator('.olv-viewcube');
  await expect(cube).toBeVisible({ timeout: 20_000 });
  await waitForCameraSettled(page);

  const toolbar = cube.getByRole('toolbar');
  await expect(toolbar).toHaveAccessibleName(/View cube/);

  // Tab in: the toolbar is a single tab stop, so Tab lands on its one target.
  await page.locator('body').focus();
  let reached = false;
  for (let i = 0; i < 300 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.closest('[role="toolbar"].olv-viewcube-stage') !== null);
  }
  expect(reached).toBe(true);
  expect(await focusedTestId(page)).toBe('viewcube-top');
  await expect(toolbar.locator('[tabindex="0"]')).toHaveCount(1);

  // The arrows visit all 26 targets once each, then wrap.
  const seen: string[] = [];
  for (let i = 0; i < 26; i++) {
    seen.push(await focusedTestId(page));
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true);
    await page.keyboard.press('ArrowRight');
  }
  expect(new Set(seen).size).toBe(26);
  expect(await focusedTestId(page)).toBe('viewcube-top');
  await page.keyboard.press('End');
  expect(await focusedTestId(page)).toBe(seen[25]);
  await page.keyboard.press('Home');
  expect(await focusedTestId(page)).toBe('viewcube-top');

  // A corner hidden for pointers at the default orientation.
  const hiddenCorner = await cube.locator('.olv-viewcube-spot[hidden]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid') ?? '').find((id) => id.startsWith('viewcube-bottom-') && id.split('-').length === 4) ?? '');
  expect(hiddenCorner).not.toBe('');
  const steps = seen.indexOf(hiddenCorner);
  for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowRight');
  expect(await focusedTestId(page)).toBe(hiddenCorner);
  const corner = cube.locator(`[data-testid="${hiddenCorner}"]`);
  // Shown for focus only: outlined, named, never pressable by pointer.
  await expect(corner).toBeVisible();
  await expect(corner).toHaveClass(/is-kbd-only/);
  await expect(corner).toHaveAccessibleName(/^View from bottom, /);
  await expect(cube.locator('.olv-viewcube-caption')).toBeVisible();
  expect(await corner.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  await page.keyboard.press('Enter');
  await waitForCameraSettled(page);

  // The camera now looks from that corner: the corner is front-most and shown
  // for pointers, and the view is a corner view on every axis.
  const p = await pose(page);
  const off = [0, 1, 2].map((i) => p.position[i] - p.target[i]);
  const len = Math.hypot(...off);
  for (const v of off) expect(Math.abs(v / len)).toBeGreaterThan(0.4);
  await expect(corner).not.toHaveAttribute('hidden', '');
  await expect(corner).not.toHaveClass(/is-kbd-only/);
  await expect(page.locator('body > .olv-visually-hidden[role="status"]')).toHaveText(/^Camera turned: view from bottom, /);
});
