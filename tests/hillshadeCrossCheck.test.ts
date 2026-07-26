/**
 * hillshadeCrossCheck.test.ts — HILLSHADE against an independent implementation.
 *
 * The third product to move E3 → E4, built the same way as
 * `slopeCrossCheck.test.ts` and `aspectCrossCheck.test.ts`: our shading is
 * compared against a committed GDAL reference AND against the same surface's
 * closed-form gradient, on the same frozen DEM.
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
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO FORMULAS, ESTABLISHED BEFORE ANY COMPARISON RAN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * OURS (`shadeFromSlopeAspect`, src/terrain/surface/hillshade.ts), reading the
 * code rather than the docstring:
 *
 *   zenith   = (90 − altitudeDeg)·π/180                       altitude 45 default
 *   azimuth  = ((360 − azimuthDeg + 90) mod 360)·π/180        azimuth 315 default
 *   slopeRad = atan(zFactor · slope)                          slope = |∇z|, rise/run
 *   h        = cos(zenith)·cos(slopeRad)
 *            + sin(zenith)·sin(slopeRad)·cos(azimuth − aspect)
 *   level    = clamp(round(255·h), 0, 255)
 *
 * Conventions: `azimuthDeg` is CLOCKWISE FROM NORTH and `azimuthToMathRad`
 * converts it into the MATH frame (CCW from east, π/2 = north); `altitudeDeg`
 * is degrees above the horizon. `aspect` arrives from `hornSlopeAspect` as the
 * DOWNSLOPE direction in that same math frame, atan2(−∂z/∂y, −∂z/∂x) on a
 * NORTHING-UP grid, so `cos(azimuth − aspect)` compares like with like.
 *
 * GDAL (`gdaldem hillshade`, defaults −az 315 −alt 45 −z 1 −s 1 −alg Horn):
 * the same standard ESRI illumination model over a Horn 3×3 gradient, with the
 * same compass-azimuth and altitude-above-horizon conventions.
 *
 * SAME MODEL — with ONE difference, and it is not in the physics. GDAL encodes
 * the intensity as
 *
 *   level = round(1 + 254·h)          (h clamped at 0 → level 1)
 *
 * reserving level 0 for nodata, where we use `round(255·h)`. The two encodings
 * of one intensity differ by exactly (1 − h) levels, which is strictly less
 * than one level for any lit cell. This is an output-format convention, not a
 * shading disagreement, and it is left VISIBLE in every figure this file
 * reports rather than divided out — see `HAZARD: 8-BIT ENCODING` below and the
 * `reproduces the GDAL reference exactly under GDAL's own encoding` case, which
 * pins the relationship as an identity instead of asserting it in prose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SKIPS RATHER THAN FAILS WHEN THE REFERENCE IS ABSENT. Producing
 * `hillshade-gdal.asc` requires GDAL, which is not a dependency of this project
 * and is not installed in CI. The skip is conditional on a file that either
 * exists or does not. `REFERENCE_SLOTS` tracks the file, so no claim is
 * promoted by a test that did not execute.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { shadeFromSlopeAspect, azimuthToMathRad } from '../src/terrain/surface/hillshade';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import {
  GRID,
  SUN,
  analyticHillshade255,
  analyticSlopeDegrees,
} from '../scripts/make-slope-fixture.mjs';

/**
 * The hillshade reference sits in its own directory but reuses the SLOPE
 * fixture's DEM, exactly as the aspect reference does. One DEM, one surface
 * definition: a second copy could be edited or regenerated out of step with the
 * first, and then three products would be validated against three different
 * surfaces while all three READMEs claimed one.
 * `tests/fixtures/reference/hillshade/SHA256SUMS` pins the DEM by hash for
 * exactly that reason.
 */
const DEM = resolve(__dirname, 'fixtures/reference/slope/input-dem.asc');
const REF = resolve(__dirname, 'fixtures/reference/hillshade/hillshade-gdal.asc');

