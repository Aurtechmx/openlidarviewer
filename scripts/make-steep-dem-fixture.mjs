#!/usr/bin/env node
/**
 * make-steep-dem-fixture.mjs — a steep analytic DEM, for the slope range the
 * existing fixture does not reach.
 *
 * Writes `tests/fixtures/dem-steep/input-dem.asc`.
 *
 * WHY A SECOND SURFACE. `scripts/make-slope-fixture.mjs` writes the DEM behind
 * the slope, aspect and hillshade references, and its own register record says
 * what it cannot settle: "Slope range is roughly 0.05 to 16.4 degrees, so steep
 * terrain is untested." Two Horn implementations agreeing at 16 degrees is not
 * evidence about their behaviour at 60. Horn's kernel is a finite-difference
 * approximation over a 3x3 window, and the gap between it and the true gradient
 * grows with slope and curvature, so the untested end of the range is also the
 * end where the approximation is weakest. This surface covers it.
 *
 * WHY NOT WIDEN THE EXISTING FIXTURE. That DEM is frozen: three committed GDAL
 * reference rasters and their recorded checksums are keyed to those exact bytes.
 * Changing its coefficients would invalidate all three at once. A second file
 * costs 100 kB and leaves the first one alone.
 *
 * WHY THIS SURFACE. Same family as the base fixture,
 * z = a.x^2 + b.y^2 + c.x.y + d.x + e.y, so the same reasoning carries over:
 *   - slope varies across the grid, so a constant-slope bug cannot hide;
 *   - a != b makes it asymmetric in x and y, so transposing the axes changes
 *     the answer;
 *   - the cross and linear terms remove every mirror symmetry, so a
 *     north-south flip is detectable — the hazard that ASCII Grid's
 *     northern-row-first order creates against a kernel treating row+1 as
 *     north;
 *   - the gradient is exact:
 *       dz/dx = 2a.x + c.y + d
 *       dz/dy = 2b.y + c.x + e
 *
 * WHY THESE COEFFICIENTS. Chosen so the slope range is about 15.3 to 65.6
 * degrees. That abuts the base fixture's 0.05 to 16.1 with a narrow overlap
 * band rather than a gap, so the pair covers 0 to 65 degrees continuously and
 * the overlap is a place the two can be checked for consistency.
 *
 * NO FLAT CELLS. The stationary point of this surface (where both partial
 * derivatives vanish) lies outside the grid, so the gradient never reaches zero
 * and the minimum slope is 15.3 degrees. The base fixture has near-flat cells
 * that its aspect test has to exclude; this one does not, so aspect would be
 * defined on every cell. No aspect or hillshade closed form is exported here
 * because nothing needs one yet — this file is an input DEM, not a reference
 * set.
 *
 * NO GDAL OUTPUT. Nothing in `tests/fixtures/dem-steep/` is a reference raster.
 * The reference directories under `tests/fixtures/reference/` each carry a
 * `command.txt` and an `environment.json` recording the GDAL run that produced
 * them; this directory has neither, because no run has happened. The DEM is
 * registered as a dataset so a study can cite it; a registered dataset is
 * provenance written down, not a result.
 *
 * ASCII Grid for the same reason as the base fixture: a documented text format
 * GDAL reads natively, diffable in review, parsed in a few lines with no
 * dependency.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'tests/fixtures/dem-steep');

/**
 * Grid geometry. Deliberately identical to the base fixture's: same shape, same
 * cell size, same origin, so a comparison between the two isolates the surface
 * and not the framing. `ncols != nrows` still, because a square grid hides a
 * rows/cols swap.
 */
export const GRID = {
  ncols: 120,
  nrows: 100,
  cellsize: 1.0,
  xllcorner: 500000.0,
  yllcorner: 4600000.0,
  nodata: -9999,
};

/** Surface coefficients. See the header for how the range was chosen. */
export const SURFACE = { a: 0.011, b: 0.004, c: 0.003, d: 0.75, e: -0.55 };

/**
 * Cell-centre offsets from the grid centre, in metres.
 *
 * `row` is ASCII-Grid order: row 0 is the NORTHERNMOST row. Kept in file order
 * so the written grid and any truth grid derived from it cannot disagree about
 * which way is north.
 */
export function cellOffset(row, col) {
  const cx = (GRID.ncols * GRID.cellsize) / 2;
  const cy = (GRID.nrows * GRID.cellsize) / 2;
  const x = (col + 0.5) * GRID.cellsize - cx;
  // Row 0 is north, so northing DECREASES as row increases.
  const y = (GRID.nrows - row - 0.5) * GRID.cellsize - cy;
  return { x, y };
}

/** Surface height at a cell centre. */
export function heightAt(row, col) {
  const { x, y } = cellOffset(row, col);
  const { a, b, c, d, e } = SURFACE;
  return a * x * x + b * y * y + c * x * y + d * x + e * y;
}

/** Closed-form slope at a cell centre, in DEGREES. */
export function analyticSlopeDegrees(row, col) {
  const { x, y } = cellOffset(row, col);
  const { a, b, c, d, e } = SURFACE;
  const dzdx = 2 * a * x + c * y + d;
  const dzdy = 2 * b * y + c * x + e;
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

function writeAsciiGrid(path, valueAt) {
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
    // Six decimals: well inside float32, and enough that the written file is
    // not itself a source of disagreement at a 0.5 degree tolerance.
    for (let c = 0; c < GRID.ncols; c++) row.push(valueAt(r, c).toFixed(6));
    rows.push(row.join(' '));
  }
  writeFileSync(path, `${head.join('\n')}\n${rows.join('\n')}\n`, 'utf8');
}

/**
 * Writing happens only when this file is RUN, never when it is imported, for
 * the same reason as the base fixture: an import that rewrote the grid as a
 * side effect would let a test regenerate a corrupted input and then pass
 * against its own fresh copy.
 */
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const demPath = resolve(OUT_DIR, 'input-dem.asc');
  writeAsciiGrid(demPath, heightAt);

  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < GRID.nrows; r++) {
    for (let c = 0; c < GRID.ncols; c++) {
      const s = analyticSlopeDegrees(r, c);
      if (s < min) min = s;
      if (s > max) max = s;
    }
  }
  console.log(`wrote ${demPath}`);
  console.log(`  ${GRID.ncols} x ${GRID.nrows} cells @ ${GRID.cellsize} m`);
  console.log(`  analytic slope range: ${min.toFixed(3)}deg .. ${max.toFixed(3)}deg`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
