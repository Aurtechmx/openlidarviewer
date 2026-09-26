/**
 * Shared scaffolding for the DEM package raster tests: the analysis result
 * around a hand-built DTM grid, the package options, and a reader for the
 * single-strip, pixel-interleaved GeoTIFFs the package writes.
 */

import type { AnalyseContoursResult } from '../../src/terrain/contour/analyseContours';
import type { DtmGrid } from '../../src/terrain/ground/cellConfidence';

/** An analysis result around `grid`, georeferenced in EPSG:32610. */
export function demResultFor(grid: Record<string, unknown> & { cols: number; rows: number }, verticalUnitToMetres = 1): AnalyseContoursResult {
  return demResultAround({
    ...grid,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: 5703, verticalUnitToMetres,
    coverageMode: 'full', sourcePointCount: 100, analyzedPointCount: 100, warnings: [],
  } as unknown as DtmGrid);
}

/** An analysis result around `dtm` exactly as given. */
export function demResultAround(dtm: DtmGrid): AnalyseContoursResult {
  return {
    dtm,
    intervalM: 1,
    surface: { canopy: { heightM: new Float32Array(dtm.cols * dtm.rows).fill(Number.NaN) } },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: { measured: 0, interpolated: 0, lowConfidence: 0, edgeRisk: 0, empty: 0, total: 0 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

export const DEM_PKG_OPTS = {
  basename: 'terrain',
  worldOrigin: { x: 600000, y: 4000000 },
  generationDateIso: '2026-01-01T00:00:00.000Z',
} as const;

/**
 * Decode every band of a single-strip GeoTIFF, south row first. `read(dv, o)`
 * reads one sample at byte offset `o`; `size` is its width in bytes.
 */
export function decodeBands<T extends Uint8Array | Float32Array>(
  bytes: Uint8Array,
  make: (n: number) => T,
  size: number,
  read: (dv: DataView, o: number) => number,
): T[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = dv.getUint32(4, true);
  const count = dv.getUint16(start, true);
  const tags = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const p = start + 2 + k * 12;
    const type = dv.getUint16(p + 2, true);
    tags.set(dv.getUint16(p, true), type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true));
  }
  const cols = tags.get(256)!;
  const rows = tags.get(257)!;
  const spp = tags.get(277)!;
  let o = tags.get(273)!;
  const bands = Array.from({ length: spp }, () => make(cols * rows));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let b = 0; b < spp; b++) {
        bands[b][(rows - 1 - r) * cols + c] = read(dv, o);
        o += size;
      }
    }
  }
  return bands;
}
