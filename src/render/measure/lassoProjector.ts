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
