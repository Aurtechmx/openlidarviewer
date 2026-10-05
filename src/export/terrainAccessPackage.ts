/**
 * terrainAccessPackage.ts — the Terrain Access deliverable: a route GeoJSON, a
 * traversability raster, a diagnostics table, the sealed run record, a
 * reproducible config, a processing manifest and README, and an artifact
 * passport, bundled into one ZIP.
 *
 * Follows `flowPulsePackage.ts`'s own pattern (itself following
 * `src/terrain/export/demPackage.ts`) rather than inventing a second export
 * shape: a pure function from a result to ZIP bytes, a README that is always
 * self-documenting, a passport bound to the raster it names. Reuses the DEM
 * package's ASCII Grid writer for the traversability raster.
 *
 * ── §22 WORDING, ENFORCED HERE TOO ───────────────────────────────────────────
 * The README states plainly, in every place a reader might otherwise assume
 * one, that this is a geometry-based screening — never "safe", "drivable" or
 * "passable". `terrainAccessRunner.ts`'s own `modelLimitations` already says
 * this in the sealed record; the README repeats it in the same words rather
 * than paraphrasing, so the two documents can never quietly disagree.
 *
 * ── WHY THE RASTER CARRIES NO CRS BY DEFAULT ─────────────────────────────────
 * Same reasoning as `flowPulsePackage.ts`: `TerrainAccessGrid` knows cell
 * sizes in metres and nothing else, no world origin and no CRS. Omitted, the
 * raster is written at a local origin (0, 0) and the README says so.
 *
 * ── WHY THE ROUTE SHIPS AS GEOJSON WITH AN EXPLICIT COORDINATE FRAME ─────────
 * Same reasoning as the Flow Pulse path: plain GeoJSON with no CRS member
 * implies WGS84 lon/lat by the spec's own default, which local grid
 * coordinates are not. The file carries a top-level `coordinateFrame` field
 * and the README repeats the warning.
 *
 * Pure-data: returns ZIP bytes; no DOM.
 */

import { SOURCE_NOT_SUPPLIED_NOTE, sourceSha256Text, type ExportDigests } from '../science/exportDigestRecord';
import { crsOriginLine } from '../science/crsOrigin';
import { writeAsciiGrid } from '../terrain/export/demAsciiGrid';
import { buildZip, type ZipEntry } from '../convert/zipStore';
import { sourceInterpretationLines, sourceInterpretationOf, type SourceInterpretationRecord } from '../science/sourceInterpretation';
import { buildSha256Manifest } from '../terrain/export/sha256';
import { buildProcessingManifest, type ManifestParamValue, type ProcessingOpInput } from '../science/processingManifest';
import { buildScientificAnalysisRecord } from '../science/scientificAnalysisRecord';
import {
  buildScientificArtifactPassport,
  type PassportEvidence,
} from '../science/scientificArtifactPassport';
import { methodRef, methodTag } from '../science/methodRegistry';
import { BUILD_IDENTITY, buildIdentityProvenance, type BuildIdentity } from '../build/buildIdentity';
import type { TerrainAccessResult } from '../simulation/terrainAccess/terrainAccessRunner';

