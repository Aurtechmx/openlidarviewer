/**
 * areaValidity.ts
 *
 * The one verdict on whether a picked 3D ring establishes an area. Every
 * surface that reports an Area figure (commit, session import, the live
 * headline, chain totals and each export) asks this module, so a ring that
 * crosses itself, collapses, repeats a vertex or holds a non-finite vertex can
 * never reach a plausible area number.
 *
 * Method. The ring is projected onto its own best-fit plane (the eigenvector
 * of the smallest covariance eigenvalue, so a vertical wall or a tilted plane
 * is judged in its own plane and never in XY), then `validatePolygon` runs on
 * the projected ring. Coordinates are taken relative to the first vertex before
 * any arithmetic, so the verdict does not depend on the ring's offset.
 *
 * Non-planar rings. A ring whose vertices sit within `NON_PLANAR_RATIO` of the
 * plane (out-of-plane spread over in-plane extent) is judged on its plane
 * projection and reports a plane area, which is a lower bound on a draped
 * surface. A ring that deviates more than that is refused: a plane area would
 * not describe it.
 */

import type { Vec3 } from '../navMath';
import { describeValidity, validatePolygon, type PolygonValidity, type Vec2Like } from './polygonHygiene';

/** Out-of-plane spread over in-plane extent beyond which a ring is refused. */
export const NON_PLANAR_RATIO = 0.25;

export type AreaRingReason = Exclude<PolygonValidity, 'ok'> | 'non-planar';

export type AreaRingVerdict =
  | { readonly ok: true; readonly planarityRatio: number }
  | { readonly ok: false; readonly reason: AreaRingReason; readonly text: string };

const NON_PLANAR_TEXT =
  'Polygon vertices are not close to one plane, so a plane area would not describe it.';

function refuse(reason: AreaRingReason): AreaRingVerdict {
  return {
    ok: false,
    reason,
    text: reason === 'non-planar' ? NON_PLANAR_TEXT : describeValidity(reason),
  };
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 (cyclic Jacobi). */
function smallestEigenvector(c: number[][]): Vec3 {
  const a = c.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    const diag = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]);
    if (off <= 1e-15 * diag || off === 0) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = cs * vkp - sn * vkq;
          v[k][q] = sn * vkp + cs * vkq;
        }
      }
    }
  }
  let m = 0;
  if (a[1][1] < a[m][m]) m = 1;
  if (a[2][2] < a[m][m]) m = 2;
  return [v[0][m], v[1][m], v[2][m]];
}

/** Drop consecutive duplicate vertices and a trailing copy of the first. */
function collapseRepeats(points: ReadonlyArray<Vec3>): ReadonlyArray<Vec3> {
  const same = (a: Vec3, b: Vec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const out: Vec3[] = [];
  for (const p of points) if (out.length === 0 || !same(out[out.length - 1], p)) out.push(p);
  if (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  return out;
}

/**
 * Whether the ring establishes an area. The verdict is the same for any
 * rigid placement of the ring and for either winding.
 */
export function areaRingVerdict(points: ReadonlyArray<Vec3>): AreaRingVerdict {
  if (points.length < 3) return refuse('too-few-vertices');
  for (const p of points) {
    if (typeof p[0] !== 'number' || typeof p[1] !== 'number' || typeof p[2] !== 'number' ||
        !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      return refuse('non-finite-vertex');
    }
  }
  // Work relative to the first vertex, then the centroid of those offsets.
  // Consecutive duplicate vertices (a double click) and an explicit closing
  // vertex add no area, so they are collapsed; a vertex repeated elsewhere
  // pinches the ring and is caught as a self-touch below.
  const o = points[0];
  const q = collapseRepeats(points).map((p): Vec3 => [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
  if (q.length < 3) return refuse('zero-area');
  const n = q.length;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const p of q) {
    mx += p[0];
    my += p[1];
    mz += p[2];
  }
  mx /= n;
  my /= n;
  mz /= n;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of q) {
    const d = [p[0] - mx, p[1] - my, p[2] - mz];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const normal = smallestEigenvector(cov);
  // In-plane basis: u is the world axis least aligned with the normal, made
  // orthogonal to it; w completes the frame.
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  const seed: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const dp = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2];
  let u: Vec3 = [seed[0] - dp * normal[0], seed[1] - dp * normal[1], seed[2] - dp * normal[2]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const w: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  const flat: Vec2Like[] = [];
  let maxOut = 0;
  let extent = 0;
  for (const p of q) {
    const d: Vec3 = [p[0] - mx, p[1] - my, p[2] - mz];
    const x = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    const y = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
    const out = Math.abs(d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]);
    if (out > maxOut) maxOut = out;
    if (Math.abs(x) > extent) extent = Math.abs(x);
    if (Math.abs(y) > extent) extent = Math.abs(y);
    flat.push({ x, y });
  }
  const verdict = validatePolygon(flat);
  if (verdict.validity !== 'ok') return refuse(verdict.validity);
  const planarityRatio = extent > 0 ? maxOut / extent : 0;
  if (planarityRatio > NON_PLANAR_RATIO) return refuse('non-planar');
  return { ok: true, planarityRatio };
}

/** The stated reason an Area ring reports no area, or undefined when it does. */
export function areaWithheldReason(points: ReadonlyArray<Vec3>): string | undefined {
  const v = areaRingVerdict(points);
  return v.ok ? undefined : v.text;
}
