/**
 * demEvidence.ts
 *
 * The terrain evidence raster written beside the DEM: a three-band Float32
 * GeoTIFF on exactly the DEM's grid, origin, cell size, CRS and NoData mask.
 *
 *   band 1  support_count           ground returns that landed in the cell
 *   band 2  interpolation_distance  8-connected steps to the nearest measured
 *                                   cell times the cell size, in the grid's
 *                                   horizontal unit (0 on a measured cell)
 *   band 3  cell_state              CELL_STATUS_CODE: 1 measured,
 *                                   2 interpolated, 3 lowConfidence, 4 edgeRisk
 *
 * Every value comes from the DTM grid the DEM was written from: `counts`,
 * `interpDistanceCells`, and `classifyCellStatus` with its default parameters
 * (the same call the analysis tallies its cell states with). Cells the DEM
 * writes as NoData are NoData in every band, so `empty` (code 0) never appears.
 *
 * The grid has one cell size for both axes, so band 2 is the same distance
 * along either axis. The bands describe how much measured ground stands behind
 * each cell, not how accurate its height is.
 *
 * All three bands are Float32: GDAL opens a multi-band TIFF only when every
 * band shares one sample type. Counts up to 2^24 and the state codes are exact
 * in Float32.
 *
 * Pure data; deterministic.
 */

import type { DtmGrid } from '../ground/cellConfidence';
import { classifyCellStatus } from '../quality/dtmCellStatus';
import { writeGeoTiff } from './demGeoTiff';

/** Registered method id for this raster. */
export const TERRAIN_EVIDENCE_METHOD_ID = 'olv.terrain.evidence.support';

/** Band names in band order, as written to GDAL_METADATA. */
export const TERRAIN_EVIDENCE_BANDS = ['support_count', 'interpolation_distance', 'cell_state'] as const;

/** The grid fields the evidence bands are read from. */
export type EvidenceGrid = Pick<
  DtmGrid,
  'coverage' | 'confidence' | 'counts' | 'interpDistanceCells' | 'cols' | 'rows' | 'cellSizeM'
>;

/** The three band arrays, row-major on the DTM grid. */
export interface TerrainEvidenceBands {
  readonly supportCount: Float32Array;
  readonly interpolationDistance: Float32Array;
  readonly cellState: Uint8Array;
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

/** Compute the three band arrays from a DTM grid. */
export function terrainEvidenceBands(dtm: EvidenceGrid): TerrainEvidenceBands {
  const n = dtm.cols * dtm.rows;
  const supportCount = new Float32Array(n);
  const interpolationDistance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    supportCount[i] = dtm.counts[i];
    interpolationDistance[i] = dtm.interpDistanceCells[i] * dtm.cellSizeM;
  }
  const cellState = classifyCellStatus(dtm as DtmGrid);
  return { supportCount, interpolationDistance, cellState };
}

/** Georeferencing shared with the DEM rasters of the same package. */
export interface EvidenceGeoreference {
  readonly xllCorner: number;
  readonly yllCorner: number;
  readonly noData: number;
  readonly epsg: number | null;
  readonly isGeographic: boolean;
  /** Horizontal unit label for band 2 ('m', 'ft', 'degrees', ...). */
  readonly horizontalUnit: string;
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

/** Write the three-band evidence GeoTIFF. */
export function writeTerrainEvidenceGeoTiff(dtm: EvidenceGrid, geo: EvidenceGeoreference): Uint8Array {
  const b = terrainEvidenceBands(dtm);
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
      { values: b.interpolationDistance, description: TERRAIN_EVIDENCE_BANDS[1], unit: geo.horizontalUnit },
      { values: b.cellState, description: TERRAIN_EVIDENCE_BANDS[2], unit: 'code' },
    ],
  });
}

/** README lines describing the evidence raster. */
export function terrainEvidenceReadmeLines(filename: string, horizontalUnit: string): string[] {
  return [
    `Terrain evidence (${filename})`,
    `  Three Float32 bands on the same grid, origin, cell size, CRS and NoData`,
    `  cells as the DTM. They describe how much measured ground stands behind`,
    `  each cell. They do not describe how accurate a height is.`,
    `  Band 1 support_count           Ground returns that landed in the cell.`,
    `                                 0 on a cell filled from its neighbours.`,
    `  Band 2 interpolation_distance  Steps to the nearest cell with a ground`,
    `                                 return (8-connected) times the cell size,`,
    `                                 in ${horizontalUnit}. 0 on a measured cell.`,
    `  Band 3 cell_state              1 measured, 2 interpolated,`,
    `                                 3 low confidence (interpolated),`,
    `                                 4 edge risk (interpolated from 3 or more`,
    `                                 cells away). Cells without a height are`,
    `                                 NoData, not a state.`,
    `  Method ${TERRAIN_EVIDENCE_METHOD_ID}`,
    ``,
  ];
}
