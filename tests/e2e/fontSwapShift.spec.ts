import { test, expect, type Page } from '@playwright/test';

/**
 * The Manrope swap does not move the header.
 *
 * Manrope is served `font-display: swap`. the build preloads the 400/500
 * weights so the first paint is already in Manrope, and a metric-matched
 * "Manrope Fallback" face (src/styles/01-tokens.css) keeps the line boxes
 * identical for a first paint that does beat the font.
 *
 * Neither test blocks fonts. The first loads the page as a user does and
 * samples every header link box on every animation frame from the header's
 * first appearance until the fonts have settled: the boxes may not move by
 * more than MAX_SHIFT_PX. The second holds the .woff2 responses until the
 * fallback layout has been measured, then releases them, which is the worst
 * case (fonts slower than first paint) and measures the fallback face itself.
 */

const MAX_SHIFT_PX = 0.5;
/** Fallback face vs Manrope: one size-adjust per weight cannot match every string. */
const MAX_FALLBACK_WIDTH_SHIFT_PX = 1.5;

type Box = { key: string; x: number; y: number; w: number; h: number };

const SELECTOR = 'header.olv-topbar a, header.olv-topbar button';

async function headerBoxes(page: Page): Promise<Box[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((n) => n.offsetParent !== null)
      .map((n, i) => {
        const r = n.getBoundingClientRect();
        return { key: `${i}:${n.getAttribute('aria-label') ?? ''}`, x: r.x, y: r.y, w: r.width, h: r.height };
      });
  }, SELECTOR);
}

function diff(before: Box[], after: Box[]): { worst: number; worstY: number; rows: string[] } {
  let worst = 0;
  let worstY = 0;
  const rows = before.map((b, i) => {
    const a = after[i];
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
    worst = Math.max(worst, d);
    worstY = Math.max(worstY, Math.abs(a.y - b.y), Math.abs(a.h - b.h));
    return `${b.key} dx=${(a.x - b.x).toFixed(2)} dy=${(a.y - b.y).toFixed(2)} dw=${(a.w - b.w).toFixed(2)} dh=${(a.h - b.h).toFixed(2)}`;
  });
  return { worst, worstY, rows };
}

const manropeLoaded = (): boolean =>
  Array.from(document.fonts).some((f) => f.family.replace(/"/g, '') === 'Manrope' && f.status === 'loaded');

test('header links do not move while the page and its fonts load', async ({ page }) => {
  await page.addInitScript((sel) => {
    const frames: Array<{ fontLoaded: boolean; boxes: Array<[number, number, number, number]> }> = [];
    (window as unknown as { __fontShiftFrames: typeof frames }).__fontShiftFrames = frames;
    const tick = (): void => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((n) => n.offsetParent !== null);
      if (nodes.length > 0) {
        frames.push({
          fontLoaded: Array.from(document.fonts).some(
            (f) => f.family.replace(/"/g, '') === 'Manrope' && f.status === 'loaded',
          ),
          boxes: nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        });
      }
      if (frames.length < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SELECTOR);

  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await page.waitForFunction(manropeLoaded, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  const frames = await page.evaluate(
    () => (window as unknown as { __fontShiftFrames: Array<{ fontLoaded: boolean; boxes: number[][] }> }).__fontShiftFrames,
  );
  expect(frames.length).toBeGreaterThan(0);
  const final = frames[frames.length - 1];
  let worst = 0;
  for (const f of frames) {
    // Controls mount progressively; compare only frames with the final set.
    if (f.boxes.length !== final.boxes.length) continue;
    f.boxes.forEach((b, i) => {
      for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(b[k] - final.boxes[i][k]));
    });
  }
  const fallbackFrames = frames.filter((f) => !f.fontLoaded).length;
  console.log(
    `[fontSwapShift:load] frames=${frames.length} fallbackFrames=${fallbackFrames} worst=${worst.toFixed(2)}px`,
  );
  expect(worst).toBeLessThanOrEqual(MAX_SHIFT_PX);
});

test('the fallback face keeps header line boxes when fonts arrive late', async ({ page }) => {
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
  const before = await headerBoxes(page);
  expect(before.length).toBeGreaterThan(0);

  release = true;
  for (const go of held.splice(0)) await go();
  await page.waitForFunction(manropeLoaded, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const after = await headerBoxes(page);
  expect(after.map((b) => b.key)).toEqual(before.map((b) => b.key));

  const { worst, worstY, rows } = diff(before, after);
  console.log(`[fontSwapShift:late] worst=${worst.toFixed(2)}px vertical=${worstY.toFixed(2)}px\n  ${rows.join('\n  ')}`);
  expect(worstY).toBeLessThanOrEqual(MAX_SHIFT_PX);
  expect(worst).toBeLessThanOrEqual(MAX_FALLBACK_WIDTH_SHIFT_PX);
});
