/**
 * demSensitivity.ts
 *
 * The terrain sensitivity raster written beside the DEM on request: a two-band
 * Float32 GeoTIFF on exactly the DEM's grid, origin, cell size, CRS and NoData
 * mask.
 *
 *   band 1  sensitivity_range    highest minus lowest member height at the
 *                                cell, vertical unit
 *   band 2  sensitivity_members  members that produced a height at the cell
 *
 * The members are fixed by validation/protocols/evidencedem-sensitivity-ensemble-v1.md,
 * committed before any raster was computed:
 *
 *   0  the canonical configuration (the run that produced the DEM)
 *   1  ground filter slope 0.15
 *   2  ground filter slope 0.2
 *   3  inverse distance weighting void fill in place of the geodesic fill
 *
 * No member changes the cell size. The raster measures how much these choices
 * move the height at each cell. It says nothing about how close any height is
 * to the ground.
 *
 * Off by default: it costs three extra terrain runs. This module holds no
 * terrain code of its own; {@link runSensitivityEnsemble} takes the terrain
 * run as a function. demSensitivityRun.ts supplies the app's run.
 *
 * Pure data; deterministic.
 */

import { dtmRebuildFor, type DtmGrid } from '../ground/cellConfidence';
import type { TerrainCoreParams } from '../contour/analyseContours';
import { writeGeoTiff } from './demGeoTiff';
import { demWrittenMask } from './demEvidence';

/** Registered method id for this raster. */
export const TERRAIN_SENSITIVITY_METHOD_ID = 'olv.terrain.sensitivity.ensemble';

/** Band names in band order, as written to GDAL_METADATA. */
export const TERRAIN_SENSITIVITY_BANDS = ['sensitivity_range', 'sensitivity_members'] as const;

/** One pre-registered ensemble member: the overrides it applies to the canonical parameters. */
export interface SensitivityMember {
  readonly index: number;
  readonly label: string;
  /** Ground filter slope (rise/run), or undefined to keep the canonical value. */
  readonly slope?: number;
  /** Void-fill method, or undefined to keep the canonical one. */
  readonly interpolation?: 'idw';
}

/** The v1 ensemble. Member 0 is always the canonical configuration. */
export const SENSITIVITY_ENSEMBLE: readonly SensitivityMember[] = [
  { index: 0, label: 'canonical configuration' },
  { index: 1, label: 'ground filter slope 0.15', slope: 0.15 },
  { index: 2, label: 'ground filter slope 0.2', slope: 0.2 },
  { index: 3, label: 'inverse distance weighting void fill', interpolation: 'idw' },
];

/** The canonical parameters with one member's overrides applied. */
export function sensitivityMemberParams(base: TerrainCoreParams, member: SensitivityMember): TerrainCoreParams {
  let p: TerrainCoreParams = base;
  if (member.slope !== undefined) p = { ...p, ground: { ...(p.ground ?? {}), slope: member.slope } };
  if (member.interpolation !== undefined) p = { ...p, interpolation: member.interpolation };
  return p;
}

/** The grid fields a member contributes. */
export type SensitivityMemberGrid = Pick<DtmGrid, 'z' | 'coverage' | 'cols' | 'rows' | 'cellSizeM' | 'originH1' | 'originH2'>;

/** Thrown when a member's grid does not share member 0's geometry. */
export class SensitivityGridMismatchError extends Error {
  constructor(member: number) {
    super(
      `Sensitivity raster not written: ensemble member ${member} produced a grid with a different ` +
        'origin, cell size or size than the canonical run, so its heights cannot be compared cell by cell.',
    );
    this.name = 'SensitivityGridMismatchError';
  }
}

/** The band arrays, row-major on the DTM grid. NaN where no member produced a height. */
export interface TerrainSensitivityBands {
  readonly range: Float32Array;
  readonly members: Float32Array;
}

/**
 * Per-cell range and member count over the ensemble grids. `grids[0]` is the
 * canonical run. A member produced a height at a cell when its coverage is
 * non-zero and its height is finite.
 */
export function terrainSensitivityBands(grids: readonly SensitivityMemberGrid[]): TerrainSensitivityBands {
  if (grids.length === 0) throw new Error('terrainSensitivityBands: no member grids');
  const g0 = grids[0];
  const n = g0.cols * g0.rows;
  grids.forEach((g, k) => {
    if (
      g.cols !== g0.cols || g.rows !== g0.rows || g.cellSizeM !== g0.cellSizeM ||
      g.originH1 !== g0.originH1 || g.originH2 !== g0.originH2 ||
      g.z.length !== n || g.coverage.length !== n
    ) {
      throw new SensitivityGridMismatchError(k);
    }
  });
  const range = new Float32Array(n);
  const members = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    let count = 0;
    for (const g of grids) {
      const z = g.z[i];
      if (g.coverage[i] === 0 || !Number.isFinite(z)) continue;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
      count++;
    }
    range[i] = count > 0 ? hi - lo : NaN;
    members[i] = count;
  }
  return { range, members };
}

