/**
 * tests/classScopeBanner.test.ts
 *
 * Coverage for the raster-export class-scope banner — the escape-hatch
 * closure that keeps a filtered image self-describing. Two non-negotiables:
 *
 *  1. An EMPTY / whitespace stamp draws NOTHING — an unfiltered export is
 *     byte-identical to the pre-feature image (no banner pixels touched).
 *  2. A non-empty stamp draws a pill + the "Class filter active — …" label.
 *
 * The renderer runs in the Node test environment (no DOM / canvas), so we
 * drive `drawClassScopeBanner` with a minimal stub 2-D context that records
 * the calls it would make. We assert on the recorded text + fill/stroke
 * activity rather than pixels — enough to pin the contract.
 */

import { describe, it, expect } from 'vitest';
import { drawClassScopeBanner } from '../src/export/ScanReportRenderer';

/** A tiny recording stub of the slice of CanvasRenderingContext2D used. */
function makeStubCtx(width = 1200, height = 800) {
  const calls = {
    fillTextArgs: [] as string[],
    fillCount: 0,
    strokeCount: 0,
    roundRectish: 0,
  };
  const ctx = {
    canvas: { width, height },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    arcTo() {
      calls.roundRectish++;
    },
    closePath() {},
    fill() {
      calls.fillCount++;
    },
    stroke() {
      calls.strokeCount++;
    },
    fillRect() {},
    measureText(text: string) {
      // A deterministic monospace-ish metric so truncation logic is testable.
      return { width: text.length * 8 };
    },
    fillText(text: string) {
      calls.fillTextArgs.push(text);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawClassScopeBanner — no-filter is a no-op', () => {
  it('empty / whitespace stamp draws nothing', () => {
    for (const stamp of ['', '   ', '\t\n']) {
      const { ctx, calls } = makeStubCtx();
      drawClassScopeBanner(ctx, stamp);
      expect(calls.fillTextArgs).toHaveLength(0);
      expect(calls.fillCount).toBe(0);
      expect(calls.strokeCount).toBe(0);
    }
  });
});

describe('drawClassScopeBanner — filtered draws the caveat', () => {
  it('draws a pill and the "Class filter active — …" label', () => {
    const { ctx, calls } = makeStubCtx();
    drawClassScopeBanner(ctx, 'Ground + Building · 2 of 5 classes');
    // Pill background + border were drawn.
    expect(calls.fillCount).toBeGreaterThanOrEqual(1);
    expect(calls.strokeCount).toBeGreaterThanOrEqual(1);
    // The label is present and names the filter scope.
    expect(calls.fillTextArgs).toHaveLength(1);
    expect(calls.fillTextArgs[0]).toContain('Class filter active');
    expect(calls.fillTextArgs[0]).toContain('Ground + Building · 2 of 5 classes');
  });

  it('truncates an over-wide label to fit the canvas with an ellipsis', () => {
    // A very narrow canvas forces the ellipsis branch.
    const { ctx, calls } = makeStubCtx(120, 800);
    drawClassScopeBanner(ctx, 'Ground + Building + Water + Rail + Bridge deck · 5 of 9 classes');
    expect(calls.fillTextArgs).toHaveLength(1);
    expect(calls.fillTextArgs[0].endsWith('…')).toBe(true);
  });
});
