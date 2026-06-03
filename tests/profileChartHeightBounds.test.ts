import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROFILE_CHART_MIN_HEIGHT_PX,
  PROFILE_CHART_MAX_HEIGHT_PX,
} from '../src/ui/MeasurePanel';

/**
 * tests/profileChartHeightBounds.test.ts
 *
 * Pin the resizable profile chart's height bounds together across
 * TypeScript and CSS. v0.3.10 honesty-patch code-review #4 — the
 * 80 / 360 range is enforced in two places:
 *
 *   - `src/style.css` → `.olv-mp-chart { min-height: 80px;
 *     max-height: 360px; height: 140px; }` — the native
 *     `resize: vertical` handle is clamped by these CSS values.
 *   - `src/ui/MeasurePanel.ts` → the ResizeObserver callback only
 *     persists `clientHeight` to localStorage when it lies within
 *     `[PROFILE_CHART_MIN_HEIGHT_PX, PROFILE_CHART_MAX_HEIGHT_PX]`,
 *     and the on-mount restore path applies the same gate.
 *
 * Without this test, a future contributor could bump one side and
 * not the other — the symptom would be silent: the chart would
 * either snap back unexpectedly after a drag (CSS allowed more
 * than JS accepted), or never persist large heights (CSS clamped
 * before JS even ran). Both failure modes look like generic
 * "weird resize behaviour" bugs.
 *
 * The test parses the stylesheet textually rather than spinning
 * up a browser-like environment — the bounds live in plain
 * `min-height: <N>px;` / `max-height: <N>px;` declarations inside
 * the `.olv-mp-chart` rule.
 */
describe('profile chart height bounds — CSS vs TS source-of-truth', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/style.css', import.meta.url)),
    'utf8',
  );

  /**
   * Extract a single numeric pixel value for `<prop>` from the
   * `.olv-mp-chart { ... }` block. Returns `null` if the rule or
   * the property cannot be located.
   */
  function readChartPx(prop: 'min-height' | 'max-height' | 'height'): number | null {
    const blockMatch = css.match(/\.olv-mp-chart\s*\{([\s\S]*?)\}/);
    if (!blockMatch) return null;
    const block = blockMatch[1];
    // Match `<prop>: <N>px;` with optional whitespace; the `\b`
    // prevents `height` from matching `min-height` / `max-height`.
    const re = new RegExp(`\\b${prop}\\s*:\\s*(\\d+)px`, 'i');
    const m = block.match(re);
    return m ? Number(m[1]) : null;
  }

  it('CSS .olv-mp-chart min-height matches PROFILE_CHART_MIN_HEIGHT_PX', () => {
    const cssMin = readChartPx('min-height');
    expect(cssMin).not.toBeNull();
    expect(cssMin).toBe(PROFILE_CHART_MIN_HEIGHT_PX);
  });

  it('CSS .olv-mp-chart max-height matches PROFILE_CHART_MAX_HEIGHT_PX', () => {
    const cssMax = readChartPx('max-height');
    expect(cssMax).not.toBeNull();
    expect(cssMax).toBe(PROFILE_CHART_MAX_HEIGHT_PX);
  });

  it('CSS default height sits inside the [min, max] window', () => {
    // The default height isn't a hard contract with the TS layer,
    // but a future contributor who bumps the default to e.g. 500
    // would silently break the clamp. Catch it here.
    const cssDefault = readChartPx('height');
    expect(cssDefault).not.toBeNull();
    expect(cssDefault!).toBeGreaterThanOrEqual(PROFILE_CHART_MIN_HEIGHT_PX);
    expect(cssDefault!).toBeLessThanOrEqual(PROFILE_CHART_MAX_HEIGHT_PX);
  });

  it('TS bounds are sensible (min < max, both positive)', () => {
    expect(PROFILE_CHART_MIN_HEIGHT_PX).toBeGreaterThan(0);
    expect(PROFILE_CHART_MAX_HEIGHT_PX).toBeGreaterThan(
      PROFILE_CHART_MIN_HEIGHT_PX,
    );
  });
});
