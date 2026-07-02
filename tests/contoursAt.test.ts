/**
 * contoursAt.test.ts — marching-squares specs. Correctness is
 * pinned against an analytic linear surface (where every contour vertex
 * must lie exactly on the iso-line), plus grading and gap-break
 * behaviour.
 */

import { describe, it, expect } from 'vitest';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function grid(
  zfn: (x: number, y: number) => number,
  cols: number,
  rows: number,
  opts: { conf?: (x: number, y: number) => number; cov?: (x: number, y: number) => 0 | 1 | 2 } = {},
): DtmGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  const confidence = new Float32Array(n);
  const coverage = new Uint8Array(n);
  const counts = new Uint32Array(n);
  const interpDistanceCells = new Float32Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const x = col;
      const y = row;
      z[i] = zfn(x, y);
      confidence[i] = opts.conf ? opts.conf(x, y) : 100;
      coverage[i] = opts.cov ? opts.cov(x, y) : 2;
      counts[i] = coverage[i] === 2 ? 1 : 0;
    }
  }
  return {
    z,
    confidence,
    coverage,
    counts,
    interpDistanceCells,
    cols,
    rows,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32610',
    verticalDatum: null,
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 100,
    warnings: [],
  };
}

describe('contoursAt', () => {
  it('places every contour vertex exactly on the iso-line (linear surface)', () => {
    const zfn = (x: number, y: number) => 0.37 * x + 0.21 * y;
    const set = contoursAt(grid(zfn, 20, 20), { intervalM: 2 });
    expect(set.levels.length).toBeGreaterThan(0);
    let segCount = 0;
    for (const level of set.levels) {
      for (const s of level.segments) {
        segCount++;
        const mx = (s.x1 + s.x2) / 2;
        const my = (s.y1 + s.y2) / 2;
        // CELL-CENTRE REGISTRATION: z[row][col] = zfn(col, row) is the value
        // of the cell whose centre sits at world (col + 0.5, row + 0.5) with
        // a 1 m cell. The surface as a function of WORLD coordinates is
        // therefore zfn(wx − 0.5, wy − 0.5).
        expect(Math.abs(zfn(mx - 0.5, my - 0.5) - level.value)).toBeLessThan(1e-4);
      }
    }
    expect(segCount).toBeGreaterThan(0);
  });

  it('registers contours to CELL CENTRES (single-ramp analytic truth)', () => {
    // A 2x2 grid, z = col: cell values 0 and 1, cell centres at world
    // x = 0.5 and x = 1.5 (origin 0, 1 m cells). The 0.5 m contour of the
    // ramp between those centres is the vertical line x = 1.0 — exactly
    // midway BETWEEN the cell centres. The pre-v0.4.4 corner registration
    // placed it at x = 0.5 (half a cell south-west of the true crossing).
    const set = contoursAt(grid((x) => x, 2, 2), { intervalM: 1, levels: [0.5] });
    expect(set.levels.length).toBe(1);
    const segs = set.levels[0].segments;
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(s.x1).toBeCloseTo(1.0, 6);
      expect(s.x2).toBeCloseTo(1.0, 6);
      // The segment spans the marching square vertically, between the two
      // row centres y = 0.5 and y = 1.5.
      expect(Math.min(s.y1, s.y2)).toBeCloseTo(0.5, 6);
      expect(Math.max(s.y1, s.y2)).toBeCloseTo(1.5, 6);
    }
  });

  it('is deterministic', () => {
    const zfn = (x: number, y: number) => 0.37 * x + 0.21 * y;
    const a = contoursAt(grid(zfn, 20, 20), { intervalM: 2 });
    const b = contoursAt(grid(zfn, 20, 20), { intervalM: 2 });
    expect(a.levels.map((l) => l.segments.length)).toEqual(b.levels.map((l) => l.segments.length));
  });

  it('grades segments by the confidence of their cell', () => {
    const zfn = (x: number, y: number) => 0.37 * x + 0.21 * y;
    const conf = (x: number) => (x < 10 ? 100 : 20);
    const set = contoursAt(grid(zfn, 20, 20, { conf }), { intervalM: 2 });
    const grades = new Set<string>();
    for (const l of set.levels) for (const s of l.segments) grades.add(s.grade);
    expect(grades.has('solid')).toBe(true);
    expect(grades.has('gap')).toBe(true);
  });

  it('breaks contours across no-data gaps (no segments in the gap band)', () => {
    const zfn = (x: number, y: number) => 0.37 * x + 0.21 * y;
    const cov = (x: number): 0 | 1 | 2 => (x >= 8 && x < 12 ? 0 : 2);
    const set = contoursAt(grid(zfn, 20, 20, { cov }), { intervalM: 2 });
    let inBand = 0;
    for (const l of set.levels) {
      for (const s of l.segments) {
        const mx = (s.x1 + s.x2) / 2;
        if (mx > 8 && mx < 11) inBand++;
      }
    }
    expect(inBand).toBe(0);
  });

  it('carries CRS through to the contour set', () => {
    const set = contoursAt(grid((x) => x, 5, 5), { intervalM: 1 });
    expect(set.crs).toBe('EPSG:32610');
  });

  it('clamps an over-fine interval with a warning', () => {
    const set = contoursAt(grid((x, y) => 0.37 * x + 0.21 * y, 20, 20), {
      intervalM: 0.001,
      maxLevels: 10,
    });
    expect(set.levels.length).toBeLessThanOrEqual(10);
    expect(set.warnings.join(' ')).toMatch(/exceeds cap/i);
  });

  it('returns no levels for an all-gap grid', () => {
    const set = contoursAt(grid((x) => x, 6, 6, { cov: () => 0 }), { intervalM: 1 });
    expect(set.levels.length).toBe(0);
    expect(set.warnings.join(' ')).toMatch(/insufficient/i);
  });
});