/** No CRS is known for the raster/GeoJSON; every coordinate is local grid metres. */
export interface TerrainAccessPackageOptions {
  /** Base filename (no extension) for the package's entries. Default 'terrain-access'. */
  readonly basename?: string;
  readonly generationDateIso?: string;
  readonly softwareName?: string;
  readonly softwareVersion?: string;
  /** The scan's load-time origin, in horizontal CRS units, when known. */
  readonly worldOrigin?: { readonly x: number; readonly y: number } | null;
  /** The grid's own position in the scan. With {@link worldOrigin}, places the route and raster in the scan CRS. */
  readonly gridPlacement?: TerrainAccessGridPlacement | null;
  /** A CRS name for the README/passport, when the caller can supply one. Never invented here. */
  readonly crsName?: string | null;
  /**
   * CRS WKT for a `.prj` sidecar, when the caller can resolve one — same
   * seam `demPackage.ts`/`flowPulsePackage.ts` read for their own `.prj`.
   * Omitted or null writes no `.prj` at all, rather than one with an empty
   * or guessed CRS.
   */
  readonly wkt?: string | null;
  /** SHA-256 of the source scan, when the loader verified one. */
  readonly sourceSha256?: string | null;
  /** Source-file digest and CRS origin (`exportDigestRecord.ts`). */
  readonly digests?: ExportDigests | null;
  readonly build?: BuildIdentity;
  /**
   * Interpretation level of the source file and the data basis the analysed
   * surface was built on. Omitted records `not-recorded` / `unknown`.
   */
  readonly sourceInterpretation?: SourceInterpretationRecord | null;
}

const NO_DATA = -9999;

/** {@link buildTerrainAccessMapBuffers}'s bucket order, as raster codes: -1 for a cell with no
 * elevation, so the ASCII Grid's own NODATA writes exactly there. */
const MAP_STATE_CODE: Record<string, number> = {
  blocked: 0,
  unknown: 1,
  'low-cost': 2,
  'moderate-cost': 3,
  'high-cost': 4,
};

/** Every registered method's params from the sealed record, for the manifest. */
function manifestOps(result: TerrainAccessResult): ProcessingOpInput[] {
  const p = result.record.parameters as { readonly profile: ManifestParamValue; readonly weights: ManifestParamValue };
  return result.record.methods.map((id) => ({
    method: methodTag(methodRef(id)),
    params: id === 'olv.simulation.terrain-access.astar'
      ? ({ profile: p.profile, weights: p.weights } as Readonly<Record<string, ManifestParamValue>>)
      : ({} as Readonly<Record<string, ManifestParamValue>>),
  }));
}

/** The reproducible `*.olv-field-sim.json` config: re-running it reproduces `resultDigest`. */
export function buildTerrainAccessConfig(result: TerrainAccessResult): Record<string, unknown> {
  const p = result.record.parameters as {
    readonly profile: unknown;
    readonly interpolated: unknown;
    readonly maxCells: unknown;
    readonly weights: unknown;
    readonly startIndex: unknown;
    readonly endIndex: unknown;
  };
  return {
    schemaVersion: 1,
    kind: 'terrain-access',
    profile: p.profile,
    interpolated: p.interpolated,
    maxCells: p.maxCells,
    weights: p.weights,
    startIndex: p.startIndex,
    endIndex: p.endIndex,
    withheldExcluded: result.basis.withheldExcluded,
  };
}

function diagnosticsCsv(result: TerrainAccessResult): string {
  const d = result.diagnostics;
  const rows: [string, string][] = [
    ['cellCount', String(d.cellCount)],
    ['horizontalLengthM', String(d.horizontalLengthM)],
    ['length3dM', String(d.length3dM)],
    ['totalAscentM', String(d.totalAscentM)],
    ['totalDescentM', String(d.totalDescentM)],
    ['maxLongitudinalGrade', String(d.maxLongitudinalGrade)],
    ['p95LongitudinalGrade', String(d.p95LongitudinalGrade)],
    ['maxCrossSlope', String(d.maxCrossSlope)],
    ['p95CrossSlope', String(d.p95CrossSlope)],
    ['maxEdgeStepM', String(d.maxEdgeStepM)],
    ['maxLocalReliefM', String(d.maxLocalReliefM)],
    ['maxVrm', String(d.maxVrm)],
    ['minTerrainConfidence', String(d.minTerrainConfidence)],
    ['fractionMeasured', d.fractionMeasured == null ? '' : String(d.fractionMeasured)],
    ['fractionInterpolated', d.fractionInterpolated == null ? '' : String(d.fractionInterpolated)],
    ['fractionLowConfidenceOrEdgeRisk', d.fractionLowConfidenceOrEdgeRisk == null ? '' : String(d.fractionLowConfidenceOrEdgeRisk)],
    ['cost', String(result.cost)],
    ['exploredCells', String(result.explored)],
    ['resultDigest', String(result.record.result.resultDigest)],
  ];
  const contributors = result.diagnostics.dominantCostContributors
    .map((c) => `dominantCostContributor.${c.term},${c.total}`);
  return ['metric,value', ...rows.map(([k, v]) => `${k},${v}`), ...contributors].join('\n') + '\n';
}

