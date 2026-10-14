/**
 * The support signals the controller gathers (on a return, points within the
 * trust radius) fed to the grade, on planar, linear, sparse and 3D clouds.
 */
import { describe, it, expect } from 'vitest';
import { buildPointSnapIndex, countPointsWithinRadius, isOnMeasuredReturn, type Vec3 } from '../src/render/measure/snap';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';

function pack(points: Vec3[]): Float32Array {
  return Float32Array.from(points.flat());
}

function grade(points: Vec3[], vertices: Vec3[]) {
  const idx = buildPointSnapIndex(pack(points));
  const support = vertices.map((v) => ({
    snappedToPoint: isOnMeasuredReturn(idx, v),
    pointsWithinRadius: countPointsWithinRadius(idx, v, idx.cellSize * 4),
  }));
  return { support, trust: gradeMeasurement({ vertices: support, crsKnown: true }) };
}

const plane: Vec3[] = [];
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) plane.push([x, y, 0]);

describe('measurement support grade', () => {
  it('vertices 1 m above a planar grid are not on a return and not green', () => {
    const { support, trust } = grade(plane, [[3, 4, 1], [6, 5, 1]]);
    expect(support.every((s) => !s.snappedToPoint)).toBe(true);
    expect(trust.grade).not.toBe('green');
  });

  it('vertices on a planar grid stay supported', () => {
    const { support, trust } = grade(plane, [[3, 4, 0], [6, 5, 0]]);
    expect(support.every((s) => s.snappedToPoint)).toBe(true);
    expect(trust.grade).toBe('green');
  });

  it('a linear cloud: off the line is not a return, on it is', () => {
    const line: Vec3[] = [];
    for (let i = 0; i < 200; i++) line.push([i, 0, 0]);
    expect(grade(line, [[50, 0, 1], [90, 0, 1]]).trust.grade).not.toBe('green');
    // A line holds too few returns inside the trust radius to read as dense.
    const onLine = grade(line, [[50, 0, 0], [90, 0, 0]]);
    expect(onLine.support.every((s) => s.snappedToPoint)).toBe(true);
    expect(onLine.trust.grade).toBe('yellow');
  });

  it('a sparse cloud is never green, even on a point', () => {
    const sparse: Vec3[] = [[0, 0, 0], [500, 0, 0], [0, 500, 0], [500, 500, 0]];
    const { support, trust } = grade(sparse, [[0, 0, 0], [500, 500, 400]]);
    expect(support[1].snappedToPoint).toBe(false);
    expect(trust.grade).not.toBe('green');
  });

  it('an ordinary 3D cloud: a vertex in the volume is supported, one far outside is a void', () => {
    const cube: Vec3[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) cube.push([x, y, z]);
    expect(grade(cube, [[2, 2, 2], [3, 3, 3]]).trust.grade).toBe('green');
    const far = grade(cube, [[2, 2, 2], [40, 40, 40]]);
    expect(far.trust.grade).toBe('red');
    expect(far.trust.presentable).toBe(false);
  });
});
