/**
 * stitchContours.test.ts — specs for joining segment soup into
 * ordered polylines while preserving per-vertex evidence.
 */

import { describe, it, expect } from 'vitest';
import { stitchLevel, quantumForCellSize } from '../src/terrain/contour/stitchContours';
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

describe('unit-aware endpoint quantum (geographic-degree grids)', () => {
  it('quantumForCellSize is a thousandth of the cell (fallback 1e-3)', () => {
    expect(quantumForCellSize(0.25)).toBeCloseTo(2.5e-4, 12);
    expect(quantumForCellSize(1e-5)).toBeCloseTo(1e-8, 15);
    expect(quantumForCellSize(0)).toBe(1e-3);
    expect(quantumForCellSize(Number.NaN)).toBe(1e-3);
  });

  it('a degree-scale grid stitches correctly with a cell-scaled quantum', () => {
    // Two DISJOINT chains 4e-4 "units" (degrees) apart — closer than the
    // legacy fixed 1 mm quantum, which keys both onto the same rounded cell
    // (4e-4/1e-3 rounds to 0) and welds them into ONE polyline. A 1e-4-cell
    // grid's quantum (1e-7) keeps them apart: two polylines.
    const chains = [seg(0, 0, 1e-4, 0), seg(0, 4e-4, 1e-4, 4e-4)];
    const legacy = stitchLevel(5, chains); // fixed 1e-3 quantum
    expect(legacy.length).toBe(1); // documents the audited failure mode
    const scaled = stitchLevel(5, chains, quantumForCellSize(1e-4));
    expect(scaled.length).toBe(2);
  });

  it('still joins genuinely shared endpoints under a tiny quantum', () => {
    const polys = stitchLevel(5, [seg(0, 0, 1e-4, 0), seg(1e-4, 0, 2e-4, 0)], quantumForCellSize(1e-4));
    expect(polys.length).toBe(1);
    expect(polys[0].vertices.length).toBe(3);
  });
});
