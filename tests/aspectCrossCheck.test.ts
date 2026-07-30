/**
 * aspectCrossCheck.test.ts — ASPECT-RASTER against an independent implementation.
 *
 * The sibling of `slopeCrossCheck.test.ts`, and deliberately built the same
 * way. Aspect is the second product to move E3 → E4: our Horn aspect is
 * compared against a committed GDAL reference AND against the surface's
 * closed-form gradient.
 *
 * THREE-WAY, NOT PAIRWISE. Ours against GDAL is two implementations of ONE
 * algorithm; they can agree while both being wrong the same way. So all three
 * edges of the triangle are checked:
 *
 *   ours   vs analytic   — are we right?
 *   GDAL   vs analytic   — is the reference right, i.e. did the operator run
 *                          the command we think they ran?
 *   ours   vs GDAL       — the cross-implementation claim itself
 *
 * ASPECT BRINGS THREE HAZARDS SLOPE DID NOT. Each is handled explicitly below
 * and each is named where it is handled:
 *
 *   1. Aspect is CIRCULAR. 359° and 1° differ by 2°, not 358°. Every
 *      comparison in this file goes through `circularDiff` before it reaches
 *      `crossCheck` (see `agreement` for why that is equivalent).
 *   2. Flat cells have NO aspect. GDAL writes -9999 there; our kernel returns
 *      0, which is a real direction (north). Comparing those two would be
 *      comparing a value against a placeholder, so cells whose ANALYTIC slope
 *      is at or below `MIN_SLOPE_DEG` are excluded on all three legs.
 *   3. FRAME CONVERSION. Ours is radians, math frame (CCW from east, π/2 =
 *      north), on a northing-up grid; GDAL is degrees clockwise from north;
 *      ASCII Grid writes the NORTHERN row first while our kernel treats row+1
 *      as north. Rows are flipped in and back out, so every grid in this file
 *      is in one order — ASCII-Grid order, row 0 = north.
 *
 * WHY THIS SKIPS RATHER THAN FAILS WHEN THE REFERENCE IS ABSENT. Producing
 * `aspect-gdal.asc` requires GDAL, which is not a dependency of this project
 * and is not installed in CI. The skip is conditional on a file that either
 * exists or does not. `REFERENCE_SLOTS` stays `pending` until the file lands,
 * so no claim is promoted by a test that did not execute.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import { GRID, analyticSlopeDegrees, analyticAspectDegrees } from '../scripts/make-slope-fixture.mjs';

/**
 * The aspect reference sits in its own directory but reuses the SLOPE fixture's
 * DEM. One DEM, one surface definition: a second copy could be edited or
 * regenerated out of step with the first, and then slope and aspect would be
 * validated against two different surfaces while both READMEs claimed one.
 * `tests/fixtures/reference/aspect/SHA256SUMS` pins the DEM by hash for exactly
 * that reason.
 */
const DEM = resolve(__dirname, 'fixtures/reference/slope/input-dem.asc');
const REF = resolve(__dirname, 'fixtures/reference/aspect/aspect-gdal.asc');

/**
 * Cells flatter than this (by the CLOSED FORM, not by either implementation)
 * are dropped from every comparison.
 *
 * On a near-flat cell the aspect is numerically unstable and physically
 * meaningless — the downslope direction of an almost-level surface swings
 * wildly for a rounding-sized change in the gradient — and the two
 * implementations do not even agree that it exists: GDAL emits its NODATA
 * placeholder for a detected flat, ours returns 0, which reads as due north.
 * 2° is the same threshold used to verify the reference by hand, and it leaves
 * 10,932 of the 11,564 interior cells in the comparison, so this is a
 * well-defined exclusion rather than a way to drop inconvenient cells.
 *
 * The threshold is applied to the ANALYTIC slope so the cell set is a property
 * of the fixture alone; deriving it from our own slope would let a bug in our
 * kernel choose which cells get to judge it.
 */
