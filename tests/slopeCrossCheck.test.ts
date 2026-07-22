/**
 * slopeCrossCheck.test.ts — SLOPE-RASTER against an independent implementation.
 *
 * Slope reached E4 here: this file compares our Horn slope against a committed
 * GDAL reference AND the closed-form gradient. Every OTHER entry in
 * `REFERENCE_SLOTS` still ships `pending`, so for those, nothing in
 * this project has been compared against an implementation we did not write.
 * This is the first slot that can move.
 *
 * THREE-WAY, NOT PAIRWISE. Our Horn slope against GDAL's Horn slope is two
 * implementations of one algorithm; they can agree while both being wrong the
 * same way. So the fixture surface has a closed-form gradient and this file
 * checks all three edges of the triangle:
 *
 *   ours   vs analytic   — are we right?
 *   GDAL   vs analytic   — is the reference right, i.e. did the operator run
 *                          the command we think they ran?
 *   ours   vs GDAL       — the cross-implementation claim itself
 *
 * The middle one is what makes this worth doing. A GDAL run with the wrong
 * algorithm, the wrong z-factor, or a resampled grid shows up there rather
 * than being averaged into a plausible-looking agreement.
 *
 * WHY THIS SKIPS RATHER THAN FAILS WHEN THE REFERENCE IS ABSENT. Producing
 * `slope-gdal.asc` requires GDAL, which is not a dependency of this project
 * and is not installed in CI. The skip is conditional on a file that either
 * exists or does not — not a placeholder waiting on future work. The moment
 * the file lands the assertions run, and `REFERENCE_SLOTS` stays `pending`
 * until then, so no claim is promoted by a test that did not execute.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hornSlope } from '../src/terrain/ground/terrainDerivatives';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import { GRID, analyticSlopeDegrees } from '../scripts/make-slope-fixture.mjs';

const DIR = resolve(__dirname, 'fixtures/reference/slope');
const DEM = resolve(DIR, 'input-dem.asc');
const REF = resolve(DIR, 'slope-gdal.asc');

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
 * Deliberately strict: a header key it does not recognise, or a cell count
 * that disagrees with ncols x nrows, throws rather than being tolerated. A
 * lenient parser here would let a malformed reference file through as data.
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
 * Our slope, in DEGREES, in ASCII-Grid row order.
 *
 * Two conversions, both of which produce plausible wrong numbers if missed:
 *
 *  - `hornSlope` returns rise/run (the gradient magnitude), NOT degrees. GDAL
 *    with `--unit degree` returns degrees. atan converts.
 *  - `hornSlopeAspect` treats row+1 as NORTH; ASCII Grid writes the northern
 *    row first. The rows are flipped on the way in and back on the way out, so
 *    every grid in this file is in one order.
 */
function ourSlopeDegrees(dem: AsciiGrid): Float64Array {
  const { ncols, nrows } = dem;
  const northingUp = new Float32Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const src = r * ncols;
    const dst = (nrows - 1 - r) * ncols;
    for (let c = 0; c < ncols; c++) northingUp[dst + c] = dem.values[src + c];
  }
  const riseRun = hornSlope(northingUp, ncols, nrows, dem.cellsize, dem.cellsize, 1);
  const out = new Float64Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const src = (nrows - 1 - r) * ncols;
    const dst = r * ncols;
    for (let c = 0; c < ncols; c++) out[dst + c] = (Math.atan(riseRun[src + c]) * 180) / Math.PI;
  }
  return out;
}

/**
 * Drop the one-cell border.
 *
 * Our kernel clamps at the edge; the documented GDAL command leaves edges
 * undefined. Comparing them there would measure a difference in edge policy
 * and report it as a difference in slope. Interior cells only.
 */
function interior(grid: Float64Array, ncols: number, nrows: number): number[] {
  const out: number[] = [];
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) out.push(grid[r * ncols + c]);
  }
  return out;
}

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'SLOPE-RASTER')!;

