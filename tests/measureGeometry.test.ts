import { describe, it, expect } from 'vitest';
import {
  distance,
  segmentLengths,
  polylineLength,
  newellNormal,
  polygonAreaPlanar,
  polygonAreaHorizontal,
  polygonPerimeter,
  angleAtVertex,
  slopeBetween,
  verticalDelta,
} from '../src/render/measure/geometry';
import type { Vec3 } from '../src/render/navMath';

const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
const UP_Z: Vec3 = [0, 0, 1];
const UP_Y: Vec3 = [0, 1, 0];

describe('distance', () => {
  it('measures a 3-4-5 triangle', () => {
    expect(distance(v(0, 0, 0), v(3, 4, 0))).toBeCloseTo(5, 9);
  });

  it('is zero for a coincident point', () => {
    expect(distance(v(2, 2, 2), v(2, 2, 2))).toBe(0);
  });
});

describe('polyline', () => {
  it('returns empty segments for fewer than two points', () => {
    expect(segmentLengths([])).toEqual([]);
    expect(segmentLengths([v(1, 1, 1)])).toEqual([]);
    expect(polylineLength([]).total).toBe(0);
  });

  it('sums segments with running cumulative totals', () => {
    const r = polylineLength([v(0, 0, 0), v(3, 0, 0), v(3, 4, 0)]);
    expect(r.segments).toEqual([3, 4]);
    expect(r.cumulative).toEqual([3, 7]);
    expect(r.total).toBe(7);
  });
});

describe('polygon area', () => {
  const square: Vec3[] = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)];

  it('Newell normal of a unit XY square points up with magnitude 2', () => {
    const n = newellNormal(square);
    expect(n[0]).toBeCloseTo(0, 9);
    expect(n[1]).toBeCloseTo(0, 9);
    expect(n[2]).toBeCloseTo(2, 9);
  });

  it('planar area of a unit square is 1', () => {
    expect(polygonAreaPlanar(square)).toBeCloseTo(1, 9);
  });

  it('planar area of a right triangle is 0.5', () => {
    expect(polygonAreaPlanar([v(0, 0, 0), v(1, 0, 0), v(0, 1, 0)])).toBeCloseTo(0.5, 9);
  });

  it('is zero for fewer than three vertices', () => {
    expect(polygonAreaPlanar([v(0, 0, 0), v(1, 0, 0)])).toBe(0);
    expect(polygonAreaHorizontal([v(0, 0, 0), v(1, 0, 0)], UP_Z)).toBe(0);
  });

  it('horizontal area equals planar area for a flat polygon', () => {
    expect(polygonAreaHorizontal(square, UP_Z)).toBeCloseTo(1, 9);
  });

  it('horizontal area of a vertical wall polygon is zero', () => {
    const wall: Vec3[] = [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)];
    expect(polygonAreaPlanar(wall)).toBeCloseTo(1, 9);
    expect(polygonAreaHorizontal(wall, UP_Z)).toBeCloseTo(0, 9);
  });

  it('horizontal area of a 45°-tilted unit square is planar·cos45°', () => {
    const c = Math.SQRT1_2;
    const tilted: Vec3[] = [v(0, 0, 0), v(1, 0, 0), v(1, c, c), v(0, c, c)];
    expect(polygonAreaPlanar(tilted)).toBeCloseTo(1, 6);
    expect(polygonAreaHorizontal(tilted, UP_Z)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('perimeter of a unit square is 4', () => {
    expect(polygonPerimeter(square)).toBeCloseTo(4, 9);
  });
});

describe('angleAtVertex', () => {
  it('measures a right angle', () => {
    expect(angleAtVertex(v(1, 0, 0), v(0, 0, 0), v(0, 1, 0))).toBeCloseTo(90, 6);
  });

  it('measures a straight line', () => {
    expect(angleAtVertex(v(1, 0, 0), v(0, 0, 0), v(-1, 0, 0))).toBeCloseTo(180, 6);
  });

  it('measures 45 degrees', () => {
    expect(angleAtVertex(v(1, 0, 0), v(0, 0, 0), v(1, 1, 0))).toBeCloseTo(45, 6);
  });

  it('returns zero for a degenerate ray', () => {
    expect(angleAtVertex(v(0, 0, 0), v(0, 0, 0), v(1, 0, 0))).toBe(0);
  });
});

describe('slopeBetween', () => {
  it('reads a 45° / 100% grade', () => {
    const s = slopeBetween(v(0, 0, 0), v(1, 0, 1), UP_Z);
    expect(s.rise).toBeCloseTo(1, 9);
    expect(s.run).toBeCloseTo(1, 9);
    expect(s.gradePercent).toBeCloseTo(100, 6);
    expect(s.angleDeg).toBeCloseTo(45, 6);
  });

  it('reads a 3-run / 4-rise slope', () => {
    const s = slopeBetween(v(0, 0, 0), v(3, 0, 4), UP_Z);
    expect(s.rise).toBeCloseTo(4, 9);
    expect(s.run).toBeCloseTo(3, 9);
    expect(s.gradePercent).toBeCloseTo(133.333, 3);
    expect(s.angleDeg).toBeCloseTo(53.13, 2);
  });

  it('is flat for a horizontal pair', () => {
    const s = slopeBetween(v(0, 0, 0), v(5, 0, 0), UP_Z);
    expect(s.rise).toBeCloseTo(0, 9);
    expect(s.gradePercent).toBe(0);
    expect(s.angleDeg).toBeCloseTo(0, 9);
  });

  it('reports an infinite grade for a vertical pair', () => {
    const s = slopeBetween(v(0, 0, 0), v(0, 0, 5), UP_Z);
    expect(s.run).toBeCloseTo(0, 9);
    expect(s.gradePercent).toBe(Infinity);
    expect(s.angleDeg).toBeCloseTo(90, 6);
  });
});

describe('verticalDelta', () => {
  it('splits a Z-up offset into vertical and horizontal', () => {
    const d = verticalDelta(v(0, 0, 0), v(3, 0, 4), UP_Z);
    expect(d.vertical).toBeCloseTo(4, 9);
    expect(d.horizontal).toBeCloseTo(3, 9);
  });

  it('works with a Y-up axis', () => {
    const d = verticalDelta(v(0, 0, 0), v(2, 5, 0), UP_Y);
    expect(d.vertical).toBeCloseTo(5, 9);
    expect(d.horizontal).toBeCloseTo(2, 9);
  });
});