const MIN_SLOPE_DEG = 2;

interface AsciiGrid {
  ncols: number;
  nrows: number;
  cellsize: number;
  nodata: number;
  /** Row-major, row 0 = NORTHERNMOST (ASCII Grid order). */
  values: Float64Array;
}

/**
 * Minimal ESRI ASCII Grid reader.
 *
 * Deliberately strict: a header key it does not recognise, or a cell count that
 * disagrees with ncols x nrows, throws rather than being tolerated. A lenient
 * parser here would let a malformed reference file through as data.
 */
function readAsciiGrid(path: string): AsciiGrid {
  const text = readFileSync(path, 'utf8');
  const header: Record<string, number> = {};
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  for (const k of ['ncols', 'nrows', 'cellsize']) {
    if (!Number.isFinite(header[k])) throw new Error(`${path}: header missing "${k}"`);
  }
  const ncols = header.ncols;
  const nrows = header.nrows;
  const nums = lines.slice(i).join(' ').trim().split(/\s+/).filter(Boolean);
  if (nums.length !== ncols * nrows) {
    throw new Error(`${path}: ${nums.length} values, expected ${ncols * nrows} (${ncols} x ${nrows})`);
  }
  const values = new Float64Array(nums.length);
  for (let j = 0; j < nums.length; j++) values[j] = Number(nums[j]);
  return { ncols, nrows, cellsize: header.cellsize, nodata: header.nodata_value ?? -9999, values };
}

/**
 * Our Horn aspect in COMPASS DEGREES (clockwise from north), in ASCII-Grid row
 * order.
 *
 * Two conversions, both of which produce a plausible but WRONG grid if missed —
 * and a wrong aspect grid looks entirely reasonable, which is how the v0.4.3
 * north–south aspect mirror shipped (see terrainDerivatives.ts):
 *
 *  - ROW ORDER. `hornSlopeAspect` treats row+1 as NORTH; ASCII Grid writes the
 *    northern row first. Rows are flipped on the way in and back on the way
 *    out, so every grid in this file is in one order.
 *  - FRAME. Ours is radians CCW from east (π/2 = north). GDAL is degrees CW
 *    from north. `(90 - mathDeg) mod 360` both rotates the zero and reverses
 *    the sense; doing only one of the two yields a mirrored grid that still
 *    spans 0–360 and still "looks like" an aspect raster.
 */
function ourAspectDegrees(dem: AsciiGrid): Float64Array {
  const { ncols, nrows } = dem;
  const northingUp = new Float32Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const src = r * ncols;
    const dst = (nrows - 1 - r) * ncols;
    for (let c = 0; c < ncols; c++) northingUp[dst + c] = dem.values[src + c];
  }
  const { aspect } = hornSlopeAspect(northingUp, ncols, nrows, dem.cellsize, dem.cellsize, 1);
  const out = new Float64Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const src = (nrows - 1 - r) * ncols;
    const dst = r * ncols;
    for (let c = 0; c < ncols; c++) {
      const mathDeg = (aspect[src + c] * 180) / Math.PI;
      out[dst + c] = (((90 - mathDeg) % 360) + 360) % 360;
    }
  }
  return out;
}

/**
 * Shortest angular separation between two compass bearings, in degrees, 0..180.
 *
 * The reason this file cannot hand raw bearings to `crossCheck`: 359° and 1°
 * are 2° apart, but subtraction reports 358°. Without this, a pair of
 * implementations that agree perfectly across due north would be reported as
 * the largest possible disagreement.
 */
function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The set of interior cells the comparison runs over: the one-cell border
 * dropped, plus the near-flat exclusion.
 *
 * The border goes because `gdaldem` leaves edge cells undefined without
 * `-compute_edges`; comparing there would measure a difference in edge policy and
 * report it as a difference in aspect. Our kernel does answer for those cells,
 * extrapolating the way `-compute_edges` does; the ring is compared directly in
 * tests/rasterAgreementMatrix.test.ts rather than here.
 */