describe('SLOPE-RASTER cross-implementation', () => {
  it('has a declared GDAL slot with a pre-registered tolerance', () => {
    // The tolerance is fixed BEFORE the comparison runs. If the measured
    // agreement misses it, that is a finding about the slope implementation,
    // not an invitation to widen the number until it passes.
    expect(SLOT.referenceTool).toBe('GDAL');
    expect(SLOT.toleranceAbs).toBe(0.5);
    expect(SLOT.unit).toBe('°');
  });

  it('our Horn slope matches the closed form on the fixture surface', () => {
    const dem = readAsciiGrid(DEM);
    expect(dem.ncols).toBe(GRID.ncols);
    expect(dem.nrows).toBe(GRID.nrows);

    const ours = ourSlopeDegrees(dem);
    const truth = new Float64Array(dem.ncols * dem.nrows);
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) truth[r * dem.ncols + c] = analyticSlopeDegrees(r, c);
    }

    const report = crossCheck(
      interior(ours, dem.ncols, dem.nrows),
      interior(truth, dem.ncols, dem.nrows),
      { toleranceAbs: SLOT.toleranceAbs, minCells: 1000 },
    );
    expect(report.verdict, report.summary).toBe('agree');
  });

  it('has no symmetry that would hide a flipped or transposed grid', () => {
    // Guards the FIXTURE, not the code. The first version of this surface was
    // z = a*x^2 + b*y^2, which is even in both x and y: flipping the grid
    // north-south left every slope value identical, so a reference produced
    // with the rows reversed passed the cross-check. That was confirmed by
    // feeding the test a deliberately flipped reference and watching it agree.
    //
    // The north-south flip is the hazard that matters here, because ASCII Grid
    // writes the northern row first while our kernel treats row+1 as north.
    // A surface that cannot detect it would make this whole file decorative.
    const R = GRID.nrows - 1;
    const C = GRID.ncols - 1;
    let maxFlipDiff = 0;
    let maxMirrorDiff = 0;
    for (let r = 0; r < GRID.nrows; r += 7) {
      for (let c = 0; c < GRID.ncols; c += 7) {
        const here = analyticSlopeDegrees(r, c);
        maxFlipDiff = Math.max(maxFlipDiff, Math.abs(here - analyticSlopeDegrees(R - r, c)));
        maxMirrorDiff = Math.max(maxMirrorDiff, Math.abs(here - analyticSlopeDegrees(r, C - c)));
      }
    }
    // Comfortably above the 0.5 degree tolerance, so either flip is a
    // disagreement rather than a near miss.
    expect(maxFlipDiff, 'north-south flip is invisible on this surface').toBeGreaterThan(2);
    expect(maxMirrorDiff, 'east-west mirror is invisible on this surface').toBeGreaterThan(2);
  });

  const withReference = existsSync(REF) ? it : it.skip;

  withReference('agrees with GDAL, and GDAL agrees with the closed form', () => {
    const dem = readAsciiGrid(DEM);
    const ref = readAsciiGrid(REF);

    // A reference on a different grid is not a reference. Resampling to force
    // a comparison would invent the agreement being measured.
    expect(ref.ncols, 'reference grid width differs from the DEM').toBe(dem.ncols);
    expect(ref.nrows, 'reference grid height differs from the DEM').toBe(dem.nrows);

    const gdal = interior(ref.values, ref.ncols, ref.nrows);
    const ours = interior(ourSlopeDegrees(dem), dem.ncols, dem.nrows);
    const truth: number[] = [];
    for (let r = 1; r < dem.nrows - 1; r++) {
      for (let c = 1; c < dem.ncols - 1; c++) truth.push(analyticSlopeDegrees(r, c));
    }

    const opts = { toleranceAbs: SLOT.toleranceAbs, nodata: ref.nodata, minCells: 1000 };

    // Did the operator run the command we documented? A wrong algorithm, a
    // wrong z-factor or a resampled grid surfaces HERE, before it can be
    // averaged into a plausible ours-vs-GDAL agreement.
    const refVsTruth = crossCheck(gdal, truth, opts);
    expect(refVsTruth.verdict, `GDAL vs closed form: ${refVsTruth.summary}`).toBe('agree');

    const oursVsRef = crossCheck(ours, gdal, opts);
    expect(oursVsRef.verdict, `ours vs GDAL: ${oursVsRef.summary}`).toBe('agree');

    // Printed so the published figures are read off a run, not typed in.
    console.log(`SLOPE-RASTER  ours vs GDAL: ${oursVsRef.summary}`);
    console.log(`SLOPE-RASTER  GDAL vs truth: ${refVsTruth.summary}`);
  });

  it('keeps the slot pending until a reference is actually supplied', () => {
    // The claim and the artifact move together. Flipping the slot to
    // "supplied" without the file, or landing the file without flipping the
    // slot, both fail here.
    expect(SLOT.status).toBe(existsSync(REF) ? 'supplied' : 'pending');
  });
});
