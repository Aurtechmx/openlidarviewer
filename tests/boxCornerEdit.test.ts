/**
 * boxCornerEdit.test.ts
 *
 * A committed Box measurement can be resized by dragging any of its 8
 * wireframe corners. The rules that make that trustworthy:
 *
 *   - the corner diagonally opposite the dragged one does not move at all;
 *   - a drag past that anchor yields a normalised box, never a negative
 *     extent or a min/max swap;
 *   - the panel figures (dimensions, volume, surface area) follow the edit;
 *   - the corner numbering follows the scan's up-axis, so a Y-up frame
 *     anchors the drag to a different corner than a Z-up one would.
 */

import { describe, it, expect } from 'vitest';
import { resizeBoxByCorner, oppositeCornerIndex, BOX_CORNER_INDICES } from '../src/render/measure/boxEdit';
import { boxFromCorners, boxCorners, boxMetrics } from '../src/render/measure/geometry';
import type { Vec3 } from '../src/render/navMath';

const BOX = boxFromCorners([0, 0, 0], [10, 20, 5]);

describe('box corner resize', () => {
  it('holds the opposite corner exactly still while the dragged corner moves', () => {
    for (const ci of BOX_CORNER_INDICES) {
      const before = boxCorners(BOX, [0, 0, 1]);
      const anchor = before[oppositeCornerIndex(ci)];
      const dragged: Vec3 = [
        before[ci][0] + 3.25,
        before[ci][1] - 1.5,
        before[ci][2] + 0.75,
      ];
      const after = boxCorners(resizeBoxByCorner(BOX, ci, dragged, [0, 0, 1]), [0, 0, 1]);
      expect(after[oppositeCornerIndex(ci)]).toEqual(anchor);
      expect(after[ci]).toEqual(dragged);
    }
  });

  it('re-normalises a drag past the anchor instead of inverting the box', () => {
    // Corner 0 is the low corner on all three axes; dragging it well beyond
    // corner 6 turns the box inside out unless the pair is re-normalised.
    const out = resizeBoxByCorner(BOX, 0, [40, 50, 30], [0, 0, 1]);
    expect(out.min).toEqual([10, 20, 5]);
    expect(out.max).toEqual([40, 50, 30]);
    for (let axis = 0; axis < 3; axis++) {
      expect(out.max[axis]).toBeGreaterThanOrEqual(out.min[axis]);
    }
    // The mirror case: dragging the HIGH corner below the low one puts the
    // anchor above the dragged point on every axis, which is the ordering an
    // un-normalised min/max pair gets backwards.
    const flipped = resizeBoxByCorner(BOX, 6, [-4, -6, -2], [0, 0, 1]);
    expect(flipped.min).toEqual([-4, -6, -2]);
    expect(flipped.max).toEqual([0, 0, 0]);
    const fm = boxMetrics(flipped, [0, 0, 1]);
    expect([fm.width, fm.depth, fm.height]).toEqual([4, 6, 2]);
    const m = boxMetrics(out, [0, 0, 1]);
    expect(m.width).toBeGreaterThan(0);
    expect(m.depth).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThan(0);
    expect(m.volume).toBeCloseTo(30 * 30 * 25, 9);
  });

  it('recomputes the reported dimensions from the edited box', () => {
    const before = boxMetrics(BOX, [0, 0, 1]);
    expect([before.width, before.depth, before.height]).toEqual([10, 20, 5]);
    // Drag corner 6 (max on every axis) outward by 2 m on each axis.
    const out = resizeBoxByCorner(BOX, 6, [12, 22, 7], [0, 0, 1]);
    const after = boxMetrics(out, [0, 0, 1]);
    expect([after.width, after.depth, after.height]).toEqual([12, 22, 7]);
    expect(after.volume).toBeCloseTo(12 * 22 * 7, 9);
    expect(after.surfaceArea).toBeCloseTo(2 * (12 * 22 + 22 * 7 + 12 * 7), 9);
  });

  it('anchors the drag by the scan up-axis, not by an assumed Z', () => {
    // Corner 2 is (low-up, high-h1, high-h2). Under Z-up the horizontal pair
    // is (X, Y), so corner 2 sits at min-Z; under Y-up it is (X, Z), so the
    // same index names a corner at min-Y. Same drag, different anchor,
    // different box: a hardcoded Z here gives a numerically wrong answer on a
    // Y-up frame rather than a merely mislabelled one.
    const dragged: Vec3 = [3, 4, 1];
    const zUp = resizeBoxByCorner(BOX, 2, dragged, [0, 0, 1]);
    const yUp = resizeBoxByCorner(BOX, 2, dragged, [0, 1, 0]);
    expect(yUp).not.toEqual(zUp);
    // Z-up: corner 2 is (max-X, max-Y, min-Z); anchor is (0, 0, 5).
    expect(zUp).toEqual({ min: [0, 0, 1], max: [3, 4, 5] });
    // Y-up: corner 2 is (max-X, min-Y, max-Z); anchor is (0, 20, 0).
    expect(yUp).toEqual({ min: [0, 4, 0], max: [3, 20, 1] });
    // And the height for each answer comes off its own up-axis.
    expect(boxMetrics(zUp, [0, 0, 1]).height).toBeCloseTo(4, 9);
    expect(boxMetrics(yUp, [0, 1, 0]).height).toBeCloseTo(16, 9);
  });

  it('pairs every corner with its diagonal opposite, involutively', () => {
    for (const ci of BOX_CORNER_INDICES) {
      expect(oppositeCornerIndex(oppositeCornerIndex(ci))).toBe(ci);
      const c = boxCorners(BOX, [0, 0, 1]);
      const a = c[ci];
      const b = c[oppositeCornerIndex(ci)];
      for (let axis = 0; axis < 3; axis++) expect(a[axis]).not.toBe(b[axis]);
    }
  });
});
