/**
 * demEvidence.ts
 *
 * The terrain evidence raster written beside the DEM: a six-band Float32
 * GeoTIFF on exactly the DEM's grid, origin, cell size, CRS and NoData mask.
 * Bands 1 to 3 are the ED-1 layout and keep their positions; bands 4 to 6 are
 * appended.
 *
 *   band 1  support_count             ground returns that landed in the cell
 *   band 2  interpolation_distance    8-connected steps to the nearest measured
 *                                     cell times the cell size, in the grid's
 *                                     horizontal unit (0 on a measured cell)
 *   band 3  cell_state                CELL_STATUS_CODE 1 to 4, extended with
 *                                     5 edgeAffected and 6 unresolved
 *   band 4  nearest_support_distance  straight-line distance from the cell
 *                                     centre to the nearest measured cell
 *                                     centre, horizontal unit
 *   band 5  vertical_dispersion       median absolute deviation of the cell's
 *                                     ground returns, vertical unit; NoData
 *                                     under two returns
 *   band 6  edge_distance             4-connected steps to the survey boundary
 *                                     times the cell size, horizontal unit
 *
 * Bands 1, 2 and the base state come from the DTM grid the DEM was written
 * from (`counts`, `interpDistanceCells`, `classifyCellStatus` with its default
 * parameters). Band 5 comes from the raster's per-cell returns
 * (`verticalDispersion`) and is NoData everywhere when the aggregation did not
 * keep them. Band 6 uses the boundary the boundary-share metric uses
 * (cellMetrics.ts): cells with no height, and measured cells on the grid edge
 * one step inside it.
 *
 * cell_state 5 and 6 (pre-registered, see EVIDENCE_STATE_PARAMS):
 *   6 unresolved    every covered cell when the vertical unit or the horizontal
 *                   CRS is unresolved; it takes precedence over every other code.
 *   5 edgeAffected  an interpolated cell (codes 2, 3) within
 *                   `edgeAffectedWithinCells` steps of the survey boundary.
 *                   edgeRisk (4) keeps precedence over it, and a measured cell
 *                   stays 1 (the state records provenance, as in
 *                   dtmCellStatus.ts), so codes 1 to 4 still agree with
 *                   Support.tif where 5 and 6 are not set.
 *
 * The bands describe how much measured ground stands behind each cell, not how
 * accurate its height is. All bands are Float32: GDAL opens a multi-band TIFF
 * only when every band shares one sample type.
 *
 * Pure data; deterministic.
 */

import type { DtmGrid } from '../ground/cellConfidence';
import { classifyCellStatus, CELL_STATUS_CODE } from '../quality/dtmCellStatus';
import { writeGeoTiff } from './demGeoTiff';

/** Registered method id for this raster. */
export const TERRAIN_EVIDENCE_METHOD_ID = 'olv.terrain.evidence.support';

/** Band names in band order, as written to GDAL_METADATA. */
export const TERRAIN_EVIDENCE_BANDS = [
  'support_count',
  'interpolation_distance',
  'cell_state',
  'nearest_support_distance',
  'vertical_dispersion',
  'edge_distance',
] as const;

/** cell_state codes beyond CELL_STATUS_CODE, written only to the evidence raster. */
export const EVIDENCE_STATE_CODE = {
  ...CELL_STATUS_CODE,
  edgeAffected: 5,
  unresolved: 6,
} as const;

/** Pre-registered parameters of the extended cell_state. */
export const EVIDENCE_STATE_PARAMS = {
  /**
   * An interpolated cell this many 4-connected steps or fewer from the survey
   * boundary is edgeAffected: the threshold the boundary-share metric counts
   * a cell as boundary-proximate at (cellMetrics.ts, edgeThresholdCells).
   */
  edgeAffectedWithinCells: 2,
} as const;

