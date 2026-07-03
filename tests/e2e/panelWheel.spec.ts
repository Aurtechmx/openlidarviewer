import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * tests/e2e/panelWheel.spec.ts
 *
 * P9 — panel scrolling & wheel ownership. Two guarantees, both live-DOM:
 *
 *   1. Scrollable overlay panels CONTAIN their scroll — `overscroll-behavior`
 *      is `contain`, so a scroll can't chain to the page or rubber-band the
 *      canvas underneath.
 *   2. Wheel OWNERSHIP — a wheel over a panel is stopped at the panel (never
 *      bubbles onward to a handler that could move the camera), while a wheel
 *      over the canvas is NOT stopped (the camera dolly controller still owns
 *      it). We measure this by counting wheels that reach `document`.
 */

async function loadSample(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

test('scrollable panels contain their scroll (overscroll-behavior)', async ({ page }) => {
  await loadSample(page);
  const ob = await page
    .locator('.olv-left-panels')
    .evaluate((el) => getComputedStyle(el).overscrollBehaviorY);
  expect(ob).toBe('contain');
});

test('a wheel over a panel is contained; a wheel over the canvas is not', async ({ page }) => {
  await loadSample(page);

  // Instrument: count wheel events that bubble all the way to `document`.
  await page.evaluate(() => {
    (window as unknown as { __docWheel: number }).__docWheel = 0;
    document.addEventListener(
      'wheel',
      () => {
        (window as unknown as { __docWheel: number }).__docWheel++;
      },
      { passive: true },
    );
  });

  // A wheel over the left panel column is stopped at the panel.
  await page.locator('.olv-left-panels').dispatchEvent('wheel', { deltaY: 200, bubbles: true });
  const afterPanel = await page.evaluate(
    () => (window as unknown as { __docWheel: number }).__docWheel,
  );
  expect(afterPanel).toBe(0);

  // A wheel over the canvas is NOT stopped — the dolly controller owns it and it
  // still reaches document (the controller preventDefaults but does not stopPropagation).
  await page.locator('.olv-canvas').dispatchEvent('wheel', { deltaY: 200, bubbles: true });
  const afterCanvas = await page.evaluate(
    () => (window as unknown as { __docWheel: number }).__docWheel,
  );
  expect(afterCanvas).toBeGreaterThan(0);
});
