/**
 * tests/support/demPackageDriver.ts — build the full DEM package for one
 * committed terrain-field crop and write it out, with the records the three
 * independent Python readers check its code rasters against.
 *
 * `npm run dem:package -- <crop> <outdir>` reaches this through
 * tests/demPackageDriver.test.ts: the builders are TypeScript modules with
 * extensionless imports, which Node cannot load directly, so the entry point
 * runs them through vitest the way validation:matrix:update does. Nothing here
 * recomputes a product: the terrain core, the sensitivity ensemble, the
 * package assembly and the readers' records all come from the modules the
 * application and the tests already use.
 *
 * Output layout under `<outdir>`:
 *   <crop>-dem-package.zip          the package as the export dialog writes it
 *   package/                        every entry of the ZIP, extracted
 *   oracle/terrain-evidence/        terrain_evidence.tif + expected.json
 *   oracle/terrain-attention/       terrain_attention.tif + expected.json
 *   oracle/terrain-sensitivity/     terrain_sensitivity.tif + expected.json
 *   driver.json                     what was built, from which crop, with digests
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { analyseContours, computeTerrainCore, type AnalyseContoursParams } from '../../src/terrain/contour/analyseContours';
import { assembleDemPackage } from '../../src/terrain/export/demPackage';
import { runSensitivityEnsemble } from '../../src/terrain/export/demSensitivity';
import { buildZip } from '../../src/convert/zipStore';
import { sha256Hex } from '../../src/terrain/export/sha256';
import { TERRAIN_METRIC_VERSION } from '../../src/terrain/datasetIntelligence';
import type { TerrainPoint } from '../../src/terrain/TerrainContracts';
import { ASPRS_GROUND_CLASS } from '../../src/terrain/ground/liveDtmConstants';
import { attentionExpectedJson, evidenceExpectedJson, sensitivityExpectedJson } from './demOracleFixtures';
import {
  DIR as TERRAIN_FIELD_DIR,
  hasEstonia,
  hasStreamLab,
  hasWhiteSands,
  readEstoniaGround,
  readWhiteSandsGround,
  streamLabGround,
} from './terrainField';

/** A committed crop the driver can build: its ground points and the frame the datasets manifest records. */
interface CropSource {
  readonly cropId: string;
  readonly present: () => boolean;
  readonly points: () => TerrainPoint[];
  readonly crs: string;
  readonly horizontalEpsg: number;
  readonly verticalDatum: string;
  readonly verticalEpsg: number | null;
}

/**
 * The crops, with the frames validation/terrain-field/datasets/manifest.json
 * records for their sources. Estonia's EH2000 height system is named and left
 * without a code, as the manifest leaves it.
 */
export const CROPS: readonly CropSource[] = [
  { cropId: 'sl-field', present: hasStreamLab, points: streamLabGround, crs: 'EPSG:6346', horizontalEpsg: 6346, verticalDatum: 'NAVD88 height (EPSG:5703)', verticalEpsg: 5703 },
  { cropId: 'whitesands-dune', present: hasWhiteSands, points: readWhiteSandsGround, crs: 'EPSG:6342', horizontalEpsg: 6342, verticalDatum: 'NAVD88 height (EPSG:5703)', verticalEpsg: 5703 },
  { cropId: 'estonia-tava', present: hasEstonia, points: readEstoniaGround, crs: 'EPSG:3301', horizontalEpsg: 3301, verticalDatum: 'EH2000 (Baltic 2000)', verticalEpsg: null },
];

/** The smallest committed crop, the one the test builds: 40 x 40 m, about 2600 ground returns. */
export const SMALLEST_CROP = 'sl-field';

/**
 * Bin the ground returns into the DTM's cells the way rasterizeDtm does: cell
 * index from the floored offset, a point within 1e-6 of a cell of the far edge
 * kept in the edge cell, anything further outside dropped. The evidence reader
 * recomputes the dispersion band from these lists and checks each list's
 * length against support_count, so the rule has to be the rasteriser's.
 */
export function returnsPerCell(
  points: readonly TerrainPoint[],
  grid: { readonly originH1: number; readonly originH2: number; readonly cols: number; readonly rows: number; readonly cellSizeM: number },
): number[][] {
  const { originH1, originH2, cols, rows, cellSizeM } = grid;
  const EPS_CELLS = 1e-6;
  const out: number[][] = Array.from({ length: cols * rows }, () => []);
  for (const p of points) {
    const fx = (p.x - originH1) / cellSizeM;
    const fy = (p.y - originH2) / cellSizeM;
    if (fx < -EPS_CELLS || fx > cols + EPS_CELLS || fy < -EPS_CELLS || fy > rows + EPS_CELLS) continue;
    let col = Math.floor(fx);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    let row = Math.floor(fy);
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    out[row * cols + col].push(p.z);
  }
  return out;
}

