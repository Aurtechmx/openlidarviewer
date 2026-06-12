/**
 * floorPlan.test.ts
 *
 * Unit tests for the floor-plan extraction pipeline's pure stages, each with
 * HAND-COMPUTED truth: the wall-band slice (floor detection + banding), the
 * density-thresholded occupancy mask (threshold arithmetic, morphological
 * close that bridges 1-cell gaps but never a doorway), and the vectoriser
 * (boundary trace with hole orientation, Douglas-Peucker, dominant-axis
 * detection, axis snapping). The end-to-end room scenarios live in
 * floorPlanPipeline.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { wallSlice } from '../src/terrain/space/floorplan/wallSlice';
import {
  buildOccupancyMask,
  closeMask,
  closeRadiusCells,
  maskAreaM2,
  type OccupancyGrid,
} from '../src/terrain/space/floorplan/occupancyGrid';
import {
  traceMaskBoundaries,
  simplifyRing,
  detectDominantAxes,
  snapRingToAxes,
  ringSignedArea,
  dedupeRing,
} from '../src/terrain/space/floorplan/vectorize';

/** A z-up rectangular room shell (floor, ceiling, four walls). W × D × H. */
function room(W = 6, D = 4, H = 2.5, step = 0.1): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += step)
    for (let y = 0; y <= D + 1e-9; y += step) t.push(x, y, 0, x, y, H);
  for (let z = step; z < H; z += step) {
    for (let x = 0; x <= W + 1e-9; x += step) t.push(x, 0, z, x, D, z);
    for (let y = 0; y <= D + 1e-9; y += step) t.push(0, y, z, W, y, z);
  }
  return Float32Array.from(t);
}

/** Walls only — no floor, no ceiling (vertical mass is uniform). */
function wallsOnly(W = 6, D = 4, H = 2.5, step = 0.1): Float32Array {
  const t: number[] = [];
  for (let z = 0; z <= H + 1e-9; z += step) {
    for (let x = 0; x <= W + 1e-9; x += step) t.push(x, 0, z, x, D, z);
    for (let y = 0; y <= D + 1e-9; y += step) t.push(0, y, z, W, y, z);
  }
  return Float32Array.from(t);
}

describe('wallSlice', () => {
  it('finds the floor and keeps only wall-band points (no floor/ceiling leakage)', () => {
    const slice = wallSlice(room(), { upAxis: 'z' });
    expect(slice.floorLevelM).not.toBeNull();
    // Floor peak sits in the histogram bin containing z = 0 (bin centre ≈ 0.02).
    expect(Math.abs(slice.floorLevelM as number)).toBeLessThan(0.1);
    expect(slice.usedWallBand).toBe(true);
    expect(slice.count).toBeGreaterThan(0);
    // Every band point must lie ON a wall line — the 0.7–1.8 m band excludes
    // the floor (z=0) and ceiling (z=2.5) by construction.
    for (let i = 0; i < slice.count; i++) {
      const onWall =
        Math.abs(slice.xs[i]) < 1e-6 || Math.abs(slice.xs[i] - 6) < 1e-6 ||
        Math.abs(slice.ys[i]) < 1e-6 || Math.abs(slice.ys[i] - 4) < 1e-6;
      expect(onWall).toBe(true);
    }
    // Floor-band points exist (the interior fill's source).
    expect(slice.floorCount).toBeGreaterThan(0);
  });

  it('anchors on a robust low percentile when no floor plane exists', () => {
    const slice = wallSlice(wallsOnly(), { upAxis: 'z' });
    // Uniform vertical mass: no 64-bin histogram bin reaches the 4% floor
    // threshold (each bin holds ~1.6%), so no floor PLANE is claimed
    // (floorLevelM null, no floor-band points). The band anchor falls back to
    // the 5th percentile of z (≈ 0.125 m on a 0–2.5 m uniform stack), so the
    // wall band [≈0.83, ≈1.93] is still cut — NOT the old full-height smear.
    expect(slice.floorLevelM).toBeNull();
    expect(slice.usedWallBand).toBe(true);
    expect(slice.floorBasis).toBe('percentile');
    expect(slice.count).toBeGreaterThan(0);
    expect(slice.count).toBeLessThan(slice.sampledCount);
    expect(slice.floorCount).toBe(0);
  });

  it('applies the unit-to-metres scale before banding', () => {
    // The same room expressed in feet: the floor must still be found and the
    // coordinates scale to metres (max coordinate 6 ft → 1.83 m).
    const slice = wallSlice(room(), { upAxis: 'z', unitToMetres: 0.3048 });
    expect(slice.floorLevelM).not.toBeNull();
    expect(slice.bbox[2]).toBeLessThan(2);
  });

  it('is graceful on too few points', () => {
    const slice = wallSlice(Float32Array.from([0, 0, 0, 1, 1, 1]), { upAxis: 'z' });
    expect(slice.count).toBe(0);
  });
});

