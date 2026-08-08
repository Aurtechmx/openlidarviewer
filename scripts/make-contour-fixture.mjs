#!/usr/bin/env node
/**
 * make-contour-fixture.mjs — the input DEM for the CONTOURS cross-implementation
 * check (`tests/contourCrossCheck.test.ts`).
 *
 * Writes `tests/fixtures/reference/contour/input-dem.asc`: an ESRI ASCII Grid
 * carrying a TILTED PLANE whose contour lines are known in closed form.
 *
 * WHY A PLANE, NOT THE QUADRATIC SLOPE SURFACE. Contours are placed by linear
 * interpolation along grid-cell edges (marching squares here, the same in GDAL).
 * On a curved surface that interpolation is only approximate, and the error is
 * largest exactly where the gradient is small — so a level-residual metric on a
 * quadratic would fail contours in near-flat regions for a reason that is not a
 * bug. On a plane the edge value varies linearly, so linear interpolation finds
 * the crossing EXACTLY: our contour, GDAL's contour, and the analytic line all
 * coincide to floating-point precision, and the tolerance measures agreement,
 * not interpolation noise.
 *
 * WHY THIS PLANE. z(X, Y) = sx·(X − Xc) + sy·(Y − Yc) + z0 with sx ≠ sy:
 *   - distinct gradients in X and Y, so a transpose (rows↔cols) rotates the
 *     lines and moves every vertex off the analytic locus — caught;
 *   - a non-square grid (ncols ≠ nrows) makes a rows/cols swap a shape error;
 *   - ASCII Grid writes the NORTH row first while our DtmGrid is south-up, so a
 *     missed row flip when the test rebuilds the grid moves the lines to the
 *     wrong Y and the residual catches it.
 *
 * The analytic contour at level L is the world line sx·(X − Xc) + sy·(Y − Yc)
 * + z0 = L. `analyticElevation(X, Y)` returns the surface value at any world
 * point, so the test can check that every contour vertex sits on its level.
 *
 * Deterministic, no randomness. Re-running writes byte-identical output.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../tests/fixtures/reference/contour');

/** Grid geometry — non-square, world-referenced like the slope fixture. */
export const GRID = {
  ncols: 120,
  nrows: 100,
  cellsize: 1.0,
  xllcorner: 500000.0,
  yllcorner: 4600000.0,
  nodata: -9999,
};

/** Plane coefficients. sx ≠ sy so a transpose cannot hide. */
export const PLANE = { sx: 0.03, sy: 0.017, z0: 5.0 };

/** World centre the plane tilts about, so z stays in a tidy positive band. */
const Xc = GRID.xllcorner + (GRID.ncols * GRID.cellsize) / 2;
const Yc = GRID.yllcorner + (GRID.nrows * GRID.cellsize) / 2;

/** The surface elevation at any WORLD point — the analytic truth. */
export function analyticElevation(X, Y) {
  return PLANE.sx * (X - Xc) + PLANE.sy * (Y - Yc) + PLANE.z0;
}

/** World cell-centre for an ASCII-Grid file row (0 = NORTH) and column. */
export function cellCentreWorld(fileRow, col) {
  const X = GRID.xllcorner + (col + 0.5) * GRID.cellsize;
  const Y = GRID.yllcorner + (GRID.nrows - fileRow - 0.5) * GRID.cellsize;
  return [X, Y];
}

/** Write the DEM as an ESRI ASCII Grid (north row first). */
function writeAsc(path) {
  const head = [
    `ncols ${GRID.ncols}`,
    `nrows ${GRID.nrows}`,
    `xllcorner ${GRID.xllcorner}`,
    `yllcorner ${GRID.yllcorner}`,
    `cellsize ${GRID.cellsize}`,
    `NODATA_value ${GRID.nodata}`,
  ];
  const rows = [];
  for (let r = 0; r < GRID.nrows; r++) {
    const row = [];
    for (let c = 0; c < GRID.ncols; c++) {
      const [X, Y] = cellCentreWorld(r, c);
      row.push(analyticElevation(X, Y).toFixed(6));
    }
    rows.push(row.join(' '));
  }
  writeFileSync(path, `${head.join('\n')}\n${rows.join('\n')}\n`, 'utf8');
}

// Run as a script: write the DEM. The GDAL reference is produced separately by
// the documented `gdal_contour` command (see docs/validation/cross-implementation.md).
if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT_DIR, { recursive: true });
  const demPath = resolve(OUT_DIR, 'input-dem.asc');
  writeAsc(demPath);
  console.log(`wrote ${demPath}`);
}
