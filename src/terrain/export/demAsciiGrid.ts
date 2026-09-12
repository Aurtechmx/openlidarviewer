/**
 * demAsciiGrid.ts
 *
 * Serialize an elevation grid to the Esri ASCII Grid format (AAIGrid) — the
 * plain-text DEM format read natively by QGIS, ArcGIS and GDAL. The header
 * carries the georeferencing (lower-left corner + square cell size) and the
 * no-data sentinel; the body lists rows from NORTH (top) down to south, each
 * row left→right, matching the AAIGrid convention.
 *
 * Pure-data: no DOM, deterministic, unit-testable.
 */

export interface DemGridInput {
  /** Row-major cell values; length === cols*rows. */
  readonly values: ArrayLike<number>;
  /** 0 = no data at this cell (written as the NODATA sentinel). */
  readonly coverage: ArrayLike<number>;
  readonly cols: number;
  readonly rows: number;
  /** Square cell size in ground units. */
  readonly cellSize: number;
  /** World X (east) of the lower-left corner of the lower-left cell. */
  readonly xllCorner: number;
  /** World Y (north) of the lower-left corner of the lower-left cell. */
  readonly yllCorner: number;
  /** Sentinel written for empty cells. Default -9999. */
  readonly noData?: number;
  /** Decimal places for elevation values. Default 3. */
  readonly precision?: number;
}

/** Format `n` with fixed precision but no trailing-zero noise beyond it. */
function fmt(n: number, precision: number): string {
  return Number.isFinite(n) ? n.toFixed(precision) : '';
}

/** Serialize an elevation grid to Esri ASCII Grid (AAIGrid) text. */
export function writeAsciiGrid(input: DemGridInput): string {
  const { values, coverage, cols, rows, cellSize, xllCorner, yllCorner } = input;
  const noData = input.noData ?? -9999;
  const precision = input.precision ?? 3;
  // The GeoTIFF writer validates its input; this one emitted whatever it was
  // handed. A cols x rows that does not match the arrays writes a raster whose
  // rows are read from the wrong offsets, and a non-finite origin or cell size
  // writes a header no GIS can place.
  const isCount = (v: number): boolean => Number.isInteger(v) && v > 0;
  if (!isCount(cols) || !isCount(rows)) {
    throw new RangeError(`writeAsciiGrid: cols and rows must be positive integers; got ${cols} x ${rows}`);
  }
  if (values.length !== cols * rows || coverage.length !== cols * rows) {
    throw new RangeError(
      `writeAsciiGrid: ${cols} x ${rows} cells but ${values.length} values and ${coverage.length} coverage entries`,
    );
  }
  if (!(Number.isFinite(cellSize) && cellSize > 0)) {
    throw new RangeError(`writeAsciiGrid: cellSize must be a finite positive length; got ${cellSize}`);
  }
  if (!Number.isFinite(xllCorner) || !Number.isFinite(yllCorner)) {
    throw new RangeError(`writeAsciiGrid: origin must be finite; got (${xllCorner}, ${yllCorner})`);
  }
  if (!Number.isFinite(noData)) throw new RangeError(`writeAsciiGrid: NODATA must be finite; got ${noData}`);
  if (!(Number.isInteger(precision) && precision >= 0 && precision <= 20)) {
    throw new RangeError(`writeAsciiGrid: precision must be an integer in [0, 20]; got ${precision}`);
  }

  const head =
    `ncols ${cols}\n` +
    `nrows ${rows}\n` +
    `xllcorner ${xllCorner}\n` +
    `yllcorner ${yllCorner}\n` +
    `cellsize ${cellSize}\n` +
    `NODATA_value ${noData}\n`;

  const noDataStr = String(noData);
  const lines: string[] = [];
  // AAIGrid lists the NORTH-most row first. Our grid is row-major with row 0 at
  // the south (min Y), so emit rows from (rows-1) down to 0.
  for (let row = rows - 1; row >= 0; row--) {
    const base = row * cols;
    const cells: string[] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      cells[c] = coverage[i] !== 0 && Number.isFinite(values[i]) ? fmt(values[i], precision) : noDataStr;
    }
    lines.push(cells.join(' '));
  }
  return head + lines.join('\n') + '\n';
}
