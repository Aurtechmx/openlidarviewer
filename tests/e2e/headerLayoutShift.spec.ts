import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, suppressOnboardingTour } from './helpers';
import { SLOT_FILL_MAX_PX, headerShift, installHeaderMeasure, measureHeader, type HeaderBoxes } from './headerBoxes';

/**
 * The header's right cluster must not move after first paint.
 *
 * The Speed/Quality control mounts once the viewer is up. It used to be
 * inserted before GitHub at that moment, pushing Credits, Guide and the theme
 * toggle left under a pointer already aimed at them. Its slot is now reserved
 * at first paint. This spec records every header control on the first frame
 * the right cluster exists, then again after the viewer is ready and a scan is
 * open (measurement and thresholds: ./headerBoxes.ts).
 */

async function assertStable(page: Page): Promise<void> {
  // Fonts are kept out so the header is compared under one face throughout.
  // Loading and late fonts are fontSwapShift.spec.ts, same measurement.
  await page.route(/\.woff2?(\?.*)?$/, (route) => route.abort());
  await suppressOnboardingTour(page);
  await installHeaderMeasure(page);
  // First frame the header's controls exist, before the slot is filled.
  await page.addInitScript(() => {
    const w = window as unknown as { __olvMeasureHeader: () => HeaderBoxes; __olvHeaderFirst?: HeaderBoxes };
    const obs = new MutationObserver(() => {
      if (!document.querySelector('.olv-topbar-right .olv-theme-toggle')) return;
      obs.disconnect();
      requestAnimationFrame(() => { w.__olvHeaderFirst = w.__olvMeasureHeader(); });
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __olvHeaderFirst?: unknown }).__olvHeaderFirst);
  const first = await page.evaluate(
    () => (window as unknown as { __olvHeaderFirst: HeaderBoxes }).__olvHeaderFirst,
  );

  await expect(page.locator('.olv-quality-button')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.olv-quality-slot')).toHaveCount(0);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(300);
  const after = await measureHeader(page);

  const s = headerShift(first, after);
  console.log(`[headerLayoutShift] horizontal=${s.horizontal.toFixed(2)}px vertical=${s.vertical.toFixed(2)}px\n  ${s.rows.join('\n  ')}`);
  expect(s.compared).toBeGreaterThanOrEqual(2);
  expect(Object.keys(first).some((k) => k.startsWith('Theme:'))).toBe(true);
  expect(s.horizontal, 'a header control moved horizontally').toBeLessThanOrEqual(SLOT_FILL_MAX_PX);
  expect(s.vertical, 'a header control moved vertically').toBeLessThanOrEqual(SLOT_FILL_MAX_PX);
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
