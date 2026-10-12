import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, waitForCameraSettled } from './helpers';

/**
 * The navigation journey on the served build: open a scan → the one-time hint
 * → cube Top → an iso corner (orientation only, no zoom reset) → orbit and the
 * cube follows → Plan View on, then a cube corner turns it off (no stale chip)
 * → Orbit / Walk / Fly / Pan switching → hint dismissed for good.
 */

interface Pose { position: number[]; target: number[] }

async function pose(page: Page): Promise<Pose> {
  return page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { getCameraPose: () => Pose } }).__OLV_TEST_API__;
    return api.getCameraPose();
  });
}

function offset(p: Pose): number[] {
  return [0, 1, 2].map((i) => p.position[i] - p.target[i]);
}
const len = (v: number[]): number => Math.hypot(...v);

test('cube, compact navigation and first-use guidance, end to end', async ({ page }) => {
  test.setTimeout(120_000);
  // A first-time user: the hint and the cube preference are both unset.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('journey-seeded')) return;
    sessionStorage.setItem('journey-seeded', '1');
    localStorage.removeItem('olv.nav.firstUseHint');
    localStorage.removeItem('olv.compass');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await waitForCameraSettled(page);

  // ── First-use hint ──────────────────────────────────────────────────
  const hint = page.locator('.olv-touch-hint.olv-first-hint');
  await expect(hint).toHaveText(/Drag to orbit · Scroll to zoom · Double-click to focus/, { timeout: 10_000 });

  // ── Cube: visible, clear of the expanded right rail ────────────────
  const cube = page.locator('.olv-viewcube');
  await expect(cube).toBeVisible({ timeout: 20_000 });
  const rail = page.locator('.olv-right-rail');
  if (await rail.evaluate((el) => !el.classList.contains('olv-right-collapsed'))) {
    const c = (await cube.boundingBox())!;
    const r = (await rail.boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(r.x);
  }

  // ── Top: orientation only, distance kept ───────────────────────────
  const d0 = len(offset(await pose(page)));
  await cube.locator('[data-testid="viewcube-top"]').click();
  await waitForCameraSettled(page);
  const top = await pose(page);
  expect(len(offset(top))).toBeCloseTo(d0, 1);
  await expect(cube.locator('[data-testid="viewcube-top"]')).toHaveAttribute('aria-current', 'true');

  // ── An iso corner: still no zoom reset ─────────────────────────────
  const cornerId = await cube.locator('.olv-viewcube-spot:not([hidden])').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid') ?? '').find((id) => id.split('-').length === 4) ?? '');
  expect(cornerId).not.toBe('');
  await cube.locator(`[data-testid="${cornerId}"]`).click();
  await waitForCameraSettled(page);
  const iso = await pose(page);
  expect(len(offset(iso))).toBeCloseTo(d0, 1);
  // A corner view: every axis of the offset is substantial.
  const unit = offset(iso).map((v) => v / len(offset(iso)));
  for (const v of unit) expect(Math.abs(v)).toBeGreaterThan(0.4);
  await expect(cube.locator('.olv-viewcube-face[aria-current="true"]')).toHaveCount(0);

  // ── Orbit by dragging the scan: the cube follows ───────────────────
  const before = await cube.locator('.olv-viewcube-face').evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform).join('|'));
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45, { steps: 12 });
  await page.mouse.up();
  await waitForCameraSettled(page);
  const after = await cube.locator('.olv-viewcube-face').evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform).join('|'));
  expect(after).not.toBe(before);

  // ── Plan View on, then a cube corner turns it off ──────────────────
  const panelToggle = page.locator('.olv-nav-panel-toggle');
  if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click();
  const plan = page.locator('.olv-plan-toggle');
  await plan.click();
  await expect(plan).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await waitForCameraSettled(page);
  const nearCorner = await cube.locator('.olv-viewcube-spot:not([hidden])').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid') ?? '').find((id) => id.split('-').length === 4) ?? '');
  await cube.locator(`[data-testid="${nearCorner}"]`).click();
  await expect(plan).toHaveAttribute('aria-pressed', 'false');
  // And on/off by its own chip still round-trips.
  await plan.click();
  await expect(plan).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await plan.click();
  await expect(plan).toHaveAttribute('aria-pressed', 'false');
  await waitForCameraSettled(page);

  // ── Orbit | Walk | Fly | Pan ───────────────────────────────────────
  const modes = page.locator('.olv-modes-segmented');
  for (const name of ['Walk', 'Fly', 'Pan', 'Orbit']) {
    const b = modes.locator('.olv-mode', { hasText: name });
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
    await expect(modes.locator('.olv-mode[aria-pressed="true"]')).toHaveCount(1);
  }

  // ── The hint, dismissed, stays gone ────────────────────────────────
  if (await hint.isVisible()) await hint.locator('.olv-touch-hint-x').click();
  await expect(page.locator('.olv-touch-hint.olv-first-hint.olv-visible')).toHaveCount(0);
  await page.reload();
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(page.locator('.olv-touch-hint.olv-first-hint.olv-visible')).toHaveCount(0);
});
