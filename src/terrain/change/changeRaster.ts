/**
 * changeRaster.ts
 *
 * Serialise a two-epoch elevation difference to an ESRI ASCII grid (`.asc`) —
 * the simplest georeferenced raster QGIS / ArcGIS read directly. The values are
 * the signed difference in metres (after − before; positive = gain); cells that
 * were empty in either epoch are written as NODATA, never as a real 0.
 *
 * Precision. The header (xllcorner, yllcorner, cellsize) is written at full
 * double precision, as the shortest text that reads back to the same number, so
 * a geographic grid (cell size ~2e-6 degrees, origin -99.1234567) keeps its
 * georeferencing. Cell values are written as the shortest text that reads back to
 * the same Float32, independent of the header; no nonzero difference becomes 0.
 * The NODATA sentinel is -9999 unless a real difference reads back as -9999, in
 * which case it moves below every written value (the DEM exports' rule).
 *
 * Pure data: no DOM, no I/O. The caller supplies the grid's lower-left corner in
 * the scan's projected coordinates (DTM origin + cloud origin) so the raster
 * lands in the right place; the row order is flipped to ESRI's north-first
 * convention (the diff grid is stored south-row-first).
 */

import { chooseNoData, assertNoDataClear } from '../export/demNoData';
import { wktForEpsg } from '../../io/epsgWkt';

export interface ChangeRasterInput {
  /** Signed difference per cell, row-major, south row first; NaN = incomparable. */
  readonly diff: Float32Array;
  readonly ncols: number;
  readonly nrows: number;
  readonly cellSizeM: number;
  /** Lower-left corner X (west) in the scan's projected coordinates. */
  readonly xllCorner: number;
  /** Lower-left corner Y (south) in the scan's projected coordinates. */
  readonly yllCorner: number;
  /**
   * NODATA sentinel written for incomparable (NaN) cells. Omitted: -9999, or a
   * value below every written difference when one reads back as -9999. A given
   * value that a written difference reads back as is refused.
   */
  readonly nodata?: number;
}

/** Shortest text that reads back to the same double. */
function exact(v: number): string {
  return String(v);
}

/** Shortest text (at least 6 significant digits) that reads back to the same Float32. */
function float32Text(v: number): string {
  const f = Math.fround(v);
  for (let p = 6; p < 9; p++) {
    const t = Number(f.toPrecision(p));
    if (Math.fround(t) === f) return String(t);
  }
  return String(Number(f.toPrecision(9)));
}

function validate(input: ChangeRasterInput): void {
  const { diff, ncols, nrows, cellSizeM, xllCorner, yllCorner } = input;
  const isCount = (v: number): boolean => Number.isInteger(v) && v > 0;
  if (!isCount(ncols) || !isCount(nrows)) {
    throw new RangeError(`changeToEsriAscii: ncols and nrows must be positive integers; got ${ncols} x ${nrows}`);
  }
  if (diff.length !== ncols * nrows) {
    throw new RangeError(`changeToEsriAscii: ${ncols} x ${nrows} cells but ${diff.length} difference values`);
  }
  if (!(Number.isFinite(cellSizeM) && cellSizeM > 0)) {
    throw new RangeError(`changeToEsriAscii: cellSizeM must be a finite positive length; got ${cellSizeM}`);
  }
  if (!Number.isFinite(xllCorner) || !Number.isFinite(yllCorner)) {
    throw new RangeError(`changeToEsriAscii: origin must be finite; got (${xllCorner}, ${yllCorner})`);
  }
  if (input.nodata != null && !Number.isFinite(input.nodata)) {
    throw new RangeError(`changeToEsriAscii: nodata must be finite; got ${input.nodata}`);
  }
}

/** The NODATA value changeToEsriAscii writes for this input. */
export function changeRasterNoData(input: ChangeRasterInput): number {
  const coverage = Uint8Array.from(input.diff, (v) => (Number.isFinite(v) ? 1 : 0));
  const grid = [{ values: input.diff, coverage }];
  const opts = { serialisations: ['float32'] as const };
  if (input.nodata == null) return chooseNoData(grid, opts);
  assertNoDataClear(grid, input.nodata, opts);
  return input.nodata;
}

/**
 * Build an ESRI ASCII grid string from a change difference. Rows are emitted
 * north-first (grid row `nrows-1` down to `0`), matching the `.asc` convention.
 */
