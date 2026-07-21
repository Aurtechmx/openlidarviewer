#!/usr/bin/env node
/**
 * make-slope-fixture.mjs — the input DEM for the slope cross-implementation check.
 *
 * Writes `tests/fixtures/reference/slope/input-dem.asc`: an ESRI ASCII Grid
 * carrying an analytic surface whose slope is known in closed form.
 *
 * WHY A SYNTHETIC SURFACE. Comparing our Horn slope against GDAL's Horn slope
 * is two implementations of ONE algorithm, so they can agree while both being
 * wrong the same way — which is exactly the failure mode a same-algorithm pair
 * shares. An analytic surface adds a third, independent answer: if we and GDAL
 * agree with each other AND with the closed form, the agreement means
 * something. It also avoids shipping a licensed DEM, which would need an entry
 * in DATA_AVAILABILITY.md.
 *
 * WHY THIS SURFACE. z = a·x² + b·y² + c·x·y + d·x + e·y:
 *   - slope varies across the grid, so a constant-slope bug cannot hide;
 *   - a ≠ b makes it asymmetric in x and y, so transposing the axes changes
 *     the answer (a tilted plane or a cone would not catch that);
 *   - the cross and linear terms remove every MIRROR symmetry, which the pure
 *     quadratic still had. z = a·x² + b·y² is even in both x and y, so
 *     flipping the grid north-south leaves every slope value identical — and
 *     a north-south flip is the specific hazard here, because ASCII Grid
 *     writes the northern row first while our kernel treats row+1 as north.
 *     The first version of this fixture could not detect that flip: it was
 *     verified by feeding the test a deliberately flipped reference, which
 *     passed. Now it fails;
 *   - the gradient is still exact:
 *       ∂z/∂x = 2a·x + c·y + d
 *       ∂z/∂y = 2b·y + c·x + e
 *
 * ncols ≠ nrows for the same reason: a square grid hides a rows/cols swap.
 *
 * WHY ASCII GRID, not GeoTIFF. Reading a TIFF in Node needs a dependency this
 * project would carry in its SBOM forever. AAIGrid is a documented text format
 * GDAL reads and writes natively, it diffs in review, and parsing it is a few
 * lines with no dependency at all.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'tests/fixtures/reference/slope');

/** Grid geometry. Projected metric CRS, 1 m cells; UTM-like origin. */
export const GRID = {
  ncols: 120,
  nrows: 100,
  cellsize: 1.0,
  xllcorner: 500000.0,
  yllcorner: 4600000.0,
  nodata: -9999,
};

/**
 * Surface coefficients. `a != b` breaks the x/y transpose; `c`, `d` and `e`
 * break the mirror symmetries. See the header for why each is needed.
 */
export const SURFACE = { a: 0.002, b: 0.0008, c: 0.0006, d: 0.01, e: -0.02 };

/**
 * Cell-centre offsets from the grid centre, in metres.
 *
 * `row` is ASCII-Grid order: row 0 is the NORTHERNMOST row. The test converts
 * to our northing-up convention; this function stays in file order so the
 * written grid and the truth grid cannot disagree about it.
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
 * Writing happens only when this file is RUN, never when it is imported.
 *
 * The test imports `GRID` and `analyticSlopeDegrees` from here so the surface
 * has exactly one definition. Without this guard that import rewrote the
 * fixture as a side effect, which would let the test regenerate a corrupted or
 * hand-edited input and then pass against its own fresh copy — the committed
 * file would no longer be what was tested.
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
