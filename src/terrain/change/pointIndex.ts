/**
 * pointIndex.ts
 *
 * A uniform grid over a fixed point set, for exact nearest-neighbour queries.
 * Built once per registration and queried once per source point per
 * iteration, in place of the scan over every target the solver made before.
 *
 * The answer is the same one that scan gave: the target with the smallest
 * squared distance, and among exact ties the lowest index. Cells are visited
 * as shells of growing Chebyshev distance around the query's cell, and the
 * search stops once the best distance is within the ring of cells already
 * seen, so no unvisited cell can hold a closer point. A query outside the
 * grid works the same way from its projection onto the grid.
 *
 * Pure: no three.js, no DOM.
 */

import type { Vec3 } from './icpRegister';

/** Cells per axis are capped so a degenerate extent cannot ask for a huge grid. */
const MAX_CELLS_PER_AXIS = 128;

export interface PointIndex {
  /** Point coordinates, packed by cell: x, y, z for slot `s` at `3s`. */
  readonly xyz: Float64Array;
  /** Original index of the point in slot `s`; ascending within a cell. */
  readonly slotIndex: Int32Array;
  /** Slot range of cell `c` is `[cellStart[c], cellStart[c + 1])`. */
  readonly cellStart: Uint32Array;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly cell: number;
  readonly dimX: number;
  readonly dimY: number;
  readonly dimZ: number;
}

/** Build the grid over `points`. Every point must be finite. */
export function buildPointIndex(points: readonly Vec3[]): PointIndex {
  const n = points.length;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  if (n === 0) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
  const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
  // Cell size from the extents that are not flat, aiming at about two points
  // per cell; a flat axis gets one cell.
  let product = 1;
  let axes = 0;
  for (const e of [ex, ey, ez]) if (e > 0) { product *= e; axes++; }
  const cell = axes === 0 ? 1 : Math.max(1e-12, Math.pow(product / Math.max(1, n / 2), 1 / axes));
  const dimOf = (e: number): number => (e > 0 ? Math.min(MAX_CELLS_PER_AXIS, Math.ceil(e / cell)) : 1);
  const dimX = dimOf(ex), dimY = dimOf(ey), dimZ = dimOf(ez);
  const cells = dimX * dimY * dimZ;

  const cellOf = new Int32Array(n);
  const cellStart = new Uint32Array(cells + 1);
  const clampCell = (v: number, min: number, dim: number): number => {
    const c = Math.floor((v - min) / cell);
    return c < 0 ? 0 : c >= dim ? dim - 1 : c;
  };
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const c = (clampCell(p[2], minZ, dimZ) * dimY + clampCell(p[1], minY, dimY)) * dimX + clampCell(p[0], minX, dimX);
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
  const cursor = cellStart.slice(0, cells);
  const xyz = new Float64Array(3 * n);
  const slotIndex = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = cursor[cellOf[i]]++;
    const p = points[i];
    xyz[3 * s] = p[0];
    xyz[3 * s + 1] = p[1];
    xyz[3 * s + 2] = p[2];
    slotIndex[s] = i;
  }
  return { xyz, slotIndex, cellStart, minX, minY, minZ, cell, dimX, dimY, dimZ };
}

/** The squared distance of the last {@link nearestPoint} answer. */
export const nearestState = { d2: Infinity };

/**
 * Index of the point nearest to (x, y, z); the lowest index among exact ties.
 * Returns -1 for an empty index. The squared distance is left in
 * {@link nearestState} so the call allocates nothing.
 */
export function nearestPoint(index: PointIndex, x: number, y: number, z: number): number {
  const { xyz, slotIndex, cellStart, cell, dimX, dimY, dimZ } = index;
  let best = -1;
  let bestD2 = Infinity;
  if (slotIndex.length === 0) { nearestState.d2 = bestD2; return best; }

  const qx = Math.floor((x - index.minX) / cell);
  const qy = Math.floor((y - index.minY) / cell);
  const qz = Math.floor((z - index.minZ) / cell);
  const kMax = Math.max(qx, dimX - 1 - qx, qy, dimY - 1 - qy, qz, dimZ - 1 - qz);

  const scanCell = (cx: number, cy: number, cz: number): void => {
    const c = (cz * dimY + cy) * dimX + cx;
    for (let s = cellStart[c], end = cellStart[c + 1]; s < end; s++) {
      const dx = x - xyz[3 * s], dy = y - xyz[3 * s + 1], dz = z - xyz[3 * s + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const i = slotIndex[s];
      if (d2 < bestD2 || (d2 === bestD2 && i < best)) { bestD2 = d2; best = i; }
    }
  };
  const scanRow = (cy: number, cz: number, x0: number, x1: number): void => {
    for (let cx = x0; cx <= x1; cx++) scanCell(cx, cy, cz);
  };

  for (let k = 0; k <= kMax; k++) {
    // Every cell at Chebyshev distance exactly k from (qx, qy, qz), clamped
    // to the grid: full slabs at z = qz ± k, and on the slabs between them the
    // rows y = qy ± k plus the two columns x = qx ± k.
    const x0 = Math.max(0, qx - k), x1 = Math.min(dimX - 1, qx + k);
    const y0 = Math.max(0, qy - k), y1 = Math.min(dimY - 1, qy + k);
    const z0 = Math.max(0, qz - k), z1 = Math.min(dimZ - 1, qz + k);
    if (x0 <= x1 && y0 <= y1) {
      for (let cz = z0; cz <= z1; cz++) {
        if (cz === qz - k || cz === qz + k) {
          for (let cy = y0; cy <= y1; cy++) scanRow(cy, cz, x0, x1);
          continue;
        }
        if (qy - k >= 0) scanRow(qy - k, cz, x0, x1);
        if (k > 0 && qy + k < dimY) scanRow(qy + k, cz, x0, x1);
        const yi0 = Math.max(y0, qy - k + 1), yi1 = Math.min(y1, qy + k - 1);
        for (let cy = yi0; cy <= yi1; cy++) {
          if (qx - k >= 0) scanCell(qx - k, cy, cz);
          if (k > 0 && qx + k < dimX) scanCell(qx + k, cy, cz);
        }
      }
    }
    // Nothing outside the scanned shells is nearer than k whole cells.
    const reach = k * cell;
    if (bestD2 <= reach * reach) break;
  }
  nearestState.d2 = bestD2;
  return best;
}
