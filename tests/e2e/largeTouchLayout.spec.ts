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
 * Controls whose centre is covered by anything else: elementFromPoint at the
 * centre of every visible control must land on the control or a descendant.
 * A control scrolled out of its own scroll container (its centre outside a
 * clipping ancestor's padding box) is not visible, so it is skipped rather
 * than reported.
 */
async function coveredControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const clippedAway = (c: HTMLElement, x: number, y: number): boolean => {
      for (let a = c.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        // Clip to the padding box: content scrolled under the container's own
        // border or scrollbar is not visible either, and elementFromPoint
        // there returns the container.
        const r = a.getBoundingClientRect();
        const left = r.left + a.clientLeft;
        const top = r.top + a.clientTop;
        if (x < left || x >= left + a.clientWidth || y < top || y >= top + a.clientHeight) return true;
      }
      return false;
    };
    for (const c of document.querySelectorAll<HTMLElement>('button, a[href], input, select, summary, [role="button"], [role="tab"]')) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(c).visibility === 'hidden') continue;
      if (c.closest('.olv-lasso-toast:not(.olv-visible), [aria-hidden="true"], [inert]')) continue;
      if (!c.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (clippedAway(c, x, y)) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || c.contains(hit)) continue;
      const by = hit.closest<HTMLElement>('[class]');
      out.push(`${c.className} "${(c.textContent ?? '').trim().slice(0, 20)}" under ${by?.className ?? hit.tagName}`);
    }
    return out;
  });
}

/**
 * The colour key in both right-rail states. The scan opens coloured by height
 * (a colour-by-value mode), so the legend must show whether the rail is open
 * (docked, compact) or collapsed (floating, covering nothing).
 */
async function checkLegendBothRailStates(page: Page, tap: boolean, shot: string): Promise<void> {
  const legend = page.locator('.olv-colorbar');
  const rightTab = page.locator('.olv-right-rail-tab');
  const press = async (): Promise<void> => { if (tap) await rightTab.tap(); else await rightTab.click(); };
  await expect(legend).toBeVisible();
  await expect(legend).toHaveClass(/olv-colorbar-docked/);
  const docked = await legend.boundingBox();
  expect(docked?.height ?? 999).toBeLessThanOrEqual(200);

  await press();
  await expect(rightTab).toHaveAttribute('aria-expanded', 'false');
  await expect(legend).toBeVisible();
  await expect(legend).toHaveClass(/olv-colorbar-floating/);
  await page.waitForTimeout(600); // let the rail slide finish
  expect(await coveredControls(page)).toEqual([]);
  await page.screenshot({ path: `test-results/${shot}-collapsed.png` });

  await press();
  await expect(rightTab).toHaveAttribute('aria-expanded', 'true');
  await expect(legend).toBeVisible();
  await expect(legend).toHaveClass(/olv-colorbar-docked/);
  await page.waitForTimeout(600);
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
      // One navigation: Firefox aborts a second goto issued while the first
      // page is still loading its lazy chunks (NS_BINDING_ABORTED).
      await openScan(page);
      const matches = await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY);
      test.skip(!matches, `${info.project.name} does not emulate a coarse, non-hovering pointer`);

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
      expect(await coveredControls(page)).toEqual([]);
      await page.screenshot({ path: `test-results/large-touch-${size.width}x${size.height}-toast-${info.project.name}.png` });
      // Once the toast times out the legend is back, and still covers nothing.
      await expect(page.locator('.olv-lasso-toast.olv-visible')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('.olv-colorbar')).toBeVisible();
      expect(await coveredControls(page)).toEqual([]);

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
      await checkLegendBothRailStates(page, true, `large-touch-${size.width}x${size.height}-${info.project.name}`);
      await page.waitForTimeout(600); // let the rail slide finish

      // No precise drag is required: the rail corner grip is gone.
      await expect(page.locator('.olv-mp-resize')).toBeHidden();

      expect(await smallTargets(page, info.project.name)).toEqual([]);
      await noHorizontalScroll(page);
    });

    test('a long-press shows the tip and does not activate the control', async ({ page }, info) => {
      // One navigation: Firefox aborts a second goto issued while the first
      // page is still loading its lazy chunks (NS_BINDING_ABORTED).
      await openScan(page);
      const matches = await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY);
      test.skip(!matches, `${info.project.name} does not emulate a coarse, non-hovering pointer`);

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

for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
  test.describe(`fine pointer ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('keeps the desktop density, and nothing sits over a control', async ({ page }, info) => {
      await openScan(page);
      expect(await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY)).toBe(false);
      const tab = await page.locator('.olv-rail-tab').boundingBox();
      expect(tab?.width).toBeLessThan(44);
      const chip = await page.locator('.olv-ws-tab').first().boundingBox();
      expect(chip?.height).toBeLessThan(44);
      // The overlap fixes are not large-touch only: the desktop had them too.
      await expect(page.locator('.olv-lasso-toast.olv-visible')).toBeVisible();
      await page.waitForTimeout(500);
      expect(await coveredControls(page)).toEqual([]);
      // The right rail ends above the dock.
      const rail = await page.locator('.olv-right-rail').boundingBox();
      const dock = await page.locator('.olv-dock').boundingBox();
      if (rail && dock && rail.x < dock.x + dock.width) expect(rail.y + rail.height).toBeLessThanOrEqual(dock.y);
      await expect(page.locator('.olv-lasso-toast.olv-visible')).toHaveCount(0, { timeout: 10_000 });
      await page.screenshot({ path: `test-results/desktop-${size.width}x${size.height}-${info.project.name}-docked.png` });
      await checkLegendBothRailStates(page, false, `desktop-${size.width}x${size.height}-${info.project.name}`);
    });
  });
}
