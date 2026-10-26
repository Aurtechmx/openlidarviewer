/**
 * lassoProjector.ts — the camera projection a lasso selection is decided by.
 *
 * The Viewer owns the camera; this owns what the camera means for a point. It
 * takes the two matrices as plain arrays, in the column-major order three.js
 * stores them, so the projection the selection depends on can be exercised in
 * Node against hand-written matrices rather than only through a WebGL context.
 *
 * The clip test is unchanged from the inline projector this replaces: a point
 * outside the near/far planes returns null and takes no part in the selection.
 * Points outside the viewport laterally are NOT rejected here — the lasso
 * polygon rejects them, and rejecting them twice would differ at the edge.
 *
 * The depth reported is distance along the camera's view axis in the cloud's
 * own linear units, taken BEFORE the projection matrix. A normalised device
 * depth would be cheaper to reach but is non-linear under perspective, so a
 * fixed depth difference near the camera and the same difference far from it
 * would not compare, and the occlusion tolerance is a length.
 */

import type { ScreenProjector } from './lassoVolume';

/** A 4×4 matrix in three.js `Matrix4.elements` order (column-major). */
export type Matrix4Elements = ArrayLike<number>;

/**
 * Build the world-to-screen projector for a camera and a viewport in CSS
 * pixels. The returned function allocates nothing per call beyond its result
 * object; the matrices are read once and closed over.
 */
export function makeLassoProjector(
  viewMatrix: Matrix4Elements,
  projectionMatrix: Matrix4Elements,
  width: number,
  height: number,
): ScreenProjector {
  const v = viewMatrix;
  const p = projectionMatrix;
  return (x: number, y: number, z: number) => {
    // World → view. Column-major: element (row r, col c) is at c * 4 + r.
    const vw = v[3] * x + v[7] * y + v[11] * z + v[15];
    const iw = vw === 0 ? 1 : 1 / vw;
    const vx = (v[0] * x + v[4] * y + v[8] * z + v[12]) * iw;
    const vy = (v[1] * x + v[5] * y + v[9] * z + v[13]) * iw;
    const vz = (v[2] * x + v[6] * y + v[10] * z + v[14]) * iw;
    // View → clip → NDC.
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    const ciw = cw === 0 ? 1 : 1 / cw;
    const nz = (p[2] * vx + p[6] * vy + p[10] * vz + p[14]) * ciw;
    if (nz < -1 || nz > 1) return null;
    const nx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) * ciw;
    const ny = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) * ciw;
    // The camera looks down its own -Z, so view-axis distance is -vz.
    return { x: (nx * 0.5 + 0.5) * width, y: (1 - (ny * 0.5 + 0.5)) * height, depth: -vz };
  };
}

/**
 * Screen pixel → the world point where its camera ray meets the horizontal
 * plane `dot(p, up) = height`, or null when the ray runs parallel to the plane
 * or meets it behind the camera.
 */
export type LassoUnprojector = (sx: number, sy: number, height: number) => [number, number, number] | null;

/**
 * Build the inverse of {@link makeLassoProjector}: casts the ray through a
 * screen pixel and intersects it with a horizontal plane. This is how a drawn
 * lasso becomes a map footprint for the volume — the lasso projected onto the
 * plane its reference height sits on.
 *
 * @param cameraWorld - the camera's world matrix (inverse of the view matrix).
 * @param projectionInverse - the inverse projection matrix.
 * @param up - world up; the plane's normal.
 */
export function makeLassoUnprojector(
  cameraWorld: Matrix4Elements,
  projectionInverse: Matrix4Elements,
  width: number,
  height: number,
  up: readonly [number, number, number] = [0, 0, 1],
): LassoUnprojector {
  const w = cameraWorld;
  const pi = projectionInverse;
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  const ux = up[0] / ul, uy = up[1] / ul, uz = up[2] / ul;
  const toWorld = (nx: number, ny: number, nz: number): [number, number, number] => {
    // NDC → view (homogeneous divide), then view → world.
    const vwh = pi[3] * nx + pi[7] * ny + pi[11] * nz + pi[15];
    const iw = vwh === 0 ? 1 : 1 / vwh;
    const vx = (pi[0] * nx + pi[4] * ny + pi[8] * nz + pi[12]) * iw;
    const vy = (pi[1] * nx + pi[5] * ny + pi[9] * nz + pi[13]) * iw;
    const vz = (pi[2] * nx + pi[6] * ny + pi[10] * nz + pi[14]) * iw;
    return [
      w[0] * vx + w[4] * vy + w[8] * vz + w[12],
      w[1] * vx + w[5] * vy + w[9] * vz + w[13],
      w[2] * vx + w[6] * vy + w[10] * vz + w[14],
    ];
  };
  return (sx, sy, h) => {
    const nx = (sx / width) * 2 - 1;
    const ny = 1 - (sy / height) * 2;
    const a = toWorld(nx, ny, -1);
    const b = toWorld(nx, ny, 1);
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const denom = dx * ux + dy * uy + dz * uz;
    if (!(Math.abs(denom) > 1e-12)) return null;
    const t = (h - (a[0] * ux + a[1] * uy + a[2] * uz)) / denom;
    if (!(t >= 0) || !Number.isFinite(t)) return null;
    return [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t];
  };
}

/**
 * How far the camera ray through screen point (sx, sy) leans from straight
 * down, in degrees, read from `unproject` at two plane heights one unit
 * apart: the hit moves tan(angle) across the plane. Undefined when either
 * ray misses the plane.
 */
export function viewOffNadirDeg(
  unproject: LassoUnprojector,
  sx: number,
  sy: number,
  height: number,
  up: readonly [number, number, number],
): number | undefined {
  const a = unproject(sx, sy, height);
  const b = unproject(sx, sy, height + 1);
  if (!a || !b) return undefined;
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / ul;
  const h = Math.hypot(d[0] - (v * up[0]) / ul, d[1] - (v * up[1]) / ul, d[2] - (v * up[2]) / ul);
  const deg = (Math.atan2(h, Math.abs(v)) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : undefined;
}
