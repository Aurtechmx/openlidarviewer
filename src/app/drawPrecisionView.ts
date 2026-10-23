/**
 * drawPrecisionView.ts: read the active static cloud's draw off the viewer for
 * the per-draw precision bound (`science/drawPrecision.ts`).
 *
 * A static cloud is drawn by `Viewer.buildPointMesh` (instanced quad,
 * `PointsNodeMaterial`, Float32 local centres relative to `sourceOrigin`) on a
 * renderer created with `highPrecision = true`, so its path is
 * `instanced-quad-highp`; docs/architecture/draw-precision-contract.md has the
 * evidence. The model-view is composed exactly as three.js composes the
 * uniform it uploads: camera.matrixWorldInverse × mesh.matrixWorld in binary64.
 *
 * Streaming (COPC/EPT) scans have their own report path and are not evaluated.
 */

import type { PointCloud } from '../model/PointCloud';
import type { DrawPrecisionView } from '../science/drawPrecision';

/** The viewer surface this reader needs. */
export interface DrawPrecisionViewer {
  activeBackend(): 'webgpu' | 'webgl2';
  cloudModelView64(id: string): Float64Array | null;
  getCloud(id: string): PointCloud | undefined;
}

/** How far an affine model-view's bottom row may sit from (0, 0, 0, 1) and still be rounding. */
const AFFINE_ROW_SLACK = 1e-12;

/**
 * The model-view with its bottom row read as exactly (0, 0, 0, 1) when it is
 * within rounding of it. three.js inverts the camera matrix in floating point,
 * so an affine camera's inverse can carry a bottom row such as
 * (1e-17, 0, 0, 0.9999999999999999). That row sets only w, which the
 * eye-space position does not use, and the checker refuses any matrix whose
 * row is not exact. A row further off is left as it is, for the checker to refuse.
 */
export function withExactAffineRow(m: Float64Array): Float64Array {
  // Column-major: the bottom row is elements 3, 7, 11 and 15.
  const near = Math.abs(m[3]) <= AFFINE_ROW_SLACK && Math.abs(m[7]) <= AFFINE_ROW_SLACK
    && Math.abs(m[11]) <= AFFINE_ROW_SLACK && Math.abs(m[15] - 1) <= AFFINE_ROW_SLACK;
  if (!near) return m;
  const out = Float64Array.from(m);
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

/**
 * The draw of cloud `id` at the current camera, or undefined when it cannot be
 * read (no id, or `cloud` is not the cloud the viewer draws under that id).
 */
export function drawPrecisionViewFor(
  viewer: DrawPrecisionViewer,
  id: string | null,
  cloud: PointCloud,
): DrawPrecisionView | undefined {
  if (!id || viewer.getCloud(id) !== cloud) return undefined;
  const modelView64 = viewer.cloudModelView64(id);
  if (!modelView64) return undefined;
  return { modelView64: withExactAffineRow(modelView64), backend: viewer.activeBackend(), path: 'instanced-quad-highp' };
}