describe('buildOccupancyMask', () => {
  it('thresholds by density with hand-computed counts', () => {
    // A 1 m × 1 m extent forced onto a 2 × 2 grid (0.5 m cells): 11 points in
    // cell (r0,c0), 11 in (r1,c1), 1 stray in (r0,c1). Mean occupied count is
    // 23/3 ≈ 7.67 → threshold max(2, round(0.3 × 7.67)) = 2 → the stray cell
    // (count 1) is dropped, the two dense cells stay.
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < 10; k++) { xs.push(0.05 + 0.01 * k); ys.push(0.1); }
    xs.push(0); ys.push(0); // pins minX = minY = 0
    for (let k = 0; k < 10; k++) { xs.push(0.9); ys.push(0.8 + 0.01 * k); }
    xs.push(1); ys.push(1); // pins maxX / maxY = 1
    xs.push(0.9); ys.push(0.1); // the stray
    const grid = buildOccupancyMask(Float64Array.from(xs), Float64Array.from(ys), xs.length, {
      cellMinM: 0.5,
      cellMaxM: 0.5,
    });
    expect(grid).not.toBeNull();
    const g = grid as OccupancyGrid;
    expect(g.cols).toBe(2);
    expect(g.rows).toBe(2);
    expect(g.threshold).toBe(2);
    expect(Array.from(g.mask)).toEqual([1, 0, 0, 1]);
    // 2 occupied cells × 0.25 m² each.
    expect(maskAreaM2(g)).toBeCloseTo(0.5, 10);
  });

  it('returns null on degenerate input', () => {
    expect(buildOccupancyMask(new Float64Array(4), new Float64Array(4), 4)).toBeNull();
    // Collinear points: zero extent on one axis.
    const xs = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const ys = new Float64Array(9);
    expect(buildOccupancyMask(xs, ys, 9)).toBeNull();
  });
});

