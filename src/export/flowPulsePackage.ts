/**
 * flowPulsePackage.ts — the Flow Pulse deliverable: accumulation and
 * direction rasters, a depression table, the sealed run record, a
 * reproducible config, a processing manifest and README, and an artifact
 * passport, bundled into one ZIP.
 *
 * Follows the pattern `src/terrain/export/demPackage.ts` already established
 * for the DEM deliverable — a pure function from a result to ZIP bytes, a
 * README that is always self-documenting, a passport bound to the raster it
 * names — rather than inventing a second export shape. It reuses that DEM
 * package's own ASCII Grid writer for the two rasters rather than writing a
 * third geospatial serialiser.
 *
 * ── WHY THE RASTERS CARRY NO CRS BY DEFAULT ─────────────────────────────────
 * `FlowGrid` (see `flowTypes.ts`) is deliberately kept apart from the
 * georeferenced `DemRaster`/`DtmGrid` products: it knows cell sizes in
 * metres and nothing else, no world origin and no CRS. That is correct for
 * routing, which only needs physical distance, but it means this package
 * cannot honestly stamp a real-world origin or EPSG code unless the caller
 * supplies one. Omitted, the rasters are written at a local origin (0, 0) and
 * the README says so in the same words the figures use — never a silently
 * assumed real-world placement.
 *
 * ── WHY THE CATCHMENT SHIPS AS A RASTER, NOT A POLYGON ──────────────────────
 * A catchment is a per-cell membership mask. Turning that into a GeoJSON
 * polygon needs a boundary-tracing step this project does not have, and
 * approximating one would draw a boundary nobody computed. The mask itself is
 * already the CSV; `catchment.asc` is that quantity in the format the DEM
 * package's own writer produces, not a new one invented for this file.
 *
 * ── WHY THE PATH IS LOCAL COORDINATES, NOT LON/LAT ──────────────────────────
 * The downstream path is a genuine line, so it ships as GeoJSON — but writing
 * plain GeoJSON with no CRS member implies WGS84 lon/lat by the spec's own
 * default, which local grid coordinates are not. Rather than fabricate a
 * projection this module cannot resolve, the file carries an explicit
 * top-level `coordinateFrame` field and the README repeats the same warning:
 * do not load it into a lon/lat viewer without reprojecting it first.
 *
 * Pure-data: returns ZIP bytes; no DOM.
 */

import { writeAsciiGrid } from '../terrain/export/demAsciiGrid';
import { buildZip, type ZipEntry } from '../convert/zipStore';
import { buildSha256Manifest, sha256Hex } from '../terrain/export/sha256';
import {
  buildProcessingManifest,
  type ProcessingOpInput,
} from '../science/processingManifest';
import { buildScientificAnalysisRecord } from '../science/scientificAnalysisRecord';
import {
  buildScientificArtifactPassport,
  type PassportEvidence,
} from '../science/scientificArtifactPassport';
import { methodRef, methodTag } from '../science/methodRegistry';
import { BUILD_IDENTITY, buildIdentityProvenance, type BuildIdentity } from '../build/buildIdentity';
import type { FlowPulseResult } from '../simulation/flowPulse/flowPulseRunner';
import type { FlowGrid } from '../simulation/flowPulse/flowTypes';

/** A caller-supplied downstream path (from `pulseFrom`), for the optional GeoJSON. */
export interface FlowPulsePathInput {
  /** Cell indices from the start cell to where the trace ended, in order. */
  readonly cells: Int32Array;
}

/** A caller-supplied catchment mask (from `catchmentFrom`), for the optional raster. */
export interface FlowPulseCatchmentInput {
  readonly mask: Uint8Array;
  /** The outlet cell the catchment was queried for, named in the README. */
  readonly outletCell: number;
}

/** No CRS is known for the rasters/GeoJSON; every coordinate is local grid metres. */
export interface FlowPulsePackageOptions {
  /** Base filename (no extension) for the package's entries. Default 'flow-pulse'. */
  readonly basename?: string;
  /** ISO generation timestamp. Default `new Date().toISOString()`. */
  readonly generationDateIso?: string;
  readonly softwareName?: string;
  readonly softwareVersion?: string;
  /** World offset added to local grid coordinates in the rasters/GeoJSON, when known. */
  readonly worldOrigin?: { readonly x: number; readonly y: number } | null;
  /** A CRS name for the README/passport, when the caller can supply one. Never invented here. */
  readonly crsName?: string | null;
  /**
   * CRS WKT for a `.prj` sidecar, when the caller can resolve one — same
   * seam `demPackage.ts` reads for its own `.prj`. Omitted or null writes no
   * `.prj` at all, rather than one with an empty or guessed CRS.
   */
  readonly wkt?: string | null;
  /** SHA-256 of the source scan, when the loader verified one. */
  readonly sourceSha256?: string | null;
  /** Build identity. Default the stamped {@link BUILD_IDENTITY}. */
  readonly build?: BuildIdentity;
  /** The downstream path from a click-to-pulse, when the caller ran one. */
  readonly path?: FlowPulsePathInput | null;
  /** The upstream catchment from a catchment query, when the caller ran one. */
  readonly catchment?: FlowPulseCatchmentInput | null;
}