interface AsciiGrid {
  ncols: number;
  nrows: number;
  cellsize: number;
  nodata: number;
  /** Row-major, row 0 = NORTHERNMOST (ASCII Grid order). */
  values: Float64Array;
}

/**
 * Minimal ESRI ASCII Grid reader — the same strict one the sibling checks use.
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
 * Run our real shading pipeline over the DEM and return BOTH the shipped 8-bit
 * levels and the unrounded 255·h intensities, in ASCII-Grid row order.
 *
 * ROW ORDER, the same hazard the aspect check documents: `hornSlopeAspect`
 * treats row+1 as NORTH; ASCII Grid writes the northern row first. Rows are
 * flipped on the way in and back on the way out, so every grid in this file is
 * in one order. It matters more for hillshade than for slope, because a
 * hillshade lit from the north-west is a DIRECTIONAL product: a row-order
 * mistake does not scramble the values, it lights the opposite flank of every
 * ridge and still produces a picture that looks like terrain. That is the
 * v0.4.3 defect recorded in terrainDerivatives.ts, and it reached users.
 *
 * `shade` comes from the live `shadeFromSlopeAspect` — the shipped product, no
 * reimplementation. `raw` re-evaluates the same closed-form expression on the
 * same slope/aspect arrays purely to recover the pre-rounding intensity, which
 * `HillshadeResult` does not expose; the `quantisation is the only difference`
 * case asserts the two agree, so `raw` cannot drift into being a second, softer
 * implementation that the comparison silently prefers.
 */
function ourHillshade(dem: AsciiGrid): { shade: Float64Array; raw: Float64Array } {
  const { ncols, nrows } = dem;
  const northingUp = new Float32Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    const src = r * ncols;
    const dst = (nrows - 1 - r) * ncols;
    for (let c = 0; c < ncols; c++) northingUp[dst + c] = dem.values[src + c];
  }
  const { slope, aspect } = hornSlopeAspect(northingUp, ncols, nrows, dem.cellsize, dem.cellsize, 1);

  // Every cell carries data: the fixture is a dense analytic surface with no
  // holes. Passing a full-coverage mask keeps `shadeFromSlopeAspect` from
  // skipping cells for a reason unrelated to shading.
  const coverage = new Uint8Array(ncols * nrows).fill(1);
  const result = shadeFromSlopeAspect(slope, aspect, coverage, ncols, nrows, SUN);

  const DEG = Math.PI / 180;
  const zenith = (90 - SUN.altitudeDeg) * DEG;
  const cosZen = Math.cos(zenith);
  const sinZen = Math.sin(zenith);
  const azMath = azimuthToMathRad(SUN.azimuthDeg);

  const shade = new Float64Array(ncols * nrows);
  const raw = new Float64Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const src = (nrows - 1 - r) * ncols + c;
      const dst = r * ncols + c;
      shade[dst] = result.shade[src];
      const slopeRad = Math.atan(SUN.zFactor * slope[src]);
      raw[dst] =
        255 *
        (cosZen * Math.cos(slopeRad) + sinZen * Math.sin(slopeRad) * Math.cos(azMath - aspect[src]));
    }
  }
  return { shade, raw };
}

/** The closed-form hillshade over the whole grid, in ASCII-Grid row order. */
function analyticGrid(ncols: number, nrows: number): Float64Array {
  const out = new Float64Array(ncols * nrows);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) out[r * ncols + c] = analyticHillshade255(r, c);
  }
  return out;
}

