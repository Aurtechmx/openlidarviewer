/**
 * tiePointAlignment.test.ts — the manual tie-point fallback + per-tie residuals.
 */

import { describe, it, expect } from 'vitest';
import { alignTiePoints, type TiePoint } from '../src/registration/tiePointAlignment';
import type { Vec3, Mat3 } from '../src/registration/rigidSolve';

function rot(ax: number, ay: number, az: number, angle: number): Mat3 {
  const n = Math.hypot(ax, ay, az); const x = ax / n, y = ay / n, z = az / n;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
function ap(R: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}

describe('alignTiePoints', () => {
  const R = rot(0.2, -0.3, 1, 0.4);
  const t: Vec3 = [10, -5, 3];
  const sources: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const ties: TiePoint[] = sources.map((s, i) => ({ source: s, target: ap(R, t, s), label: `tie${i}` }));

  it('recovers the transform from 4 clean, well-distributed ties with ~0 residuals', () => {
    const res = alignTiePoints(ties);
    expect(res.ok).toBe(true);
    expect(res.rmse).toBeLessThan(1e-6);
    expect(Math.max(...res.perTieResidual)).toBeLessThan(1e-6);
    const probe: Vec3 = [3, 4, 5];
    const got = ap(res.R, res.t, probe), want = ap(R, t, probe);
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 5);
  });

  it('surfaces a mis-clicked tie as the worst per-tie residual instead of averaging it away', () => {
    const bad = ties.map((p, i) => (i === 2 ? { ...p, target: [p.target[0] + 2, p.target[1], p.target[2]] as Vec3 } : p));
    const res = alignTiePoints(bad);
    expect(res.ok).toBe(true);
    expect(res.worstTie).toBe(2); // the corrupted tie is flagged
    expect(res.perTieResidual[2]).toBeGreaterThan(0.1);
  });

  it('refuses fewer than three ties', () => {
    const r = alignTiePoints(ties.slice(0, 2));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOO_FEW_TIES');
  });

  it('refuses a near-collinear tie set (cannot pin all axes)', () => {
    const collinear: TiePoint[] = [0, 1, 2, 3].map((i) => ({ source: [i, 0, 0], target: [i + 5, 0, 0] }));
    const r = alignTiePoints(collinear);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('DEGENERATE_GEOMETRY');
  });
});
