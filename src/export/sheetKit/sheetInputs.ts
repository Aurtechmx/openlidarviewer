/**
 * sheetInputs.ts: what a Light or Dark contour sheet takes from the terrain
 * analysis besides the contours: the analysed grid as relief, and the angle of
 * true north at the map centre. Loaded with the map sheet, never at startup.
 */
import type { SheetReliefInput } from './contourSheetModel';
import { trueNorthFromGridDeg } from './trueNorth';
import type { SheetStyle } from './tokens';

/** The fields of the analysed DTM grid a sheet reads. */
export interface SheetDtm {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
  readonly z: ArrayLike<number>;
  readonly coverage: ArrayLike<number>;
  readonly horizontalEpsg?: number | null;
}

/** The analysed grid as sheet relief, in the contour model's own frame. */
export function reliefFromDtm(d: SheetDtm): SheetReliefInput {
  return { cols: d.cols, rows: d.rows, cellSize: d.cellSizeM, originX: d.originH1, originY: d.originH2, z: d.z, coverage: d.coverage };
}

/**
 * Relief and true north for a map sheet in `style`. Classic reads neither, so
 * both are null for it. True north needs the world origin (the map centre in
 * CRS coordinates) and a CRS with a projection definition here; otherwise null,
 * and the sheet draws grid north.
 */
export function styledSheetInputs(
  style: SheetStyle,
  dtm: SheetDtm,
  bbox: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null,
  worldOrigin: { readonly x: number; readonly y: number } | null,
): { relief: SheetReliefInput | null; trueNorth: { convergenceDeg: number } | null } {
  if (style === 'classic') return { relief: null, trueNorth: null };
  let trueNorth: { convergenceDeg: number } | null = null;
  if (bbox && worldOrigin) {
    const deg = trueNorthFromGridDeg(dtm.horizontalEpsg ?? null, (bbox.minX + bbox.maxX) / 2 + worldOrigin.x, (bbox.minY + bbox.maxY) / 2 + worldOrigin.y);
    if (deg != null) trueNorth = { convergenceDeg: deg };
  }
  return { relief: reliefFromDtm(dtm), trueNorth };
}
