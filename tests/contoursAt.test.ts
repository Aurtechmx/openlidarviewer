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
        expect(Math.abs(zfn(mx, my) - level.value)).toBeLessThan(1e-4);
      }
    }
    expect(segCount).toBeGreaterThan(0);
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
