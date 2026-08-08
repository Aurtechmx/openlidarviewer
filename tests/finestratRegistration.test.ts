/**
 * finestratRegistration.test.ts — ICP validated on REAL terrestrial LiDAR
 * geometry (a gypsum slope), not synthetic points.
 *
 * Dataset: multi-temporal terrestrial laser scans of a gypsum slope in
 * Finestrat, Alicante, Spain (Abellán & Riquelme 2017, Zenodo DOI
 * 10.5281/zenodo.7576524), in a scanner-local frame. A decimated epoch is
 * committed as a compact fixture.
 *
 * The test applies a KNOWN rigid transform to the real slope points and checks
 * generalIcp recovers it from identity — so the recovery is measured against
 * ground truth (the applied transform) on genuine slope structure, and also
 * that the aligner is idempotent on already-aligned scans. This is the terrestrial
 * multi-epoch case the registration model targets; the change-detection use
 * (aligning two epochs, then reading the trimmed residual tail as rockfall) is a
 * downstream application of the same aligner.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generalIcp } from '../src/registration/generalIcp';
import type { Vec3, Mat3 } from '../src/registration/rigidSolve';

const FIX = resolve(__dirname, '../validation/registration/finestrat-slope__epoch2011.f32');

function readCloud(): Vec3[] {
  const buf = readFileSync(FIX);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
  return pts;
}
function rotAxis(ax: number, ay: number, az: number, angle: number): Mat3 {
  const nn = Math.hypot(ax, ay, az);
  const x = ax / nn, y = ay / nn, z = az / nn;
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

describe('ICP on real terrestrial slope geometry (Finestrat gypsum slope)', () => {
  const has = existsSync(FIX);

  (has ? it : it.skip)('recovers a known rigid transform from identity on real slope points', () => {
    const src = readCloud();
    expect(src.length).toBeGreaterThan(5000);
    const R = rotAxis(0.2, -0.5, 1, 0.02); // ~1.1°
    const t: Vec3 = [0.6, -0.4, 0.3];
    const dst = src.map((p) => apply(R, t, p));

    const res = generalIcp(src, dst, { searchRadius: 1.5, trimFraction: 0.1, minInlierFraction: 0.5 });
    // eslint-disable-next-line no-console
    console.log(`[registration] Finestrat ICP: ok=${res.ok} rmse=${res.rmse.toExponential(2)} iters=${res.iterations} inlier=${res.inlierFraction.toFixed(2)} converged=${res.converged}`);
    expect(res.ok).toBe(true);
    expect(res.converged).toBe(true);
    expect(res.rmse).toBeLessThan(0.05);
    // Recovered transform maps a probe point onto its true image.
    const probe: Vec3 = src[1000];
    const got = apply(res.R, res.t, probe);
    const want = apply(R, t, probe);
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 2);
    expect(res.inlierFraction).toBeGreaterThan(0.8);
  });

  (has ? it : it.skip)('is idempotent on an already-aligned scan (identity, near-zero residual)', () => {
    const src = readCloud();
    const res = generalIcp(src, src, { searchRadius: 1.0 });
    expect(res.ok).toBe(true);
    expect(res.rmse).toBeLessThan(1e-6);
    expect(Math.hypot(res.t[0], res.t[1], res.t[2])).toBeLessThan(1e-3);
  });
});
