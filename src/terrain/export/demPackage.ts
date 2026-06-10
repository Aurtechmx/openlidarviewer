/**
 * demPackage.ts
 *
 * Assemble a georeferenced DEM deliverable from an analysis result: the
 * bare-earth DTM, the top-surface DSM, and the canopy height model (CHM), each
 * as both an Esri ASCII Grid (.asc) and a Float32 GeoTIFF (.tif), plus an
 * optional .prj (CRS WKT) and a metadata README with the survey details.
 * Bundled into a single store-only ZIP.
 *
 * Pure-data: returns the ZIP bytes; no DOM. The DSM grid is reconstructed as
 * DTM + canopy height (= max(DTM, DSM)), so no extra grid needs threading
 * through the pipeline.
 *
 * Honesty contract: the DEM export stays AVAILABLE even when the contour
 * quality gate is preview-only or the coverage is partial — the bare-earth
 * raster is still real data. But the README is then self-documenting about it:
 * it always carries the coverage mode, the quality-gate verdict, the warnings
 * list, the generation parameters, and a real bounds extent, and it leads with
 * a prominent PRELIMINARY caveat whenever the data is not full + ready.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import { buildExportProvenance, provenanceLines } from './exportProvenance';
import { writeAsciiGrid } from './demAsciiGrid';
import { writeGeoTiff } from './demGeoTiff';
import { buildZip, type ZipEntry } from '../../convert/zipStore';

export interface DemPackageOptions {
  /** Absolute world origin (cloud origin x/y) added to the grid frame. */
  readonly worldOrigin?: { readonly x: number; readonly y: number } | null;
  /** Base filename (no extension) for the entries. Default 'terrain'. */
  readonly basename?: string;
  /** CRS WKT for the .prj sidecar, when available. */
  readonly wkt?: string | null;
  /** True when the horizontal CRS is geographic (lat/lon, degree cells). */
  readonly isGeographic?: boolean;
  /** ISO generation timestamp. Default `new Date().toISOString()`. */
  readonly generationDateIso?: string;
  /** Producing software name. Default 'OpenLiDARViewer'. */
  readonly softwareName?: string;
  /** Producing software version. Default 'unknown'. */
  readonly softwareVersion?: string;
  /** Terrain metric version (e.g. 'v0.4.1'). Default 'unknown'. */
  readonly metricVersion?: string;
}

/** Parse an "EPSG:1234" identifier to its numeric code, or null. */
export function parseEpsg(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /(?:EPSG:)?(\d{3,6})/i.exec(id);
  return m ? Number(m[1]) : null;
}

const NO_DATA = -9999;

/** Print a numeric coordinate at full precision, or an explicit fallback. */
function coord(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? String(v) : 'unknown';
}

/**
 * Reconstruct the DSM (top surface) and CHM (canopy height) coverage from the
 * bare-earth DTM and the per-cell canopy height.
 *
 * DSM = DTM + canopy height, defined only where BOTH the canopy height is
 * finite AND the DTM has a ground reference at that cell (otherwise there is no
 * height to add the canopy onto). CHM coverage is wherever the canopy height is
 * finite — the above-ground figure stands on its own. NaN canopy → no DSM/CHM.
 *
 * Pure, deterministic, allocation-only; exported for direct unit testing.
 */
export function reconstructDsmChm(
  dtmZ: ArrayLike<number>,
  dtmCoverage: ArrayLike<number>,
  canopyHeight: ArrayLike<number>,
): { dsmZ: Float32Array; dsmCov: Uint8Array; chmCov: Uint8Array } {
  const n = dtmZ.length;
  const dsmZ = new Float32Array(n);
  const dsmCov = new Uint8Array(n);
  const chmCov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = canopyHeight[i];
    if (Number.isFinite(h)) {
      chmCov[i] = 1;
      if (dtmCoverage[i] !== 0 && Number.isFinite(dtmZ[i])) {
        dsmZ[i] = dtmZ[i] + h;
        dsmCov[i] = 1;
      }
    }
  }
  return { dsmZ, dsmCov, chmCov };
}

/** Options for {@link buildDemReadme}. */
export interface DemReadmeOptions {
  readonly result: AnalyseContoursResult;
  readonly basename: string;
  readonly isGeographic: boolean;
  /** Bounds extent in CRS units (lower-left + upper-right). null when unknown. */
  readonly boundsMinX: number | null;
  readonly boundsMinY: number | null;
  readonly boundsMaxX: number | null;
  readonly boundsMaxY: number | null;
  readonly generationDateIso: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly metricVersion: string;
}

