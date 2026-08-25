/**
 * profileAxisLabelFit.test.ts — axis labels that do not overprint each other.
 *
 * The profile chart thinned its x labels by sample index: keep every Nth, and
 * drop one that fell within half a stride of the last. Index spacing is pixel
 * spacing only when every label is the same width and anchored the same way,
 * and neither is true on this axis. On a 105 m profile that left "80" and
 * "105.26 m" overprinting into one unreadable run of digits.
 *
 * One fitter serves two renderers, which anchor their end labels differently.
 * A canvas axis centres every label, so an end label can hang past the strip
 * and has to be dropped. The panel's HTML overlay pulls its ends inside the
 * plot instead, so nothing overhangs and the ends are kept: they carry the
 * axis range. Judging one renderer by the other's rule is the whole reason
 * `ends` is an input rather than an assumption.
 */

import { describe, it, expect } from 'vitest';
import { fitAxisLabels, axisLabelWidth, AXIS_LABEL_CHAR_EM } from '../src/render/measure/profileAxes';

type Fit = Parameters<typeof fitAxisLabels>[0];

/** A strip whose labels all occupy `width`, positioned by fraction. */
const strip = (
  at: readonly number[],
  width: number,
  containerPx: number,
  ends: 'centred' | 'pulled-in',
): Fit => ({
  labels: at.map(() => 'x'),
  pixels: at.map((f) => f * containerPx),
  containerPx,
  fontPx: 11,
  extentPx: () => width,
  ends,
});

const evenly = (n: number, width: number, containerPx: number, ends: 'centred' | 'pulled-in') =>
  strip(Array.from({ length: n }, (_, i) => i / (n - 1)), width, containerPx, ends);

/** The span a kept label occupies, mirroring the fitter's own anchoring. */
function spans(fit: Fit, keep: readonly boolean[]): Array<readonly [number, number]> {
  const last = fit.labels.length - 1;
  const out: Array<readonly [number, number]> = [];
  fit.labels.forEach((l, i) => {
    if (!keep[i]) return;
    const w = fit.extentPx!(l);
    if (fit.ends === 'pulled-in' && i === 0) out.push([0, w]);
    else if (fit.ends === 'pulled-in' && i === last) out.push([fit.containerPx - w, fit.containerPx]);
    else out.push([fit.pixels[i]! - w / 2, fit.pixels[i]! + w / 2]);
  });
  return out;
}

describe('label width errs wide', () => {
  it('is at least the widest measured character advance', () => {
    // "88 m" measures 6.74px at 11px in the axis font. Understating a width
    // is what lets two labels overlap, so the constant has to sit above it.
    expect(11 * AXIS_LABEL_CHAR_EM).toBeGreaterThanOrEqual(6.74);
    expect(axisLabelWidth('88 m', 11)).toBeGreaterThanOrEqual(4 * 6.74);
  });

  it('treats a missing or absurd font size as zero rather than guessing', () => {
    expect(axisLabelWidth('88 m', 0)).toBe(0);
    expect(axisLabelWidth('88 m', Number.NaN)).toBe(0);
  });
});

describe('a centred strip', () => {
  it('drops an end label that would hang past the strip', () => {
    // Centred on the last tick, half the label sits outside the plot. Half a
    // number at the edge states a value the axis is not showing.
    const keep = fitAxisLabels(strip([0, 0.5, 1], 40, 300, 'centred'));
    expect(keep[0]).toBe(false);
    expect(keep[2]).toBe(false);
    expect(keep[1]).toBe(true);
  });
});

describe('a pulled-in strip', () => {
  it('keeps both ends, because they carry the axis range', () => {
    const keep = fitAxisLabels(evenly(3, 40, 300, 'pulled-in'));
    expect(keep[0]).toBe(true);
    expect(keep[2]).toBe(true);
  });

  it('keeps every label when the strip has room', () => {
    expect(fitAxisLabels(evenly(5, 20, 500, 'pulled-in'))).toEqual([true, true, true, true, true]);
  });

  it('drops the interior when only the ends fit', () => {
    // 150 wide with 60-wide labels: the ends take [0,60] and [90,150], and no
    // centred box fits in the 30 between them.
    const keep = fitAxisLabels(evenly(5, 60, 150, 'pulled-in'));
    expect(keep[0]).toBe(true);
    expect(keep[4]).toBe(true);
    expect(keep.slice(1, 4)).toEqual([false, false, false]);
  });

  it('drops a label that would touch the right-anchored last one', () => {
    // The reported case: a label close to the end whose centred box runs into
    // the final label's box even though its index is a stride away.
    const fit: Fit = {
      labels: ['0 m', '50 m', '92 m', '105.26 m'],
      pixels: [0, 150, 261, 300],
      containerPx: 300,
      fontPx: 11,
      ends: 'pulled-in',
    };
    const keep = fitAxisLabels(fit);
    expect(keep[3]).toBe(true);
    expect(keep[2]).toBe(false);
  });

  it('never lets two kept labels overlap', () => {
    const fit = evenly(9, 40, 320, 'pulled-in');
    const boxes = spans(fit, fitAxisLabels(fit));
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i][0], `label ${i} starts before ${i - 1} ends`).toBeGreaterThanOrEqual(
        boxes[i - 1][1],
      );
    }
  });

  it('keeps the far end when the two ends themselves collide', () => {
    // A very short strip. The end carrying the extent is the one to keep.
    const keep = fitAxisLabels(evenly(2, 40, 60, 'pulled-in'));
    expect(keep[1]).toBe(true);
    expect(keep[0]).toBe(false);
  });
});

describe('degenerate input', () => {
  it('invents nothing', () => {
    expect(fitAxisLabels(strip([], 10, 100, 'pulled-in'))).toEqual([]);
    expect(fitAxisLabels(evenly(3, 10, 0, 'pulled-in'))).toEqual([false, false, false]);
    expect(fitAxisLabels(strip([0], 10, 100, 'pulled-in'))).toEqual([true]);
  });

  it('skips a tick with no finite position', () => {
    const fit: Fit = {
      labels: ['a', 'b'],
      pixels: [Number.NaN, 150],
      containerPx: 300,
      fontPx: 11,
      extentPx: () => 20,
      ends: 'centred',
    };
    expect(fitAxisLabels(fit)[0]).toBe(false);
  });
});