/**
 * Where the grid sits in the scan, as `DtmGrid` records it: the west and
 * south edges of cell (0, 0) relative to the load-time origin, and the cell
 * size, all in the scan's horizontal CRS units. Rows run north from
 * `originH2` (see `cellConfidence.ts`).
 */
export interface TerrainAccessGridPlacement {
  readonly originH1: number;
  readonly originH2: number;
  readonly cellSize: number;
}

/** The coordinate frame the route and raster are written in. */
export type TerrainAccessCoordinateFrame = 'scan-crs' | 'scan-source-coordinates' | 'local-planar-metres';

/** The lower-left corner, the cell sizes and the frame both the route and the raster use. */
export interface TerrainAccessPlacement {
  readonly xll: number;
  readonly yll: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly frame: TerrainAccessCoordinateFrame;
}

/**
 * Place the grid. With a world origin and the grid's own placement, the
 * corner is `origin + originH1/originH2` in scan CRS units, the same corner
 * the DEM package writes for this grid. Without them the grid is written in
 * local metres from its own lower-left corner.
 */
export function terrainAccessPlacement(
  grid: { readonly cellMetresX: number; readonly cellMetresY: number },
  worldOrigin: { readonly x: number; readonly y: number } | null,
  placement: TerrainAccessGridPlacement | null,
  crsName: string | null,
): TerrainAccessPlacement {
  if (!worldOrigin || !placement) {
    return { xll: 0, yll: 0, cellX: grid.cellMetresX, cellY: grid.cellMetresY, frame: 'local-planar-metres' };
  }
  return {
    xll: worldOrigin.x + placement.originH1,
    yll: worldOrigin.y + placement.originH2,
    cellX: placement.cellSize,
    cellY: placement.cellSize,
    frame: crsName ? 'scan-crs' : 'scan-source-coordinates',
  };
}

/** The route vertex for a cell index: the cell's centre. */
export function routeVertex(cell: number, cols: number, p: TerrainAccessPlacement): [number, number] {
  const col = cell % cols;
  const row = (cell - col) / cols;
  return [p.xll + (col + 0.5) * p.cellX, p.yll + (row + 0.5) * p.cellY];
}

/** What the route GeoJSON's coordinates are, for the frame they were written in. */
export function routeFrameLines(frame: TerrainAccessCoordinateFrame, crsName: string | null): string[] {
  if (frame === 'scan-crs') {
    return [
      `  Cell centres in the scan CRS (${crsName}), the same frame as the raster and`,
      '  the .prj when one is written.',
    ];
  }
  if (frame === 'scan-source-coordinates') {
    return [
      '  Cell centres in the scan\'s own source coordinates. The CRS did not resolve,',
      '  so no .prj names it; assign the CRS before loading into a GIS.',
    ];
  }
  return [
    '  Cell centres in local planar metres from the grid\'s lower-left corner,',
    '  NOT longitude/latitude. Loading it as-is in a lon/lat viewer places it at',
    '  the equator/prime meridian.',
  ];
}

