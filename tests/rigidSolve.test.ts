/**
 * rigidSolve.test.ts — 6-DOF rigid registration recovers known transforms and
 * refuses degenerate ones.
 */

import { describe, it, expect } from 'vitest';
import { rigidSolve, type Vec3, type Mat3 } from '../src/registration/rigidSolve';

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotation about an arbitrary axis by angle (Rodrigues), row-major. */
function rotAxis(ax: number, ay: number, az: number, angle: number): Mat3 {
  const n = Math.hypot(ax, ay, az);
  const x = ax / n, y = ay / n, z = az / n;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
function apply(R: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}
function det3(m: Mat3): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function cloud(n: number, seed: number): Vec3[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => [r() * 100, r() * 100, r() * 100] as Vec3);
}

describe('rigidSolve recovers a known transform', () => {
  it('exactly recovers a rotation + translation from clean correspondences', () => {
    const src = cloud(30, 1);
    const R = rotAxis(0.3, -0.7, 0.5, 0.9);
    const t: Vec3 = [12.5, -3.2, 7.8];
    const dst = src.map((p) => apply(R, t, p));

    const res = rigidSolve(src, dst);
    expect(res.ok).toBe(true);
    expect(res.rmse).toBeLessThan(1e-6);
    // Recovered R matches the true R, and it is a proper rotation.
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(res.R[i][j]).toBeCloseTo(R[i][j], 6);
    expect(det3(res.R)).toBeCloseTo(1, 6);
    for (let k = 0; k < 3; k++) expect(res.t[k]).toBeCloseTo(t[k], 5);
  });

  it('returns a proper rotation (det +1), never a reflection, for a 180° turn', () => {
    const src = cloud(40, 7);
    const R = rotAxis(0, 0, 1, Math.PI); // 180° about z — the reflection trap
    const dst = src.map((p) => apply(R, [0, 0, 0], p));
    const res = rigidSolve(src, dst);
    expect(res.ok).toBe(true);
    expect(det3(res.R)).toBeCloseTo(1, 6);
    expect(res.rmse).toBeLessThan(1e-6);
  });

  it('recovers the transform under small noise with a residual near the noise level', () => {
    const src = cloud(200, 3);
    const R = rotAxis(1, 0.2, -0.4, 0.5);
    const t: Vec3 = [5, 5, 5];
    const rng = mulberry32(99);
    const sigma = 0.05;
    const dst = src.map((p) => {
      const q = apply(R, t, p);
      return [q[0] + (rng() - 0.5) * sigma, q[1] + (rng() - 0.5) * sigma, q[2] + (rng() - 0.5) * sigma] as Vec3;
    });
    const res = rigidSolve(src, dst);
    expect(res.ok).toBe(true);
    expect(res.rmse).toBeLessThan(0.05);
    expect(res.R[0][0]).toBeCloseTo(R[0][0], 2);
  });
});

describe('rigidSolve refuses rather than guesses', () => {
  it('too few correspondences → refused', () => {
    const r = rigidSolve([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOO_FEW_CORRESPONDENCES');
  });
  it('collinear correspondences cannot pin all axes → refused', () => {
    const src: Vec3[] = Array.from({ length: 10 }, (_, i) => [i, 0, 0]);
    const dst = src.map((p) => [p[0] + 1, 0, 0] as Vec3);
    const r = rigidSolve(src, dst);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('DEGENERATE_GEOMETRY');
  });
  it('coincident source points → refused', () => {
    const src: Vec3[] = Array.from({ length: 5 }, () => [3, 3, 3]);
    const dst: Vec3[] = Array.from({ length: 5 }, () => [9, 1, 2]);
    const r = rigidSolve(src, dst);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('DEGENERATE_SOURCE');
  });

  it('a residual over the maxRmse gate is refused (no ok:true on a bad fit)', () => {
    // A non-rigid (sheared) correspondence set: no rigid transform fits it well,
    // so the residual is large. With a tight gate it must be refused.
    const src: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]];
    const dst: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 5], [1, 1, 9]];
    const gated = rigidSolve(src, dst, 3, 0.01);
    expect(gated.ok).toBe(false);
    expect(gated.reason).toBe('FIT_RMSE_EXCEEDED');
    expect(gated.rmse).toBeGreaterThan(0.01); // the residual is still reported
    // The SAME solve without a gate returns ok:true (closed-form always solves).
    const ungated = rigidSolve(src, dst, 3);
    expect(ungated.ok).toBe(true);
    expect(ungated.rmse).toBeGreaterThan(0.01);
  });

  it('a good fit within the gate still passes', () => {
    const src: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const dst = src.map((p) => [p[0] + 2, p[1] - 1, p[2] + 3] as Vec3); // pure translation
    const r = rigidSolve(src, dst, 3, 0.001);
    expect(r.ok).toBe(true);
    expect(r.rmse).toBeLessThan(0.001);
  });
});