const NO_DATA = -9999;

/** Direction-index legend, matching `D8_NEIGHBOURS` in `flowTypes.ts`. */
const DIRECTION_LEGEND = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

/** cols/rows-only coverage: every cell the flow grid marks valid. */
function coverageOf(grid: FlowGrid): Uint8Array {
  return grid.valid;
}

/** Every registered method's params from the sealed record, for the manifest. */
function manifestOps(result: FlowPulseResult): ProcessingOpInput[] {
  const p = result.record.parameters;
  const ops: ProcessingOpInput[] = [];
  for (const id of result.record.methods) {
    if (id.startsWith('olv.simulation.terrain-flow.priority-flood')) {
      ops.push({
        method: methodTag(methodRef(id)),
        params: {
          fillEpsilon: (p.fillEpsilon as number | null) ?? null,
          fillNoData: (p.fillNoData as string | null) ?? null,
        },
      });
    } else if (id === 'olv.simulation.terrain-flow.d8') {
      ops.push({
        method: methodTag(methodRef(id)),
        params: { interpolated: (p.interpolated as string | null) ?? null },
      });
    } else if (id === 'olv.simulation.terrain-flow.accumulation') {
      ops.push({ method: methodTag(methodRef(id)), params: {} });
    } else if (id === 'olv.simulation.terrain-flow.depression-inventory') {
      ops.push({ method: methodTag(methodRef(id)), params: {} });
    }
  }
  if (result.record.parameters.__hasPath) {
    ops.push({
      method: methodTag(methodRef('olv.simulation.terrain-flow.d8')),
      params: {},
      note: 'Downstream trace from the routed field, over the same receivers as the D8 step above.',
    });
  }
  if (result.record.parameters.__hasCatchment) {
    ops.push({
      method: methodTag(methodRef('olv.simulation.terrain-flow.catchment')),
      params: {},
    });
  }
  return ops;
}

/** The reproducible `*.olv-field-sim.json` config: re-running it reproduces `fieldDigest`. */
export function buildFlowPulseConfig(result: FlowPulseResult): Record<string, unknown> {
  const p = result.record.parameters;
  return {
    schemaVersion: 1,
    kind: 'terrain-flow',
    conditioning: p.conditioning,
    routing: p.routing,
    interpolated: p.interpolated,
    fillEpsilon: p.fillEpsilon,
    fillNoData: p.fillNoData,
    maxCells: p.maxCells,
    withheldExcluded: result.basis.withheldExcluded,
  };
}

function summaryCsv(result: FlowPulseResult): string {
  const s = result.summary;
  const d = result.depressions;
  const rows: [string, string][] = [
    ['cells', String(s.cells)],
    ['readableCells', String(s.readableCells)],
    ['sinkCount', String(s.sinkCount)],
    ['flatCount', String(s.flatCount)],
    ['outletCount', String(s.outletCount)],
    ['maxUpstreamCells', String(s.maxUpstreamCells)],
    ['maxContributingAreaM2', s.maxContributingAreaM2 == null ? '' : String(s.maxContributingAreaM2)],
    ['cellsRaised', s.cellsRaised == null ? '' : String(s.cellsRaised)],
    ['maxFillDepth', s.maxFillDepth == null ? '' : String(s.maxFillDepth)],
    ['epsilonAbsorbed', s.epsilonAbsorbed == null ? '' : String(s.epsilonAbsorbed)],
    ['cellsUnreachable', s.cellsUnreachable == null ? '' : String(s.cellsUnreachable)],
    ['depressionCount', String(d.depressions.length)],
    ['largestDepressionCells', String(d.largestCells)],
    ['largestDepressionAreaM2', d.largestAreaM2 == null ? '' : String(d.largestAreaM2)],
    ['largestDepressionMaxFillDepth', d.largestMaxFillDepth == null ? '' : String(d.largestMaxFillDepth)],
    ['largestDepressionOutletElevation', d.largestOutletElevation == null ? '' : String(d.largestOutletElevation)],
    ['fieldDigest', String(result.record.result.fieldDigest)],
  ];
  return ['metric,value', ...rows.map(([k, v]) => `${k},${v}`)].join('\n') + '\n';
}

