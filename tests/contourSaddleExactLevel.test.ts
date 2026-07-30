/**
 * contourSaddleExactLevel.test.ts
 *
 * The exact saddle tie in marching squares: the one level at which the two
 * candidate pairings of an ambiguous cell differ, and which pairing ships.
 *
 * WHY A DEDICATED FILE. Registered mutant M04 flips the saddle decider from
 * `zSaddle >= level` to `zSaddle > level`. That mutation is invisible unless a
 * fixture puts the bilinear saddle value EXACTLY on a traced level: anywhere
 * else the two comparisons agree, so a suite full of analytic surfaces can be
 * green and never reach the branch that decides topology. The fixtures here are
 * built from dyadic rationals so `zSaddle == level` is a property of the
 * numbers, not of rounding: every corner height is exactly representable in
 * Float32 storage and in the Float64 arithmetic the decider runs in, and the
 * quotient (144 - 64) / 8 is itself exact.
 *
 * WHY THE PREDICATES RE-DERIVE EVERYTHING. Which edges a segment joins is read
 * back from the segment's own coordinates against the cell rectangle, not from
 * the generator's edge table, so a change in the table cannot make the check
 * agree with it by construction.
 */

import { describe, it, expect } from 'vitest';
import { contoursAt, type ContourSet } from '../src/terrain/contour/contoursAt';
import { surfaceGrid } from './benchmark/contourSurfaces';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/**
 * The saddle fixture, as one 2x2 block of cell centres.
 *
 * Corners in the order marching squares reads them are (BL, BR, TR, TL) =
 * (base + d, base - d, base + d, base - d), which puts the bilinear saddle
 * value at `base`:
 *
 *   z* = (v0·v2 - v1·v3) / (v0 + v2 - v1 - v3)
 *      = ((base+d)^2 - (base-d)^2) / (4d)
 *      = base.
 *
 * With base = 10 and d = 2 that is (144 - 64) / 8 = 10, computed exactly.
 * `scale` multiplies heights, level and cell size together, which leaves the
 * tie exact (z* is homogeneous of degree one in the heights) and scales the
 * traced geometry by the same factor.
 */
function saddleTieGrid(opts: { base?: number; scale?: number } = {}): {
  dtm: DtmGrid;
  level: number;
  zStar: number;
} {
  const base = opts.base ?? 10;
  const scale = opts.scale ?? 1;
  const d = 2 * scale;
  const hi = base * scale + d;
  const lo = base * scale - d;
  // Row-major over a 2x2 grid: row 0 is (BL, BR), row 1 is (TL, TR).
  const cells = [hi, lo, lo, hi];
  const dtm = surfaceGrid((col, row) => cells[row * 2 + col], {
    cols: 2,
    rows: 2,
    cellSizeM: 1 * scale,
  });
  const zStar = (hi * hi - lo * lo) / (hi + hi - lo - lo);
  return { dtm, level: base * scale, zStar };
}

/** The rectangle of cell centres the single marching square spans. */
function cellRect(dtm: DtmGrid): { minX: number; maxX: number; minY: number; maxY: number } {
  const h = dtm.cellSizeM;
  return {
    minX: dtm.originH1 + 0.5 * h,
    maxX: dtm.originH1 + 1.5 * h,
    minY: dtm.originH2 + 0.5 * h,
    maxY: dtm.originH2 + 1.5 * h,
  };
}

/**
 * Which side of the cell a point sits on, named the way the segment table names
 * its edges (0 bottom, 1 right, 2 top, 3 left). Derived from the coordinates
 * against the cell rectangle, independently of the generator.
 */
function edgeOf(dtm: DtmGrid, x: number, y: number): number {
  const r = cellRect(dtm);
  const eps = dtm.cellSizeM * 1e-9;
  if (Math.abs(y - r.minY) < eps) return 0;
  if (Math.abs(x - r.maxX) < eps) return 1;
  if (Math.abs(y - r.maxY) < eps) return 2;
  if (Math.abs(x - r.minX) < eps) return 3;
  throw new Error(`point (${x}, ${y}) is not on the cell boundary`);
}

