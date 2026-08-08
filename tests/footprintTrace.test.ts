/**
 * footprintTrace.test.ts — boundary trace, simplify, orthogonalise.
 */

import { describe, it, expect } from 'vitest';
import { traceOccupancyBoundary, simplifyRing, orthogonaliseRing, type Pt2 } from '../src/features/footprintTrace';

/** All cells of a rectangle [x0,x1)×[y0,y1) in cell coords. */
function rectCells(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const c: Array<[number, number]> = [];
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) c.push([x, y]);
  return c;
}
function ringArea(r: readonly Pt2[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}

describe('traceOccupancyBoundary + simplifyRing', () => {
  it('a rectangle block traces + simplifies to a 4-corner ring with the right area', () => {
    const cells = rectCells(0, 0, 10, 6); // 10×6 cells, cellSize 1 → 60 m²
    const ring = traceOccupancyBoundary(cells, 1, 0, 0);
    expect(ringArea(ring)).toBeCloseTo(60, 6);
    const simp = simplifyRing(ring, 0.01);
    expect(simp.length).toBe(4);
    expect(ringArea(simp)).toBeCloseTo(60, 6);
  });

  it('an L-shape simplifies to 6 corners and preserves area', () => {
    const cells = [...rectCells(0, 0, 12, 4), ...rectCells(0, 4, 4, 12)];
    const ring = traceOccupancyBoundary(cells, 1, 0, 0);
    const area = ringArea(ring);
    expect(area).toBeCloseTo(12 * 4 + 4 * 8, 6); // 48 + 32 = 80
    const simp = simplifyRing(ring, 0.01);
    expect(simp.length).toBe(6);
    expect(ringArea(simp)).toBeCloseTo(area, 6);
  });
});

describe('orthogonaliseRing', () => {
  it('snaps a perturbed axis-aligned rectangle back to clean right-angle edges', () => {
    // Corners nudged off a 10×4 axis rectangle by a few cm — dominant orientation
    // is still the world axis, so orthogonalisation should snap the edges to it.
    const corners: Pt2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0.15 }, { x: 10.2, y: 4.1 }, { x: -0.1, y: 4 },
    ];
    const ortho = orthogonaliseRing(corners, 12);
    // Every edge should be parallel or perpendicular to a SINGLE orthogonal
    // frame: fold each edge angle to [0,90) and require them to cluster tightly.
    const folded = ortho.map((_, i) => {
      const a = ortho[i], b = ortho[(i + 1) % ortho.length];
      return ((((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 90) + 90) % 90;
    });
    const theta = folded[0];
    for (const f of folded) {
      const dev = Math.min(Math.abs(f - theta), 90 - Math.abs(f - theta));
      expect(dev).toBeLessThan(1); // all edges aligned to one clean frame
    }
  });

  it('leaves an irregular (no-dominant-orientation) ring unchanged — no forced rectangle', () => {
    // A near-regular pentagon: edges spread across orientations, none dominant.
    const pent: Pt2[] = Array.from({ length: 5 }, (_, i) => {
      const t = (i / 5) * 2 * Math.PI;
      return { x: 10 * Math.cos(t), y: 10 * Math.sin(t) };
    });
    const out = orthogonaliseRing(pent, 12, 0.6);
    expect(out).toEqual(pent); // unchanged
  });
});
