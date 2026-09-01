/**
 * oracleConsensusRegistration.test.ts — oracle-triangulation for point-cloud
 * registration (rigid transform recovery).
 *
 * The scientific statement here is stronger than "OLV's ICP converges": on a
 * KNOWN rigid transform we prove OLV recovers that exact transform. No third-party
 * registration tool (Open3D, CloudCompare) is available in CI, so the truth anchor
 * is the closed-form known transform itself — an ANALYTIC-TRUTH leg, not a matched
 * implementation.
 *
 * For each case we build an asymmetric source cloud P (deterministic; enough
 * geometric structure that the rotation is uniquely determined — not a symmetric
 * or planar shape), apply a KNOWN small rigid transform (rotation <=5 deg +
 * translation) to make the target cloud Q, then run OLV's registration LIVE
 * (src/registration/generalIcp, trimmed ICP over rigidSolve) from an identity
 * initial pose and assert the recovered (R,t) matches the known transform within
 * the contract tolerance -> PASS_TRUTH.
 *
 * CONVENTION: source->target. generalIcp returns R,t that map the source onto the
 * target, i.e. q ~= R*p + t — precisely the transform that generated Q from P — so
 * the recovered transform is compared directly against the known one.
 *
 * Verdicts:
 *   PASS_TRUTH   OLV recovers the known transform within tolerance (rotation +
 *                translation + residual RMS),
 *   OLV_DISAGREEMENT  the recovered transform is outside tolerance of the truth.
 *
 * Two cases use different small rotations, axes and translations, so a single
 * systematic error (e.g. a fixed axis swap or a scale factor) could not pass both.
 * Negative controls confirm the triangulation FLAGS a wrong truth and that a gross
 * perturbation of Q pushes the residual past tolerance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generalIcp } from '../src/registration/generalIcp';
import type { Vec3, Mat3 } from '../src/registration/rigidSolve';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Oracle = {
  id: string;
  referenceClass: string;
  eulerDegZYX: { rz: number; ry: number; rx: number };
  translationM: [number, number, number];
};
type Case = { fixture: { id: string; points: number; seed: number; extents: [number, number, number] }; oracles: Oracle[] };
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/registration-icp.consensus.json'), 'utf8'),
) as {
  contract: { rotationToleranceDeg: number; translationToleranceM: number; rmsToleranceM: number };
  cases: Case[];
};

const DEG = Math.PI / 180;

/** Row-major R = Rz(rz)·Ry(ry)·Rx(rx), angles in degrees. */
function rotZYX(rzDeg: number, ryDeg: number, rxDeg: number): Mat3 {
  const [cz, sz] = [Math.cos(rzDeg * DEG), Math.sin(rzDeg * DEG)];
  const [cy, sy] = [Math.cos(ryDeg * DEG), Math.sin(ryDeg * DEG)];
  const [cx, sx] = [Math.cos(rxDeg * DEG), Math.sin(rxDeg * DEG)];
  const Rz: Mat3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const Ry: Mat3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rx: Mat3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  return mul(Rz, mul(Ry, Rx));
}
function mul(a: Mat3, b: Mat3): Mat3 {
  const o: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return o as unknown as Mat3;
}
function apply(R: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}
/** Geodesic angle (degrees) between two rotation matrices: acos((tr(Ra^T·Rb)-1)/2). */
function rotAngleBetweenDeg(a: Mat3, b: Mat3): number {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += a[i][k] * b[i][k]; // tr(a^T b) = Σ a_ik b_ik
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}
function transErrM(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Deterministic asymmetric source cloud (LCG); extents pin all three axes. */
function makeSource(seed: number, n: number, ext: [number, number, number]): Vec3[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const P: Vec3[] = [];
  for (let i = 0; i < n; i++) P.push([rnd() * ext[0], rnd() * ext[1], rnd() * ext[2]]);
  return P;
}

type KnownTransform = { R: Mat3; t: Vec3 };
function truthOf(c: Case): KnownTransform {
  const o = c.oracles.find((x) => x.referenceClass === 'analytic-truth')!;
  return { R: rotZYX(o.eulerDegZYX.rz, o.eulerDegZYX.ry, o.eulerDegZYX.rx), t: o.translationM };
}

/** Build P and Q=truth(P) for a case. */
function cloudsOf(c: Case): { P: Vec3[]; Q: Vec3[]; truth: KnownTransform } {
  const P = makeSource(c.fixture.seed, c.fixture.points, c.fixture.extents);
  const truth = truthOf(c);
  const Q = P.map((p) => apply(truth.R, truth.t, p));
  return { P, Q, truth };
}

/** Run OLV registration LIVE, recovering the source->target transform. */
function recover(P: Vec3[], Q: Vec3[]) {
  return generalIcp(P, Q, { maxIterations: 100, trimFraction: 0, convergenceTol: 1e-12 });
}

type Verdict = 'PASS_TRUTH' | 'OLV_DISAGREEMENT';
function verdict(
  recovered: { R: Mat3; t: Vec3; rmse: number; ok: boolean },
  truth: KnownTransform,
  tol: { rotationToleranceDeg: number; translationToleranceM: number; rmsToleranceM: number },
): Verdict {
  if (!recovered.ok) return 'OLV_DISAGREEMENT';
  const rotErr = rotAngleBetweenDeg(recovered.R, truth.R);
  const tErr = transErrM(recovered.t, truth.t);
  if (rotErr <= tol.rotationToleranceDeg && tErr <= tol.translationToleranceM && recovered.rmse <= tol.rmsToleranceM) {
    return 'PASS_TRUTH';
  }
  return 'OLV_DISAGREEMENT';
}

describe('oracle-consensus: point-cloud registration (rigid transform recovery)', () => {
  const tol = record.contract;

  for (const c of record.cases) {
    const label = c.fixture.id;
    const { P, Q, truth } = cloudsOf(c);
    const res = recover(P, Q);

    it(`OLV registration converges on a valid transform [${label}]`, () => {
      expect(res.ok, res.reason).toBe(true);
      expect(res.converged).toBe(true);
    });

    it(`OLV recovers the known rotation within tolerance [${label}]`, () => {
      expect(rotAngleBetweenDeg(res.R, truth.R)).toBeLessThanOrEqual(tol.rotationToleranceDeg);
    });

    it(`OLV recovers the known translation within tolerance [${label}]`, () => {
      expect(transErrM(res.t, truth.t)).toBeLessThanOrEqual(tol.translationToleranceM);
    });

    it(`the residual RMS is within tolerance [${label}]`, () => {
      expect(res.rmse).toBeLessThanOrEqual(tol.rmsToleranceM);
    });

    it(`the triangulation verdict is PASS_TRUTH [${label}]`, () => {
      expect(verdict(res, truth, tol)).toBe('PASS_TRUTH');
    });
  }

  it('the two cases are genuinely different transforms (a fixed systematic error could not pass both)', () => {
    const a = truthOf(record.cases[0]);
    const b = truthOf(record.cases[1]);
    expect(rotAngleBetweenDeg(a.R, b.R)).toBeGreaterThan(1); // distinct rotations
    expect(transErrM(a.t, b.t)).toBeGreaterThan(1); // distinct translations
  });

  it('NEGATIVE CONTROL: a WRONG truth transform surfaces as OLV_DISAGREEMENT', () => {
    const c = record.cases[0];
    const { P, Q, truth } = cloudsOf(c);
    const res = recover(P, Q);
    // Poison the truth: rotate the reference rotation by a gross extra yaw.
    const wrongTruth: KnownTransform = { R: mul(rotZYX(30, 0, 0), truth.R), t: truth.t };
    expect(verdict(res, wrongTruth, tol)).toBe('OLV_DISAGREEMENT');
  });

  it('NEGATIVE CONTROL: a WRONG truth translation surfaces as OLV_DISAGREEMENT', () => {
    const c = record.cases[0];
    const { P, Q, truth } = cloudsOf(c);
    const res = recover(P, Q);
    const wrongTruth: KnownTransform = { R: truth.R, t: [truth.t[0] + 2, truth.t[1], truth.t[2]] };
    expect(verdict(res, wrongTruth, tol)).toBe('OLV_DISAGREEMENT');
  });

  it('NEGATIVE CONTROL: a grossly offset target pushes the residual past tolerance', () => {
    const c = record.cases[0];
    const { P, Q, truth } = cloudsOf(c);
    // Displace ONE half of Q by a large rigid-inconsistent offset so no single
    // transform fits: the achieved RMS must exceed the truth tolerance.
    const spoiled = Q.map((q, i): Vec3 => (i % 2 === 0 ? [q[0] + 3, q[1] - 2, q[2] + 1.5] : q));
    const res = recover(P, spoiled);
    expect(verdict(res, truth, tol)).toBe('OLV_DISAGREEMENT');
    expect(res.rmse).toBeGreaterThan(tol.rmsToleranceM);
  });
});
