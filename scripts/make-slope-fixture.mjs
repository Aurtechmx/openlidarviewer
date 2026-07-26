#!/usr/bin/env node
/**
 * make-slope-fixture.mjs — the input DEM for the slope, aspect and hillshade
 * cross-implementation checks.
 *
 * Writes `tests/fixtures/reference/slope/input-dem.asc`: an ESRI ASCII Grid
 * carrying an analytic surface whose slope, aspect AND hillshade are known in
 * closed form. The aspect reference (`tests/fixtures/reference/aspect/`) and
 * the hillshade reference (`tests/fixtures/reference/hillshade/`) reuse this
 * same DEM rather than copying it, so the three products cannot end up
 * validated against three different surfaces.
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

/**
 * Closed-form ASPECT at a cell centre, in COMPASS DEGREES clockwise from north
 * (0 = north, 90 = east), which is what `gdaldem aspect` emits.
 *
 * Same `SURFACE` coefficients and same `cellOffset` as the slope above, so the
 * surface has exactly ONE definition and slope, aspect and hillshade cannot
 * drift apart.
 *
 * Aspect is the DOWNSLOPE direction, so both gradient components are negated
 * (`-dzdy` is the northing component because `cellOffset` returns y increasing
 * NORTHWARD). `atan2(-dzdy, -dzdx)` is the math-frame angle — CCW from east,
 * 90 = north — which is exactly what `hornSlopeAspect` returns in radians. The
 * conversion to compass is `(90 - mathDeg) mod 360`: it both rotates the zero
 * from east to north and reverses the sense from CCW to CW. Getting only one
 * of those two right yields a plausible-looking grid that is mirrored, which is
 * the same class of defect as the v0.4.3 aspect bug recorded in
 * terrainDerivatives.ts.
 *
 * Undefined on a flat cell: an exactly zero gradient has no downslope
 * direction. Returns NaN there rather than 0 (which is a real direction,
 * north) so a caller cannot mistake "no aspect" for "points north".
 */
export function analyticAspectDegrees(row, col) {
  const { x, y } = cellOffset(row, col);
  const { a, b, c, d, e } = SURFACE;
  const dzdx = 2 * a * x + c * y + d;
  const dzdy = 2 * b * y + c * x + e;
  if (dzdx === 0 && dzdy === 0) return Number.NaN;
  const mathDeg = (Math.atan2(-dzdy, -dzdx) * 180) / Math.PI;
  return ((90 - mathDeg) % 360 + 360) % 360;
}

/**
 * Default sun for the hillshade reference: azimuth 315° clockwise from north,
 * altitude 45° above the horizon, vertical exaggeration 1.
 *
 * Pinned here rather than left to each caller's defaults. `shadeFromSlopeAspect`
 * defaults to these and so does `gdaldem hillshade`, but a default that agrees
 * today is not a comparison basis: if either side changed its default, the two
 * grids would be lit by different suns and the cross-check would report a
 * shading disagreement that is really a parameter disagreement. Both the test
 * and `tests/fixtures/reference/hillshade/command.txt` pass these explicitly.
 */
export const SUN = { azimuthDeg: 315, altitudeDeg: 45, zFactor: 1 };