/** Georeference and NoData for the sensitivity raster: the DEM's own. */
export interface SensitivityGeoreference {
  readonly xllCorner: number;
  readonly yllCorner: number;
  readonly noData: number;
  readonly epsg: number | null;
  readonly isGeographic: boolean;
  /** Vertical unit label for band 1 ('m', 'ft', 'unknown', ...). */
  readonly verticalUnit: string;
  /** The DEM's written heights; a cell the DEM writes as NoData is NoData here too. */
  readonly demValues: ArrayLike<number>;
}

/** Write the two-band sensitivity GeoTIFF. `grids[0]` is the canonical run the DEM came from. */
export function writeTerrainSensitivityGeoTiff(
  grids: readonly SensitivityMemberGrid[],
  geo: SensitivityGeoreference,
): Uint8Array {
  const b = terrainSensitivityBands(grids);
  const g0 = grids[0];
  return writeGeoTiff({
    coverage: demWrittenMask(g0.coverage, geo.demValues),
    cols: g0.cols,
    rows: g0.rows,
    cellSize: g0.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    noData: geo.noData,
    epsg: geo.epsg,
    isGeographic: geo.isGeographic,
    bands: [
      { values: b.range, description: TERRAIN_SENSITIVITY_BANDS[0], unit: geo.verticalUnit },
      { values: b.members, description: TERRAIN_SENSITIVITY_BANDS[1], unit: 'members' },
    ],
  });
}

/** One terrain run: the DTM grid for these parameters. */
export type SensitivityTerrainRun = (params: TerrainCoreParams, signal?: AbortSignal) => Promise<SensitivityMemberGrid>;

/**
 * Run members 1 to 3 in order and return all four grids, member 0 first.
 * `canonical` is the grid the DEM was written from; it is not recomputed.
 * Checks the signal before each run and throws an AbortError when it is set,
 * so a cancelled request writes nothing.
 */
export async function runSensitivityEnsemble(
  canonical: SensitivityMemberGrid,
  baseParams: TerrainCoreParams,
  run: SensitivityTerrainRun,
  signal?: AbortSignal,
): Promise<SensitivityMemberGrid[]> {
  const grids: SensitivityMemberGrid[] = [canonical];
  for (const member of SENSITIVITY_ENSEMBLE.slice(1)) {
    if (signal?.aborted) throw aborted();
    grids.push(await run(sensitivityMemberParams(baseParams, member), signal));
  }
  if (signal?.aborted) throw aborted();
  // Refuse a mismatched member here, before any file is assembled.
  terrainSensitivityBands(grids);
  return grids;
}

/** Thrown when no rebuild was recorded for the DTM being exported. */
export class SensitivityRebuildMissingError extends Error {
  constructor() {
    super('the points behind this surface are no longer held; run the analysis again, then export');
    this.name = 'SensitivityRebuildMissingError';
  }
}

function aborted(): DOMException {
  return new DOMException('Sensitivity ensemble cancelled.', 'AbortError');
}

/**
 * Run the ensemble for a DTM the terrain core cache handed out, over the
 * points and canonical parameters recorded for it. `onMember(k, of)` is called
 * before member k (1 to 3) runs. When `signal` is set the wait on the current
 * member ends at once and an AbortError is thrown.
 */
export async function runDemSensitivity(
  dtm: SensitivityMemberGrid,
  onMember: (member: number, of: number) => void,
  signal?: AbortSignal,
): Promise<SensitivityMemberGrid[]> {
  const rebuild = dtmRebuildFor(dtm);
  if (!rebuild) throw new SensitivityRebuildMissingError();
  const of = SENSITIVITY_ENSEMBLE.length - 1;
  let member = 0;
  return runSensitivityEnsemble(dtm, rebuild.params, (params, s) => {
    onMember(++member, of);
    if (!s) return rebuild.run(params);
    return new Promise<SensitivityMemberGrid>((resolve, reject) => {
      const stop = (): void => reject(aborted());
      if (s.aborted) return stop();
      s.addEventListener('abort', stop, { once: true });
      rebuild.run(params).then(resolve, reject).finally(() => s.removeEventListener('abort', stop));
    });
  }, signal);
}

/** README lines describing the sensitivity raster. */
export function terrainSensitivityReadmeLines(filename: string, verticalUnit = 'unknown'): string[] {
  return [
    `Terrain sensitivity (${filename})`,
    `  Two Float32 bands on the same grid, origin, cell size, CRS and NoData`,
    `  cells as the DTM. The terrain model was run ${SENSITIVITY_ENSEMBLE.length} times over the same`,
    `  points, once per member of a fixed ensemble recorded before any result:`,
    ...SENSITIVITY_ENSEMBLE.map((m) => `    member ${m.index}  ${m.label}`),
    `  No member changes the cell size. The terrain analysis default slope is`,
    `  0.2, so member 2 repeats member 0 unless the analysis used another slope.`,
    `  When the analysis used the source ground classification, the slope has`,
    `  no effect and members 1 and 2 repeat member 0.`,
    `  Band 1 sensitivity_range    Highest minus lowest member height at the`,
    `                              cell, in ${verticalUnit}.`,
    `  Band 2 sensitivity_members  Members that produced a height at the cell.`,
    `  This is model sensitivity. A low value means the listed choices agree`,
    `  at the cell, not that the height there is correct.`,
    `  Method ${TERRAIN_SENSITIVITY_METHOD_ID}`,
    ``,
  ];
}
