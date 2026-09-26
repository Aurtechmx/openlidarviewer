import type { Page } from '@playwright/test';

/**
 * One way to measure the header, shared by headerLayoutShift.spec.ts (the
 * Speed/Quality slot fill, fonts blocked) and fontSwapShift.spec.ts (normal
 * load and fonts arriving late), so the two cannot disagree about what a
 * shift is.
 *
 * Every visible link and button in the header, keyed by its accessible name
 * (text for an unnamed one). A comparison covers the keys both sides have:
 * controls that mount later, such as the Speed/Quality button that replaces
 * its placeholder, have no earlier box to compare with.
 */

export const HEADER_CONTROLS = 'header.olv-topbar a, header.olv-topbar button';

/**
 * Thresholds, one set for both specs.
 *
 * FONT_SHIFT_MAX_PX: the header's text links and badge have fixed boxes
 * (src/styles/20-topbar.css), so which face paints them (Manrope, "Manrope
 * Fallback", or the platform sans-serif Firefox paints before it resolves a
 * local() face) cannot move a control. Half a pixel absorbs layout rounding.
 *
 * SLOT_FILL_MAX_PX: the placeholder and the Speed/Quality control are both
 * 30x30, but the control is a different element with its own border and
 * rounding, so the fill is held to 1 px.
 */
export const FONT_SHIFT_MAX_PX = 0.5;
export const SLOT_FILL_MAX_PX = 1;

export type HeaderBox = { x: number; y: number; w: number; h: number };
export type HeaderBoxes = Record<string, HeaderBox>;

/**
 * Runs in the page. Defines `window.__olvMeasureHeader()`, which measures every
 * visible element matching `selector`. Passed to Playwright as a function with
 * an argument, so no script text is assembled from values.
 */
export function installMeasureInPage(selector: string): void {
  (window as unknown as { __olvMeasureHeader: () => HeaderBoxes }).__olvMeasureHeader = () => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const n of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const r = n.getBoundingClientRect();
      if (n.offsetParent === null || (r.width === 0 && r.height === 0)) continue;
      const key = n.getAttribute('aria-label') || (n.textContent ?? '').trim() || n.className;
      out[key] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  };
}

/** Makes `window.__olvMeasureHeader()` available from the first script on. */
export async function installHeaderMeasure(page: Page): Promise<void> {
  await page.addInitScript(installMeasureInPage, HEADER_CONTROLS);
}

export async function measureHeader(page: Page): Promise<HeaderBoxes> {
  await page.evaluate(installMeasureInPage, HEADER_CONTROLS);
  return page.evaluate(() => (window as unknown as { __olvMeasureHeader: () => HeaderBoxes }).__olvMeasureHeader());
}

export type HeaderShift = { compared: number; horizontal: number; vertical: number; rows: string[] };

/** Largest horizontal (x, width) and vertical (y, height) change across shared keys. */
export function headerShift(before: HeaderBoxes, after: HeaderBoxes): HeaderShift {
  let horizontal = 0;
  let vertical = 0;
  let compared = 0;
  const rows: string[] = [];
  for (const key of Object.keys(before)) {
    const a = before[key];
    const b = after[key];
    if (!b) continue;
    compared++;
    const dx = b.x - a.x, dy = b.y - a.y, dw = b.w - a.w, dh = b.h - a.h;
    horizontal = Math.max(horizontal, Math.abs(dx), Math.abs(dw));
    vertical = Math.max(vertical, Math.abs(dy), Math.abs(dh));
    rows.push(`${key} dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dw=${dw.toFixed(2)} dh=${dh.toFixed(2)}`);
  }
  return { compared, horizontal, vertical, rows };
}