/** The reproduction steps and honest limitations a reader needs, per §22/§23. */
function buildTerrainAccessReadme(result: TerrainAccessResult, opts: {
  readonly basename: string;
  readonly generationDateIso: string;
  readonly build: BuildIdentity;
  readonly crsName: string | null;
  readonly hasWkt: boolean;
  readonly sourceInterpretation: SourceInterpretationRecord;
  readonly sourceSha256Text: string;
  readonly frame: TerrainAccessCoordinateFrame;
}): string {
  const r = result.record;
  const d = result.diagnostics;
  const grid = result.grid;
  const lines: (string | null)[] = [
    'OpenLiDARViewer — Terrain Access export',
    '',
    'A geometry-based traversability screening over the declared terrain and mobility',
    'limits. This is NOT a safety assessment, a guaranteed-passable route, or a vehicle',
    'dynamics simulation. Never read any part of this package as a claim that a route',
    'is safe, drivable or passable: soil strength, traction, tire/track-soil interaction,',
    'rollover, weather and vegetation compliance are not modelled.',
    '',
    'Files',
    `  ${opts.basename}-route.geojson              Found route (${opts.frame === 'local-planar-metres' ? 'local planar coordinates' : 'scan coordinates'})`,
    `  ${opts.basename}-traversability.asc         Traversability-map bucket per cell (Esri ASCII Grid)`,
    opts.hasWkt ? `  ${opts.basename}.prj                    Coordinate reference system (WKT)` : null,
    `  ${opts.basename}-diagnostics.csv            Route diagnostics (worst conditions along the route)`,
    `  ${opts.basename}-simulation-run.json        The sealed run record`,
    `  ${opts.basename}.olv-field-sim.json         Reproducible config: re-run it, get the same resultDigest`,
    `  ${opts.basename}-processing-manifest.json   Ordered processing steps, hash-chained (a self-consistency check, not a signature)`,
    `  ${opts.basename}-scientific-artifact-passport.json   Tamper-evident provenance for the traversability raster`,
    '  SHA256SUMS.txt                        SHA-256 of every file above',
    '',
    'Identity',
    `  OLV version    ${opts.build.version} (${opts.build.commit}${opts.build.dirty ? '+dirty' : ''})`,
    `  Generated      ${opts.generationDateIso}`,
    ...sourceInterpretationLines(opts.sourceInterpretation),
    `  Layer          ${r.source.layerId ?? 'unknown'}`,
    `  Source file    ${r.source.filename ?? 'unknown'}`,
    `  Source SHA-256 ${opts.sourceSha256Text}`,
    `  Input digest   ${r.source.analysisInputDigest}`,
    `  Input coverage ${r.source.basis.coverage} (${r.source.basis.complete ? 'complete' : 'partial'})`,
    `  Cells read     ${r.source.basis.measuredCells} of ${r.source.basis.totalCells}`,
    `  CRS            ${opts.crsName ?? (opts.frame === 'local-planar-metres'
      ? 'not georeferenced — the raster uses a local (0, 0) origin'
      : 'not resolved — the raster uses the scan\'s source coordinates')}`,
    ...(opts.sourceInterpretation.crsOrigin ? [`  ${crsOriginLine(opts.sourceInterpretation.crsOrigin)}`] : []),
    '',
    'Grid',
    `  Size           ${grid.cols} x ${grid.rows} cells`,
    `  Cell size      ${grid.cellMetresX} m (east-west) x ${grid.cellMetresY} m (north-south)`,
    `  NODATA value   ${NO_DATA}`,
    '  Traversability bucket codes   0=blocked, 1=no data/unknown, 2=low-cost, 3=moderate-cost, 4=high-cost',
    ...(opts.frame === 'local-planar-metres' && grid.cellMetresX !== grid.cellMetresY ? [
      '  Anisotropic grid: the Esri ASCII Grid format has one cell size field, so the',
      `  raster is written at the X cell size (${grid.cellMetresX} m) and will appear`,
      `  stretched along Y in GIS software (true Y is ${grid.cellMetresY} m). Routing`,
      '  itself used the true per-axis sizes; only this raster file is affected.',
    ] : []),
    '',
    'Method',
    `  Model          ${r.model.id}@${r.model.version}`,
    `  Methods run    ${r.methods.map((id) => methodTag(methodRef(id))).join(', ')}`,
    '',
    'Route',
    `  Cells                  ${d.cellCount}`,
    `  Horizontal length      ${d.horizontalLengthM.toFixed(1)} m`,
    `  3D length              ${d.length3dM.toFixed(1)} m`,
    `  Total ascent/descent   ${d.totalAscentM.toFixed(1)} m / ${d.totalDescentM.toFixed(1)} m`,
    `  Max longitudinal grade ${d.maxLongitudinalGrade.toFixed(3)} (tangent)`,
    `  Max cross slope        ${d.maxCrossSlope.toFixed(3)} (tangent)`,
    `  Max step (limit applies here)   ${d.maxEdgeStepM.toFixed(3)} m`,
    `  Terrain relief within the footprint window   ${d.maxLocalReliefM.toFixed(3)} m`,
    `  Min terrain confidence ${Number.isFinite(d.minTerrainConfidence) ? d.minTerrainConfidence.toFixed(0) : 'n/a'}`,
    `  Cost                   ${result.cost}`,
    `  Result digest          ${r.result.resultDigest}`,
    `  Run record digest      ${r.digest}`,
    '',
    'Limitations',
    ...r.limitations.map((l) => `  - ${l}`),
    '',
    'Reproduction',
    `  1. Load ${opts.basename}.olv-field-sim.json's profile/interpolated/maxCells/weights/`,
    '     startIndex/endIndex into a Terrain Access run over the identical terrain',
    `     (input digest ${r.source.analysisInputDigest}).`,
    `  2. Re-run. The result's resultDigest must equal ${r.result.resultDigest}.`,
    '  3. A different digest means the terrain, the profile or the method version',
    '     changed — the config or the README says which was declared.',
    '',
    'route.geojson coordinates',
    ...routeFrameLines(opts.frame, opts.crsName),
    '',
    'What this is not',
    '  Not a safety assessment, a guaranteed-passable route, or a vehicle dynamics',
    '  simulation. A route this tool finds is a geometric candidate under the',
    '  declared limits, never a passability guarantee.',
    '',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** Build the Terrain Access ZIP package from a completed run. */
export function buildTerrainAccessPackage(
  result: TerrainAccessResult,
  options: TerrainAccessPackageOptions = {},
): Uint8Array {
  const basename = options.basename ?? 'terrain-access';
  const generationDateIso = options.generationDateIso ?? new Date().toISOString();
  const build = options.build ?? BUILD_IDENTITY;
  const softwareVersion = options.softwareVersion ?? buildIdentityProvenance(build);
  const sourceInterpretation = {
    ...(options.sourceInterpretation ?? sourceInterpretationOf(undefined, undefined)),
    ...(options.digests ? { crsOrigin: options.digests.crsOrigin } : {}),
  };
  const grid = result.grid;
  const place = terrainAccessPlacement(grid, options.worldOrigin ?? null, options.gridPlacement ?? null, options.crsName ?? null);

  const entries: ZipEntry[] = [];

  const coords = result.path.map((c) => routeVertex(c, grid.cols, place));
  const geojson = {
    type: 'FeatureCollection',
    coordinateFrame: place.frame,
    features: [{
      type: 'Feature',
      properties: { cells: result.path.length, cost: result.cost },
      geometry: { type: 'LineString', coordinates: coords },
    }],
  };
  entries.push({
    name: `${basename}-route.geojson`,
    bytes: new TextEncoder().encode(`${JSON.stringify(geojson, null, 2)}\n`),
  });

  const codes = new Int32Array(grid.cols * grid.rows);
  const coverage = new Uint8Array(grid.cols * grid.rows);
  for (let i = 0; i < codes.length; i++) {
    if (grid.valid[i] === 0) { coverage[i] = 0; continue; }
    coverage[i] = 1;
    codes[i] = MAP_STATE_CODE[result.map[i].state] ?? 1;
  }
  entries.push({
    name: `${basename}-traversability.asc`,
    bytes: new TextEncoder().encode(writeAsciiGrid({
      values: codes, coverage,
      cols: grid.cols, rows: grid.rows, cellSize: place.cellX,
      xllCorner: place.xll, yllCorner: place.yll, noData: NO_DATA, precision: 0,
    })),
  });

  entries.push(
    {
      name: `${basename}-diagnostics.csv`,
      bytes: new TextEncoder().encode(diagnosticsCsv(result)),
    },
    {
      name: `${basename}-simulation-run.json`,
      bytes: new TextEncoder().encode(`${JSON.stringify(result.record, null, 2)}\n`),
    },
  );

  const config = buildTerrainAccessConfig(result);
  entries.push({
    name: `${basename}.olv-field-sim.json`,
    bytes: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
  });

  const manifest = buildProcessingManifest({
    build: softwareVersion,
    source: result.record.source.filename,
    ops: manifestOps(result),
    sourceInterpretation,
  });
  entries.push({
    name: `${basename}-processing-manifest.json`,
    bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });

  const readme = buildTerrainAccessReadme(result, {
    basename, generationDateIso, build, crsName: options.crsName ?? null, hasWkt: !!options.wkt, sourceInterpretation,
    frame: place.frame,
    sourceSha256Text: options.sourceSha256 ?? (options.digests ? sourceSha256Text(options.digests) : (result.record.source.sourceDigest ?? SOURCE_NOT_SUPPLIED_NOTE)),
  });
  entries.push({
    name: `${basename}-README.txt`,
    bytes: new TextEncoder().encode(readme),
  });

  if (options.wkt) {
    entries.push({ name: `${basename}.prj`, bytes: new TextEncoder().encode(options.wkt) });
  }

  // The passport binds to the traversability raster: the one file in this
  // package most likely to be handed on its own.
  const rasterEntry = entries.find((e) => e.name === `${basename}-traversability.asc`);
  if (rasterEntry) {
    const analysis = buildScientificAnalysisRecord({
      kind: 'terrain-access',
      source: result.record.source.filename,
      crs: {
        horizontal: options.crsName ?? 'not georeferenced',
        horizontalKnown: options.crsName != null,
        verticalDatum: 'unknown',
        verticalDatumKnown: false,
      },
      methodIds: [...result.record.methods],
      // A geometric screening is never a scored evidence claim; see the module doc.
      evidenceExploratory: true,
      summary: {
        cellCount: result.diagnostics.cellCount,
        horizontalLengthM: result.diagnostics.horizontalLengthM,
        cost: result.cost,
        resultDigest: String(result.record.result.resultDigest),
      },
      generatedAt: generationDateIso,
      build,
    });
    const evidence: PassportEvidence = {
      baseline: null,
      effective: null,
      resolutionState: 'not applicable',
      matchedStudy: null,
      applicabilityVerdict: 'Geometry-based screening result; not a claim scored on the evidence ladder, and never a safety/passability guarantee.',
    };
    const passport = buildScientificArtifactPassport({
      source: { name: result.record.source.filename, sha256: options.sourceSha256 ?? options.digests?.sourceSha256 ?? null },
      analysis,
      processing: manifest,
      evidence,
      artifact: {
        filename: rasterEntry.name,
        mediaType: 'text/plain',
        bytes: rasterEntry.bytes,
      },
      build,
    });
    entries.push({
      name: `${basename}-scientific-artifact-passport.json`,
      bytes: new TextEncoder().encode(`${JSON.stringify(passport, null, 2)}\n`),
    });
  }

  entries.push({
    name: 'SHA256SUMS.txt',
    bytes: new TextEncoder().encode(buildSha256Manifest(entries)),
  });

  return buildZip(entries);
}

export { sha256Hex } from '../terrain/export/sha256';