function depressionsCsv(result: FlowPulseResult): string {
  const cols = result.grid.cols;
  const header = 'rank,cells,areaM2,maxFillDepth,outletElevation,seedCol,seedRow';
  const lines = result.depressions.depressions.map((dep) => {
    const col = dep.seedCell % cols;
    const row = (dep.seedCell - col) / cols;
    return [
      dep.rank, dep.cells, dep.areaM2 ?? '', dep.maxFillDepth ?? '', dep.outletElevation ?? '', col, row,
    ].join(',');
  });
  return [header, ...lines].join('\n') + '\n';
}

/** The reproduction steps and honest limitations a reader needs, per §23. */
function buildFlowReadme(result: FlowPulseResult, opts: {
  readonly basename: string;
  readonly generationDateIso: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly build: BuildIdentity;
  readonly crsName: string | null;
  readonly hasWkt: boolean;
  readonly hasPath: boolean;
  readonly hasCatchment: boolean;
}): string {
  const r = result.record;
  const s = result.summary;
  const grid = result.grid;
  const lines: (string | null)[] = [
    'OpenLiDARViewer — Terrain Flow Pulse export',
    '',
    'SIMULATED. A topographic routing graph over the declared surface — not rainfall,',
    'runoff, infiltration or flood modelling. Accumulation counts cells, not water.',
    '',
    'Files',
    `  ${opts.basename}-accumulation.asc   Upstream cell count per cell (Esri ASCII Grid)`,
    `  ${opts.basename}-direction.asc      D8 receiver direction index per cell (-1 to 7)`,
    `  ${opts.basename}-sinks-depressions.csv   Depression inventory (§10.10), largest first`,
    opts.hasPath ? `  ${opts.basename}-flow-path.geojson   Downstream path from a click-to-pulse` : null,
    opts.hasCatchment ? `  ${opts.basename}-catchment.asc      Upstream catchment mask (1 = contributing)` : null,
    opts.hasWkt ? `  ${opts.basename}.prj                 Coordinate reference system (WKT)` : null,
    `  ${opts.basename}-summary.csv         The figures above, flat`,
    `  ${opts.basename}-simulation-run.json The sealed run record`,
    `  ${opts.basename}.olv-field-sim.json  Reproducible config: re-run it, get the same fieldDigest`,
    `  ${opts.basename}-processing-manifest.json   Ordered, tamper-evident processing steps`,
    `  ${opts.basename}-scientific-artifact-passport.json   Tamper-evident provenance for the accumulation raster`,
    `  SHA256SUMS.txt               SHA-256 of every file above`,
    '',
    'Identity',
    `  OLV version    ${opts.build.version} (${opts.build.commit}${opts.build.dirty ? '+dirty' : ''})`,
    `  Generated      ${opts.generationDateIso}`,
    `  Layer          ${r.source.layerId ?? 'unknown'}`,
    `  Source file    ${r.source.filename ?? 'unknown'}`,
    `  Source digest  ${r.source.sourceDigest ?? 'unavailable'}`,
    `  Input digest   ${r.source.analysisInputDigest}`,
    `  Input coverage ${r.source.basis.coverage} (${r.source.basis.complete ? 'complete' : 'partial'})`,
    `  Cells read     ${r.source.basis.measuredCells} of ${r.source.basis.totalCells}`,
    `  Withheld excluded   ${r.source.basis.withheldExcluded === null ? 'not recorded' : String(r.source.basis.withheldExcluded)}`,
    `  CRS            ${opts.crsName ?? 'not georeferenced — rasters use a local (0, 0) origin'}`,
    '',
    'Grid',
    `  Size           ${grid.cols} x ${grid.rows} cells`,
    `  Cell size      ${grid.cellMetresX} m (east-west) x ${grid.cellMetresY} m (north-south)`,
    `  NODATA value   ${NO_DATA}`,
    `  Direction legend   ${DIRECTION_LEGEND.map((d, i) => `${i}=${d}`).join(', ')}, -1 = sink/outlet/no data`,
    ...(grid.cellMetresX !== grid.cellMetresY ? [
      '  Anisotropic grid: the Esri ASCII Grid format has one cell size field, so',
      `  the two .asc rasters are written at the X cell size (${grid.cellMetresX} m) and`,
      `  will appear stretched along Y in GIS software (true Y is ${grid.cellMetresY} m).`,
      '  Routing itself used the true per-axis sizes; only these two raster files are',
      '  affected. The CSV and JSON files carry the true cell sizes throughout.',
    ] : []),
    '',
    'Method',
    `  Model          ${r.model.id}@${r.model.version}`,
    `  Methods run    ${r.methods.map((id) => methodTag(methodRef(id))).join(', ')}`,
    `  Conditioning   ${r.parameters.conditioning}`,
    '',
    'Results',
    `  Cells routed           ${s.readableCells} of ${s.cells}`,
    `  Sinks                  ${s.sinkCount}`,
    `  Flats (unresolved)     ${s.flatCount}`,
    `  Outlets                ${s.outletCount}`,
    `  Largest upstream count ${s.maxUpstreamCells} cells`,
    `  Largest contributing area   ${s.maxContributingAreaM2 == null ? 'withheld (horizontal scale unresolved)' : `${s.maxContributingAreaM2} m2`}`,
    `  Depressions catalogued ${result.depressions.depressions.length}`,
    `  Field digest            ${r.result.fieldDigest}`,
    `  Run record digest       ${r.digest}`,
    '',
    'Assumptions',
    '  D8 single-flow-direction routing: each cell drains to the one neighbour with the',
    '  steepest descent per unit of physical distance. Real water divides across a',
    '  divergent hillslope; D8 cannot, and reports one receiver per cell regardless.',
    '',
    'Limitations',
    ...r.limitations.map((l) => `  - ${l}`),
    '',
    'Reproduction',
    `  1. Load ${opts.basename}.olv-field-sim.json's conditioning/routing/interpolated/`,
    '     fillEpsilon/fillNoData/maxCells into a Flow Pulse run over the identical DTM',
    `     (input digest ${r.source.analysisInputDigest}).`,
    `  2. Re-run. The result's fieldDigest must equal ${r.result.fieldDigest}.`,
    '  3. A different digest means the terrain, the parameters or the method version',
    '     changed — the config or the README says which was declared.',
    '',
    'What this is not',
    '  Not rainfall-runoff, hydraulic, storm-sewer or infiltration modelling. Not a',
    '  flood forecast or a water-depth prediction. A conditioned surface is a drainage',
    '  aid for routing, never a corrected terrain.',
    '',
  ];
  if (opts.hasPath) {
    lines.push(
      'flow-path.geojson coordinates',
      '  Local planar metres relative to the grid\'s own (0, 0) corner (cell 0,0\'s',
      '  lower-left), NOT longitude/latitude. Reproject before loading into a lon/lat',
      '  viewer; loading it as-is will place it at the equator/prime meridian.',
      '',
    );
  }
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** Build the Flow Pulse ZIP package from a completed run. */
export function buildFlowPulsePackage(
  result: FlowPulseResult,
  options: FlowPulsePackageOptions = {},
): Uint8Array {
  const basename = options.basename ?? 'flow-pulse';
  const generationDateIso = options.generationDateIso ?? new Date().toISOString();
  const build = options.build ?? BUILD_IDENTITY;
  const softwareName = options.softwareName ?? 'OpenLiDARViewer';
  const softwareVersion = options.softwareVersion ?? buildIdentityProvenance(build);
  const ox = options.worldOrigin?.x ?? 0;
  const oy = options.worldOrigin?.y ?? 0;
  const grid = result.grid;
  const coverage = coverageOf(grid);
  const hasPath = !!options.path;
  const hasCatchment = !!options.catchment;

  const entries: ZipEntry[] = [];

  // Accumulation: upstream cell count, always available regardless of scale.
  entries.push({
    name: `${basename}-accumulation.asc`,
    bytes: new TextEncoder().encode(writeAsciiGrid({
      values: result.accumulation.upstreamCells, coverage,
      cols: grid.cols, rows: grid.rows, cellSize: grid.cellMetresX,
      xllCorner: ox, yllCorner: oy, noData: NO_DATA, precision: 0,
    })),
  });

  // Direction: the receiver index into D8_NEIGHBOURS, -1 where flow does not
  // route (sink, flat, outlet or NoData). This is a code, not an elevation,
  // so it rides through the same writer with zero decimal places.
  entries.push({
    name: `${basename}-direction.asc`,
    bytes: new TextEncoder().encode(writeAsciiGrid({
      values: result.routed.direction, coverage,
      // Esri ASCII Grid has one `cellsize` field: square cells only. Both
      // rasters use the X cell size; see the README note on anisotropic grids.
      cols: grid.cols, rows: grid.rows, cellSize: grid.cellMetresX,
      xllCorner: ox, yllCorner: oy, noData: NO_DATA, precision: 0,
    })),
  });

  entries.push({
    name: `${basename}-sinks-depressions.csv`,
    bytes: new TextEncoder().encode(depressionsCsv(result)),
  });

  if (options.path) {
    const coords = Array.from(options.path.cells, (c) => {
      const col = c % grid.cols;
      const row = (c - col) / grid.cols;
      return [ox + col * grid.cellMetresX, oy + row * grid.cellMetresY];
    });
    const geojson = {
      type: 'FeatureCollection',
      coordinateFrame: 'local-planar-metres',
      features: [{
        type: 'Feature',
        properties: { cells: options.path.cells.length },
        geometry: { type: 'LineString', coordinates: coords },
      }],
    };
    entries.push({
      name: `${basename}-flow-path.geojson`,
      bytes: new TextEncoder().encode(`${JSON.stringify(geojson, null, 2)}\n`),
    });
  }

  if (options.catchment) {
    entries.push({
      name: `${basename}-catchment.asc`,
      bytes: new TextEncoder().encode(writeAsciiGrid({
        values: options.catchment.mask, coverage,
        cols: grid.cols, rows: grid.rows, cellSize: grid.cellMetresX,
        xllCorner: ox, yllCorner: oy, noData: NO_DATA, precision: 0,
      })),
    });
  }

  entries.push({
    name: `${basename}-summary.csv`,
    bytes: new TextEncoder().encode(summaryCsv(result)),
  });

  entries.push({
    name: `${basename}-simulation-run.json`,
    bytes: new TextEncoder().encode(`${JSON.stringify(result.record, null, 2)}\n`),
  });

  const config = buildFlowPulseConfig(result);
  entries.push({
    name: `${basename}.olv-field-sim.json`,
    bytes: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
  });

  // A marker read only by manifestOps above, to add the optional path/
  // catchment steps without smuggling non-parameter state through the sealed
  // record's own `parameters` object (which stays exactly what the runner
  // built, so its digest is unaffected by what the export happens to include).
  const opsSource: FlowPulseResult = {
    ...result,
    record: {
      ...result.record,
      parameters: { ...result.record.parameters, __hasPath: hasPath, __hasCatchment: hasCatchment },
    },
  };
  const manifest = buildProcessingManifest({
    build: softwareVersion,
    source: result.record.source.filename,
    ops: manifestOps(opsSource),
  });
  entries.push({
    name: `${basename}-processing-manifest.json`,
    bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });

  if (options.wkt) {
    entries.push({ name: `${basename}.prj`, bytes: new TextEncoder().encode(options.wkt) });
  }

  const readme = buildFlowReadme(result, {
    basename, generationDateIso, softwareName, softwareVersion, build,
    crsName: options.crsName ?? null, hasWkt: !!options.wkt, hasPath, hasCatchment,
  });
  entries.push({
    name: `${basename}-README.txt`,
    bytes: new TextEncoder().encode(readme),
  });

  // The passport binds to the accumulation raster: the one file in this
  // package a GIS is most likely to be handed on its own.
  const accumulationEntry = entries.find((e) => e.name === `${basename}-accumulation.asc`);
  if (accumulationEntry) {
    const analysis = buildScientificAnalysisRecord({
      kind: 'terrain-flow-pulse',
      source: result.record.source.filename,
      crs: {
        horizontal: options.crsName ?? 'not georeferenced',
        horizontalKnown: options.crsName != null,
        verticalDatum: 'unknown',
        verticalDatumKnown: false,
      },
      methodIds: [...result.record.methods],
      // A simulation is never a scored evidence claim; see the module doc.
      evidenceExploratory: true,
      summary: {
        sinkCount: result.summary.sinkCount,
        flatCount: result.summary.flatCount,
        outletCount: result.summary.outletCount,
        maxUpstreamCells: result.summary.maxUpstreamCells,
        depressionCount: result.depressions.depressions.length,
        fieldDigest: String(result.record.result.fieldDigest),
      },
      generatedAt: generationDateIso,
      build,
    });
    const evidence: PassportEvidence = {
      baseline: null,
      effective: null,
      resolutionState: 'not applicable',
      matchedStudy: null,
      applicabilityVerdict: 'Simulated result; not a claim scored on the evidence ladder.',
    };
    const passport = buildScientificArtifactPassport({
      source: { name: result.record.source.filename, sha256: options.sourceSha256 ?? null },
      analysis,
      processing: manifest,
      evidence,
      artifact: {
        filename: accumulationEntry.name,
        mediaType: 'text/plain',
        bytes: accumulationEntry.bytes,
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

/** SHA-256 of `bytes`, re-exported so a caller can verify a package entry without a second import. */
export { sha256Hex };
