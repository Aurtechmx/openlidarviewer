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
  // Kind buttons fade their active state; settle transitions so a capture
  // never shows the previous kind mid-fade.
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
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

/**
 * Record the pill and its floor on every animation frame from now until the
 * pill has been settled for a few frames. Call before the key that opens a
 * tool; await the returned promise afterwards. Each sample is taken in a
 * requestAnimationFrame callback, i.e. the geometry of the frame about to
 * paint, while the pill is actually visible (placing is visibility: hidden).
 */
async function sampleEntrance(page: Page): Promise<() => Promise<{ frames: number; overlaps: string[] }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __atiSamples?: Promise<{ frames: number; overlaps: string[] }> };
    w.__atiSamples = new Promise((done) => {
      const overlaps: string[] = [];
      let frames = 0;
      let settledFor = 0;
      const t0 = performance.now();
      const hit = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const tick = (): void => {
        const pill = document.querySelector<HTMLElement>('.olv-ati');
        const shown = !!pill && !pill.hidden && getComputedStyle(pill).display !== 'none' && getComputedStyle(pill).visibility === 'visible';
        if (pill && shown) {
          frames++;
          const r = pill.getBoundingClientRect();
          for (const sel of ['.olv-dock', '.olv-navbar .olv-modes-triangle']) {
            const n = document.querySelector<HTMLElement>(sel);
            const b = n?.getBoundingClientRect();
            if (n && b && b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== 'hidden' && hit(r, b)) {
              overlaps.push(`frame ${frames} (${Math.round(performance.now() - t0)} ms): pill ${JSON.stringify(r.toJSON())} overlaps ${sel} ${JSON.stringify(b.toJSON())}`);
            }
          }
          if (pill.classList.contains('olv-ati-settled')) settledFor++;
        }
        if (settledFor >= 20 || performance.now() - t0 > 5000) done({ frames, overlaps });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __atiSamples: Promise<{ frames: number; overlaps: string[] }> }).__atiSamples);
}

/** Wait until the pill is revealed and its box holds still across frames. */
async function settled(page: Page): Promise<void> {
  await expect(pill(page)).toHaveClass(/olv-ati-settled/);
  await page.waitForFunction(() => new Promise<boolean>((ok) => {
    const p = document.querySelector('.olv-ati');
    if (!p) { ok(false); return; }
    const a = p.getBoundingClientRect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = p.getBoundingClientRect();
      ok(a.top === b.top && a.left === b.left && getComputedStyle(p).opacity === '1');
    }));
  }));
}

test.describe('active-tool pill', () => {
  test('absent while orbiting; measuring distance shows it, Esc leaves', async ({ page }) => {
    await open(page);
    await expect(pill(page)).toBeHidden();
    const entrance = await sampleEntrance(page);
    await page.keyboard.press('m');
    await expect(label(page)).toHaveText('Measuring distance');
    // From the very first frame it is visible, the pill sits clear of the dock
    // and the navigation widget: it is seated before it is revealed.
    const seen = await entrance();
    expect(seen.frames, 'the pill was revealed').toBeGreaterThan(0);
    expect(seen.overlaps).toEqual([]);
    await settled(page);
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
        await settled(page);
        await shot(page, `distance-${tag}`);
        await clear(page, '.olv-ati', '.olv-navbar .olv-modes-triangle');
        await clear(page, '.olv-ati', '.olv-viewcube');
        await page.locator('.olv-mkind', { hasText: 'Box' }).click();
        await expect(label(page)).toHaveText('Drawing box');
        await shot(page, `box-${tag}`);
        await page.locator('.olv-mkind', { hasText: 'Area' }).click();
        await expect(page.locator('.olv-mkind.olv-mkind-active')).toHaveCount(1);
        await expect(page.locator('.olv-mkind.olv-mkind-active')).toContainText('Area');
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