/**
 * Closed-form HILLSHADE at a cell centre, on the 0–255 scale, UNROUNDED.
 *
 * Same `SURFACE` coefficients and same `cellOffset` as the slope and aspect
 * above, so one surface backs all three products and none can drift.
 *
 * The illumination model is the standard ESRI/Horn one, written here directly
 * from the closed-form gradient rather than from either implementation:
 *
 *   slopeRad = atan(zFactor · |∇z|)
 *   aspect   = atan2(−∂z/∂y, −∂z/∂x)          math frame, CCW from east
 *   azimuth  = ((360 − azimuthDeg + 90) mod 360)·π/180
 *   zenith   = (90 − altitudeDeg)·π/180
 *   h        = cos(zenith)·cos(slopeRad) + sin(zenith)·sin(slopeRad)·cos(azimuth − aspect)
 *
 * `h` is a cosine of the angle between the surface normal and the sun, so it is
 * an intensity in [−1, 1] (negative = self-shadowed).
 *
 * ENCODING. This returns 255·h — OUR encoding, the one `shadeFromSlopeAspect`
 * applies. That choice is deliberate and it is the whole reason the GDAL leg of
 * the hillshade cross-check does not read as an exact match: `gdaldem hillshade`
 * encodes the SAME intensity as 1 + 254·h, reserving level 0 for nodata. The
 * two encodings differ by exactly (1 − h) levels. Encoding the analytic in
 * GDAL's scale instead would make the GDAL leg look perfect and push the whole
 * discrepancy onto our own kernel, which is backwards: the encoding difference
 * belongs to GDAL's output format, not to our shading. Keeping the analytic in
 * our scale leaves that difference visible and attributable in the reported
 * figures. See `tests/hillshadeCrossCheck.test.ts`.
 *
 * Not clamped and not rounded: clamping would hide a sign error in the
 * alignment term (a self-shadowed cell and a level-0 cell would read alike),
 * and rounding is a property of the 8-bit product, not of the surface.
 *
 * Unlike `analyticAspectDegrees` this is TOTAL — it returns a number on a flat
 * cell rather than NaN. Aspect is genuinely undefined at zero gradient, but
 * hillshade is not: sin(slopeRad) is 0 there, so the aspect term drops out and
 * h reduces to cos(zenith) whatever direction the undefined aspect names. That
 * is why the hillshade test compares every interior cell while the aspect test
 * has to exclude the near-flat ones.
 */
export function analyticHillshade255(row, col) {
  const { x, y } = cellOffset(row, col);
  const { a, b, c, d, e } = SURFACE;
  const dzdx = 2 * a * x + c * y + d;
  const dzdy = 2 * b * y + c * x + e;
  const DEG = Math.PI / 180;
  const slopeRad = Math.atan(SUN.zFactor * Math.hypot(dzdx, dzdy));
  const aspectRad = dzdx === 0 && dzdy === 0 ? 0 : Math.atan2(-dzdy, -dzdx);
  const zenith = (90 - SUN.altitudeDeg) * DEG;
  let azMath = (360 - SUN.azimuthDeg + 90) % 360;
  if (azMath < 0) azMath += 360;
  const h =
    Math.cos(zenith) * Math.cos(slopeRad) +
    Math.sin(zenith) * Math.sin(slopeRad) * Math.cos(azMath * DEG - aspectRad);
  return 255 * h;
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
 * The tests import `GRID`, `analyticSlopeDegrees`, `analyticAspectDegrees` and
 * `analyticHillshade255` from here so the surface has exactly one definition.
 * Without this guard that
 * import rewrote the
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
  let aMin = Infinity;
  let aMax = -Infinity;
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let r = 0; r < GRID.nrows; r++) {
    for (let c = 0; c < GRID.ncols; c++) {
      const s = analyticSlopeDegrees(r, c);
      if (s < min) min = s;
      if (s > max) max = s;
      const a = analyticAspectDegrees(r, c);
      if (Number.isFinite(a)) {
        if (a < aMin) aMin = a;
        if (a > aMax) aMax = a;
      }
      const h = analyticHillshade255(r, c);
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }
  console.log(`wrote ${demPath}`);
  console.log(`  ${GRID.ncols} x ${GRID.nrows} cells @ ${GRID.cellsize} m`);
  console.log(`  analytic slope range: ${min.toFixed(3)}deg .. ${max.toFixed(3)}deg`);
  console.log(`  analytic aspect range: ${aMin.toFixed(3)}deg .. ${aMax.toFixed(3)}deg (compass)`);
  console.log(
    `  analytic hillshade range: ${hMin.toFixed(3)} .. ${hMax.toFixed(3)} ` +
      `(0-255, az ${SUN.azimuthDeg} alt ${SUN.altitudeDeg} z ${SUN.zFactor})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