/** The grid fields the evidence bands are read from. */
export type EvidenceGrid = Pick<
  DtmGrid,
  'coverage' | 'confidence' | 'counts' | 'interpDistanceCells' | 'cols' | 'rows' | 'cellSizeM' | 'verticalDispersion'
>;

/** The band arrays, row-major on the DTM grid. */
export interface TerrainEvidenceBands {
  readonly supportCount: Float32Array;
  readonly interpolationDistance: Float32Array;
  readonly cellState: Uint8Array;
  readonly nearestSupportDistance: Float32Array;
  readonly verticalDispersion: Float32Array;
  readonly edgeDistance: Float32Array;
}

/** Frame facts the cell_state extension reads. */
export interface EvidenceFrame {
  /** False when the vertical unit or the horizontal CRS is unresolved: every covered cell is then code 6. */
  readonly frameResolved: boolean;
}

/**
 * True when the grid carries every per-cell array the bands need, each the
 * length of the grid. A hand-built grid without them gets no evidence raster.
 */
export function hasEvidenceArrays(dtm: Partial<EvidenceGrid>): dtm is EvidenceGrid {
  const n = (dtm.cols ?? 0) * (dtm.rows ?? 0);
  return (
    n > 0 &&
    dtm.coverage?.length === n &&
    dtm.confidence?.length === n &&
    dtm.counts?.length === n &&
    dtm.interpDistanceCells?.length === n
  );
}

/**
 * Squared Euclidean distance transform in cell units (Felzenszwalb and
 * Huttenlocher 2012), exact on integer offsets: for every cell, the squared
 * distance to the nearest cell whose `seed` is 1. Infinity when there is none.
 */
export function squaredDistanceToSeeds(seed: ArrayLike<number>, cols: number, rows: number): Float64Array {
  const n = cols * rows;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = seed[i] ? 0 : Infinity;
  const len = Math.max(cols, rows);
  const f = new Float64Array(len);
  const out = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  const pass = (count: number): void => {
    let k = 0;
    let first = -1;
    for (let q = 0; q < count; q++) {
      if (f[q] === Infinity) continue;
      if (first < 0) {
        first = q;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      let sInt = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sInt <= z[k]) {
        k--;
        sInt = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = sInt;
      z[k + 1] = Infinity;
    }
    if (first < 0) {
      for (let q = 0; q < count; q++) out[q] = Infinity;
      return;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      out[q] = dq * dq + f[v[k]];
    }
  };
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) f[r] = d[r * cols + c];
    pass(rows);
    for (let r = 0; r < rows; r++) d[r * cols + c] = out[r];
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) f[c] = d[r * cols + c];
    pass(cols);
    for (let c = 0; c < cols; c++) d[r * cols + c] = out[c];
  }
  return d;
}

/**
 * 4-connected steps from each covered cell to the survey boundary, the rule
 * cellMetrics.ts measures boundary share with: a cell with no height is at 0,
 * a measured cell on the grid edge at 1, and steps travel through covered
 * cells only. Infinity where no boundary is reachable; 0 on uncovered cells.
 */
