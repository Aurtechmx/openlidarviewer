/**
 * The observability test of the point-to-plane rigid fit (yaw, x, y, z) runs on
 * the undamped information matrix, so a plane is refused whatever damping
 * would have made solvable.
 */
import { describe, expect, test } from 'vitest';
import { OBSERVABILITY_MIN_RATIO, rigidObservability, symEigenvalues4 } from '../src/terrain/change/rigidObservability';
import { icpRegister, type Vec3 } from '../src/terrain/change/icpRegister';

/** Σ rowᵀ·row over point-to-plane rows [lever, nx, ny, nz] about the centroid. */
function information(pts: readonly Vec3[], normals: readonly Vec3[]): { A: number[][]; lever: number } {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let l2 = 0;
  pts.forEach((p, i) => {
    const [nx, ny, nz] = normals[i];
    const row = [-(p[1] - cy) * nx + (p[0] - cx) * ny, nx, ny, nz];
    for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) A[u][v] += row[u] * row[v];
    l2 += (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
  });
  return { A, lever: Math.sqrt(l2 / pts.length) };
}

const grid = (f: (x: number, y: number) => number, n = 30): Vec3[] => {
  const out: Vec3[] = [];
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) out.push([x, y, f(x, y)]);
  return out;
};
/** Analytic unit normal of z = f(x, y) by central differences. */
const normalOf = (f: (x: number, y: number) => number) => (p: Vec3): Vec3 => {
  const h = 1e-4;
  const gx = (f(p[0] + h, p[1]) - f(p[0] - h, p[1])) / (2 * h);
  const gy = (f(p[0], p[1] + h) - f(p[0], p[1] - h)) / (2 * h);
  const m = Math.hypot(gx, gy, 1);
  return [-gx / m, -gy / m, 1 / m];
};

describe('symEigenvalues4', () => {
  test('diagonal and a rotated diagonal give the same spectrum', () => {
    const d = [4, 3, 2, 1];
    expect(symEigenvalues4(d.map((v, i) => d.map((_, j) => (i === j ? v : 0)))).sort()).toEqual([1, 2, 3, 4]);
    // Q·diag·Qᵀ with a Householder Q.
    const v = [1, 2, -1, 0.5];
    const vv = v.reduce((s, x) => s + x * x, 0);
    const Q = v.map((a, i) => v.map((b, j) => (i === j ? 1 : 0) - (2 * a * b) / vv));
    const M = Q.map((_, i) => Q.map((__, j) => d.reduce((s, dk, k) => s + Q[i][k] * dk * Q[j][k], 0)));
    const ev = symEigenvalues4(M).sort((a, b) => a - b);
    ev.forEach((e, i) => expect(e).toBeCloseTo(i + 1, 10));
  });
});

describe('rigidObservability', () => {
  for (const s of [0, 0.1, 0.5, 1, -0.5]) {
    test(`a plane of slope ${s} is unobservable`, () => {
      const f = (x: number): number => s * x;
      const pts = grid(f);
      const { A, lever } = information(pts, pts.map(normalOf(f)));
      const o = rigidObservability(A, pts.length, lever);
      expect(o.observable).toBe(false);
      expect(o.eigenRatio).toBeLessThan(1e-9);
    });
  }

  test('relief varying along both axes is observable', () => {
    const f = (x: number, y: number): number => 3 * Math.sin(x / 5) + 2 * Math.cos(y / 4);
    const pts = grid(f);
    const { A, lever } = information(pts, pts.map(normalOf(f)));
    const o = rigidObservability(A, pts.length, lever);
    expect(o.observable).toBe(true);
    expect(o.horizontalRatio).toBeGreaterThanOrEqual(o.eigenRatio);
    expect(o.threshold).toBe(OBSERVABILITY_MIN_RATIO);
  });

  test('a ridge (relief along x only) leaves y unconstrained', () => {
    const f = (x: number): number => 3 * Math.sin(x / 5);
    const pts = grid(f);
    const { A, lever } = information(pts, pts.map(normalOf(f)));
    const o = rigidObservability(A, pts.length, lever);
    expect(o.observable).toBe(false);
  });

  test('too few pairs or no lever arm is not observable', () => {
    const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    expect(rigidObservability(I, 3, 1).observable).toBe(false);
    expect(rigidObservability(I, 10, 0).observable).toBe(false);
  });
});

describe('icpRegister with minObservability', () => {
  const plane = (dz: number): Vec3[] => grid((x) => 0.5 * x + dz, 40);

  test('a sloped plane with a 1 m uplift is refused before damping, with no pose', () => {
    const r = icpRegister(plane(1), plane(0), {
      metric: 'plane', normalRadius: 2, initialPose: 'identity', maxCorrespondenceDistance: 3, minObservability: OBSERVABILITY_MIN_RATIO,
    });
    expect(r.unobservable).toBe(true);
    expect(r.refused).toBe(true);
    expect(r.translation).toEqual([0, 0, 0]);
    expect(r.yawRad).toBe(0);
    expect(r.observability?.observable).toBe(false);
  });

  test('without the option the damped solve still slides the plane (the defect the gate prevents)', () => {
    const r = icpRegister(plane(1), plane(0), { metric: 'plane', normalRadius: 2, initialPose: 'identity', maxCorrespondenceDistance: 3 });
    expect(r.unobservable).toBeUndefined();
    expect(Math.abs(r.translation[0])).toBeGreaterThan(0.1);
  });
});