describe('closeMask', () => {
  /** Build a 1-row grid from a literal mask (1 m cells). */
  const rowGrid = (cells: number[]): OccupancyGrid => ({
    mask: Uint8Array.from(cells),
    cols: cells.length,
    rows: 1,
    cellX: 1,
    cellY: 1,
    originX: 0,
    originY: 0,
    threshold: 1,
  });

  it('bridges a 1-cell scan gap', () => {
    const closed = closeMask(rowGrid([1, 1, 1, 0, 1, 1, 1]), 1);
    expect(Array.from(closed.mask)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('never seals a doorway-sized gap', () => {
    // 5-cell gap, radius 1: dilation reaches one cell into the gap from each
    // side, erosion takes it back — the mask returns exactly to the input.
    const before = [1, 1, 0, 0, 0, 0, 0, 1, 1];
    const closed = closeMask(rowGrid(before), 1);
    expect(Array.from(closed.mask)).toEqual(before);
  });

  it('derives a door-safe radius from the cell size', () => {
    // Largest bridged gap is 2 × radius × cell ≤ keepOpen / 3.
    expect(closeRadiusCells(0.05, 0.6)).toBe(2);
    expect(closeRadiusCells(0.02, 0.6)).toBe(5);
    expect(closeRadiusCells(0.2, 0.6)).toBe(1); // floored at 1 — heal hairlines
  });
});

describe('vectorize', () => {
  const unitGrid = (mask: number[], cols: number, rows: number): OccupancyGrid => ({
    mask: Uint8Array.from(mask),
    cols,
    rows,
    cellX: 1,
    cellY: 1,
    originX: 0,
    originY: 0,
    threshold: 1,
  });

  it('traces a single cell as its CCW unit square', () => {
    const rings = traceMaskBoundaries(unitGrid([1], 1, 1));
    expect(rings.length).toBe(1);
    expect(rings[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(ringSignedArea(rings[0])).toBeCloseTo(1, 10);
  });

  it('traces a hole as a separate CW ring (nonzero winding renders it open)', () => {
    // 3×3 block with the centre empty: outer ring area +9, hole ring area −1.
    const rings = traceMaskBoundaries(unitGrid([1, 1, 1, 1, 0, 1, 1, 1, 1], 3, 3));
    expect(rings.length).toBe(2);
    const areas = rings.map(ringSignedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-1, 10);
    expect(areas[1]).toBeCloseTo(9, 10);
  });

  it('traces disjoint regions as separate rings', () => {
    // Two cells separated by an empty column.
    const rings = traceMaskBoundaries(unitGrid([1, 0, 1], 3, 1));
    expect(rings.length).toBe(2);
    expect(rings.map(ringSignedArea).every((a) => Math.abs(a - 1) < 1e-9)).toBe(true);
  });

  it('Douglas-Peucker keeps exactly the 4 true corners of a square', () => {
    // A 2×2 block traces with edge midpoints (8 points); ε = 0.1 removes the
    // collinear midpoints and keeps the 4 corners — area is preserved.
    const rings = traceMaskBoundaries(unitGrid([1, 1, 1, 1], 2, 2));
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBe(8);
    const simple = simplifyRing(rings[0], 0.1);
    expect(simple.length).toBe(4);
    expect(Math.abs(ringSignedArea(simple))).toBeCloseTo(4, 10);
  });

  it('detects two dominant perpendicular axes on a rectangle', () => {
    const rect = [[0, 0], [10, 0], [10, 8], [0, 8]] as const;
    const axes = detectDominantAxes([rect]);
    expect(axes).not.toBeNull();
    // Stronger axis is horizontal (length 20 vs 16) → θ ≈ 0; full coverage.
    expect(Math.min(axes!.thetaRad, Math.PI - axes!.thetaRad)).toBeLessThan(0.02);
    expect(axes!.coverage).toBeCloseTo(1, 5);
  });

  it('recovers a rotated rectangle direction', () => {
    const th = Math.PI / 6; // 30°
    const rot = ([x, y]: readonly [number, number]): [number, number] => [
      x * Math.cos(th) - y * Math.sin(th),
      x * Math.sin(th) + y * Math.cos(th),
    ];
    const rect: Array<[number, number]> = ([[0, 0], [10, 0], [10, 8], [0, 8]] as const).map(rot);
    const axes = detectDominantAxes([rect]);
    expect(axes).not.toBeNull();
    const d = Math.abs(axes!.thetaRad - th);
    expect(Math.min(d, Math.PI - d)).toBeLessThan(0.02);
  });

  it('refuses the Manhattan assumption when the histogram is not bimodal', () => {
    // A regular octagon has FOUR equal directions 45° apart — no perpendicular
    // pair carries the mass, so axis snapping must stay off.
    const oct: Array<[number, number]> = [];
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k + Math.PI / 8;
      oct.push([Math.cos(a) * 5, Math.sin(a) * 5]);
    }
    expect(detectDominantAxes([oct])).toBeNull();
  });

  it('snaps a jittered rectangle onto exact axis lines (hand truth)', () => {
    const ring = [[0, 0.05], [10, -0.05], [10.05, 8], [0, 8.02]] as const;
    const snapped = snapRingToAxes(ring, 0);
    // Segment targets: south y = 0 (mean of ±0.05), east x = 10.025,
    // north y = 8.01, west x = 0.
    expect(snapped.length).toBe(4);
    expect(snapped[0][0]).toBeCloseTo(0, 9);
    expect(snapped[0][1]).toBeCloseTo(0, 9);
    expect(snapped[1][0]).toBeCloseTo(10.025, 9);
    expect(snapped[1][1]).toBeCloseTo(0, 9);
    expect(snapped[2][0]).toBeCloseTo(10.025, 9);
    expect(snapped[2][1]).toBeCloseTo(8.01, 9);
    expect(snapped[3][0]).toBeCloseTo(0, 9);
    expect(snapped[3][1]).toBeCloseTo(8.01, 9);
  });

  it('leaves genuinely diagonal segments unsnapped', () => {
    // South wall + a 45° cut corner: the diagonal must survive as-is.
    const ring = [[0, 0], [10, 0], [10, 6], [8, 8], [0, 8]] as const;
    const snapped = snapRingToAxes(ring, 0);
    const diag = snapped.find(
      ([x, y]) => Math.abs(x - 10) < 1e-6 && Math.abs(y - 6) < 1e-6,
    );
    expect(diag).toBeDefined();
  });

  it('dedupeRing removes consecutive duplicates and a wrapped duplicate', () => {
    const ring = [[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]] as const;
    expect(dedupeRing(ring)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});
