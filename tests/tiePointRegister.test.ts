import { describe, it, expect } from 'vitest';
import { registerTiePoints, applyRigid, type Vec3 } from '../src/geo/tiePointRegister';

/** A row-major rotation from a unit quaternion [w,x,y,z]. */
function rotFromQuat(w: number, x: number, y: number, z: number): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

function apply(R: number[], t: Vec3, p: Vec3): Vec3 {
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ];
}

// Five non-coplanar source points.
const SRC: Vec3[] = [
  [0, 0, 0],
  [10, 0, 1],
  [3, 12, -2],
  [-5, 4, 8],
  [7, -6, 3],
];

describe('registerTiePoints (Horn absolute orientation)', () => {
  it('recovers a known rotation + translation exactly', () => {
    // 40° about a tilted, normalised axis.
    const theta = (40 * Math.PI) / 180;
    const ax = [1, 2, 2];
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    const s = Math.sin(theta / 2);
    const q: [number, number, number, number] = [
      Math.cos(theta / 2),
      (ax[0] / al) * s,
      (ax[1] / al) * s,
      (ax[2] / al) * s,
    ];
    const R = rotFromQuat(q[0], q[1], q[2], q[3]);
    const t: Vec3 = [123.5, -47.25, 8.0];
    const dst = SRC.map((p) => apply(R, t, p));

    const tf = registerTiePoints(SRC, dst);
    // Sub-micron recovery on 10 m-scale points (the eigensolver is iterative).
    expect(tf.rmsResidual).toBeLessThan(1e-5);
    for (let i = 0; i < 9; i++) expect(tf.rotation[i]).toBeCloseTo(R[i], 5);
    for (let i = 0; i < 3; i++) expect(tf.translation[i]).toBeCloseTo(t[i], 4);
    // The recovered transform reproduces every correspondence.
    for (let i = 0; i < SRC.length; i++) {
      const m = applyRigid(tf, SRC[i]);
      for (let a = 0; a < 3; a++) expect(m[a]).toBeCloseTo(dst[i][a], 5);
    }
  });

  it('never returns a reflection (proper rotation, det = +1)', () => {
    // A point set whose naive covariance polar factor could flip to a reflection.
    const dst = SRC.map((p): Vec3 => [-p[0], p[1], p[2]]); // mirror across X
    const tf = registerTiePoints(SRC, dst);
    const r = tf.rotation;
    const det =
      r[0] * (r[4] * r[8] - r[5] * r[7]) -
      r[1] * (r[3] * r[8] - r[5] * r[6]) +
      r[2] * (r[3] * r[7] - r[4] * r[6]);
    expect(det).toBeGreaterThan(0.99); // +1, not −1
  });

  it('reports a residual at the noise level and stays near the true transform', () => {
    const t: Vec3 = [5, 5, 5]; // identity rotation, pure translation
    // Deterministic ±5 mm perturbation per axis.
    const jitter = [0.005, -0.005, 0.004, -0.003, 0.005];
    const dst = SRC.map((p, i): Vec3 => [
      p[0] + t[0] + jitter[i],
      p[1] + t[1] - jitter[i],
      p[2] + t[2] + jitter[(i + 1) % jitter.length],
    ]);
    const tf = registerTiePoints(SRC, dst);
    expect(tf.rmsResidual).toBeGreaterThan(0);
    expect(tf.rmsResidual).toBeLessThan(0.02); // within a couple cm of the 5 mm jitter
  });

  it('requires at least three correspondences', () => {
    expect(() => registerTiePoints(SRC.slice(0, 2), SRC.slice(0, 2))).toThrow(/three/);
  });
});
