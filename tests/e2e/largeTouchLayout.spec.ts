import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, suppressOnboardingTour } from './helpers';
import { LARGE_TOUCH_LAYOUT_QUERY } from '../../src/platform/runtimeFormFactor';

/**
 * tests/e2e/largeTouchLayout.spec.ts
 *
 * The large-touch workspace: a touch-first screen (coarse pointer, no hover)
 * big enough for the desktop layout keeps the rails, mode tabs and dock, but
 * every control is a 44 px touch target, nothing needs hover (tips come up on
 * a long-press) and nothing needs a precise drag.
 *
 * Driven entirely by taps at two landscape sizes, with touch emulation on and
 * the mobile viewport flag off, so the page sees `(pointer: coarse) and
 * (hover: none)` at a desktop-sized viewport. A last case checks a fine
 * pointer at the same size keeps the desktop density.
 */

const TARGETS = [
  '.olv-left-panels button', '.olv-left-panels summary', '.olv-left-panels select',
  '.olv-right-rail button', '.olv-right-rail summary', '.olv-right-rail select',
  '.olv-dock button', '.olv-measure-bar button', '.olv-rail-tab', '.olv-right-rail-tab',
  '.olv-ws-tab', '.olv-cam-chip', '.olv-theme-toggle', '.olv-quality-button', '.olv-github',
].join(', ');

