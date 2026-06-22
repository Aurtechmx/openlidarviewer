/**
 * changeRaster.ts
 *
 * Serialise a two-epoch elevation difference to an ESRI ASCII grid (`.asc`) —
 * the simplest georeferenced raster QGIS / ArcGIS read directly. The values are
 * the signed difference in metres (after − before; positive = gain); cells that
 * were empty in either epoch are written as NODATA, never as a real 0.
 *
 * Pure data: no DOM, no I/O. The caller supplies the grid's lower-left corner in
 * the scan's projected coordinates (DTM origin + cloud origin) so the raster
 * lands in the right place; the row order is flipped to ESRI's north-first
 * convention (the diff grid is stored south-row-first).
 */

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
  /** NODATA sentinel written for incomparable (NaN) cells. Default -9999. */
  readonly nodata?: number;
}

/** Format a finite number to at most `d` decimals, trailing zeros trimmed. */
function num(v: number, d = 3): string {
  const f = 10 ** d;
  return String(Math.round(v * f) / f);
}

/**
 * Build an ESRI ASCII grid string from a change difference. Rows are emitted
 * north-first (grid row `nrows-1` down to `0`), matching the `.asc` convention.
 */
export function changeToEsriAscii(input: ChangeRasterInput): string {
  const nodata = input.nodata ?? -9999;
  const { diff, ncols, nrows, cellSizeM, xllCorner, yllCorner } = input;
  const lines: string[] = [
    `ncols ${ncols}`,
    `nrows ${nrows}`,
    `xllcorner ${num(xllCorner)}`,
    `yllcorner ${num(yllCorner)}`,
    `cellsize ${num(cellSizeM)}`,
    `NODATA_value ${nodata}`,
  ];
  // ESRI ASCII lists the NORTH row first; our grid is stored south-row-first.
  for (let row = nrows - 1; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < ncols; col++) {
      const v = diff[row * ncols + col];
      cells.push(Number.isFinite(v) ? num(v) : String(nodata));
    }
    lines.push(cells.join(' '));
  }
  return lines.join('\n') + '\n';
}
