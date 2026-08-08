/**
 * generalIcp.test.ts — trimmed ICP recovers a known transform without given
 * correspondences, and refuses when the clouds do not overlap.
 */

import { describe, it, expect } from 'vitest';
import { generalIcp } from '../src/registration/generalIcp';
import type { Vec3, Mat3 } from '../src/registration/rigidSolve';

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
/** A distinctive 3-D lattice (spacing 1). */
function lattice(g: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let x = 0; x < g; x++) for (let y = 0; y < g; y++) for (let z = 0; z < g; z++) pts.push([x, y, z]);
  return pts;
}
/** A well-separated seeded random cloud — nearest-neighbour matches are unique
 *  under a small transform, so the recovered alignment is unambiguous. */
function randomCloud(n: number, seed: number, box = 100): Vec3[] {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: n }, () => [r() * box, r() * box, r() * box] as Vec3);
}

describe('generalIcp recovers a small known transform without correspondences', () => {
  it('converges to the true rotation + translation from identity', () => {
    const src = randomCloud(160, 42);
    const R = rotAxis(0.1, -0.2, 1, 0.03); // ~1.7°
    const t: Vec3 = [0.5, -0.4, 0.3];
    const dst = src.map((p) => apply(R, t, p));

    const res = generalIcp(src, dst, { searchRadius: 4, trimFraction: 0.1 });
    expect(res.ok).toBe(true);
    expect(res.converged).toBe(true);
    expect(res.rmse).toBeLessThan(1e-4);
    // Recovered transform maps a probe point onto its true image.
    const probe: Vec3 = [2, 3, 4];
    const got = apply(res.R, res.t, probe);
    const want = apply(R, t, probe);
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 3);
    expect(res.inlierFraction).toBeGreaterThan(0.9);
  });

  it('is idempotent on already-aligned clouds (identity recovered)', () => {
    const src = lattice(5);
    const res = generalIcp(src, src, { searchRadius: 0.5 });
    expect(res.ok).toBe(true);
    expect(res.rmse).toBeLessThan(1e-9);
    // R ≈ identity, t ≈ 0.
    expect(res.R[0][0]).toBeCloseTo(1, 6);
    expect(Math.hypot(res.t[0], res.t[1], res.t[2])).toBeLessThan(1e-6);
  });
});

describe('generalIcp refuses rather than reporting a wrong alignment', () => {
  it('too few points → refused', () => {
    const r = generalIcp([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOO_FEW_POINTS');
  });

  it('disjoint clouds with no matches → NO_OVERLAP', () => {
    const src = lattice(4);
    const dst = lattice(4).map((p) => [p[0] + 1000, p[1] + 1000, p[2] + 1000] as Vec3);
    const r = generalIcp(src, dst, { searchRadius: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_OVERLAP');
  });

  it('low overlap is refused with LOW_OVERLAP and the achieved fraction reported', () => {
    // Only a small corner of source has a nearby target point.
    const src = lattice(6);
    const dst: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const r = generalIcp(src, dst, { searchRadius: 0.6, minInlierFraction: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('LOW_OVERLAP');
    expect(r.inlierFraction).toBeLessThan(0.5);
  });
});
