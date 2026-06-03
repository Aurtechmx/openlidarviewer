/**
 * stitchContours.test.ts — specs for joining segment soup into
 * ordered polylines while preserving per-vertex evidence.
 */

import { describe, it, expect } from 'vitest';
import { stitchLevel } from '../src/terrain/contour/stitchContours';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourSegment } from '../src/terrain/contour/contoursAt';

const seg = (x1: number, y1: number, x2: number, y2: number, c = 90): ContourSegment => ({
  x1,
  y1,
  x2,
  y2,
  confidence: c,
  grade: gradeForConfidence(c),
});

describe('stitchLevel', () => {
  it('joins two adjacent segments into one 3-vertex polyline', () => {
    const polys = stitchLevel(5, [seg(0, 0, 1, 0), seg(1, 0, 2, 0)]);
    expect(polys.length).toBe(1);
    expect(polys[0].vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(polys[0].closed).toBe(false);
  });

  it('detects a closed loop and drops the duplicate closing vertex', () => {
    const polys = stitchLevel(5, [
      seg(0, 0, 1, 0),
      seg(1, 0, 1, 1),
      seg(1, 1, 0, 1),
      seg(0, 1, 0, 0),
    ]);
    expect(polys.length).toBe(1);
    expect(polys[0].closed).toBe(true);
    expect(polys[0].vertices.length).toBe(4);
  });

  it('takes the minimum confidence at a junction', () => {
    const polys = stitchLevel(5, [seg(0, 0, 1, 0, 90), seg(1, 0, 2, 0, 30)]);
    const mid = polys[0].vertices.find((v) => v.x === 1 && v.y === 0)!;
    expect(mid.confidence).toBe(30);
    expect(mid.grade).toBe(gradeForConfidence(30));
  });

  it('returns nothing for an empty level', () => {
    expect(stitchLevel(1, [])).toEqual([]);
  });

  it('produces two polylines for two disjoint chains', () => {
    const polys = stitchLevel(5, [
      seg(0, 0, 1, 0),
      seg(1, 0, 2, 0),
      seg(10, 10, 11, 10),
    ]);
    expect(polys.length).toBe(2);
  });
});
