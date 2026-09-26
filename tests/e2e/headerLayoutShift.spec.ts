import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, suppressOnboardingTour } from './helpers';

/**
 * The header's right cluster must not move after first paint.
 *
 * The Speed/Quality control mounts once the viewer is up. It used to be
 * inserted before GitHub at that moment, pushing Credits, Guide and the theme
 * toggle left under a pointer already aimed at them. Its slot is now reserved
 * at first paint. This spec records the cluster's boxes on the first frame the
 * header exists, then again after the viewer is ready and a scan is open.
 */

type Boxes = Record<string, { x: number; y: number; w: number; h: number } | null>;

/** Selectors for the controls a pointer might be aimed at. */
const TARGETS: Record<string, string> = {
  credits: '.olv-topbar-right a[href="credits.html"]',
  guide: '.olv-topbar-right a[href*="/guide/"]',
  theme: '.olv-topbar-right .olv-theme-toggle',
  github: '.olv-topbar-right a[href*="github.com"]',
  fullscreen: '.olv-topbar-right .olv-fs-toggle',
};

async function recordFirstPaint(page: Page): Promise<void> {
  await page.addInitScript((targets: Record<string, string>) => {
    const measure = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, sel] of Object.entries(targets)) {
        const n = document.querySelector(sel);
        if (!n) { out[k] = null; continue; }
        const r = n.getBoundingClientRect();
        out[k] = r.width === 0 && r.height === 0 ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return out;
    };
    const w = window as unknown as { __olvHeaderFirst?: unknown };
    const obs = new MutationObserver(() => {
      if (!document.querySelector(targets.theme)) return;
      obs.disconnect();
      requestAnimationFrame(() => { w.__olvHeaderFirst = measure(); });
    });
    obs.observe(document, { childList: true, subtree: true });
  }, TARGETS);
}

async function measureNow(page: Page): Promise<Boxes> {
  return page.evaluate((targets: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [k, sel] of Object.entries(targets)) {
      const n = document.querySelector(sel);
      if (!n) { out[k] = null; continue; }
      const r = n.getBoundingClientRect();
      out[k] = r.width === 0 && r.height === 0 ? null : { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, TARGETS) as Promise<Boxes>;
}

async function assertStable(page: Page): Promise<void> {
  // The Manrope web font swaps in after first paint (font-display: swap) and
  // reflows the text links by 1-3 px on its own. That is a separate effect
  // from the control mount this spec pins, so the font is kept out and every
  // measurement uses the same fallback face.
  await page.route(/\.woff2?(\?.*)?$/, (route) => route.abort());
  await suppressOnboardingTour(page);
  await recordFirstPaint(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __olvHeaderFirst?: unknown }).__olvHeaderFirst);
  // The slot exists at first paint, empty, hidden from assistive tech.
  const first = await page.evaluate(
    () => (window as unknown as { __olvHeaderFirst: unknown }).__olvHeaderFirst,
  ) as Boxes;

  // The slot is inert until filled; once filled the real control is there.
  await expect(page.locator('.olv-quality-button')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.olv-quality-slot')).toHaveCount(0);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(300);
  const after = await measureNow(page);

  let compared = 0;
  for (const key of Object.keys(TARGETS)) {
    const a = first[key];
    const b = after[key];
    if (!a || !b) continue;
    compared++;
    expect.soft(Math.abs(a.x - b.x), `${key} moved horizontally`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(a.y - b.y), `${key} moved vertically`).toBeLessThanOrEqual(1);
  }
  expect(compared).toBeGreaterThanOrEqual(2);
  expect(first.theme).not.toBeNull();
}

test.describe('header right cluster does not shift after first paint', () => {
  test('desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await assertStable(page);
  });

  test('phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await assertStable(page);
  });
});
