/**
 * contourAnalyticValidation.test.ts
 *
 * Analytic contour validation (v0.5.9 spec §24.1): extract contours from
 * surfaces whose true isolines are known in closed form and check the geometry.
 * This is E3 evidence — self-consistency against a known analytic surface, NOT
 * independent accuracy (see docs/validation/EVIDENCE_MODEL.md).
 *
 * Registration note: cell value z[row][col] = zfn(col, row) sits at world
 * (col + 0.5, row + 0.5) with a 1 m cell, so a feature defined at world centre
 * (cx, cy) uses zfn(x, y) with the apex at (cx − 0.5, cy − 0.5).
 */

import { describe, it, expect } from 'vitest';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function grid(zfn: (x: number, y: number) => number, cols: number, rows: number): DtmGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  const confidence = new Float32Array(n).fill(100);
  const coverage = new Uint8Array(n).fill(2);
  const counts = new Uint32Array(n).fill(1);
  const interpDistanceCells = new Float32Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) z[row * cols + col] = zfn(col, row);
  }
  return {
    z, confidence, coverage, counts, interpDistanceCells,
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', verticalDatum: null, coverageMode: 'full',
    sourcePointCount: n, analyzedPointCount: n, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

/** Every segment vertex, in world coordinates. */
function vertices(set: ReturnType<typeof contoursAt>): Array<{ x: number; y: number; value: number }> {
  const out: Array<{ x: number; y: number; value: number }> = [];
  for (const level of set.levels) {
    for (const s of level.segments) {
      out.push({ x: s.x1, y: s.y1, value: level.value }, { x: s.x2, y: s.y2, value: level.value });
    }
  }
  return out;
}

describe('analytic contour validation (§24.1)', () => {
  // ── Cone: z = radius from the apex → contour at L is a circle of radius L ──
  it('a cone yields concentric circles at the correct radius', () => {
    const CX = 20.5, CY = 20.5; // world centre
    const cone = (x: number, y: number) => Math.hypot(x - (CX - 0.5), y - (CY - 0.5));
    const set = contoursAt(grid(cone, 41, 41), { intervalM: 5, levels: [5, 10, 15] });
    expect(set.levels).toHaveLength(3);
    for (const v of vertices(set)) {
      const r = Math.hypot(v.x - CX, v.y - CY);
      // Marching-squares linear interpolation on a smooth cone keeps every
      // vertex within a fraction of a cell of the true radius = the level.
      expect(Math.abs(r - v.value)).toBeLessThan(0.75);
    }
  });

  // ── Paraboloid: z = 0.02·r² → contour at L is a circle of radius √(L/0.02) ──
  it('a paraboloid hill yields circles at radius sqrt(L/a)', () => {
    const CX = 25.5, CY = 25.5, A = 0.02;
    const bowl = (x: number, y: number) => A * (Math.hypot(x - (CX - 0.5), y - (CY - 0.5)) ** 2);
    const set = contoursAt(grid(bowl, 51, 51), { intervalM: 2, levels: [2, 8] });
    for (const v of vertices(set)) {
      const r = Math.hypot(v.x - CX, v.y - CY);
      const expected = Math.sqrt(v.value / A);
      // Curvature of z(r) makes the tolerance grow with the level; keep it tight.
      expect(Math.abs(r - expected)).toBeLessThan(1.0);
    }
  });

  // ── Tilted plane: contour spacing = interval / |gradient| ─────────────────
  it('a tilted plane spaces parallel contours by interval / gradient', () => {
    const gx = 0.5; // z = 0.5·x, gradient magnitude 0.5 along x
    const set = contoursAt(grid((x) => gx * x, 40, 6), { intervalM: 2 });
    // For each level, the contour is the vertical line x = value/gx (+ 0.5 world
    // registration). Consecutive levels are interval/gx = 4 world units apart.
    const xByLevel = new Map<number, number[]>();
    for (const v of vertices(set)) {
      const arr = xByLevel.get(v.value) ?? [];
      arr.push(v.x);
      xByLevel.set(v.value, arr);
    }
    const levels = [...xByLevel.keys()].sort((a, b) => a - b);
    expect(levels.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < levels.length; i++) {
      const meanPrev = mean(xByLevel.get(levels[i - 1])!);
      const meanCur = mean(xByLevel.get(levels[i])!);
      // Level step is `intervalM` = 2 → world spacing 2/0.5 = 4.
      expect(Math.abs((meanCur - meanPrev) - 4)).toBeLessThan(0.25);
    }
  });

  // ── Degeneracy: a constant surface crosses no intermediate level ──
  it('a constant surface produces no contour segments at a level it does not equal', () => {
    const flat = grid(() => 50, 30, 30);
    const set = contoursAt(flat, { intervalM: 5, levels: [10, 20, 30, 40] });
    const total = set.levels.reduce((n, l) => n + l.segments.length, 0);
    // No cell straddles any requested level, so marching squares emits nothing —
    // a flat surface has no isolines, and inventing one would be a false feature.
    expect(total).toBe(0);
  });

  // ── Metamorphic: translating elevation shifts the level labels, not the lines ──
  it('adding a constant Δz to a tilted plane relabels the isolines by Δz (same geometry)', () => {
    // z = x (gradient 1 in x): the contour at value L is the vertical line x = L.
    // Adding Δ makes z = x + Δ, so its contour at value L sits where x = L − Δ —
    // i.e. exactly where the ORIGINAL surface's contour at value (L − Δ) sits.
    const plane = (x: number) => x;
    const delta = 7;
    const base = contoursAt(grid((x) => plane(x), 41, 41), { intervalM: 10, levels: [20] });
    const shifted = contoursAt(grid((x) => plane(x) + delta, 41, 41), { intervalM: 10, levels: [20 + delta] });
    const xs = (s: ReturnType<typeof contoursAt>): number =>
      mean(vertices(s).map((v) => v.x));
    expect(base.levels[0].segments.length).toBeGreaterThan(0);
    expect(shifted.levels[0].segments.length).toBeGreaterThan(0);
    // Same isoline geometry: the mean x of level 20 on z equals that of level
    // 20+Δ on z+Δ, to sub-cell precision.
    expect(Math.abs(xs(shifted) - xs(base))).toBeLessThan(0.1);
  });
});

function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}
