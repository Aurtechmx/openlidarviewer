/**
 * lassoVolume.test.ts
 *
 * Unit tests for the 3D volumetric lasso pipeline:
 *   - selectByLasso projects each 3D point through a mock projector
 *     and includes only those whose 2D projection lands inside the
 *     lasso polygon.
 *   - convexHull2D returns the right hull on the canonical shapes.
 *   - percentile linearly interpolates between ranks.
 *   - volumeFromLasso wires the above into volumeCutFill and returns
 *     the expected fill / cut / footprint for a synthetic ramp.
 */

import { describe, it, expect } from 'vitest';
import {
  selectByLasso,
  filterSelectionToVisible,
  convexHull2D,
  percentile,
  volumeFromLasso,
  type Vec2,
  type ScreenProjector,
} from '../src/render/measure/lassoVolume';
import { clipKeepsPoint, type ClipBox } from '../src/render/clip/clipBox';

function makePositions(triples: number[][]): Float32Array {
  const out = new Float32Array(triples.length * 3);
  for (let i = 0; i < triples.length; i++) {
    out[i * 3] = triples[i][0];
    out[i * 3 + 1] = triples[i][1];
    out[i * 3 + 2] = triples[i][2];
  }
  return out;
}

describe('selectByLasso — projects 3D points to screen + tests against lasso', () => {
  it('includes a point whose projection lies inside the lasso', () => {
    const positions = makePositions([[10, 20, 5]]);
    // Identity projector: world (x, y, *) → screen (x, y). Ignores z.
    const project: ScreenProjector = (x, y) => ({ x, y });
    // A square lasso around (10, 20).
    const lasso: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(selectByLasso({ positions, lasso, project })).toEqual([0]);
  });

  it('excludes a point whose projection lies outside the lasso', () => {
    const positions = makePositions([[500, 500, 0]]);
    const project: ScreenProjector = (x, y) => ({ x, y });
    const lasso: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(selectByLasso({ positions, lasso, project })).toEqual([]);
  });

  it('excludes points the projector reports as clipped (null)', () => {
    const positions = makePositions([
      [10, 20, 5],
      [10, 20, -10], // simulated behind-camera
    ]);
    // Projector returns null for points with negative z.
    const project: ScreenProjector = (x, y, z) => (z < 0 ? null : { x, y });
    const lasso: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(selectByLasso({ positions, lasso, project })).toEqual([0]);
  });

  it('returns the empty set for a lasso with fewer than 3 vertices', () => {
    const positions = makePositions([[10, 20, 5]]);
    const project: ScreenProjector = (x, y) => ({ x, y });
    expect(
      selectByLasso({
        positions,
        lasso: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
        project,
      }),
    ).toEqual([]);
  });

  it('selects the SAME 3D point regardless of z (volumetric pick)', () => {
    // Two points at the same XY but different depths — both should be
    // selected because the lasso projection captures all depths along
    // the camera ray.
    const positions = makePositions([
      [10, 20, 5],
      [10, 20, 50],
      [10, 20, 100],
    ]);
    const project: ScreenProjector = (x, y) => ({ x, y });
    const lasso: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(selectByLasso({ positions, lasso, project })).toEqual([0, 1, 2]);
  });
});

describe('filterSelectionToVisible — an edit may only touch visible points', () => {
  // The reclassify-invisible-points finding (Critical): reclassifyLasso
  // applied the raw selectByLasso result, permanently rewriting points hidden
  // by the clip box or the class-visibility filter. This is the pure seam the
  // Viewer now routes the selection through — same rules as click-picking.
  const positions = makePositions([
    [0, 0, 0], // 0 — inside clip box
    [5, 5, 5], // 1 — outside clip box
    [1, 1, 1], // 2 — inside clip box
  ]);

  it('returns the selection untouched (same array) when no filter is active', () => {
    const indices = [0, 1, 2];
    const out = filterSelectionToVisible(indices, positions, {});
    expect(out).toBe(indices);
    expect(out).toEqual([0, 1, 2]);
  });

  it('drops points the clip predicate hides (keep-inside box)', () => {
    const clip: ClipBox = {
      box: { min: [-1, -1, -1], max: [2, 2, 2] },
      mode: 'keep-inside',
      enabled: true,
    };
    const indices = [0, 1, 2];
    const out = filterSelectionToVisible(indices, positions, {
      keepPoint: (x, y, z) => clipKeepsPoint(clip, [x, y, z]),
    });
    expect(out).toEqual([0, 2]); // point 1 is clipped away, so it may not be edited
  });

  it('drops points of a hidden class via the per-index predicate', () => {
    const classification = Uint8Array.from([2, 5, 2]); // point 1 is class 5
    const hidden = new Set([5]);
    const indices = [0, 1, 2];
    const out = filterSelectionToVisible(indices, positions, {
      acceptIndex: (i) => !hidden.has(classification[i]),
    });
    expect(out).toEqual([0, 2]);
  });

  it('applies both filters together and compacts in place', () => {
    const classification = Uint8Array.from([2, 2, 5]);
    const clip: ClipBox = {
      box: { min: [-1, -1, -1], max: [2, 2, 2] },
      mode: 'keep-inside',
      enabled: true,
    };
    const indices = [0, 1, 2];
    const out = filterSelectionToVisible(indices, positions, {
      keepPoint: (x, y, z) => clipKeepsPoint(clip, [x, y, z]), // drops 1
      acceptIndex: (i) => classification[i] !== 5, // drops 2
    });
    expect(out).toBe(indices); // in place — no new array
    expect(out).toEqual([0]);
  });

  it('a keep-outside clip inverts which points remain editable', () => {
    const clip: ClipBox = {
      box: { min: [-1, -1, -1], max: [2, 2, 2] },
      mode: 'keep-outside',
      enabled: true,
    };
    const out = filterSelectionToVisible([0, 1, 2], positions, {
      keepPoint: (x, y, z) => clipKeepsPoint(clip, [x, y, z]),
    });
    expect(out).toEqual([1]);
  });
});

