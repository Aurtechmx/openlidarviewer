import { describe, test, expect } from 'vitest';
import { icpRegister, applyIcp, type Vec3 } from '../src/terrain/change/icpRegister';

/** Deterministic pseudo-random cloud (seeded LCG) in a `size`-unit box. */
function cloud(n: number, size: number, seed: number): Vec3[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    pts.push([rnd() * size, rnd() * size, rnd() * size * 0.25]);
  }
  return pts;
}

/** Apply R(yaw)·p + t to make a target from a source. */
function transform(src: readonly Vec3[], yaw: number, t: Vec3): Vec3[] {
  return src.map((p) => applyIcp({ yawRad: yaw, translation: t }, p));
}

function maxError(a: readonly Vec3[], b: readonly Vec3[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i][0] - b[i][0], dy = a[i][1] - b[i][1], dz = a[i][2] - b[i][2];
    m = Math.max(m, Math.hypot(dx, dy, dz));
  }
  return m;
}

describe('icpRegister', () => {
  test('identical clouds → identity transform, ~0 residual', () => {
    const src = cloud(50, 40, 1);
    const r = icpRegister(src, src);
    expect(r.degenerate).toBe(false);
    expect(r.converged).toBe(true);
    expect(r.rmsResidual).toBeLessThan(1e-6);
    expect(Math.abs(r.yawRad)).toBeLessThan(1e-6);
    expect(Math.hypot(...r.translation)).toBeLessThan(1e-6);
  });

  test('recovers a known pure translation', () => {
    const src = cloud(60, 40, 7);
    const t: Vec3 = [5, -3, 2];
    const tgt = transform(src, 0, t);
    const r = icpRegister(src, tgt);
    expect(r.rmsResidual).toBeLessThan(0.01);
    expect(r.translation[0]).toBeCloseTo(5, 1);
    expect(r.translation[1]).toBeCloseTo(-3, 1);
    expect(r.translation[2]).toBeCloseTo(2, 1);
    // The solved transform reproduces the target.
    expect(maxError(src.map((p) => applyIcp(r, p)), tgt)).toBeLessThan(0.02);
  });

  test('inlier fraction: 1.0 for a clean overlap within tolerance', () => {
    const src = cloud(50, 40, 1);
    const r = icpRegister(src, src, { maxResidual: 0.001 });
    expect(r.inlierFraction).toBe(1);
  });

  test('inlier fraction: below 1 when residual exceeds tolerance', () => {
    const src = cloud(60, 40, 9);
    // Pitch about X — planar (yaw-only) ICP cannot remove it, so residual stays.
    const c = Math.cos(0.3), s = Math.sin(0.3);
    const tgt: Vec3[] = src.map(([x, y, z]) => [x, y * c - z * s, y * s + z * c]);
    const r = icpRegister(src, tgt, { maxResidual: 0.01 });
    expect(r.inlierFraction).toBeLessThan(1);
    expect(r.inlierFraction).toBeGreaterThanOrEqual(0);
  });

  test('recovers a known translation + yaw', () => {
    const src = cloud(60, 40, 11);
    const yaw0 = 0.08;
    const t: Vec3 = [4, -2, 1.5];
    const tgt = transform(src, yaw0, t);
    const r = icpRegister(src, tgt, { maxIterations: 60, tolerance: 1e-8 });
    expect(r.refused).toBe(false);
    expect(r.yawRad).toBeCloseTo(yaw0, 2);
    expect(r.rmsResidual).toBeLessThan(0.05);
    expect(maxError(src.map((p) => applyIcp(r, p)), tgt)).toBeLessThan(0.1);
  });

  test('refuses when two clouds cannot be aligned (residual exceeds the floor)', () => {
    const a = cloud(50, 40, 3);
    const b = cloud(50, 40, 999); // unrelated
    const r = icpRegister(a, b, { maxResidual: 1.0 });
    expect(r.rmsResidual).toBeGreaterThan(1.0);
    expect(r.refused).toBe(true);
  });

  test('degenerate input (fewer than 3 points) is refused, not thrown', () => {
    const r = icpRegister([[0, 0, 0]], cloud(10, 10, 1));
    expect(r.degenerate).toBe(true);
    expect(r.refused).toBe(true);
    expect(r.iterations).toBe(0);
  });

  test('a residual below the floor is accepted (not refused)', () => {
    const src = cloud(40, 30, 5);
    const tgt = transform(src, 0.03, [1, 1, 0.5]);
    const r = icpRegister(src, tgt, { maxResidual: 0.5 });
    expect(r.refused).toBe(false);
    expect(r.rmsResidual).toBeLessThan(0.5);
  });
});
