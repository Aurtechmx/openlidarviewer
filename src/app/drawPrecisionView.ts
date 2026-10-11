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
  return { modelView64, backend: viewer.activeBackend(), path: 'instanced-quad-highp' };
}