/**
 * HAZARD: EDGE POLICY. The set of cells every leg runs over — the one-cell
 * border dropped.
 *
 * `gdaldem` leaves the border undefined and, on a Byte band, writes its nodata
 * value 0 there; our kernel edge-clamps and produces a real shade. Comparing
 * there would measure a difference in edge policy — a full 150 levels of it —
 * and report it as a difference in shading. Verified against the committed
 * reference: all 436 border cells are 0 and no interior cell is.
 *
 * HAZARD: FLAT GROUND — INCLUDED, deliberately, unlike the aspect check.
 *
 * Flat ground shades to a constant (cos(zenith) ≈ 180 levels) that carries no
 * directional information, so it cannot help detect a lighting error. It is
 * kept in anyway, for two reasons the aspect check could not use. First,
 * hillshade is DEFINED at zero gradient where aspect is not: sin(slopeRad) is
 * 0, the aspect term drops out, and both implementations agree that the answer
 * exists — GDAL writes a real level there rather than the NODATA placeholder it
 * writes for a flat aspect, so there is no value-against-placeholder comparison
 * to avoid. Second, excluding cells that are guaranteed to agree would INFLATE
 * the reported agreement, not clean it: dropping the 632 interior cells below
 * 2° would remove easy cells from the denominator and quietly improve the
 * headline. The exclusion an aspect comparison needs would be a thumb on the
 * scale here, so the comparison spans all 11,564 interior cells. The
 * `is not carried by the near-flat cells` case checks the steep subset on its
 * own so the claim cannot rest on the easy majority.
 */
function comparableCells(ncols: number, nrows: number): number[] {
  const idx: number[] = [];
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) idx.push(r * ncols + c);
  }
  return idx;
}

/** One leg of the comparison, over `idx`, at the pre-registered tolerance. */
function agreement(a: ArrayLike<number>, b: ArrayLike<number>, idx: number[], tol: number) {
  const ours = new Float64Array(idx.length);
  const ref = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    ours[k] = a[idx[k]];
    ref[k] = b[idx[k]];
  }
  return crossCheck(ours, ref, { toleranceAbs: tol, minCells: 1000 });
}

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'HILLSHADE')!;