describe('convexHull2D — Andrew\'s monotone chain', () => {
  it('returns the polygon itself for a triangle (no interior points)', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 },
    ];
    const hull = convexHull2D(tri);
    expect(hull.length).toBe(3);
  });

  it('drops interior points from a square', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 }, // interior — must NOT be in the hull
    ];
    const hull = convexHull2D(square);
    expect(hull.length).toBe(4);
    for (const p of hull) {
      // Interior point (2, 2) is excluded.
      expect(p.x === 2 && p.y === 2).toBe(false);
    }
  });

  it('returns the points themselves for an under-defined input', () => {
    expect(convexHull2D([])).toEqual([]);
    expect(convexHull2D([{ x: 1, y: 2 }])).toHaveLength(1);
    expect(convexHull2D([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(2);
  });

  it('CCW orientation — area is positive via shoelace', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const hull = convexHull2D(square);
    let area2 = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      area2 += a.x * b.y - a.y * b.x;
    }
    // Counter-clockwise = positive signed area under shoelace.
    expect(area2).toBeGreaterThan(0);
  });
});

describe('percentile — linear interpolation between ranks', () => {
  it('returns NaN for an empty array', () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('returns the only value for a single-element array', () => {
    expect(percentile([42], 0.5)).toBe(42);
  });

  it('returns the minimum at p = 0', () => {
    expect(percentile([3, 1, 4, 1, 5, 9, 2, 6], 0)).toBe(1);
  });

  it('returns the maximum at p = 1', () => {
    expect(percentile([3, 1, 4, 1, 5, 9, 2, 6], 1)).toBe(9);
  });

  it('linearly interpolates between ranks', () => {
    // Five values 1..5. At p = 0.5 the rank is 2.0 → exactly value 3.
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    // At p = 0.25 the rank is 1.0 → exactly value 2.
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    // At p = 0.125 the rank is 0.5 → midpoint of values 1 and 2 → 1.5.
    expect(percentile([1, 2, 3, 4, 5], 0.125)).toBe(1.5);
  });

  it('clamps p out of [0, 1]', () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 2)).toBe(3);
  });
});

describe('volumeFromLasso — integrates selection → footprint → cut/fill', () => {
  it('returns all-zero result for a degenerate selection (< 3 points)', () => {
    const positions = makePositions([[0, 0, 0], [1, 1, 1]]);
    const res = volumeFromLasso({ positions, selected: [0, 1] });
    expect(res.fill).toBe(0);
    expect(res.cut).toBe(0);
    expect(res.footprintArea).toBe(0);
  });

  it('returns positive fill for a stockpile-shaped selection', () => {
    // Four corners at z = 0, one peak at z = 10. The 5th-percentile
    // reference Z will be near 0, so the peak contributes fill > 0.
    const positions = makePositions([
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
      [5, 5, 10],
    ]);
    const res = volumeFromLasso({
      positions,
      selected: [0, 1, 2, 3, 4],
      referencePercentile: 0.05,
    });
    expect(res.footprintArea).toBeGreaterThan(0);
    expect(res.fill).toBeGreaterThan(0);
    expect(res.cut).toBe(0);
    expect(res.net).toBeGreaterThan(0);
  });

  it('returns positive cut for a pit-shaped selection', () => {
    // Four corners at z = 10, one bottom at z = 0. 5th-percentile
    // reference ≈ 0 (the bottom), so all corners are above ≡ fill,
    // and the pit produces zero cut. Bump to median for a true pit.
    const positions = makePositions([
      [0, 0, 10],
      [10, 0, 10],
      [10, 10, 10],
      [0, 10, 10],
      [5, 5, 0],
    ]);
    // Reference at the median Z (== 10) treats the bottom as cut.
    const res = volumeFromLasso({
      positions,
      selected: [0, 1, 2, 3, 4],
      referencePercentile: 0.5,
    });
    expect(res.cut).toBeGreaterThan(0);
  });

  it('honours the up-axis when projecting the footprint', () => {
    // Z-up: footprint is the XY square; volume is fill from a single
    // peak above the 5th-percentile.
    const positions = makePositions([
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
      [0, 4, 0],
      [2, 2, 5],
    ]);
    const res = volumeFromLasso({
      positions,
      selected: [0, 1, 2, 3, 4],
      up: [0, 0, 1],
    });
    expect(res.footprintArea).toBeCloseTo(16, 6);
  });
});