export interface DriverResult {
  readonly cropId: string;
  readonly outDir: string;
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly oracleDirs: Readonly<Record<'terrain-evidence' | 'terrain-attention' | 'terrain-sensitivity', string>>;
  readonly groundPoints: number;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Build the package for `cropId` into `outDir`. The generation date comes from
 * SOURCE_DATE_EPOCH when set, so two runs over the same commit write the same
 * bytes; otherwise the clock, as the export dialog does.
 */
export async function buildCropDemPackage(cropId: string, outDir: string): Promise<DriverResult> {
  const crop = CROPS.find((c) => c.cropId === cropId);
  if (!crop) {
    throw new Error(`unknown crop "${cropId}"; the driver knows ${CROPS.map((c) => c.cropId).join(', ')} (validation/terrain-field/crops)`);
  }
  if (!crop.present()) throw new Error(`crop ${cropId} is not present under ${TERRAIN_FIELD_DIR}/crops`);
  const points = crop.points();
  if (points.length === 0) throw new Error(`crop ${cropId} has no ground returns`);

  // The crop is ground only, as the harness cut it, so the source classification
  // is trusted rather than re-derived: every return is ASPRS class 2.
  const params: AnalyseContoursParams = {
    cellSizeM: 1,
    crs: crop.crs,
    horizontalEpsg: crop.horizontalEpsg,
    verticalEpsg: crop.verticalEpsg,
    verticalDatum: crop.verticalDatum,
    verticalUnitToMetres: 1,
    horizontalUnitToMetres: 1,
    verticalScaleKnown: true,
    horizontalScaleKnown: true,
    classification: new Uint8Array(points.length).fill(ASPRS_GROUND_CLASS),
    trustGroundClassification: true,
  };
  const result = analyseContours(points, params);
  const sensitivityGrids = await runSensitivityEnsemble(result.dtm, params, (p) => Promise.resolve(computeTerrainCore(points, p).dtm));

  const epoch = process.env.SOURCE_DATE_EPOCH;
  const generationDateIso = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000).toISOString() : new Date().toISOString();
  const pkg = JSON.parse(readFileSync(resolve(TERRAIN_FIELD_DIR, '../../package.json'), 'utf8')) as { version: string };

  const { entries, products } = assembleDemPackage(result, {
    basename: cropId,
    worldOrigin: { x: 0, y: 0, z: 0 },
    linearUnit: 'metre',
    verticalUnitToMetres: 1,
    horizontalUnitToMetres: 1,
    sensitivityGrids,
    attention: true,
    generationDateIso,
    softwareVersion: pkg.version,
    metricVersion: TERRAIN_METRIC_VERSION,
  });
  if (!products.evidence || !products.sensitivity || !products.attention) {
    throw new Error(`the package for ${cropId} lacks a code raster (evidence ${!!products.evidence}, sensitivity ${!!products.sensitivity}, attention ${!!products.attention})`);
  }

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `${cropId}-dem-package.zip`);
  writeFileSync(zipPath, buildZip(entries));
  const packageDir = join(outDir, 'package');
  mkdirSync(packageDir, { recursive: true });
  for (const e of entries) writeFileSync(join(packageDir, e.name), e.bytes);

  const oracleDirs = {
    'terrain-evidence': join(outDir, 'oracle', 'terrain-evidence'),
    'terrain-attention': join(outDir, 'oracle', 'terrain-attention'),
    'terrain-sensitivity': join(outDir, 'oracle', 'terrain-sensitivity'),
  } as const;
  for (const d of Object.values(oracleDirs)) mkdirSync(d, { recursive: true });

  const ev = products.evidence;
  writeFileSync(join(oracleDirs['terrain-evidence'], 'terrain_evidence.tif'), ev.bytes);
  writeFileSync(
    join(oracleDirs['terrain-evidence'], 'expected.json'),
    evidenceExpectedJson({
      grid: result.dtm,
      geo: ev.geo,
      bytes: ev.bytes,
      returns: returnsPerCell(points, result.dtm),
      horizontalUnit: ev.geo.horizontalUnit,
      verticalUnit: ev.geo.verticalUnit,
    }),
  );
  const at = products.attention;
  writeFileSync(join(oracleDirs['terrain-attention'], 'terrain_attention.tif'), at.bytes);
  writeFileSync(
    join(oracleDirs['terrain-attention'], 'expected.json'),
    attentionExpectedJson({ grid: result.dtm, inputs: at.inputs, residual: at.residual, bands: at.bands, geo: at.geo, bytes: at.bytes }),
  );
  const se = products.sensitivity;
  writeFileSync(join(oracleDirs['terrain-sensitivity'], 'terrain_sensitivity.tif'), se.bytes);
  writeFileSync(
    join(oracleDirs['terrain-sensitivity'], 'expected.json'),
    sensitivityExpectedJson({ grids: se.grids, geo: se.geo, bytes: se.bytes, verticalUnit: se.geo.verticalUnit }),
  );

  const summary: DriverResult = {
    cropId,
    outDir,
    zipPath,
    entries: entries.map((e) => e.name),
    oracleDirs,
    groundPoints: points.length,
    cols: result.dtm.cols,
    rows: result.dtm.rows,
  };
  writeFileSync(
    join(outDir, 'driver.json'),
    `${JSON.stringify({ ...summary, generationDateIso, softwareVersion: pkg.version, zipSha256: sha256Hex(new Uint8Array(readFileSync(zipPath))) }, null, 2)}\n`,
  );
  return summary;
}