/** Map a coverage mode to a one-line plain-English label. */
function coverageLabel(mode: string): string {
  switch (mode) {
    case 'full': return 'full (every source point participated)';
    case 'resident-only': return 'resident-only (streaming scan — only resident nodes were walked)';
    case 'sampled': return 'sampled (a stride / random subset was analysed under budget)';
    default: return mode || 'unknown';
  }
}

/**
 * Build the metadata README that travels with the rasters. ALWAYS self-
 * documenting: CRS + status, vertical datum + status, no-data, cell size, a
 * real bounds extent, coverage mode, quality-gate verdict + status, the
 * warnings list, generation parameters, generation date, and software +
 * version + metric version. Leads with a PRELIMINARY caveat when the data is
 * not full + ready, so a partial / preview export can never read as final.
 */
export function buildDemReadme(opts: DemReadmeOptions): string {
  const { result, basename, isGeographic } = opts;
  const dtm = result.dtm;
  const quality = result.quality;

  // ONE provenance object — the SAME builder every other export uses — so the
  // README's reference frame, verdicts, accuracy, software + version and date
  // are word-for-word identical to the GeoJSON / DXF / SVG / map sheet.
  const p = buildExportProvenance(result, {
    basename,
    generatedAt: opts.generationDateIso,
    softwareVersion: opts.softwareVersion,
    metricVersion: opts.metricVersion,
  });

  const cov = (() => {
    let measured = 0; let interp = 0; const total = dtm.coverage.length;
    for (let i = 0; i < dtm.coverage.length; i++) {
      if (dtm.coverage[i] === 2) measured++;
      else if (dtm.coverage[i] === 1) interp++;
    }
    return { measured, interp, total };
  })();
  const pct = (n: number): string => (cov.total ? `${Math.round((100 * n) / cov.total)}%` : '—');
  const hUnit = isGeographic ? 'degrees' : 'm';
  const reasons = quality?.reasons ?? [];
  const exportReasons = quality?.exportReasons ?? [];
  const warnings = result.warnings ?? [];

  // Prominent top caveat when the GEOREFERENCED export is anything short of full
  // coverage + export-ready. The DEM is the georeferenced deliverable, so its
  // caveat keys off the unified EXPORT readiness verdict (which already gates on
  // a known CRS + vertical datum) — a clean surface with an unknown datum still
  // reads PRELIMINARY here. The reason is named inline.
  const isFull = p.coverageMode === 'full';
  const isExportReady = p.exportReadiness === 'Ready';
  const caveatNote = p.exportReason ? ` (${p.exportReason})` : '';
  const lines: string[] = [];
  if (!isFull || !isExportReady) {
    lines.push(
      `*** PRELIMINARY DEM — coverage: ${p.coverageMode}; export readiness: ${p.exportReadiness}${caveatNote}. ***`,
      `*** Not for reliable terrain products. Treat heights and extents as`,
      `*** provisional and read the Quality gate + Warnings sections below.`,
      ``,
    );
  }

  lines.push(
    `OpenLiDARViewer — DEM export`,
    ``,
    `Files`,
    `  ${basename}-dtm.asc / .tif   Bare-earth digital terrain model (ground)`,
    `  ${basename}-dsm.asc / .tif   Digital surface model (top surface: canopy + structures)`,
    `  ${basename}-chm.asc / .tif   Canopy height model (above-ground height = DSM - DTM)`,
    `  *.prj                        Coordinate reference system (WKT), when known`,
    ``,
    `Raster`,
    `  Grid size      ${dtm.cols} x ${dtm.rows} cells`,
    `  Cell size      ${dtm.cellSizeM} ${hUnit}`,
    `  NODATA value   ${NO_DATA}`,
    `  Coverage       ${pct(cov.measured)} measured, ${pct(cov.interp)} interpolated`,
    `  Bounds (CRS units, ${isGeographic ? 'lon/lat degrees' : 'projected'})`,
    `    min X / min Y  ${coord(opts.boundsMinX)} / ${coord(opts.boundsMinY)}`,
    `    max X / max Y  ${coord(opts.boundsMaxX)} / ${coord(opts.boundsMaxY)}`,
    `  Elevation unit metres`,
    ``,
    `Coverage mode`,
    `  ${coverageLabel(p.coverageMode)}`,
    ``,
  );

  // Quality gate — the unified verdicts come from the provenance block below;
  // here we surface the gate's own per-axis REASON lists (surface + export
  // georeferencing) so a preview / blocked export explains itself in full.
  lines.push(`Quality gate`);
  if (reasons.length) {
    lines.push(`  Surface reasons`);
    for (const r of reasons) lines.push(`    - ${r}`);
  }
  if (exportReasons.length) {
    lines.push(`  Export reasons (georeferencing)`);
    for (const r of exportReasons) lines.push(`    - ${r}`);
  }
  if (!reasons.length && !exportReasons.length) {
    lines.push(`  (no gate reasons — see Export readiness in Provenance below)`);
  }
  lines.push(``);

  lines.push(`Warnings`);
  if (warnings.length) {
    for (const w of warnings) lines.push(`  - ${w}`);
  } else {
    lines.push(`  (none)`);
  }
  lines.push(``);

  // Generation parameters are derived from the actual run (result.generationParams),
  // never mirrored constants. If the field is somehow absent we say "unknown"
  // rather than silently asserting geodesic/on/on — provenance must stay honest.
  // (The contour STYLE lives in the Provenance block below — single-sourced — so
  // it can't drift from what the other exports stamp.)
  const gp = result.generationParams;
  const interpStr = gp ? `${gp.interpolation} void fill` : 'unknown';
  const despikeStr = gp
    ? (gp.despike ? 'on (blunder-only outlier removal)' : 'off')
    : 'unknown';
  const aggStr = gp ? gp.aggregation : 'unknown';
  lines.push(
    `Generation parameters`,
    `  Interpolation  ${interpStr}`,
    `  Cell aggregation ${aggStr}`,
    `  Despike        ${despikeStr}`,
    `  Grid cell size ${dtm.cellSizeM} ${hUnit}`,
    ``,
    // The unified provenance block — IDENTICAL lines to every other export.
    `Provenance`,
    ...provenanceLines(p).map((l) => `  ${l}`),
    ``,
    `The ASCII grids and GeoTIFFs describe the same surfaces; use whichever your`,
    `software prefers. Interpolated cells are real estimates between measured`,
    `ground; treat them with the coverage figure above in mind.`,
    ``,
  );

  return lines.join('\n');
}