export function changeToEsriAscii(input: ChangeRasterInput): string {
  validate(input);
  const nodata = changeRasterNoData(input);
  const { diff, ncols, nrows, cellSizeM, xllCorner, yllCorner } = input;
  const lines: string[] = [
    `ncols ${ncols}`,
    `nrows ${nrows}`,
    `xllcorner ${exact(xllCorner)}`,
    `yllcorner ${exact(yllCorner)}`,
    `cellsize ${exact(cellSizeM)}`,
    `NODATA_value ${nodata}`,
  ];
  const noDataText = String(nodata);
  // ESRI ASCII lists the NORTH row first; our grid is stored south-row-first.
  for (let row = nrows - 1; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < ncols; col++) {
      const v = diff[row * ncols + col];
      cells.push(Number.isFinite(v) ? float32Text(v) : noDataText);
    }
    lines.push(cells.join(' '));
  }
  return lines.join('\n') + '\n';
}

/** The horizontal CRS the raster's origin and cell size are expressed in. */
export interface ChangeRasterCrs {
  readonly kind: 'projected' | 'geographic' | 'geocentric' | 'local' | 'unknown';
  readonly name: string;
  readonly epsg?: number;
  readonly wkt?: string;
}

export interface ChangeRasterSidecarInput {
  readonly crs: ChangeRasterCrs;
  /** Unit the cell values are written in, e.g. "metre". */
  readonly valueUnit: string;
  readonly beforeScan: string;
  readonly afterScan: string;
  /** From {@link changeRasterNoData}. */
  readonly nodata: number;
}

export interface ChangeRasterSidecars {
  /** Projection file text; null for a local-coordinate scan, which has no CRS to name. */
  readonly prj: string | null;
  /** Plain-text metadata sidecar. */
  readonly metadata: string;
}

/** Thrown when the raster cannot be georeferenced correctly. */
export class ChangeRasterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeRasterRefusal';
  }
}

/**
 * The .prj and metadata sidecars for a change raster. Refuses when the CRS is
 * unknown, or is projected or geographic but no WKT can be written for it,
 * rather than packaging a raster whose georeferencing a GIS would misread.
 */
export function changeRasterSidecars(input: ChangeRasterSidecarInput): ChangeRasterSidecars {
  const { crs } = input;
  let prj: string | null = null;
  if (crs.kind === 'unknown') {
    throw new ChangeRasterRefusal(
      'Difference raster not written: the scans have no declared coordinate reference system, so the grid could not be placed. Set a CRS in the Inspector and compare again.',
    );
  }
  if (crs.kind === 'geocentric') {
    throw new ChangeRasterRefusal(
      `Difference raster not written: "${crs.name}" is a geocentric CRS (Earth-centred X/Y/Z), which has no ground plane to grid on.`,
    );
  }
  if (crs.kind === 'projected' || crs.kind === 'geographic') {
    prj = crs.wkt?.trim() || wktForEpsg(crs.epsg) || null;
    if (!prj) {
      throw new ChangeRasterRefusal(
        `Difference raster not written: no projection definition is available for the ${crs.kind} CRS "${crs.name}", so a .prj could not be written and the grid would be misplaced.`,
      );
    }
  }
  const metadata = [
    'Change raster metadata',
    `CRS: ${crs.kind === 'local' ? 'local coordinates (no CRS)' : crs.name}`,
    `EPSG: ${crs.epsg ?? 'not declared'}`,
    `Horizontal CRS kind: ${crs.kind}`,
    `Cell value unit: ${input.valueUnit}`,
    'Comparison basis: after minus before (positive = gain)',
    `Before scan: ${input.beforeScan}`,
    `After scan: ${input.afterScan}`,
    `NODATA value: ${input.nodata}`,
    '',
  ].join('\n');
  return { prj, metadata };
}

/** The .asc text and its sidecar files, ready to hold for download. */
export interface ChangeRasterFiles {
  readonly asc: () => string;
  readonly sidecars: readonly { readonly suffix: string; readonly text: string }[];
}

/** Validate the grid and CRS once, then package the .asc with its .prj and metadata. Throws {@link ChangeRasterRefusal}. */
export function packageChangeRaster(
  input: ChangeRasterInput,
  ctx: Omit<ChangeRasterSidecarInput, 'nodata'>,
): ChangeRasterFiles {
  validate(input);
  const side = changeRasterSidecars({ ...ctx, nodata: changeRasterNoData(input) });
  return {
    asc: () => changeToEsriAscii(input),
    sidecars: [
      ...(side.prj ? [{ suffix: '.prj', text: side.prj }] : []),
      { suffix: '-metadata.txt', text: side.metadata },
    ],
  };
}
