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
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
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
}

/** Parse an "EPSG:1234" identifier to its numeric code, or null. */
export function parseEpsg(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /(?:EPSG:)?(\d{3,6})/i.exec(id);
  return m ? Number(m[1]) : null;
}

const NO_DATA = -9999;

function fmt(v: number | null | undefined, d = 2): string {
  return v != null && Number.isFinite(v) ? v.toFixed(d) : '—';
}

/** Build the metadata README that travels with the rasters. */
function buildReadme(result: AnalyseContoursResult, basename: string, isGeographic: boolean): string {
  const dtm = result.dtm;
  const acc = result.accuracyStandards;
  const cov = (() => {
    let measured = 0; let interp = 0; let total = dtm.coverage.length;
    for (let i = 0; i < dtm.coverage.length; i++) {
      if (dtm.coverage[i] === 2) measured++;
      else if (dtm.coverage[i] === 1) interp++;
    }
    return { measured, interp, total };
  })();
  const pct = (n: number): string => (cov.total ? `${Math.round((100 * n) / cov.total)}%` : '—');
  const hUnit = isGeographic ? 'degrees' : 'm';

  return [
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
    ``,
    `Reference system`,
    `  Horizontal CRS ${dtm.crs ?? 'unknown'}`,
    `  Vertical datum ${dtm.verticalDatum ?? 'unknown'}`,
    `  Elevation unit metres`,
    ``,
    `Validated accuracy`,
    `  Vertical RMSEz ${fmt(acc.rmseZM)} m`,
    `  NVA (95%)      ${fmt(acc.nvaM)} m   (non-vegetated vertical accuracy, RMSEz x 1.96)`,
    `  VVA (95th pct) ${fmt(acc.vvaM)} m   (vegetated vertical accuracy)`,
    `  Point density  ${fmt(acc.pointDensityPerM2, 1)} pts/m²`,
    `  USGS 3DEP      ${acc.qualityLevel} — ${acc.qualityLevelReason}`,
    ``,
    `The ASCII grids and GeoTIFFs describe the same surfaces; use whichever your`,
    `software prefers. Interpolated cells are real estimates between measured`,
    `ground; treat them with the coverage figure above in mind.`,
    ``,
  ].join('\n');
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

  // Reconstruct DSM = DTM + canopy height (= max(DTM, DSM)). Covered where the
  // canopy height is defined (both surfaces present at that cell).
  const n = dtm.z.length;
  const chm = result.surface.canopy.heightM;
  const dsmZ = new Float32Array(n);
  const dsmCov = new Uint8Array(n);
  const chmCov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = chm[i];
    if (Number.isFinite(h)) {
      chmCov[i] = 1;
      if (dtm.coverage[i] !== 0 && Number.isFinite(dtm.z[i])) {
        dsmZ[i] = dtm.z[i] + h;
        dsmCov[i] = 1;
      }
    }
  }

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
  entries.push({
    name: `${basename}-README.txt`,
    bytes: new TextEncoder().encode(buildReadme(result, basename, isGeographic)),
  });

  return buildZip(entries);
}
