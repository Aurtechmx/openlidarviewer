import { test, expect } from '@playwright/test';
import {
  FONT_SHIFT_MAX_PX,
  headerShift,
  installHeaderMeasure,
  measureHeader,
  type HeaderBoxes,
} from './headerBoxes';

/**
 * The Manrope swap does not move the header.
 *
 * Manrope is served `font-display: swap`. The build preloads the 400/500
 * weights, a metric-matched "Manrope Fallback" face (src/styles/01-tokens.css)
 * keeps text close to Manrope when a first paint beats the font, and the
 * header's text links and badge have fixed boxes, so none of those faces can
 * move a control. headerLayoutShift.spec.ts covers the third case, fonts that
 * never arrive, with the same measurement (./headerBoxes.ts).
 *
 * The first test loads the page as a user does and records the header on
 * every animation frame from its first appearance until the fonts have
 * settled. The second holds the .woff2 responses until the header has been
 * measured without them, then releases them: fonts slower than first paint.
 */

const manropeLoaded = (): boolean =>
  Array.from(document.fonts).some((f) => f.family.replace(/"/g, '') === 'Manrope' && f.status === 'loaded');

type Frame = { fontLoaded: boolean; boxes: HeaderBoxes };

test('header links do not move while the page and its fonts load', async ({ page }) => {
  await installHeaderMeasure(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __olvMeasureHeader: () => HeaderBoxes; __fontShiftFrames: Frame[] };
    const frames: Frame[] = [];
    w.__fontShiftFrames = frames;
    const tick = (): void => {
      const boxes = w.__olvMeasureHeader();
      if (Object.keys(boxes).length > 0) {
        frames.push({
          fontLoaded: Array.from(document.fonts).some(
            (f) => f.family.replace(/"/g, '') === 'Manrope' && f.status === 'loaded',
          ),
          boxes,
        });
      }
      if (frames.length < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await page.waitForFunction(manropeLoaded, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  const frames = await page.evaluate(() => (window as unknown as { __fontShiftFrames: Frame[] }).__fontShiftFrames);
  expect(frames.length).toBeGreaterThan(0);
  const final = frames[frames.length - 1].boxes;
  let horizontal = 0;
  let vertical = 0;
  for (const f of frames) {
    const s = headerShift(f.boxes, final);
    horizontal = Math.max(horizontal, s.horizontal);
    vertical = Math.max(vertical, s.vertical);
  }
  const fallbackFrames = frames.filter((f) => !f.fontLoaded).length;
  console.log(
    `[fontSwapShift:load] frames=${frames.length} fallbackFrames=${fallbackFrames} horizontal=${horizontal.toFixed(2)}px vertical=${vertical.toFixed(2)}px`,
  );
  expect(horizontal).toBeLessThanOrEqual(FONT_SHIFT_MAX_PX);
  expect(vertical).toBeLessThanOrEqual(FONT_SHIFT_MAX_PX);
});

test('header links do not move when fonts arrive late', async ({ page }) => {
  const held: Array<() => Promise<void>> = [];
  let release = false;
  await page.route(/\.woff2(\?.*)?$/, async (route) => {
    if (release) return route.continue();
    held.push(() => route.continue());
  });

  // 'domcontentloaded': the load event waits on the held fonts.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header.olv-topbar')).toBeVisible();
  await expect(page.locator('.olv-empty')).toBeVisible();
  expect(await page.evaluate(manropeLoaded)).toBe(false);
  await page.waitForTimeout(300);
  const before = await measureHeader(page);

  release = true;
  for (const go of held.splice(0)) await go();
  await page.waitForFunction(manropeLoaded, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const after = await measureHeader(page);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

  const s = headerShift(before, after);
  console.log(
    `[fontSwapShift:late] horizontal=${s.horizontal.toFixed(2)}px vertical=${s.vertical.toFixed(2)}px\n  ${s.rows.join('\n  ')}`,
  );
  expect(s.compared).toBeGreaterThan(0);
  expect(s.horizontal).toBeLessThanOrEqual(FONT_SHIFT_MAX_PX);
  expect(s.vertical).toBeLessThanOrEqual(FONT_SHIFT_MAX_PX);
});