function comparableCells(ncols: number, nrows: number): number[] {
  const idx: number[] = [];
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      if (analyticSlopeDegrees(r, c) > MIN_SLOPE_DEG) idx.push(r * ncols + c);
    }
  }
  return idx;
}

/**
 * Run one leg of the comparison through `crossCheck`.
 *
 * `crossCheck` subtracts plain numbers, which is wrong for bearings. Rather
 * than teach it about angles, each pair is pre-reduced to its circular
 * separation and compared against zero. That is EQUIVALENT for this purpose,
 * not a shortcut: `crossCheck`'s verdict depends only on |ours − reference| per
 * cell, and |circularDiff(a,b) − 0| IS the angular separation, already
 * non-negative. `maxAbsDiff`, `rmse` and `withinTolFraction` therefore carry
 * their intended meaning in degrees of bearing. The one figure that changes
 * meaning is `meanDiff`: signed bias is not defined for a folded quantity, so
 * it reads as mean unsigned separation and is not quoted as a bias anywhere.
 */
function agreement(a: Float64Array | number[], b: Float64Array | number[], idx: number[], tol: number) {
  const diffs = idx.map((i) => circularDiff(a[i], b[i]));
  const zeros = new Float64Array(diffs.length);
  return crossCheck(diffs, zeros, { toleranceAbs: tol, minCells: 1000 });
}

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'ASPECT-RASTER')!;

