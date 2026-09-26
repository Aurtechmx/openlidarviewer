/**
 * leaveLocalOut.ts
 *
 * Rebuild one measured DTM cell with the cell held out: the canonical
 * geodesic void fill run on the window of the cell and its in-grid
 * 8-neighbours, from the measured neighbours only, search radius one cell.
 * The export layer uses it for the reconstruction residual
 * (src/terrain/export/demAttention.ts); it lives here so the fill primitive
 * stays inside the ground core.
 *
 * Pure data; deterministic.
 */

import type { DtmGrid } from './cellConfidence';
import { geodesicFill } from './geodesicFill';

/** Grid fields the residual reads. */
export type ResidualGrid = Pick<DtmGrid, 'z' | 'counts' | 'cols' | 'rows'>;

/** Step lengths and vertical scale for the geodesic path cost (see GeodesicParams). */
export interface ResidualScale {
  readonly cellMetresX?: number;
  readonly cellMetresY?: number;
  readonly verticalUnitToMetres?: number;
}

export const isMeasuredCell = (g: ResidualGrid, i: number): boolean => g.counts[i] > 0 && Number.isFinite(g.z[i]);

/**
 * Rebuild one measured cell from its measured 8-neighbours by the canonical
 * geodesic fill on the window of the cell and its in-grid neighbours, search
 * radius one cell. NaN when no neighbour is measured.
 */
export function rebuildHeldOutCell(g: ResidualGrid, index: number, scale: ResidualScale = {}): number {
  const col = index % g.cols;
  const row = (index - col) / g.cols;
  const c0 = Math.max(0, col - 1);
  const c1 = Math.min(g.cols - 1, col + 1);
  const r0 = Math.max(0, row - 1);
  const r1 = Math.min(g.rows - 1, row + 1);
  const wc = c1 - c0 + 1;
  const wr = r1 - r0 + 1;
  const z = new Float32Array(wc * wr).fill(Number.NaN);
  const had = new Uint8Array(wc * wr);
  let any = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const j = r * g.cols + c;
      if (j === index || !isMeasuredCell(g, j)) continue;
      const w = (r - r0) * wc + (c - c0);
      z[w] = g.z[j];
      had[w] = 1;
      any = true;
    }
  }
  if (!any) return Number.NaN;
  const filled = geodesicFill(z, had, wc, wr, {
    maxRadiusCells: 1,
    cellMetresX: scale.cellMetresX,
    cellMetresY: scale.cellMetresY,
    verticalUnitToMetres: scale.verticalUnitToMetres,
  });
  return filled[(row - r0) * wc + (col - c0)];
}
