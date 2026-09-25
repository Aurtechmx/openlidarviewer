/**
 * observatoryOverlayGeometry.ts — pure line-segment buffers for the
 * Observatory's shadow-voxel overlay (`ObservatoryOverlay.ts`).
 *
 * PRESENTATION, NOT SCIENCE, same split `flowOverlayGeometry.ts` and
 * `ContourOverlay.ts`'s own geometry helpers make: this only turns already-
 * decided voxel keys into a wireframe-box vertex buffer. It never decides
 * which voxels are `SHADOWED` — that is `classifyObservationField`'s call,
 * made once in `observatoryFromCloud.ts` and never re-derived here.
 *
 * Capped at `MAX_BOXES` voxels: a wireframe per voxel of a fine grid is a lot
 * of geometry for very little signal once the shadow region is large, and
 * SPEC's own wording rules ban implying "every shadowed voxel is drawn" — the
 * overlay is a sample, and the panel's own count is the true total.
 */
import { unpackVoxelKey } from '../observation/ledger';

export const MAX_SHADOW_OVERLAY_BOXES = 4000;

const BOX_EDGES: readonly (readonly [number, number, number])[][] = (() => {
  // 12 edges of a unit cube, as pairs of corner indices, expanded below.
  const corners: readonly (readonly [number, number, number])[] = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const edgeIndexPairs: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return edgeIndexPairs.map(([a, b]) => [corners[a]!, corners[b]!]);
})();

/**
 * A `Float32Array` of `[x0,y0,z0,x1,y1,z1, ...]` line-segment vertices, one
 * wireframe box per key in `keys` (capped at {@link MAX_SHADOW_OVERLAY_BOXES},
 * first-encountered order — the caller decides what "first" means, e.g. by
 * pre-sorting for determinism in a test), each box `voxelEdge` wide, centred
 * on its voxel and offset by `domainMin` — the SAME world/local frame
 * `ObservationDomain.min` already uses (`docs/coordinate-precision.md`).
 */
export function buildShadowWireframeBuffer(
  keys: readonly number[],
  grid: { readonly nx: number; readonly ny: number },
  voxelEdge: number,
  domainMin: readonly [number, number, number],
): Float32Array {
  const capped = keys.slice(0, MAX_SHADOW_OVERLAY_BOXES);
  const verts = new Float32Array(capped.length * BOX_EDGES.length * 2 * 3);
  let w = 0;
  for (const key of capped) {
    const { ix, iy, iz } = unpackVoxelKey(key, grid.nx, grid.ny);
    const ox = domainMin[0] + ix * voxelEdge;
    const oy = domainMin[1] + iy * voxelEdge;
    const oz = domainMin[2] + iz * voxelEdge;
    for (const [c0, c1] of BOX_EDGES) {
      verts[w++] = ox + c0[0] * voxelEdge;
      verts[w++] = oy + c0[1] * voxelEdge;
      verts[w++] = oz + c0[2] * voxelEdge;
      verts[w++] = ox + c1[0] * voxelEdge;
      verts[w++] = oy + c1[1] * voxelEdge;
      verts[w++] = oz + c1[2] * voxelEdge;
    }
  }
  return verts;
}