/** The edge pairs one level's segments join, each pair sorted, list sorted. */
function pairing(dtm: DtmGrid, set: ContourSet): string[] {
  return set.levels[0].segments
    .map((s) => {
      const a = edgeOf(dtm, s.x1, s.y1);
      const b = edgeOf(dtm, s.x2, s.y2);
      return a < b ? `${a}-${b}` : `${b}-${a}`;
    })
    .sort();
}

/** Endpoint pairs as order-independent keys, for the duplicate check. */
function segmentKeys(set: ContourSet): string[] {
  const out: string[] = [];
  for (const level of set.levels) {
    for (const s of level.segments) {
      const a = `${s.x1},${s.y1}`;
      const b = `${s.x2},${s.y2}`;
      out.push(a < b ? `${level.value}|${a}|${b}` : `${level.value}|${b}|${a}`);
    }
  }
  return out;
}

/**
 * Connected components of one level's segments, keyed by shared endpoints.
 *
 * Endpoints are matched on exact coordinates because every fixture here crosses
 * its edges at the midpoint, where the interpolation returns the same Float64
 * value from either cell. A tolerance would hide the case this exists to see.
 */
function components(set: ContourSet, value: number): string[][] {
  const level = set.levels.find((l) => l.value === value);
  if (!level) throw new Error(`no level ${value}`);
  const key = (x: number, y: number) => `${x},${y}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let cur = k;
    while (parent.get(cur) !== cur) cur = parent.get(cur) as string;
    return cur;
  };
  const add = (k: string) => {
    if (!parent.has(k)) parent.set(k, k);
  };
  for (const s of level.segments) {
    const a = key(s.x1, s.y1);
    const b = key(s.x2, s.y2);
    add(a);
    add(b);
    parent.set(find(a), find(b));
  }
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) {
    const root = find(k);
    const list = groups.get(root) ?? [];
    list.push(k);
    groups.set(root, list);
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

describe('a bilinear saddle exactly on the traced level', () => {
  it('puts the saddle value on the level as an exact equality, not within a tolerance', () => {
    const { level, zStar } = saddleTieGrid();
    expect(zStar === level).toBe(true);
    // The scaled and translated variants have to be exact too, or the
    // invariance cases below would be testing a near-tie instead of the tie.
    expect(saddleTieGrid({ scale: 2 }).zStar === saddleTieGrid({ scale: 2 }).level).toBe(true);
    expect(saddleTieGrid({ base: 110 }).zStar === saddleTieGrid({ base: 110 }).level).toBe(true);
  });

  it('joins the two high corners: the low corners are the ones cut off', () => {
    const { dtm, level } = saddleTieGrid();
    const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
    // The high corners are BL (edges 3 and 0) and TR (edges 1 and 2). Cutting
    // off the LOW corners means one segment across BR (edges 0 and 1) and one
    // across TL (edges 2 and 3). The other pairing, 0-3 with 1-2, isolates the
    // high corners instead and is what `>` produces at the tie.
    expect(pairing(dtm, set)).toEqual(['0-1', '2-3']);
  });

  it('emits exactly two segments, with no duplicate and no zero-length segment', () => {
    const { dtm, level } = saddleTieGrid();
    const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
    expect(set.levels[0].segments).toHaveLength(2);
    for (const s of set.levels[0].segments) {
      expect(s.x1 === s.x2 && s.y1 === s.y2).toBe(false);
    }
    const keys = segmentKeys(set);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('places the four crossings at the edge midpoints', () => {
    // Every corner sits |d| from the level, so each crossing is halfway along
    // its edge. Stated as exact coordinates because the fixture is exact.
    const { dtm, level } = saddleTieGrid();
    const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
    const points = set.levels[0].segments
      .flatMap((s) => [`${s.x1},${s.y1}`, `${s.x2},${s.y2}`])
      .sort();
    expect(points).toEqual(['0.5,1', '1,0.5', '1,1.5', '1.5,1'].sort());
  });

  it('brackets the transition: the tie resolves with the below-z* side', () => {
    const { dtm, zStar } = saddleTieGrid();
    const pairAt = (level: number) =>
      pairing(dtm, contoursAt(dtm, { intervalM: 1, levels: [level] }));
    // Below z* the high region contains the saddle point and the high corners
    // are joined; above it they are isolated. The tie has to fall on one side
    // of that transition, and the shipped rule puts it with "below".
    expect(pairAt(zStar - 0.5)).toEqual(['0-1', '2-3']);
    expect(pairAt(zStar)).toEqual(['0-1', '2-3']);
    expect(pairAt(zStar + 0.5)).toEqual(['0-3', '1-2']);
  });

  it('is unchanged by translating the surface and the level together', () => {
    const base = saddleTieGrid();
    const moved = saddleTieGrid({ base: 110 });
    const a = contoursAt(base.dtm, { intervalM: 1, levels: [base.level] });
    const b = contoursAt(moved.dtm, { intervalM: 1, levels: [moved.level] });
    expect(pairing(moved.dtm, b)).toEqual(pairing(base.dtm, a));
    // Adding a constant to every height moves no crossing, so the geometry is
    // identical and not merely similar.
    expect(b.levels[0].segments.map((s) => [s.x1, s.y1, s.x2, s.y2])).toEqual(
      a.levels[0].segments.map((s) => [s.x1, s.y1, s.x2, s.y2]),
    );
  });

  it('is unchanged by scaling the surface, the level and the cell together', () => {
    const base = saddleTieGrid();
    const big = saddleTieGrid({ scale: 2 });
    const a = contoursAt(base.dtm, { intervalM: 1, levels: [base.level] });
    const b = contoursAt(big.dtm, { intervalM: 2, levels: [big.level] });
    expect(pairing(big.dtm, b)).toEqual(pairing(base.dtm, a));
    expect(b.levels[0].segments.map((s) => [s.x1, s.y1, s.x2, s.y2])).toEqual(
      a.levels[0].segments.map((s) => [s.x1 * 2, s.y1 * 2, s.x2 * 2, s.y2 * 2]),
    );
  });
});

describe('connectivity through a cell whose saddle sits on the level', () => {
  /**
   * The ambiguous cell with one ordinary cell to its right, so the pairing
   * inside it decides which crossing the neighbour's contour continues into.
   *
   * Cells, row-major over a 3x2 grid:
   *   row 0 (low y): 12  8  8
   *   row 1        :  8 12  8
   *
   * The left square has corners (BL, BR, TR, TL) = (12, 8, 12, 8), so z* = 10
   * exactly, as above. The right square has corners (8, 8, 8, 12): a single
   * high corner at its top-left, which is the SAME grid cell as the left
   * square's top-right, so its one segment ends on the shared edge at the same
   * midpoint the left square crosses.
   */
  const cells = [12, 8, 8, 8, 12, 8];
  const dtm = surfaceGrid((col, row) => cells[row * 3 + col], {
    cols: 3,
    rows: 2,
    cellSizeM: 1,
  });
  const LEVEL = 10;

  it('runs the neighbour contour on through the bottom crossing, not the top one', () => {
    const set = contoursAt(dtm, { intervalM: 1, levels: [LEVEL] });
    // Three segments: two from the ambiguous cell, one from its neighbour.
    expect(set.levels[0].segments).toHaveLength(3);
    const groups = components(set, LEVEL);
    // Joining the high corners inside the ambiguous cell chains its bottom
    // crossing (1,0.5) through the shared edge (1.5,1) into the neighbour's
    // top crossing (2,1.5), and leaves (1,1.5) with (0.5,1). The other pairing
    // swaps which of the two ends up on the neighbour's polyline, so this is
    // the assertion the saddle rule actually decides.
    expect(groups).toEqual([
      ['0.5,1', '1,1.5'],
      ['1,0.5', '1.5,1', '2,1.5'],
    ]);
  });

  it('adds no duplicate and no zero-length segment across the pair of cells', () => {
    const set = contoursAt(dtm, { intervalM: 1, levels: [LEVEL] });
    for (const s of set.levels[0].segments) {
      expect(s.x1 === s.x2 && s.y1 === s.y2).toBe(false);
    }
    const keys = segmentKeys(set);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
