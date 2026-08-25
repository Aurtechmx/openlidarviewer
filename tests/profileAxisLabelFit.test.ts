/**
 * profileAxisLabelFit.test.ts — axis labels that do not overprint each other.
 *
 * The profile chart thinned its x labels by sample index: keep every Nth, and
 * drop one that fell within half a stride of the last. Index spacing is pixel
 * spacing only when every label is the same width and anchored the same way,
 * and neither is true on this axis. The end labels are pulled inside the plot
 * so they cannot overhang it, which puts the last label's box entirely to the
 * left of its tick while an interior label straddles its own. On a 105 m
 * profile that left "80" and "105.26 m" overprinting into one unreadable run
 * of digits.
 */

import { describe, it, expect } from 'vitest';
import { fitAxisLabels, type AxisLabelBox } from '../src/render/measure/profileAxes';

/** Labels at even fractions, each the given width. */
const evenly = (n: number, width: number): AxisLabelBox[] =>
  Array.from({ length: n }, (_, i) => ({ at: i / (n - 1), width }));

describe('fitAxisLabels', () => {
  it('keeps every label when the axis has room', () => {
    expect(fitAxisLabels(evenly(5, 20), 500, 8)).toEqual([true, true, true, true, true]);
  });

  it('keeps both ends and drops the interior when nothing else fits', () => {
    // 150 wide with 60-wide labels: the ends occupy [0,60] and [90,150], and
    // no centred box fits in the 30 between them.
    const keep = fitAxisLabels(evenly(5, 60), 150, 8);
    expect(keep[0]).toBe(true);
    expect(keep[4]).toBe(true);
    expect(keep.slice(1, 4)).toEqual([false, false, false]);
  });

  it('drops a label that would touch the right-aligned last one', () => {
    // The reported case: a label close to the end, whose centred box runs
    // into the final label's box even though its index is a stride away.
    const labels: AxisLabelBox[] = [
      { at: 0, width: 24 },
      { at: 0.5, width: 34 },
      { at: 0.87, width: 34 },
      { at: 1, width: 52 },
    ];
    const keep = fitAxisLabels(labels, 300, 8);
    expect(keep[2]).toBe(false);
    expect(keep[0]).toBe(true);
    expect(keep[3]).toBe(true);
  });

  it('never lets two kept labels overlap', () => {
    const labels = evenly(9, 40);
    const axis = 320;
    const keep = fitAxisLabels(labels, axis, 6);
    const boxes = labels
      .map((l, i) => ({ l, i }))
      .filter(({ i }) => keep[i])
      .map(({ l, i }) => {
        if (i === 0) return [0, l.width];
        if (i === labels.length - 1) return [axis - l.width, axis];
        const c = l.at * axis;
        return [c - l.width / 2, c + l.width / 2];
      });
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i][0], `label ${i} starts before ${i - 1} ends`).toBeGreaterThanOrEqual(
        boxes[i - 1][1],
      );
    }
  });

  it('keeps the far end when the two ends themselves collide', () => {
    // A very short axis. The end that carries the extent is the one to keep.
    const keep = fitAxisLabels(
      [
        { at: 0, width: 40 },
        { at: 1, width: 40 },
      ],
      60,
      8,
    );
    expect(keep[1]).toBe(false);
    expect(keep[0]).toBe(true);
  });

  it('handles a degenerate axis without inventing labels', () => {
    expect(fitAxisLabels([], 100, 4)).toEqual([]);
    expect(fitAxisLabels(evenly(3, 10), 0, 4)).toEqual([false, false, false]);
    expect(fitAxisLabels([{ at: 0, width: 10 }], 100, 4)).toEqual([true]);
  });
});
