import { describe, it, expect } from 'vitest';
import { buildPointIndex, nearestPoint, nearestState } from '../src/terrain/change/pointIndex';
import type { Vec3 } from '../src/terrain/change/icpRegister';

/**
 * The grid index must answer exactly what a scan over every point answers:
 * the smallest squared distance, and the lowest index among exact ties. The
 * reference here is that scan, with the same operand order for the distance.
 */

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

function scan(points: readonly Vec3[], x: number, y: number, z: number): { index: number; d2: number } {
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < points.length; i++) {
    const t = points[i];
    const dx = x - t[0], dy = y - t[1], dz = z - t[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return { index: best, d2: bestD2 };
}

function check(points: readonly Vec3[], queries: readonly Vec3[], label: string): void {
  const index = buildPointIndex(points);
  for (const [x, y, z] of queries) {
    const ref = scan(points, x, y, z);
    const got = nearestPoint(index, x, y, z);
    expect(got, `${label} index at (${x},${y},${z})`).toBe(ref.index);
    expect(nearestState.d2, `${label} d2 at (${x},${y},${z})`).toBe(ref.d2);
  }
}

describe('pointIndex nearest queries against a full scan', () => {
  it('random volume clouds with duplicates, queried inside, on points and far outside', () => {
    for (const seed of [1, 2, 3]) {
      const rnd = prng(seed);
      const points: Vec3[] = [];
      for (let i = 0; i < 800; i++) points.push([rnd() * 100 - 50, rnd() * 60, rnd() * 10]);
      for (let i = 0; i < 40; i++) points.push(points[i * 7]); // exact duplicates at higher indices
      const queries: Vec3[] = [];
      for (let i = 0; i < 300; i++) queries.push([rnd() * 140 - 70, rnd() * 80 - 10, rnd() * 14 - 2]);
      for (let i = 0; i < 50; i++) queries.push(points[i * 3]); // exact hits, d2 = 0
      queries.push([1e4, -1e4, 5], [-300, 30, 0], [0, 0, 1e3]);
      check(points, queries, `seed ${seed}`);
    }
  });

  it('a lattice full of equidistant targets picks the lowest index every time', () => {
    const points: Vec3[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 3; k++) points.push([i * 2, j * 2, k * 2]);
    for (let i = 0; i < 20; i++) points.push(points[i]); // duplicates
    const queries: Vec3[] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) queries.push([i * 2 + 1, j * 2 + 1, 1]); // cell centres: 8 ties
    for (let i = 0; i < 6; i++) queries.push([i * 2 + 1, 0, 0]); // edge midpoints: 2 ties
    check(points, queries, 'lattice');
  });

  it('flat and collinear clouds, where one or two extents are zero', () => {
    const rnd = prng(9);
    const plane: Vec3[] = [];
    for (let i = 0; i < 500; i++) plane.push([rnd() * 50, rnd() * 50, 12.5]);
    const line: Vec3[] = [];
    for (let i = 0; i < 300; i++) line.push([rnd() * 90, -4, 7]);
    const queries: Vec3[] = [];
    for (let i = 0; i < 200; i++) queries.push([rnd() * 70 - 10, rnd() * 70 - 10, rnd() * 30]);
    check(plane, queries, 'plane');
    check(line, queries, 'line');
  });

  it('tiny sets: empty, one point, two coincident points', () => {
    expect(nearestPoint(buildPointIndex([]), 1, 2, 3)).toBe(-1);
    expect(nearestState.d2).toBe(Infinity);
    check([[1, 1, 1]], [[0, 0, 0], [1, 1, 1], [9, 9, 9]], 'one');
    check([[2, 2, 2], [2, 2, 2]], [[0, 0, 0], [2, 2, 2]], 'coincident');
  });
});