describe('contoursAt — marching-squares saddle disambiguation (cell-average rule)', () => {
  // One marching square (2×2 grid of cell values, 1 m cells, origin 0), so
  // the four corners sit at world (0.5,0.5) BL, (1.5,0.5) BR, (1.5,1.5) TR,
  // (0.5,1.5) TL. grid()'s zfn is indexed (col,row): v0=z(0,0), v1=z(1,0),
  // v2=z(1,1), v3=z(0,1).
  const nearest = (x: number, y: number, corners: Array<[number, number]>): number => {
    let best = 0;
    let bestD = Infinity;
    corners.forEach(([cx, cy], i) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const CORNERS: Array<[number, number]> = [
    [0.5, 0.5], // v0 BL
    [1.5, 0.5], // v1 BR
    [1.5, 1.5], // v2 TR
    [0.5, 1.5], // v3 TL
  ];
  /** Which corner each segment's midpoint hugs, sorted for stable comparison. */
  const isolatedCorners = (segs: ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number }>) =>
    segs.map((s) => nearest((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, CORNERS)).sort();

  it('case 5, centre ABOVE the level: the LOW corners are cut off', () => {
    // v0=v2=1 (high), v1=v3=0.5 (low), level 0.6. Cell average 0.75 ≥ 0.6 →
    // the high corners connect through the middle; each segment isolates a
    // LOW corner (v1 BR, v3 TL). Hand-computed crossings: bottom (1.3,0.5),
    // right (1.5,0.7), top (0.7,1.5), left (0.5,1.3).
    const set = contoursAt(grid((x, y) => (x === y ? 1 : 0.5), 2, 2), {
      intervalM: 1,
      levels: [0.6],
    });
    const segs = set.levels[0].segments;
    expect(segs.length).toBe(2);
    expect(isolatedCorners(segs)).toEqual([1, 3]);
    // Pin one hand-computed segment exactly: (1.3,0.5) → (1.5,0.7) around v1.
    const brSeg = segs.find((s) => nearest((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, CORNERS) === 1)!;
    const xs = [brSeg.x1, brSeg.x2].sort((a, b) => a - b);
    const ys = [brSeg.y1, brSeg.y2].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1.3, 6);
    expect(xs[1]).toBeCloseTo(1.5, 6);
    expect(ys[0]).toBeCloseTo(0.5, 6);
    expect(ys[1]).toBeCloseTo(0.7, 6);
  });

  it('case 5, centre BELOW the level: the HIGH corners are cut off', () => {
    // v0=v2=1 (high), v1=v3=0.1 (low), level 0.9. Cell average 0.55 < 0.9 →
    // the high corners are isolated peaks (v0 BL, v2 TR).
    const set = contoursAt(grid((x, y) => (x === y ? 1 : 0.1), 2, 2), {
      intervalM: 1,
      levels: [0.9],
    });
    const segs = set.levels[0].segments;
    expect(segs.length).toBe(2);
    expect(isolatedCorners(segs)).toEqual([0, 2]);
  });

  it('case 10, centre ABOVE the level: mirrors case 5 (low corners v0/v2 cut off)', () => {
    // v1=v3=1 (high), v0=v2=0.5 (low), level 0.6. Average 0.75 ≥ 0.6 → the
    // segments isolate the LOW corners v0 (BL) and v2 (TR).
    const set = contoursAt(grid((x, y) => (x === y ? 0.5 : 1), 2, 2), {
      intervalM: 1,
      levels: [0.6],
    });
    const segs = set.levels[0].segments;
    expect(segs.length).toBe(2);
    expect(isolatedCorners(segs)).toEqual([0, 2]);
  });
});
