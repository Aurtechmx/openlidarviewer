/**
 * labelPlacement.test.ts — Labels along the line, spaced,
 * solid-only, collision-avoided.
 */

import { describe, it, expect } from 'vitest';
import { placeLabels, decimalsForInterval } from '../src/terrain/contour/labelPlacement';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex } from '../src/terrain/contour/stitchContours';

const v = (x: number, y: number, c = 90): ContourVertex => ({
  x,
  y,
  confidence: c,
  grade: gradeForConfidence(c),
});

// Straight line along +x from 0..100 with a vertex every 10.
function straightLine(confAt: (x: number) => number): ContourPolyline {
  const vertices: ContourVertex[] = [];
  for (let x = 0; x <= 100; x += 10) vertices.push(v(x, 0, confAt(x)));
  return { value: 50, vertices, closed: false };
}

describe('decimalsForInterval', () => {
  it('returns the decimals that keep adjacent levels distinguishable', () => {
    // Hand-computed: smallest d with interval × 10^d a whole number.
    expect(decimalsForInterval(5)).toBe(0);
    expect(decimalsForInterval(1)).toBe(0);
    expect(decimalsForInterval(0.5)).toBe(1);
    expect(decimalsForInterval(0.2)).toBe(1);
    expect(decimalsForInterval(0.25)).toBe(2);
    expect(decimalsForInterval(2.5)).toBe(1);
    expect(decimalsForInterval(0.125)).toBe(3);
  });

  it('falls back to 0 for invalid intervals and caps at 3', () => {
    expect(decimalsForInterval(0)).toBe(0);
    expect(decimalsForInterval(-1)).toBe(0);
    expect(decimalsForInterval(Number.NaN)).toBe(0);
    expect(decimalsForInterval(null)).toBe(0);
    expect(decimalsForInterval(undefined)).toBe(0);
    expect(decimalsForInterval(1 / 3)).toBe(3); // never more than 3
  });
});

describe('placeLabels', () => {
  it('places evenly spaced labels along a confident line', () => {
    const labels = placeLabels([straightLine(() => 90)], { spacingM: 25 });
    expect(labels.length).toBe(4); // at 12.5, 37.5, 62.5, 87.5
    for (const l of labels) {
      expect(Math.abs(l.angleRad)).toBeLessThan(1e-6); // horizontal
      expect(l.value).toBe(50);
    }
  });

  it('skips labels over low-confidence spans', () => {
    const labels = placeLabels([straightLine((x) => (x >= 40 && x <= 60 ? 10 : 90))], {
      spacingM: 25,
    });
    // 37.5 and 62.5 fall in/next to the uncertain span and are dropped.
    expect(labels.length).toBe(2);
    for (const l of labels) expect(l.x < 37 || l.x > 63).toBe(true);
  });

  it('honours minimum separation between labels', () => {
    const labels = placeLabels([straightLine(() => 90)], { spacingM: 25, minSeparationM: 60 });
    // With 60 m separation, only every other candidate survives.
    for (let i = 1; i < labels.length; i++) {
      const dx = labels[i].x - labels[i - 1].x;
      const dy = labels[i].y - labels[i - 1].y;
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(60 - 1e-9);
    }
  });

  it('places no labels on a line shorter than the first offset', () => {
    const short: ContourPolyline = { value: 1, vertices: [v(0, 0), v(10, 0)], closed: false };
    expect(placeLabels([short], { spacingM: 25 }).length).toBe(0);
  });
});