export function edgeDistanceSteps(coverage: ArrayLike<number>, cols: number, rows: number): Float64Array {
  const n = cols * rows;
  const dist = new Float64Array(n).fill(Infinity);
  const queue = new Int32Array(n);
  let tail = 0;
  // Seeds at 0 enter the queue before seeds at 1, so the queue stays in
  // distance order and each cell enters it once, at its final distance.
  for (let i = 0; i < n; i++) {
    if (coverage[i] === 0) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (coverage[i] === 2 && (r === 0 || c === 0 || r === rows - 1 || c === cols - 1)) {
        dist[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const next = dist[i] + 1;
    const visit = (j: number): void => {
      if (coverage[j] !== 0 && next < dist[j]) {
        dist[j] = next;
        queue[tail++] = j;
      }
    };
    if (r > 0) visit(i - cols);
    if (r < rows - 1) visit(i + cols);
    if (c > 0) visit(i - 1);
    if (c < cols - 1) visit(i + 1);
  }
  return dist;
}

/**
 * Extend the base cell states with 5 edgeAffected and 6 unresolved (see the
 * file header for the rule and precedence).
 */
export function extendCellState(
  base: Uint8Array,
  coverage: ArrayLike<number>,
  edgeSteps: ArrayLike<number>,
  frame: EvidenceFrame,
): Uint8Array {
  const out = new Uint8Array(base.length);
  const within = EVIDENCE_STATE_PARAMS.edgeAffectedWithinCells;
  for (let i = 0; i < base.length; i++) {
    const s = base[i];
    if (coverage[i] === 0) out[i] = s;
    else if (!frame.frameResolved) out[i] = EVIDENCE_STATE_CODE.unresolved;
    else if ((s === CELL_STATUS_CODE.interpolated || s === CELL_STATUS_CODE.lowConfidence) && edgeSteps[i] <= within) {
      out[i] = EVIDENCE_STATE_CODE.edgeAffected;
    } else out[i] = s;
  }
  return out;
}

/** Compute the band arrays from a DTM grid. */
export function terrainEvidenceBands(
  dtm: EvidenceGrid,
  frame: EvidenceFrame = { frameResolved: true },
): TerrainEvidenceBands {
  const { cols, rows, cellSizeM } = dtm;
  const n = cols * rows;
  const supportCount = new Float32Array(n);
  const interpolationDistance = new Float32Array(n);
  const measured = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    supportCount[i] = dtm.counts[i];
    interpolationDistance[i] = dtm.interpDistanceCells[i] * cellSizeM;
    measured[i] = dtm.counts[i] > 0 ? 1 : 0;
  }
  const d2 = squaredDistanceToSeeds(measured, cols, rows);
  const nearestSupportDistance = new Float32Array(n);
  for (let i = 0; i < n; i++) nearestSupportDistance[i] = Math.sqrt(d2[i]) * cellSizeM;
  const disp = dtm.verticalDispersion?.length === n ? dtm.verticalDispersion : null;
  const verticalDispersion = new Float32Array(n).fill(Number.NaN);
  if (disp) {
    for (let i = 0; i < n; i++) if (dtm.counts[i] >= 2) verticalDispersion[i] = disp[i];
  }
  const steps = edgeDistanceSteps(dtm.coverage, cols, rows);
  const edgeDistance = new Float32Array(n);
  for (let i = 0; i < n; i++) edgeDistance[i] = steps[i] * cellSizeM;
  const cellState = extendCellState(classifyCellStatus(dtm as DtmGrid), dtm.coverage, steps, frame);
  return { supportCount, interpolationDistance, cellState, nearestSupportDistance, verticalDispersion, edgeDistance };
}

/** Georeferencing shared with the DEM rasters of the same package. */
export interface EvidenceGeoreference {
  readonly xllCorner: number;
  readonly yllCorner: number;
  readonly noData: number;
  readonly epsg: number | null;
  readonly isGeographic: boolean;
  /** Horizontal unit label for bands 2, 4 and 6 ('m', 'ft', 'degrees', ...). */
  readonly horizontalUnit: string;
  /** Vertical unit label for band 5 ('m', 'ft', 'unknown', ...). Default 'unknown'. */
  readonly verticalUnit?: string;
  /** False when the vertical unit or horizontal CRS is unresolved. Default true. */
  readonly frameResolved?: boolean;
  /**
   * The DEM's written heights. A cell the DEM writes as NoData (no coverage,
   * or a non-finite height) is NoData in every evidence band too.
   */
  readonly demValues: ArrayLike<number>;
}

/** The DEM writer's NoData rule as a mask: 1 where the DEM writes a height. */
export function demWrittenMask(coverage: ArrayLike<number>, demValues: ArrayLike<number>): Uint8Array {
  const mask = new Uint8Array(coverage.length);
  for (let i = 0; i < mask.length; i++) mask[i] = coverage[i] !== 0 && Number.isFinite(demValues[i]) ? 1 : 0;
  return mask;
}

/** Write the six-band evidence GeoTIFF. */
export function writeTerrainEvidenceGeoTiff(dtm: EvidenceGrid, geo: EvidenceGeoreference): Uint8Array {
  const b = terrainEvidenceBands(dtm, { frameResolved: geo.frameResolved ?? true });
  const h = geo.horizontalUnit;
  return writeGeoTiff({
    coverage: demWrittenMask(dtm.coverage, geo.demValues),
    cols: dtm.cols,
    rows: dtm.rows,
    cellSize: dtm.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    noData: geo.noData,
    epsg: geo.epsg,
    isGeographic: geo.isGeographic,
    bands: [
      { values: b.supportCount, description: TERRAIN_EVIDENCE_BANDS[0], unit: 'returns' },
      { values: b.interpolationDistance, description: TERRAIN_EVIDENCE_BANDS[1], unit: h },
      { values: b.cellState, description: TERRAIN_EVIDENCE_BANDS[2], unit: 'code' },
      { values: b.nearestSupportDistance, description: TERRAIN_EVIDENCE_BANDS[3], unit: h },
      { values: b.verticalDispersion, description: TERRAIN_EVIDENCE_BANDS[4], unit: geo.verticalUnit ?? 'unknown' },
      { values: b.edgeDistance, description: TERRAIN_EVIDENCE_BANDS[5], unit: h },
    ],
  });
}

/** README lines describing the evidence raster. */
export function terrainEvidenceReadmeLines(
  filename: string,
  horizontalUnit: string,
  verticalUnit = 'unknown',
  frameResolved = true,
): string[] {
  const within = EVIDENCE_STATE_PARAMS.edgeAffectedWithinCells;
  return [
    `Terrain evidence (${filename})`,
    `  Six Float32 bands on the same grid, origin, cell size, CRS and NoData`,
    `  cells as the DTM. They describe how much measured ground stands behind`,
    `  each cell. They do not describe how accurate a height is.`,
    `  Band 1 support_count             Ground returns that landed in the cell.`,
    `                                   0 on a cell filled from its neighbours.`,
    `  Band 2 interpolation_distance    Steps to the nearest cell with a ground`,
    `                                   return (8-connected) times the cell size,`,
    `                                   in ${horizontalUnit}. 0 on a measured cell.`,
    `  Band 3 cell_state                1 measured, 2 interpolated,`,
    `                                   3 low confidence (interpolated),`,
    `                                   4 edge risk (interpolated from 3 or more`,
    `                                   cells away), 5 edge affected (interpolated,`,
    `                                   ${within} or fewer steps from the survey`,
    `                                   boundary), 6 unresolved (the vertical unit`,
    `                                   or CRS is unresolved; set on every cell).`,
    `                                   Cells without a height are NoData.`,
    `  Band 4 nearest_support_distance  Straight-line distance from the cell centre`,
    `                                   to the nearest measured cell centre, in`,
    `                                   ${horizontalUnit}. 0 on a measured cell.`,
    `  Band 5 vertical_dispersion       Median absolute deviation of the cell's`,
    `                                   ground returns, in ${verticalUnit}. NoData`,
    `                                   where fewer than 2 returns landed. Spread`,
    `                                   of the returns, not an error of the height.`,
    `  Band 6 edge_distance             Steps to the survey boundary (4-connected)`,
    `                                   times the cell size, in ${horizontalUnit}.`,
    ...(frameResolved
      ? []
      : [`  The vertical unit or CRS of this package is unresolved, so every cell`, `  with a height has cell_state 6.`]),
    `  Method ${TERRAIN_EVIDENCE_METHOD_ID}`,
    ``,
  ];
}