describe('HILLSHADE cross-implementation', () => {
  it('has a declared GDAL slot with a pre-registered tolerance', () => {
    // The tolerance is fixed BEFORE the comparison runs. If the measured
    // agreement misses it, that is a finding about the hillshade
    // implementation, not an invitation to widen the number until it passes.
    // 1.0 on a 0-255 scale is proportionally far tighter than the 0.5° the
    // slope and aspect slots carry — it is one quantisation step of the
    // product, so there is no room at all for a modelling difference.
    expect(SLOT.referenceTool).toBe('GDAL');
    expect(SLOT.toleranceAbs).toBe(1.0);
    expect(SLOT.unit).toBe('(0–255)');
  });

  it('our hillshade matches the closed form on the fixture surface', () => {
    const dem = readAsciiGrid(DEM);
    expect(dem.ncols).toBe(GRID.ncols);
    expect(dem.nrows).toBe(GRID.nrows);

    const { raw } = ourHillshade(dem);
    const truth = analyticGrid(dem.ncols, dem.nrows);
    const idx = comparableCells(dem.ncols, dem.nrows);

    const report = agreement(raw, truth, idx, SLOT.toleranceAbs);
    expect(report.verdict, `ours vs closed form: ${report.summary}`).toBe('agree');
    // Printed so the published figures are read off a run, not typed in.
    console.log(`HILLSHADE  ours vs truth: ${report.summary}`);
  });

  it('quantisation is the only difference between the shipped levels and the raw intensity', () => {
    // HAZARD: 8-BIT ENCODING, first half. `raw` exists only because
    // `HillshadeResult` does not expose the pre-rounding intensity. If it ever
    // drifted from what `shadeFromSlopeAspect` actually computes, every figure
    // in this file would describe a shading model the product does not ship.
    // Pinned as an identity: the shipped level must be the rounded, clamped raw
    // value for every cell, not merely close to it.
    const dem = readAsciiGrid(DEM);
    const { shade, raw } = ourHillshade(dem);
    for (const i of comparableCells(dem.ncols, dem.nrows)) {
      const expected = Math.max(0, Math.min(255, Math.round(raw[i])));
      expect(shade[i], `shipped level and raw intensity disagree at cell ${i}`).toBe(expected);
    }
  });

  it('rejects a reference that has been flipped north-south or mirrored east-west', () => {
    // Guards the FIXTURE, not the code. A hillshade is lit from one compass
    // direction, so a reflected grid is not a permutation of the values — it
    // lights the opposite flank of every slope while still looking like a
    // perfectly plausible relief image, which is precisely how the v0.4.3
    // aspect mirror shipped. ASCII Grid writes the northern row first while our
    // kernel treats row+1 as north, so a reversed reference is a live mistake,
    // not a hypothetical one, and a fixture that cannot detect it makes this
    // whole file decorative.
    //
    // Proved the way the hazard actually presents itself: a whole reference
    // grid is reflected and fed through the SAME comparison the real reference
    // uses. `disagree` is the assertion — `crossCheck` demands every compared
    // cell be within tolerance, so a per-cell min or max statistic would not
    // answer the question the cross-check asks.
    const dem = readAsciiGrid(DEM);
    const idx = comparableCells(dem.ncols, dem.nrows);
    const { raw } = ourHillshade(dem);
    const truth = analyticGrid(dem.ncols, dem.nrows);

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
    expect(agreement(raw, truth, idx, SLOT.toleranceAbs).verdict).toBe('agree');

    const flipReport = agreement(raw, flipped, idx, SLOT.toleranceAbs);
    expect(flipReport.verdict, `north-south flip is invisible: ${flipReport.summary}`).toBe('disagree');

    const mirrorReport = agreement(raw, mirrored, idx, SLOT.toleranceAbs);
    expect(mirrorReport.verdict, `east-west mirror is invisible: ${mirrorReport.summary}`).toBe('disagree');

    // Detection is not down to a handful of lucky cells: the great majority of
    // the grid must move outside tolerance under either reflection, so the
    // guard cannot be defeated by a reference that is flipped only in part.
    expect(flipReport.withinTolFraction).toBeLessThan(0.25);
    expect(mirrorReport.withinTolFraction).toBeLessThan(0.25);
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

    // HAZARD: EDGE POLICY, enforced rather than assumed. On a Byte band GDAL's
    // nodata IS 0, which is also a legal (fully shadowed) shade, so a nodata
    // cell inside the comparison set would silently read as a very dark cell
    // and drag the agreement down by ~150 levels with no clue why. Both halves
    // are asserted: nothing in the interior is 0, and the whole border is.
    for (const i of idx) {
      expect(ref.values[i], `GDAL wrote nodata (0) at cell ${i}, inside the comparison set`).not.toBe(0);
    }
    for (let r = 0; r < dem.nrows; r++) {
      for (let c = 0; c < dem.ncols; c++) {
        if (r !== 0 && r !== dem.nrows - 1 && c !== 0 && c !== dem.ncols - 1) continue;
        expect(
          ref.values[r * dem.ncols + c],
          `GDAL wrote a shade at border cell (${r},${c}); was -compute_edges passed?`,
        ).toBe(0);
      }
    }

    const gdal = ref.values;
    const { shade, raw } = ourHillshade(dem);
    const truth = analyticGrid(dem.ncols, dem.nrows);

    // Did the operator run the command we documented? A wrong azimuth, a wrong
    // altitude, a wrong z-factor or the multidirectional algorithm surfaces
    // HERE, before it can be averaged into a plausible ours-vs-GDAL agreement.
    const refVsTruth = agreement(gdal, truth, idx, SLOT.toleranceAbs);
    expect(refVsTruth.verdict, `GDAL vs closed form: ${refVsTruth.summary}`).toBe('agree');

    // HAZARD: 8-BIT ENCODING, second half — ROUNDED values are compared.
    //
    // GDAL only ships bytes, so there is no unrounded reference to compare
    // against. The headline leg therefore puts our SHIPPED 8-bit levels against
    // GDAL's shipped 8-bit levels: like for like, both sides rounded, which is
    // also the comparison the HILLSHADE claim is actually about (the product is
    // a Uint8Array). The unrounded intensity is reported alongside it as a
    // diagnostic, so the ±0.5-level quantisation contribution stays separable
    // from the encoding offset described in this file's header.
    const oursVsRef = agreement(shade, gdal, idx, SLOT.toleranceAbs);
    expect(oursVsRef.verdict, `ours vs GDAL: ${oursVsRef.summary}`).toBe('agree');

    const oursRawVsRef = agreement(raw, gdal, idx, SLOT.toleranceAbs);

    // Printed so the published figures are read off a run, not typed in.
    console.log(`HILLSHADE  ours vs GDAL (8-bit, both rounded): ${oursVsRef.summary}`);
    console.log(`HILLSHADE  ours vs GDAL (ours unrounded): ${oursRawVsRef.summary}`);
    console.log(`HILLSHADE  GDAL vs truth: ${refVsTruth.summary}`);
  });

  withReference('reproduces the GDAL reference exactly under GDAL’s own encoding', () => {
    // The strongest statement this fixture supports, and the one the tolerance
    // test is too blunt to make.
    //
    // Our intensity and GDAL's are the same number; the two products differ
    // only because GDAL writes 1 + 254·h (reserving 0 for nodata) where we
    // write 255·h. Re-encoding OUR intensity in GDAL's scale must therefore
    // reproduce GDAL's raster exactly, cell for cell, with zero tolerance —
    // and it does, over all 11,564 interior cells.
    //
    // This is a characterisation of the encoding relationship, NOT a fix: no
    // source under src/terrain/ is changed, our shipped encoding stays 255·h,
    // and the headline ours-vs-GDAL figure above is still measured on the raw
    // levels with the offset left in. It is here because it is the assertion
    // that would break first if either implementation's shading changed, while
    // a 1.0-level tolerance would absorb the change and keep reporting "agree".
    const dem = readAsciiGrid(DEM);
    const ref = readAsciiGrid(REF);
    const { raw } = ourHillshade(dem);
    let worst = 0;
    for (const i of comparableCells(dem.ncols, dem.nrows)) {
      const gdalEncoded = Math.round(1 + 254 * (raw[i] / 255));
      worst = Math.max(worst, Math.abs(gdalEncoded - ref.values[i]));
    }
    expect(worst, 'our intensity re-encoded in GDAL’s scale does not reproduce the reference').toBe(0);
  });

  withReference('is not carried by the near-flat cells', () => {
    // Flat ground shades to a constant and agrees for free. Since this
    // comparison deliberately keeps those cells in (see `comparableCells`), the
    // steep subset is measured on its own so the headline cannot be propped up
    // by the easy majority. Cells are selected by the CLOSED-FORM slope, not by
    // either implementation's: deriving the subset from our own kernel would
    // let a bug in it choose which cells get to judge it.
    const dem = readAsciiGrid(DEM);
    const ref = readAsciiGrid(REF);
    const { shade } = ourHillshade(dem);

    const steep: number[] = [];
    for (let r = 1; r < dem.nrows - 1; r++) {
      for (let c = 1; c < dem.ncols - 1; c++) {
        if (analyticSlopeDegrees(r, c) > 2) steep.push(r * dem.ncols + c);
      }
    }
    expect(steep.length).toBeGreaterThan(10000);

    const report = agreement(shade, ref.values, steep, SLOT.toleranceAbs);
    expect(report.verdict, `ours vs GDAL, steep cells only: ${report.summary}`).toBe('agree');
    console.log(`HILLSHADE  ours vs GDAL (slope above 2° only): ${report.summary}`);
  });

  it('keeps the slot status tied to whether a reference is actually supplied', () => {
    // The claim and the artifact move together. Flipping the slot to
    // "supplied" without the file, or landing the file without flipping the
    // slot, both fail here.
    expect(SLOT.status).toBe(existsSync(REF) ? 'supplied' : 'pending');
  });
});
