import { test, expect, type Page } from '@playwright/test';
import { backToModeHome, dropDenseGridPly, openToolPage, showWorkspaceMode } from './helpers';
import { dropBytes, geomFixtures } from './geomFixtures';

/**
 * The clip box is visible and behaves predictably:
 *   - typed bounds wait for Enter; arrow keys step and apply at once;
 *   - the box is drawn in the scene and follows every bound change;
 *   - Draw clipping box stays on the Clip page, keeps the scan's full height,
 *     and leaves the Box tool off afterwards;
 *   - the kept count is redone when the data under the clip changes (a reload
 *     at another density);
 *   - a clip that keeps no points says so in Export, which stays off;
 *   - returning to Tools lands back on the Clip page;
 *   - on a phone the Clip page opens at half height with one heading.
 */

interface ClipState {
  clip: { box: { min: number[]; max: number[] }; mode: string; enabled: boolean } | null;
  count: { kept: number; total: number } | null;
}
interface Outline { box: { min: number[]; max: number[] } | null; visible: boolean; inScene: boolean }
interface Api {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
  getClipState: () => ClipState;
  getClipOutline: () => Outline | null;
  reloadLayerByName: (name: string, budget: number) => Promise<void>;
  sceneUp: () => { world: number[]; camera: number[] };
}
const api = <T>(page: Page, fn: (a: Api) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__OLV_TEST_API__)`) as Promise<T>;

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
}

async function clipPage(page: Page) {
  await openToolPage(page, 'Clip box');
  const clip = page.locator('.olv-clip-panel');
  await expect(clip).toBeVisible({ timeout: 20_000 });
  return clip;
}

const state = (page: Page): Promise<ClipState> => api(page, (a) => a.getClipState());
const outline = (page: Page): Promise<Outline | null> => api(page, (a) => a.getClipOutline());

test('typed bounds wait for Enter; arrow keys step and apply at once; the drawn box follows', async ({ page }) => {
  await openScan(page);
  const clip = await clipPage(page);
  // The page is open, so the box is drawn even before the clip is on.
  await expect.poll(async () => (await outline(page))?.inScene ?? false).toBe(true);
  await clip.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await clip.locator('summary', { hasText: 'Advanced' }).click();
  await expect(clip.locator('.olv-clip-frame')).toContainText('local scene coordinates');
  const fields = clip.locator('input.olv-clip-num');
  const xMax = fields.nth(1);
  await expect(xMax).toHaveValue(/^-?\d+\.\d{3}$/);
  const before = (await state(page)).clip!.box;
  const o0 = await outline(page);
  expect(o0!.visible).toBe(true);
  expect(o0!.box).toEqual(before);

  // Typing "0.5" one character at a time applies nothing until Enter.
  await xMax.click({ clickCount: 3 });
  for (const ch of ['0', '.', '5']) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(150);
    expect((await state(page)).clip!.box.max[0]).toBe(before.max[0]);
  }
  await expect(xMax).toHaveClass(/is-pending/);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).clip!.box.max[0]).toBe(0.5);
  await expect(xMax).toHaveValue('0.500');
  await expect.poll(async () => (await outline(page))!.box!.max[0]).toBe(0.5);

  // An arrow step applies at once: 0.1 m, and 1 m with Shift.
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).clip!.box.max[0]).toBeCloseTo(0.6, 9);
  await expect(xMax).toHaveValue('0.600');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await state(page)).clip!.box.max[0]).toBeCloseTo(1.6, 9);
  await expect.poll(async () => (await outline(page))!.box!.max[0]).toBeCloseTo(1.6, 9);

  // A blank left behind returns to the last valid bound.
  await xMax.fill('');
  await clip.locator('.olv-clip-frame').click();
  await expect(xMax).toHaveValue('1.600');
  await expect(clip.locator('.olv-clip-error')).toContainText('X is back to');

  // Off, and the page closed: the box is no longer drawn.
  await clip.getByRole('button', { name: 'Turn off' }).click();
  await showWorkspaceMode(page, 'data');
  await expect.poll(async () => (await outline(page))?.inScene ?? false).toBe(false);
  // Returning to Tools lands back on the Clip page it was left on.
  await showWorkspaceMode(page, 'work');
  await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toHaveText('Clip box');
  await expect.poll(async () => (await outline(page))?.inScene ?? false).toBe(true);
});

test('Draw clipping box stays on the page, clips the full height, and leaves the Box tool off', async ({ page }) => {
  await openScan(page);
  const clip = await clipPage(page);
  // The scan's own extent, from Fit to scan.
  await clip.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await expect.poll(async () => (await state(page)).clip?.enabled ?? false).toBe(true);
  const scan = (await state(page)).clip!.box;
  await clip.getByRole('button', { name: 'Turn off' }).click();

  await clip.locator('.olv-clip-draw').click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  // Still the Clip page, with the corner hint on it.
  await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toHaveText('Clip box');
  await expect(clip.locator('.olv-clip-draw-hint')).toContainText(/corner/);

  // Two corners at different heights, as two clicks on the scan give. "Up"
  // is the scene's up axis (a PLY is Y-up, a LAS Z-up).
  const up = (await api(page, (a) => a.sceneUp())).world.findIndex((c) => Math.abs(c) === 1);
  const across = [0, 1, 2].filter((i) => i !== up);
  const at = (f: number, h: number): number[] => {
    const p = [0, 0, 0];
    for (const i of across) p[i] = scan.min[i] + (scan.max[i] - scan.min[i]) * f;
    p[up] = scan.min[up] + (scan.max[up] - scan.min[up]) * h;
    return p;
  };
  const [p, q] = [at(0.3, 0.3), at(0.7, 0.6)];
  await page.evaluate(([a0, b0]) => {
    const a = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    a.placeMeasurementPoint({ x: a0[0], y: a0[1], z: a0[2] });
    a.placeMeasurementPoint({ x: b0[0], y: b0[1], z: b0[2] });
  }, [p, q]);
  await page.getByRole('button', { name: /Isolate this box/ }).click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();

  const box = (await state(page)).clip!.box;
  for (const i of across) {
    expect(box.min[i]).toBeCloseTo(p[i], 6);
    expect(box.max[i]).toBeCloseTo(q[i], 6);
  }
  // Full height: the scan's, not the 30 % between the clicks.
  expect(box.min[up]).toBeLessThanOrEqual(scan.min[up]);
  expect(box.max[up]).toBeGreaterThanOrEqual(scan.max[up]);
  await expect(page.locator('.olv-lasso-toast-msg, .olv-toast').filter({ hasText: /full height/ }).first()).toBeVisible();

  // The Box tool is off: the measurement bar has gone and the hint with it.
  await expect(page.locator('.olv-measure-bar')).toBeHidden();
  await expect(clip.locator('.olv-clip-draw-hint')).toBeHidden();
  const count = await api(page, (a) => a.getMeasurementCount());
  const canvas = (await page.locator('canvas.olv-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.45);
  await page.mouse.click(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.55);
  await page.waitForTimeout(500);
  expect(await api(page, (a) => a.getMeasurementCount())).toBe(count);
  // The Tools home shows the clip running.
  await backToModeHome(page, 'work');
  await expect(page.locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Clip box' })).toContainText('On · Keep inside');
});

test('the kept count is taken again when the scan is reloaded', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?test=1');
  await dropBytes(page, (await geomFixtures()).geomA, 'geom-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  const clip = await clipPage(page);
  await clip.locator('label', { hasText: 'Clip the scan to this box' }).click();
  // Keep the west half of the scan.
  await expect.poll(async () => (await state(page)).clip?.enabled ?? false).toBe(true);
  const fit = (await state(page)).clip!.box;
  await clip.locator('summary', { hasText: 'Advanced' }).click();
  const xMax = clip.getByLabel('X max', { exact: true });
  await xMax.fill(String((fit.min[0] + fit.max[0]) / 2));
  await xMax.press('Enter');
  const readout = clip.locator('[role="status"]');
  const before = await expect.poll(async () => (await state(page)).count?.kept ?? 0).toBeLessThan(30_351).then(() => state(page));
  await expect(readout).toContainText(`${before.count!.kept.toLocaleString('en-US')} of 30,351 points kept`);

  // Reload the layer (the Output panel's "Reload at higher density"). The
  // reloaded copy replaces the layer, so the count is taken again on its own,
  // with no edit: the readout goes busy (dimmed) and lands a fresh figure.
  await page.evaluate(() => {
    const el = document.querySelector('.olv-clip-panel [role="status"]')!;
    const w = window as unknown as { __busy: string[] };
    w.__busy = [];
    new MutationObserver(() => w.__busy.push(el.getAttribute('aria-busy') ?? 'settled')).observe(el, { attributes: true, attributeFilter: ['aria-busy'] });
  });
  const firstLayer = await page.locator('.olv-layer').first().getAttribute('data-id');
  await api(page, (a) => a.reloadLayerByName('geom-a.las', 1_000_000));
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __busy: string[] }).__busy.join(',')), { timeout: 30_000 }).toMatch(/true.*settled$/);
  if (firstLayer) await expect(page.locator('.olv-layer').first()).not.toHaveAttribute('data-id', firstLayer);
  const after = (await state(page)).count!;
  expect(after).toEqual(before.count);
  await expect(readout).not.toHaveClass(/is-stale/);
  await expect(readout).toContainText(`${after.kept.toLocaleString('en-US')} of ${after.total.toLocaleString('en-US')} points kept`);
});

test('a clip that keeps no points: Export says so and stays off', async ({ page }) => {
  await openScan(page);
  const clip = await clipPage(page);
  await clip.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await clip.locator('summary', { hasText: 'Advanced' }).click();
  // A box far from the scan.
  for (const [label, v] of [['X max', 1001], ['X min', 1000]] as const) {
    const input = clip.getByLabel(label, { exact: true });
    await input.fill(String(v));
    await input.press('Enter');
  }
  await expect(clip.locator('[role="status"]')).toContainText(/^0 of 3,600 points kept\. No points are inside the box/);

  await showWorkspaceMode(page, 'output');
  const exp = page.locator('.olv-export-panel');
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if (await exp.evaluate((el) => el.classList.contains('olv-collapsed'))) await exp.locator('.olv-panel-head').click();
  await expect(exp.locator('.olv-export-summary')).toHaveText('The clip keeps no points.');
  await expect(exp.locator('.olv-export-summary-note')).toContainText('Move or resize the clip box, or turn the clip off');
  await expect(exp.locator('.olv-bc-convert')).toBeDisabled();

  // Turning the clip off brings Export back.
  await page.locator('.olv-clip-indicator').getByRole('button', { name: 'Turn off clipping' }).click();
  await expect(exp.locator('.olv-bc-convert')).toBeEnabled();
  await expect(exp.locator('.olv-export-summary')).toContainText('3,600 points');
});

test('phone: the Clip page opens at half height, with one heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScan(page);
  await openToolPage(page, 'Clip box');
  const sheet = page.locator('.olv-mobile-sheet');
  await expect(sheet).toHaveClass(/olv-msheet--half/, { timeout: 10_000 });
  await expect(page.locator('.olv-clip-panel')).toBeVisible();
  const headings = page.locator('.olv-mobile-sheet').getByText('Clip box', { exact: true });
  let shown = 0;
  for (let i = 0; i < await headings.count(); i++) if (await headings.nth(i).isVisible()) shown++;
  expect(shown).toBe(1);
});
