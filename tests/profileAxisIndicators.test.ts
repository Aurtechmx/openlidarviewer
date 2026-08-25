/**
 * profileAxisIndicators.test.ts
 *
 * The axis indicators the docked Profile Workbench draws over its plot: where
 * the ticks fall, what the height axis is allowed to call itself, and which
 * labels survive a narrow dock.
 *
 * Three properties are asserted, each of which the plot is wrong without.
 *
 * A TICK IS AN EXACT MULTIPLE OF ITS STEP. A reader measures off the rules, so
 * a label reading 12 has to sit at 12 and not at 12.000000000000002. The check
 * is arithmetic rather than textual: every emitted value divided by its step
 * must be an integer.
 *
 * THE HEIGHT AXIS PROMISES NOTHING THE SCAN DOES NOT SUPPORT. A section with
 * no declared datum is titled "Height (datum unknown)". "Elevation" is earned
 * by an orthometric reference and by nothing else, on this axis for the same
 * reason it is in the point inspector and on the exported sheet.
 *
 * LABELS DO NOT OVERLAP. `fitAxisLabels` decides which are drawn, and the
 * assertion below is geometric: every kept pair must be separated by at least
 * the gap the fitter promises, at the narrowest plot the dock permits.
 */

import { describe, it, expect } from 'vitest';
import {
  AXIS_LABEL_MIN_GAP_PX,
  axisLabelWidth,
  axisTicks,
  chainageTickLabels,
  DEFAULT_TARGET_TICKS,
  fitAxisLabels,
  heightAxisTitle,
  profileAxes,
} from '../src/render/measure/profileAxes';
import {
  AXIS_FONT_PX,
} from '../src/app/profileWorkbenchSection';
import { fitProfileView } from '../src/render/measure/profileViewTransform';
import type { ProfileViewport } from '../src/render/measure/profileViewTransform';

/** No metres scale on either axis: the plot's own honest mode. */
const NO_SCALE = { horizontalToMetres: null, verticalToMetres: null };

/** A section extent with awkward, non-round bounds on both axes. */
const BOUNDS = {
  minChainage: -3.7,
  maxChainage: 241.31,
  minHeight: 1103.04,
  maxHeight: 1131.9,
};

function viewOf(viewport: ProfileViewport) {
  const view = fitProfileView(BOUNDS, viewport, { kind: 'fit' }, NO_SCALE);
  if (!view) throw new Error('the fixture bounds must produce a view');
  return view;
}

describe('a tick is an exact multiple of its step', () => {
  it('holds for every span the plot can be asked for', () => {
    const spans: [number, number][] = [
      [-3.7, 241.31],
      [1103.04, 1131.9],
      [0, 0.0007],
      [-1_250_500, 1_250_500],
      [12.0000001, 12.0000009],
    ];
    for (const [lo, hi] of spans) {
      const ticks = axisTicks(lo, hi, DEFAULT_TARGET_TICKS);
      for (const v of ticks.values) {
        const q = v / ticks.step;
        expect(Math.abs(q - Math.round(q)), `${v} is not a multiple of ${ticks.step}`).toBeLessThan(
          1e-6,
        );
      }
    }
  });

  it('prints a label with no binary residue in it', () => {
    const ticks = axisTicks(0, 0.5, 5);
    for (const label of chainageTickLabels(ticks)) {
      expect(label).not.toMatch(/\d{8,}$/);
    }
  });
});

describe('the height axis states no more than the scan supports', () => {
  it('reads "Height (datum unknown)" for a section with no declared datum', () => {
    // Built explicitly rather than taken from a default: this is the case a
    // scan with no vertical datum lands in, and the one an axis is most
    // tempted to call an elevation.
    expect(heightAxisTitle('unknown', null)).toBe('Height (datum unknown)');
    // With a unit the word is unchanged and the unit is appended, the same
    // `word (unit)` composition the station table's headings use.
    expect(heightAxisTitle('unknown', 'm')).toBe('Height (datum unknown) (m)');

    const viewport: ProfileViewport = { width: 640, height: 320, devicePixelRatio: 1 };
    const axes = profileAxes(viewOf(viewport), viewport, {
      reference: 'unknown',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      units: NO_SCALE,
      targetXTicks: DEFAULT_TARGET_TICKS,
      targetYTicks: DEFAULT_TARGET_TICKS,
    });
    expect(axes.y.title).toContain('Height (datum unknown)');
    expect(axes.y.title).not.toContain('Elevation');
    expect(axes.x.title).toBe('Chainage (m)');
  });

  it('reserves "Elevation" for a reference that earns it', () => {
    expect(heightAxisTitle('orthometric', 'm')).toBe('Elevation (m)');
    expect(heightAxisTitle('local', 'm')).toBe('Local height (m)');
  });
});