describe('ASPECT-RASTER cross-implementation', () => {
  it('has a declared GDAL slot with a pre-registered tolerance', () => {
    // The tolerance is fixed BEFORE the comparison runs. If the measured
    // agreement misses it, that is a finding about the aspect implementation,
    // not an invitation to widen the number until it passes. 0.5° matches the
    // slope slot: same estimator, same fixture, same unit.
    expect(SLOT.referenceTool).toBe('GDAL');
    expect(SLOT.toleranceAbs).toBe(0.5);
    expect(SLOT.unit).toBe('°');
  });

  it('our Horn aspect matches the closed form on the fixture surface', () => {
    const dem = readAsciiGrid(DEM);
    expect(dem.ncols).toBe(GRID.ncols);
    expect(dem.nrows).toBe(GRID.nrows);

    const ours = ourAspectDegrees(dem);
    const truth = new Float64Array(dem.ncols * dem.nrows);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) truth[r * dem.ncols + c] = analyticAspectDegrees(r, c);
    }

    const idx = comparableCells(dem.ncols, dem.nrows);
    const report = agreement(ours, truth, idx, SLOT.toleranceAbs);
    expect(report.verdict, `ours vs closed form: ${report.summary}`).toBe('agree');
    // Printed so the published figures are read off a run, not typed in.
    console.log(`ASPECT-RASTER  ours vs truth: ${report.summary}`);
  });

  it('rejects a reference that has been flipped north-south or mirrored east-west', () => {
    // Guards the FIXTURE, not the code — and aspect needs this more than slope
    // did, because aspect IS a direction: a row-order mistake does not merely
    // permute the values, it reverses the northward component of every bearing.
    // The first slope fixture had exactly this hole (its surface was even in
    // both axes, so a deliberately flipped reference passed the cross-check),
    // and a fixture that cannot detect the flip makes the whole file
    // decorative. ASCII Grid writes the northern row first while our kernel
    // treats row+1 as north, so a reversed reference is a live mistake, not a
    // hypothetical one.
    //
    // Proved the way the hazard actually presents itself: a whole reference
    // grid is reflected and fed through the SAME comparison the real reference
    // uses. `disagree` is the assertion — a per-cell min or max statistic would
    // not answer the question the cross-check asks, since `crossCheck` demands
    // every compared cell be within tolerance.
    const dem = readAsciiGrid(DEM);
    const idx = comparableCells(dem.ncols, dem.nrows);
    const ours = ourAspectDegrees(dem);

    const truth = new Float64Array(dem.ncols * dem.nrows);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) truth[r * dem.ncols + c] = analyticAspectDegrees(r, c);
    }
    const flipped = new Float64Array(truth.length);
    const mirrored = new Float64Array(truth.length);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) {
        flipped[r * dem.ncols + c] = truth[(dem.nrows - 1 - r) * dem.ncols + c];
        mirrored[r * dem.ncols + c] = truth[r * dem.ncols + (dem.ncols - 1 - c)];
      }
    }

    // Sanity: the unreflected grid is the one that agrees. Without this, a
    // comparison broken in some other way would "detect" both reflections and
    // the guard would pass for the wrong reason.
    expect(agreement(ours, truth, idx, SLOT.toleranceAbs).verdict).toBe('agree');

    const flipReport = agreement(ours, flipped, idx, SLOT.toleranceAbs);
    expect(flipReport.verdict, `north-south flip is invisible: ${flipReport.summary}`).toBe('disagree');

    const mirrorReport = agreement(ours, mirrored, idx, SLOT.toleranceAbs);
    expect(mirrorReport.verdict, `east-west mirror is invisible: ${mirrorReport.summary}`).toBe('disagree');

    // Detection is not down to a handful of lucky cells: the great majority of
    // the grid must move outside tolerance under either reflection, so the
    // guard cannot be defeated by a reference that is flipped only in part.
    expect(flipReport.withinTolFraction).toBeLessThan(0.05);
    expect(mirrorReport.withinTolFraction).toBeLessThan(0.05);
  });

  const withReference = existsSync(REF) ? it : it.skip;

  withReference('agrees with GDAL, and GDAL agrees with the closed form', () => {
    const dem = readAsciiGrid(DEM);
    const ref = readAsciiGrid(REF);

    // A reference on a different grid is not a reference. Resampling to force a
    // comparison would invent the agreement being measured.
    expect(ref.ncols, 'reference grid width differs from the DEM').toBe(dem.ncols);
    expect(ref.nrows, 'reference grid height differs from the DEM').toBe(dem.nrows);

    const idx = comparableCells(dem.ncols, dem.nrows);

    // Never compare a defined value against a placeholder. If GDAL emitted its
    // flat NODATA inside the comparison set, the analytic slope threshold and
    // GDAL's own flat detection disagree, and silently skipping those cells
    // would hide it. Fail loudly instead.
    for (const i of idx) {
      expect(ref.values[i], `GDAL wrote NODATA at cell ${i}, inside the comparison set`).not.toBe(ref.nodata);
    }

    const gdal = ref.values;
    const ours = ourAspectDegrees(dem);
    const truth = new Float64Array(dem.ncols * dem.nrows);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) truth[r * dem.ncols + c] = analyticAspectDegrees(r, c);
    }

    // Did the operator run the command we documented? A wrong algorithm, a
    // wrong frame, or a resampled grid surfaces HERE, before it can be averaged
    // into a plausible ours-vs-GDAL agreement.
    const refVsTruth = agreement(gdal, truth, idx, SLOT.toleranceAbs);
    expect(refVsTruth.verdict, `GDAL vs closed form: ${refVsTruth.summary}`).toBe('agree');

    const oursVsRef = agreement(ours, gdal, idx, SLOT.toleranceAbs);
    expect(oursVsRef.verdict, `ours vs GDAL: ${oursVsRef.summary}`).toBe('agree');

    // Printed so the published figures are read off a run, not typed in.
    console.log(`ASPECT-RASTER  ours vs GDAL: ${oursVsRef.summary}`);
    console.log(`ASPECT-RASTER  GDAL vs truth: ${refVsTruth.summary}`);
  });

  it('keeps the slot pending until a reference is actually supplied', () => {
    // The claim and the artifact move together. Flipping the slot to
    // "supplied" without the file, or landing the file without flipping the
    // slot, both fail here.
    expect(SLOT.status).toBe(existsSync(REF) ? 'supplied' : 'pending');
  });
});
