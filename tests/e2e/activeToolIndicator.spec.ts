import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dropDenseGridPly, closeScanFromDock } from './helpers';

/**
 * The active-tool pill across the three pointer journeys: measure a distance,
 * draw a box, add an annotation. It must name the mode from the controller,
 * offer Finish only for a finishable draft, leave on Esc, stay absent while
 * orbiting, and sit clear of the compass and the navigation bar.
 *
 * Screenshots (light and dark, four viewports) go to SHOT_DIR when it is set.
 */

const SHOT_DIR = process.env.OLV_TOOL_SHOTS ?? '';
const pill = (page: Page) => page.locator('.olv-ati');
const label = (page: Page) => page.locator('.olv-ati-label');

async function open(page: Page, theme: 'light' | 'dark' = 'dark'): Promise<void> {
  await page.addInitScript((t) => { try { localStorage.setItem('olv-theme', t); } catch { /* private mode */ } }, theme);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.locator('canvas').first().hover();
}

const api = (page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => {
  const t = (window as unknown as { __OLV_TEST_API__: Record<string, (x?: unknown) => void> }).__OLV_TEST_API__;
  t[f as string](a);
}, [fn, arg] as const);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

/** No overlap between two visible boxes. */
async function clear(page: Page, a: string, b: string): Promise<void> {
  const ra = await page.locator(a).first().boundingBox();
  const lb = page.locator(b).first();
  if (!ra || !(await lb.isVisible())) return;
  const rb = await lb.boundingBox();
  if (!rb) return;
  const overlap = ra.x < rb.x + rb.width && rb.x < ra.x + ra.width && ra.y < rb.y + rb.height && rb.y < ra.y + ra.height;
  expect(overlap, `${a} overlaps ${b}`).toBe(false);
}

test.describe('active-tool pill', () => {
  test('absent while orbiting; measuring distance shows it, Esc leaves', async ({ page }) => {
    await open(page);
    await expect(pill(page)).toBeHidden();
    await page.keyboard.press('m');
    await expect(label(page)).toHaveText('Measuring distance');
    await expect(page.locator('.olv-ati [role="status"]')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.olv-ati-finish')).toBeHidden();
    // The pill names the mode; the bar keeps only its instruction.
    await expect(page.locator('.olv-measure-bar .olv-measure-badge')).toBeHidden();
    await expect(page.locator('.olv-ati')).toHaveCount(1);
    await clear(page, '.olv-ati', '.olv-navbar .olv-modes-triangle');
    await clear(page, '.olv-ati', '.olv-viewcube');
    await clear(page, '.olv-ati', '.olv-dock');
    await page.keyboard.press('Escape');
    await expect(pill(page)).toBeHidden();
    await expect(page.locator('.olv-measure-bar')).toBeHidden();
  });

  test('switching kind updates at once; Finish only for an open area draft', async ({ page }) => {
    await open(page);
    await page.keyboard.press('m');
    await page.locator('.olv-mkind', { hasText: 'Box' }).click();
    await expect(label(page)).toHaveText('Drawing box');
    await page.locator('.olv-mkind', { hasText: 'Area' }).click();
    await expect(label(page)).toHaveText('Measuring area');
    await expect(page.locator('.olv-ati-finish')).toBeHidden();
    await api(page, 'placeMeasurementPoint', { x: 0, y: 0, z: 0 });
    await api(page, 'placeMeasurementPoint', { x: 1, y: 0, z: 0 });
    await api(page, 'placeMeasurementPoint', { x: 1, y: 1, z: 0 });
    await expect(page.locator('.olv-ati-finish')).toBeVisible();
    await page.locator('.olv-ati-finish').click();
    await expect(page.locator('.olv-ati-finish')).toBeHidden();
    await expect(label(page)).toHaveText('Measuring area');
  });

  test('annotation mode, then Cancel in the pill exits it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('a');
    await expect(label(page)).toHaveText('Adding annotation');
    await expect(page.locator('.olv-anno-hint-badge')).toBeHidden();
    await page.locator('.olv-ati-cancel').click();
    await expect(pill(page)).toBeHidden();
  });

  test('closing the scan clears the pill', async ({ page }) => {
    await open(page);
    await page.keyboard.press('a');
    await expect(pill(page)).toBeVisible();
    await closeScanFromDock(page);
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
    await expect(pill(page)).toBeHidden();
    await expect(page.locator('.olv-anno-hint')).toBeHidden();
  });
});

test.describe('active-tool pill screenshots', () => {
  test.skip(!SHOT_DIR, 'set OLV_TOOL_SHOTS to capture');
  const sizes = [[1440, 900], [1280, 720], [820, 1180], [390, 844]] as const;
  for (const theme of ['light', 'dark'] as const) {
    for (const [w, h] of sizes) {
      test(`${theme} ${w}x${h}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await open(page, theme);
        const tag = `${theme}-${w}x${h}`;
        await page.keyboard.press('m');
        await expect(label(page)).toHaveText('Measuring distance');
        await shot(page, `distance-${tag}`);
        await clear(page, '.olv-ati', '.olv-navbar .olv-modes-triangle');
        await clear(page, '.olv-ati', '.olv-viewcube');
        await api(page, 'setMeasureKind', 'box');
        await expect(label(page)).toHaveText('Drawing box');
        await shot(page, `box-${tag}`);
        await api(page, 'setMeasureKind', 'area');
        for (const p of [[0, 0], [1, 0], [1, 1]]) await api(page, 'placeMeasurementPoint', { x: p[0], y: p[1], z: 0 });
        await expect(page.locator('.olv-ati-finish')).toBeVisible();
        await shot(page, `area-finish-${tag}`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('a');
        await expect(label(page)).toHaveText('Adding annotation');
        await shot(page, `annotation-${tag}`);
      });
    }
  }
});