/** Build a full DEM package (ZIP) from an analysis result. Returns ZIP bytes. */
export function buildDemPackage(
  result: AnalyseContoursResult,
  options: DemPackageOptions = {},
): Uint8Array {
  const dtm = result.dtm;
  const basename = options.basename || 'terrain';
  const ox = options.worldOrigin?.x ?? 0;
  const oy = options.worldOrigin?.y ?? 0;
  const xll = ox + dtm.originH1;
  const yll = oy + dtm.originH2;
  const cellSize = dtm.cellSizeM;
  const epsg = parseEpsg(dtm.crs);
  const verticalEpsg = parseEpsg(dtm.verticalDatum);
  const isGeographic = options.isGeographic ?? false;

  // Bounds extent in CRS units: lower-left corner of the lower-left cell to the
  // upper-right corner of the upper-right cell.
  const boundsMinX = xll;
  const boundsMinY = yll;
  const boundsMaxX = xll + dtm.cols * cellSize;
  const boundsMaxY = yll + dtm.rows * cellSize;

  // Reconstruct DSM = DTM + canopy height. Covered where the canopy height is
  // defined and the DTM carries a ground reference.
  const chm = result.surface.canopy.heightM;
  const { dsmZ, dsmCov, chmCov } = reconstructDsmChm(dtm.z, dtm.coverage, chm);

  const grids: Array<{ key: string; values: ArrayLike<number>; coverage: ArrayLike<number> }> = [
    { key: 'dtm', values: dtm.z, coverage: dtm.coverage },
    { key: 'dsm', values: dsmZ, coverage: dsmCov },
    { key: 'chm', values: chm, coverage: chmCov },
  ];

  const entries: ZipEntry[] = [];
  for (const g of grids) {
    const common = {
      values: g.values, coverage: g.coverage,
      cols: dtm.cols, rows: dtm.rows, cellSize, xllCorner: xll, yllCorner: yll, noData: NO_DATA,
    };
    entries.push({
      name: `${basename}-${g.key}.asc`,
      bytes: new TextEncoder().encode(writeAsciiGrid(common)),
    });
    entries.push({
      name: `${basename}-${g.key}.tif`,
      bytes: writeGeoTiff({ ...common, epsg, isGeographic, verticalEpsg }),
    });
  }

  if (options.wkt) {
    entries.push({ name: `${basename}.prj`, bytes: new TextEncoder().encode(options.wkt) });
  }
  const readme = buildDemReadme({
    result,
    basename,
    isGeographic,
    boundsMinX, boundsMinY, boundsMaxX, boundsMaxY,
    generationDateIso: options.generationDateIso ?? new Date().toISOString(),
    softwareName: options.softwareName ?? 'OpenLiDARViewer',
    softwareVersion: options.softwareVersion ?? 'unknown',
    metricVersion: options.metricVersion ?? 'unknown',
  });
  entries.push({
    name: `${basename}-README.txt`,
    bytes: new TextEncoder().encode(readme),
  });

  return buildZip(entries);
}
