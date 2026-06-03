/**
 * smoothing.test.ts — The critical spec is the honesty one:
 * smoothing must never move a vertex at or beside a low-confidence span.
 */

import { describe, it, expect } from 'vitest';
import { chaikinSmooth } from '../src/terrain/contour/smoothing';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex } from '../src/terrain/contour/stitchContours';

const v = (x: number, y: number, c = 90): ContourVertex => ({
  x,
  y,
  confidence: c,
  grade: gradeForConfidence(c),
});

const line = (vertices: ContourVertex[], closed = false): ContourPolyline => ({
  value: 1,
  vertices,
  closed,
});

describe('chaikinSmooth', () => {
  it('rounds a corner on an all-confident open line', () => {
    const out = chaikinSmooth(line([v(0, 0), v(1, 1), v(2, 0)]), { iterations: 1 });
    expect(out.vertices.length).toBe(4); // corner replaced by two cut points
    // The original corner vertex must no longer be present exactly.
    expect(out.vertices.some((p) => p.x === 1 && p.y === 1)).toBe(false);
    // Endpoints are pinned.
    expect([out.vertices[0].x, out.vertices[0].y]).toEqual([0, 0]);
    expect([out.vertices[3].x, out.vertices[3].y]).toEqual([2, 0]);
  });

  it('NEVER moves a low-confidence (gap) vertex — honesty guard', () => {
    const gap = v(1, 1, 10); // confidence 10 → gap
    const out = chaikinSmooth(line([v(0, 0), gap, v(2, 0)]), { iterations: 3 });
    expect(out.vertices.some((p) => p.x === 1 && p.y === 1 && p.confidence === 10)).toBe(true);
  });

  it('does not smooth corners adjacent to a low-confidence span', () => {
    const poly = line([v(0, 0), v(1, 0), v(2, 2, 10), v(3, 0), v(4, 0)]);
    const out = chaikinSmooth(poly, { iterations: 2 });
    // Every original vertex survives unchanged because each candidate
    // corner touches the low-confidence vertex's neighbourhood.
    for (const orig of poly.vertices) {
      expect(out.vertices.some((p) => p.x === orig.x && p.y === orig.y)).toBe(true);
    }
  });

  it('keeps a closed loop closed', () => {
    const out = chaikinSmooth(
      line([v(0, 0), v(2, 0), v(2, 2), v(0, 2)], true),
      { iterations: 1 },
    );
    expect(out.closed).toBe(true);
    expect(out.vertices.length).toBe(8); // 4 corners → 2 points each
  });

  it('returns short polylines unchanged', () => {
    const out = chaikinSmooth(line([v(0, 0), v(1, 1)]), { iterations: 3 });
    expect(out.vertices.length).toBe(2);
  });
});