describe('axis labels do not overlap', () => {
  /**
   * The narrowest plot the dock can present.
   *
   * The detail column is a fixed 216 px and the body carries its own padding,
   * so a plot narrower than this has no room for a section either. Any
   * narrower value would only make the fitter drop more, which is the safe
   * direction; the point of testing at the narrow end is that the fitter must
   * not simply thin by index and leave the crowded half touching.
   */
  const NARROW: ProfileViewport = { width: 180, height: 96, devicePixelRatio: 1 };

  function keptSpans(
    labels: readonly string[],
    pixels: readonly number[],
    containerPx: number,
    extentOf: (label: string) => number,
  ): { start: number; end: number }[] {
    const keep = fitAxisLabels({
      labels,
      pixels,
      containerPx,
      fontPx: AXIS_FONT_PX,
      ...(extentOf === undefined ? {} : { extentPx: extentOf }),
    });
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < labels.length; i++) {
      if (!keep[i]) continue;
      const half = extentOf(labels[i]!) / 2;
      spans.push({ start: pixels[i]! - half, end: pixels[i]! + half });
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  it('keeps every drawn chainage label clear of its neighbour and of both edges', () => {
    const axes = profileAxes(viewOf(NARROW), NARROW, {
      reference: 'unknown',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      units: NO_SCALE,
      targetXTicks: DEFAULT_TARGET_TICKS,
      targetYTicks: DEFAULT_TARGET_TICKS,
    });
    const spans = keptSpans(axes.x.labels, axes.x.pixels, NARROW.width, (l) =>
      axisLabelWidth(l, AXIS_FONT_PX),
    );
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeLessThanOrEqual(NARROW.width);
    }
    for (let i = 1; i < spans.length; i++) {
      expect(
        spans[i]!.start - spans[i - 1]!.end,
        `label ${i} overlaps the one before it`,
      ).toBeGreaterThanOrEqual(AXIS_LABEL_MIN_GAP_PX);
    }
  });

  it('keeps stacked height labels a line apart down a short plot', () => {
    const axes = profileAxes(viewOf(NARROW), NARROW, {
      reference: 'unknown',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      units: NO_SCALE,
      targetXTicks: DEFAULT_TARGET_TICKS,
      targetYTicks: DEFAULT_TARGET_TICKS,
    });
    const spans = keptSpans(axes.y.labels, axes.y.pixels, NARROW.height, () => AXIS_FONT_PX);
    expect(spans.length).toBeGreaterThan(0);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start - spans[i - 1]!.end).toBeGreaterThanOrEqual(AXIS_LABEL_MIN_GAP_PX);
    }
  });

  it('refuses a label that would run off the end of the strip', () => {
    // One wide label centred hard against the left edge. Half of it would be
    // outside the plot, and half a number states a value the axis is not
    // showing, so it is not drawn at all.
    const keep = fitAxisLabels({
      labels: ['-1250.5'],
      pixels: [2],
      containerPx: 200,
      fontPx: AXIS_FONT_PX,
    });
    expect(keep).toEqual([false]);
  });

  it('does not thin by index: an uneven axis keeps its sparse labels', () => {
    // Three labels crowded at the left, one alone at the right. Index thinning
    // would keep the 1st and 3rd — still touching — and drop the 4th, which
    // has a whole plot to itself.
    const labels = ['0', '1', '2', '300'];
    const pixels = [20, 26, 32, 160];
    const keep = fitAxisLabels({ labels, pixels, containerPx: 200, fontPx: AXIS_FONT_PX });
    expect(keep[3]).toBe(true);
    expect(keep[1]).toBe(false);
    expect(keep[2]).toBe(false);
  });
});