async function openScan(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** Visible, on-screen targets smaller than 44 px on either side. */
async function smallTargets(page: Page, engine: string): Promise<string[]> {
  // WebKit's desktop engine paints a native menulist <select> at its intrinsic
  // height whatever min-height says, so selects are measured on Chromium only.
  const sel = engine === 'webkit' ? TARGETS.replace(/, [^,]* select/g, '') : TARGETS;
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(e).visibility === 'hidden') continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        out.push(`${e.className} "${(e.textContent ?? '').trim().slice(0, 24)}" ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
      }
    }
    return out;
  }, sel);
}

/**
 * Controls whose centre is covered by one of the floating overlays: the colour
 * legend, the status toast or the navigation card. A control counts as covered
 * when elementFromPoint at its centre lands inside one of those overlays and
 * the control is not itself part of that overlay.
 */
async function coveredByOverlays(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const OVERLAYS = '.olv-colorbar, .olv-lasso-toast.olv-visible, .olv-navbar';
    const out: string[] = [];
    for (const c of document.querySelectorAll<HTMLElement>('button, a[href], input, select, summary, [role="button"], [role="tab"]')) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(c).visibility === 'hidden') continue;
      if (c.closest('.olv-lasso-toast:not(.olv-visible)')) continue; // faded-out toast: not shown
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || c.contains(hit)) continue;
      const over = hit.closest(OVERLAYS);
      if (over && !over.contains(c)) {
        out.push(`${c.className} "${(c.textContent ?? '').trim().slice(0, 20)}" under ${over.className}`);
      }
    }
    return out;
  });
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const [scrollW, viewW] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  // What a finger can do: try to pan the page sideways and see if it moved.
  const scrolled = await page.evaluate(() => {
    window.scrollTo(10_000, 0);
    const x = window.scrollX + document.scrollingElement!.scrollLeft;
    window.scrollTo(0, 0);
    return x;
  });
  expect(scrolled, `page scrolls sideways (scrollWidth ${scrollW} > ${viewW})`).toBe(0);
}

for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
  test.describe(`large-touch ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: false });

    test('scan, dock, rails and a measurement all work by tap with 44 px targets', async ({ page }, info) => {
      await suppressOnboardingTour(page);
      await page.goto('/');
      const matches = await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY);
      test.skip(!matches, `${info.project.name} does not emulate a coarse, non-hovering pointer`);
      await openScan(page);

      // Desktop workspace, not the phone sheet.
      await expect(page.locator('.olv-left-panels')).toBeVisible();
      await expect(page.locator('.olv-dock')).toBeVisible();
      await expect(page.locator('.olv-mobile-sheet')).toBeHidden();

      // Dock: tap Measure, pick a kind by tap.
      await page.locator('.olv-dock .olv-tool', { hasText: 'Measure' }).tap();
      await expect(page.locator('.olv-measure-bar')).toBeVisible();
      await page.locator('.olv-mkind', { hasText: 'Area' }).tap();
      await expect(page.locator('.olv-mkind-active')).toHaveText('Area');
      await page.locator('.olv-mkind', { hasText: 'Distance' }).tap();
      await expect(page.locator('.olv-mkind-active')).toHaveText('Distance');

      // A measurement: points through the placement seam (canvas picks are
      // not deterministic on headless WebGL), then the list is operated by tap.
      await page.evaluate(() => {
        const api = (window as unknown as { __OLV_TEST_API__?: {
          setMeasureKind: (k: string) => void;
          placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
        } }).__OLV_TEST_API__;
        if (!api) throw new Error('__OLV_TEST_API__ not mounted');
        api.setMeasureKind('distance');
        api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
        api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
      });
      await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

      // The legend, the scan-ready toast and the navigation card are all up
      // now; none of them may sit over a control.
      await expect(page.locator('.olv-colorbar')).toBeAttached();
      await expect(page.locator('.olv-lasso-toast.olv-visible')).toBeVisible();
      await expect(page.locator('.olv-navbar')).toBeVisible();
      await page.waitForTimeout(500); // let the toast's move settle before hit-testing
      expect(await coveredByOverlays(page)).toEqual([]);
      await page.screenshot({ path: `test-results/large-touch-${size.width}x${size.height}-toast-${info.project.name}.png` });
      // Once the toast times out the legend is back, and still covers nothing.
      await expect(page.locator('.olv-lasso-toast.olv-visible')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('.olv-colorbar')).toBeVisible();
      expect(await coveredByOverlays(page)).toEqual([]);

      expect(await smallTargets(page, info.project.name)).toEqual([]);
      await noHorizontalScroll(page);
      await page.screenshot({ path: info.outputPath(`large-touch-${size.width}x${size.height}.png`) });
      await page.screenshot({ path: `test-results/large-touch-${size.width}x${size.height}-${info.project.name}.png` });

      await page.locator('.olv-measure-clear').tap();
      await expect(page.locator('.olv-mp-row')).toHaveCount(0);

      // Mode tabs by tap.
      await page.locator('.olv-ws-tab', { hasText: 'Data' }).tap();
      await expect(page.locator('.olv-ws-tab', { hasText: 'Data' })).toHaveClass(/is-active/);

      // Rails: collapse and restore both by tap.
      const leftTab = page.locator('.olv-rail-tab');
      await leftTab.tap();
      await expect(page.locator('.olv-left-panels')).toHaveClass(/olv-rail-collapsed/);
      await leftTab.tap();
      await expect(page.locator('.olv-left-panels')).not.toHaveClass(/olv-rail-collapsed/);
      const rightTab = page.locator('.olv-right-rail-tab');
      await expect(rightTab).toHaveAttribute('aria-expanded', 'true');
      await rightTab.tap();
      await expect(rightTab).toHaveAttribute('aria-expanded', 'false');
      await rightTab.tap();
      await expect(rightTab).toHaveAttribute('aria-expanded', 'true');
      await page.waitForTimeout(600); // let the rail slide finish

      // No precise drag is required: the rail corner grip is gone.
      await expect(page.locator('.olv-mp-resize')).toBeHidden();

      expect(await smallTargets(page, info.project.name)).toEqual([]);
      await noHorizontalScroll(page);
    });

    test('a long-press shows the tip and does not activate the control', async ({ page }, info) => {
      await suppressOnboardingTour(page);
      await page.goto('/');
      const matches = await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY);
      test.skip(!matches, `${info.project.name} does not emulate a coarse, non-hovering pointer`);
      await openScan(page);

      const result = await page.evaluate(async () => {
        const anchor = document.querySelector<HTMLElement>('.olv-dock [data-tip], .olv-dock [title]');
        if (!anchor) throw new Error('no dock control with a tip');
        let activated = 0;
        anchor.addEventListener('click', () => { activated += 1; });
        const r = anchor.getBoundingClientRect();
        const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: 'touch', pointerId: 7, isPrimary: true };
        anchor.dispatchEvent(new PointerEvent('pointerdown', at));
        await new Promise((res) => setTimeout(res, 700));
        const layer = document.querySelector('.olv-tip-layer');
        const shown = Boolean(layer?.classList.contains('olv-tip-layer--visible')) && getComputedStyle(layer!).display !== 'none';
        anchor.dispatchEvent(new PointerEvent('pointerup', at));
        anchor.dispatchEvent(new PointerEvent('pointerout', at));
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const stillShown = Boolean(layer?.classList.contains('olv-tip-layer--visible'));
        // A short tap afterwards dismisses the tip and activates normally.
        document.body.dispatchEvent(new PointerEvent('pointerdown', { ...at, clientX: 5, clientY: 5 }));
        const hiddenAfterTap = !layer?.classList.contains('olv-tip-layer--visible');
        return { shown, stillShown, activated, hiddenAfterTap, text: layer?.textContent ?? '' };
      });
      expect(result.shown).toBe(true);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.stillShown).toBe(true);
      expect(result.activated).toBe(0);
      expect(result.hiddenAfterTap).toBe(true);
    });
  });
}

test.describe('fine pointer at the same size', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps the desktop density (the large-touch rules do not apply)', async ({ page }) => {
    await openScan(page);
    expect(await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY)).toBe(false);
    const tab = await page.locator('.olv-rail-tab').boundingBox();
    expect(tab?.width).toBeLessThan(44);
    const chip = await page.locator('.olv-ws-tab').first().boundingBox();
    expect(chip?.height).toBeLessThan(44);
    // The overlay fix is not large-touch only: the desktop had the same overlap.
    await expect(page.locator('.olv-lasso-toast.olv-visible')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await coveredByOverlays(page)).toEqual([]);
  });
});
