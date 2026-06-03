import { describe, it, expect } from 'vitest';
import {
  MIN_POINTS,
  FIXED_POINTS,
  isComplete,
  isFull,
} from '../src/render/measure/types';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';

function make(kind: MeasurementKind, count: number, closed?: boolean): Measurement {
  const points: Vec3[] = Array.from({ length: count }, (): Vec3 => [0, 0, 0]);
  return { id: 'm', kind, name: kind, points, closed };
}

describe('MIN_POINTS / FIXED_POINTS', () => {
  it('requires sane minimum vertex counts', () => {
    expect(MIN_POINTS.distance).toBe(2);
    expect(MIN_POINTS.polyline).toBe(2);
    expect(MIN_POINTS.area).toBe(3);
    expect(MIN_POINTS.height).toBe(2);
    expect(MIN_POINTS.angle).toBe(3);
    expect(MIN_POINTS.slope).toBe(2);
  });

  it('fixes the vertex count only for fixed-count kinds', () => {
    expect(FIXED_POINTS.distance).toBe(2);
    expect(FIXED_POINTS.height).toBe(2);
    expect(FIXED_POINTS.slope).toBe(2);
    expect(FIXED_POINTS.angle).toBe(3);
    expect(FIXED_POINTS.polyline).toBeUndefined();
    expect(FIXED_POINTS.area).toBeUndefined();
  });
});

describe('isComplete', () => {
  it('needs the minimum vertices', () => {
    expect(isComplete(make('distance', 1))).toBe(false);
    expect(isComplete(make('distance', 2))).toBe(true);
    expect(isComplete(make('angle', 2))).toBe(false);
    expect(isComplete(make('angle', 3))).toBe(true);
    expect(isComplete(make('polyline', 1))).toBe(false);
    expect(isComplete(make('polyline', 2))).toBe(true);
  });

  it('requires a closed ring for area', () => {
    expect(isComplete(make('area', 3, false))).toBe(false);
    expect(isComplete(make('area', 3, true))).toBe(true);
    expect(isComplete(make('area', 2, true))).toBe(false);
  });
});

describe('isFull', () => {
  it('is true once a fixed-count kind has its vertices', () => {
    expect(isFull(make('distance', 1))).toBe(false);
    expect(isFull(make('distance', 2))).toBe(true);
    expect(isFull(make('angle', 3))).toBe(true);
  });

  it('is never full for open-ended kinds', () => {
    expect(isFull(make('polyline', 2))).toBe(false);
    expect(isFull(make('polyline', 25))).toBe(false);
    expect(isFull(make('area', 50, true))).toBe(false);
  });
});
