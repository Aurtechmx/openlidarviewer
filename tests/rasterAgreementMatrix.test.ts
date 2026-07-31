/**
 * rasterAgreementMatrix.test.ts — slope, aspect and hillshade across a FIXTURE
 * MATRIX rather than one frozen DEM.
 *
 * The three existing cross-implementation checks (`slopeCrossCheck`,
 * `aspectCrossCheck`, `hillshadeCrossCheck`) each run on a single 120x100
 * quadratic at 1 m in a projected CRS with no holes. That is enough to establish
 * that the kernels are not grossly wrong; it is not enough to say anything about
 * cell size, extent, gradient sign, surface shape, nodata policy, edge policy or
 * horizontal unit, because none of those varies. This file varies all of them
 * and reports each combination separately.
 *
 * This file ADDS to those three and changes none of them, and it promotes
 * nothing: `src/validation/crossCheck.ts` REFERENCE_SLOTS and
 * `docs/validation/claim-register.yaml` are untouched. What it produces is a
 * record of where the agreement holds and where it stops.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE LEVEL. THE FIXTURE COUNT IS NOT E4 BREADTH.
 * ─────────────────────────────────────────────────────────────────────────────
 * Comparing our kernel against a closed-form formula on an analytic fixture is
 * E2 — one implementation against a formula, however many fixtures it runs on.
 * Against a synthetic surface it is E3. It is E4 only when a SECOND INDEPENDENT
 * IMPLEMENTATION produced the reference. Every leg below therefore carries an
 * explicit `reference` and `evidenceLevel`, and only the `GDAL 3.13.1` legs are
 * cross-implementation. Twenty-four analytic fixtures do not add up to E4; the
 * gdaldem runs recorded in `validation/cross-implementation/raster-matrix/reference-runs.json`
 * are what do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH ERROR METRIC BELONGS TO WHICH PRODUCT
 * ─────────────────────────────────────────────────────────────────────────────
 * SLOPE is a magnitude, so plain absolute error is the correct metric: max |Δ|,
 * RMSE, mean signed bias, within-tolerance fraction. (The brief that prompted
 * this work called absolute error "circularly irrelevant" for slope. That is
 * wrong and unfollowable: circularity is a property of a BEARING, and slope is
 * not one. Circular separation belongs to aspect and is used there.)
 *
 * ASPECT is a bearing, so every difference is a CIRCULAR separation: 359° and 1°
 * differ by 2, not 358. Cells below a preregistered minimum slope are excluded,
 * because aspect is undefined on flat ground, and the count of excluded cells is
 * reported rather than hidden.
 *
 * HILLSHADE is compared twice, and the two must not be allowed to substitute for
 * one another. The ILLUMINATION MODEL is compared as an unquantised intensity;
 * the BYTE ENCODING is compared as the shipped 8-bit product. Our encoding is
 * round(255·h) and gdaldem's is round(1 + 254·h) (level 0 reserved for nodata),
 * a fixed offset of up to one level, so a byte tolerance wide enough to absorb
 * that offset is also wide enough to absorb a real shading error of half a level.
 * `hides a sub-level shading error in the byte product but not in the intensity`
 * demonstrates exactly that, by injecting such an error and showing which leg
 * catches it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROW ORDER. ESRI ASCII Grid writes the NORTHERNMOST row first; `hornSlopeAspect`
 * treats row+1 as NORTH. Rows are flipped on the way into the Horn pass and back
 * on the way out, so every grid in this file is in ASCII-Grid order. This is the
 * v0.4.3 defect recorded in `src/terrain/ground/terrainDerivatives.ts`: a
 * directional product lit from the wrong flank still looks like terrain.
 * `records which fixtures are blind to a row-order flip` measures, per fixture,
 * whether this matrix could actually detect the mistake.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { shadeFromSlopeAspect, computeMultiHillshade, azimuthToMathRad } from '../src/terrain/surface/hillshade';
import { crossCheck } from '../src/validation/crossCheck';
import type { CrossCheckReport } from '../src/validation/crossCheck';
import {
  FIXTURES,
  SUNS,
  MATRIX_DIR,
  NODATA,
  ASPECT_MIN_SLOPE_DEG,
  GEO_METRES_PER_DEG_LAT,
  GEO_METRES_PER_DEG_LON,
  GEO_CENTRE_LATITUDE_DEG,
  cellMetres,
  analyticGradient,
  analyticSlopeDegrees,
  analyticAspectDegrees,
  straddlesKink,
  windowFullyValid,
  isHaloCell,
  isNodata,
} from '../scripts/generate-raster-fixtures.mjs';
import type { FixtureSpec, FixtureSun } from '../scripts/generate-raster-fixtures.mjs';

/**
 * Write a committed evidence artifact, or in verify mode prove the committed
 * one is what this run produces.
 *
 * The reproduce instructions recomputed the OLV side and rewrote `olv/`,
 * `olv-SHA256SUMS` and `results.json` every time. That makes the committed
 * evidence unfalsifiable by its own procedure: whatever the code does today
 * becomes the record, and a change in the OLV side rewrites the file it was
 * supposed to be checked against. The hashes pin both sides and nothing
 * compared against them.
 *
 * So verifying is the DEFAULT and regenerating is the opt-in. The first version
 * of this helper had it the other way round, behind `MATRIX_VERIFY=1`, and that
 * was worse than useless: this file sits in the `terrain` bucket, `test:terrain`
 * is in `test:release:execute`, and nothing set the variable. Every release run
 * therefore rewrote the record it was supposed to check, while a verify mode
 * existed to say the record was checked. A guard that is off unless you
 * remember a variable is a guard that is off.
 *
 * `MATRIX_WRITE=1` regenerates, for the one case that needs it: a deliberate
 * change to the OLV side, reviewed as a diff to the committed evidence.
 *
 * Verification is SEMANTIC, not byte-for-byte. `results.json` stores 569
 * full-precision doubles derived from `atan2`, and a byte compare of those
 * turns a libm ulp difference on another CPU into a red release gate with no
 * way to tell it from a regression. Numbers compare within a relative epsilon
 * far tighter than any real change and far looser than rounding noise;
 * everything else compares exactly. A guard that fails on the wrong machine
 * gets disabled, which is the same outcome as not having one.
 *
 * Failures are collected rather than asserted here. This runs at module scope,
 * so an `expect` would surface as a collection error naming no test.
 */
const MATRIX_WRITE = process.env.MATRIX_WRITE === '1';

/** Drift found during the run, asserted inside a test at the end of the file. */
const evidenceDrift: string[] = [];

const NUM_REL_EPS = 1e-9;
const NUM_ABS_EPS = 1e-12;

/** Deep equality where numbers are compared within a tolerance. */
function sameValue(a: unknown, b: unknown, path: string, out: string[]): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    const tol = Math.max(NUM_ABS_EPS, NUM_REL_EPS * Math.max(Math.abs(a), Math.abs(b)));
    if (!(Math.abs(a - b) <= tol)) out.push(`${path}: ${b} committed, ${a} produced`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}: ${b.length} entries committed, ${a.length} produced`); return; }
    for (let i = 0; i < a.length; i++) sameValue(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join() !== kb.join()) { out.push(`${path}: key set differs`); return; }
    for (const k of ka) {
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(b)} committed, ${JSON.stringify(a)} produced`);
}

function writeOrVerify(path: string, content: string, what: string): void {
  if (MATRIX_WRITE) {
    writeFileSync(path, content, 'utf8');
    return;
  }
  if (!existsSync(path)) {
    evidenceDrift.push(`${what} is missing. Run with MATRIX_WRITE=1 to generate it, then commit it.`);
    return;
  }
  const committed = readFileSync(path, 'utf8');
  if (committed === content) return;

  if (what.endsWith('.json')) {
    const diffs: string[] = [];
    try {
      sameValue(JSON.parse(content), JSON.parse(committed), what, diffs);
    } catch {
      diffs.push(`${what}: committed file is not parseable JSON`);
    }
    // Byte-different but numerically equal is the platform case, not a change.
    if (diffs.length === 0) return;
    evidenceDrift.push(...diffs.slice(0, 12));
    if (diffs.length > 12) evidenceDrift.push(`${what}: ${diffs.length - 12} further differences`);
    return;
  }

  // Line-oriented artifacts (the hash list). Name the lines, not the blob.
  const cl = committed.split('\n');
  const nl = content.split('\n');
  const changed = nl.filter((l, i) => l !== cl[i]).slice(0, 8);
  evidenceDrift.push(
    `${what} differs on ${changed.length} line(s): ${changed.join(', ')}`
    + '. If the change is intended, re-run with MATRIX_WRITE=1 and commit the diff.',
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FROZEN TOLERANCES
 *
 * Every number below was fixed BEFORE any comparison in this file was run, from
 * the stated derivation and not from a measurement. If a fixture family misses
 * one, that is a finding about the implementation or about the fixture, and the
 * boundary is reported in `results.json` and in this file's console output. None
 * of these is widened to make a leg pass.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const FROZEN_TOLERANCES = {
  /**
   * Slope, degrees. 0.01° for BOTH the analytic and the GDAL leg.
   *
   * Derivation: Horn's weighted 3x3 central difference is EXACT on every surface
   * in this matrix away from a kink. A central difference reproduces the
   * derivative of a quadratic exactly (((x+h)² − (x−h)²)/2h = 2x), the 1-2-1 row
   * weighting is a convex combination of three such exact differences, and the
   * planar, ridge and terrace families are locally linear. So the only error is
   * float32 storage of the DEM and the 6-decimal output rounding: with relief
   * under ~1100 m, float32 spacing is ~6e-5 m, which over the shortest run in the
   * matrix (8 x 0.5 m) is ~1e-4 rise/run, or ~0.006° of slope. 0.01° leaves less
   * than a factor of two of headroom, so a modelling difference cannot hide in it.
   * Deliberately far tighter than the 0.5° carried by the SLOPE-RASTER slot.
   */
  slopeDeg: 0.01,
  /**
   * Slope, percentage POINTS of rise. 0.05 pp.
   *
   * Derivation: percent rise is 100·tan(slope), and d(100·tan)/d(slope in
   * degrees) is 1.75 pp per degree at 0° rising to 3.5 pp per degree at 45°. The
   * steepest cell in the matrix is ~24° (0.45 rise/run), where the factor is
   * ~2.1, so 0.01° of slope is ~0.02 pp. 0.05 pp is that with a small margin for
   * the 6-decimal output rounding on a value of order 40.
   */
  slopePercentPoints: 0.05,
  /**
   * Aspect, degrees of CIRCULAR separation. 0.25°.
   *
   * Derivation: an aspect error is the gradient error divided by the gradient
   * magnitude. At the ASPECT_MIN_SLOPE_DEG cutoff of 0.5° the gradient magnitude
   * is 0.0087 rise/run, and the ~1e-4 worst-case gradient error derived above
   * gives 0.011 rad, i.e. 0.66°... which is why the cutoff matters: at the 0.5°
   * cutoff the run is 8 x 0.5 m only on the two finest fixtures, and on those the
   * relief is small so the float32 spacing is ~1e-6 rather than 6e-5, giving
   * ~0.01°. 0.25° is an order of magnitude above the typical case and still an
   * order of magnitude below any plausible convention error (a mirrored or
   * rotated frame moves aspect by tens of degrees, not tenths).
   */
  aspectCircularDeg: 0.25,
  /**
   * Hillshade ILLUMINATION MODEL, in units of h (the cosine of the angle between
   * the surface normal and the sun, so h is in [-1, 1]). 0.0025.
   *
   * Derivation: gdaldem only ships an 8-bit band, so the finest reference
   * intensity obtainable is the decoded level (level − 1)/254. Decoding a value
   * gdaldem rounded costs up to 0.5/254 = 0.001969 on its own. 0.0025 is that
   * quantisation floor plus 0.13 of a level of headroom for a genuine modelling
   * difference — tight enough that a half-level shading error fails this leg,
   * which is the whole point of separating it from the byte leg.
   */
  hillshadeIntensity: 0.0025,
  /**
   * Hillshade BYTE ENCODING, in 8-bit levels. 2.0.
   *
   * Derivation: our shipped encoding is round(255·h), gdaldem's is
   * round(1 + 254·h). For the same h those differ by |1 − h| ≤ 1 level before
   * rounding, and the two independent roundings add up to 1 more. 2.0 is exactly
   * that budget and no more. It is DELIBERATELY too coarse to catch a sub-level
   * shading error, which is why the intensity leg above exists and why
   * `hides a sub-level shading error in the byte product but not in the intensity`
   * proves the separation instead of asserting it in prose.
   */
  hillshadeByteLevels: 2.0,
} as const;

/**
 * Minimum comparable cells for a leg to return a verdict at all.
 *
 * 24 rather than crossCheck's default 8: a couple of dozen cells is enough that
 * a lucky match cannot read as agreement, and it is low enough that the
 * `thin-corridor` fixture still reports — by construction that grid has only 186
 * fully-valid 3x3 windows, and on its aspect leg fewer still. A leg below the
 * floor is recorded `insufficient`, never as a pass.
 */
const MIN_CELLS = 24;

/**
 * The half-level intensity error injected by the encoding-separation test.
 *
 * 0.5/254 is not a tuned number: it is the largest error the 8-bit product can
 * round away, so it is the exact size of fault the byte leg is blind to by
 * construction.
 */
const HALF_LEVEL = 0.5 / 254;

const DEG = Math.PI / 180;
const FIXTURE_DIR = resolve(MATRIX_DIR, 'fixtures');
const GDAL_DIR = resolve(MATRIX_DIR, 'gdal');
const OLV_DIR = resolve(MATRIX_DIR, 'olv');
const RUNS_PATH = resolve(MATRIX_DIR, 'reference-runs.json');

// ── ASCII Grid IO ───────────────────────────────────────────────────────────

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
 * Deliberately strict: a missing header key, or a cell count that disagrees with
 * ncols x nrows, throws rather than being tolerated. A lenient parser here would
 * let a malformed reference file through as data. Duplicated from the sibling
 * cross-check tests on purpose — those files are owned by other in-flight work
 * and must not be edited to hoist a shared helper.
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
  return { ncols, nrows, cellsize: header.cellsize, nodata: header.nodata_value ?? NODATA, values };
}

/** Write an OLV product grid so the two sides of every comparison are both on disk. */
function writeAsciiGrid(path: string, spec: FixtureSpec, values: ArrayLike<number>, decimals: number): void {
  const lines = [
    `ncols ${spec.cols}`,
    `nrows ${spec.rows}`,
    `xllcorner ${spec.xll}`,
    `yllcorner ${spec.yll}`,
    `cellsize ${spec.cellsize}`,
    `NODATA_value ${NODATA}`,
  ];
  for (let r = 0; r < spec.rows; r++) {
    const row = new Array<string>(spec.cols);
    for (let c = 0; c < spec.cols; c++) {
      const v = values[r * spec.cols + c];
      row[c] = Number.isFinite(v) ? (decimals === 0 ? String(v) : v.toFixed(decimals)) : String(NODATA);
    }
    lines.push(row.join(' '));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ── the OLV side ────────────────────────────────────────────────────────────

interface OlvGrids {
  /** rise/run, ASCII-Grid row order. */
  tangent: Float64Array;
  slopeDeg: Float64Array;
  slopePct: Float64Array;
  /** Downslope direction, math frame radians (CCW from east), ASCII order. */
  aspectRad: Float64Array;
  /** Downslope bearing, compass degrees clockwise from north, ASCII order. */
  aspectDeg: Float64Array;
  /** 1 where the DEM cell carries data. */
  coverage: Uint8Array;
}

/**
 * Run the shipped Horn kernel over a fixture DEM and return every slope/aspect
 * form the comparison needs, in ASCII-Grid row order.
 *
 * `cellX`/`cellY` are metres per cell along each axis. They are parameters
 * rather than derived inside, because the geographic fixture is deliberately run
 * BOTH ways: once with the true unequal metres (the physically correct model) and
 * once with equal spacing (the only model `gdaldem aspect` can express). Passing
 * them in is what makes that pair of runs possible without a second code path.
 */
function computeOlv(spec: FixtureSpec, dem: AsciiGrid, cellX: number, cellY: number): OlvGrids {
  const { cols, rows } = { cols: spec.cols, rows: spec.rows };
  const n = cols * rows;
  // ASCII Grid row 0 is north; hornSlopeAspect wants row+1 = north.
  const northingUp = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = dem.values[r * cols + c];
      northingUp[(rows - 1 - r) * cols + c] = v === dem.nodata ? Number.NaN : v;
    }
  }
  const { slope, aspect } = hornSlopeAspect(northingUp, cols, rows, cellX, cellY, 1);

  const tangent = new Float64Array(n);
  const slopeDeg = new Float64Array(n);
  const slopePct = new Float64Array(n);
  const aspectRad = new Float64Array(n);
  const aspectDeg = new Float64Array(n);
  const coverage = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = (rows - 1 - r) * cols + c;
      const dst = r * cols + c;
      const t = slope[src];
      tangent[dst] = t;
      slopeDeg[dst] = (Math.atan(t) * 180) / Math.PI;
      slopePct[dst] = t * 100;
      aspectRad[dst] = aspect[src];
      // Math frame (CCW from east, 90 = north) to compass (CW from north). Both
      // the zero AND the sense change; getting only one right yields a mirrored
      // grid that still looks like terrain.
      const mathDeg = (aspect[src] * 180) / Math.PI;
      aspectDeg[dst] = (((90 - mathDeg) % 360) + 360) % 360;
      coverage[dst] = Number.isFinite(northingUp[src]) ? 1 : 0;
    }
  }
  return { tangent, slopeDeg, slopePct, aspectRad, aspectDeg, coverage };
}

interface OlvShade {
  /** Unquantised illumination intensity h in [-1, 1], ASCII order. */
  intensity: Float64Array;
  /** The SHIPPED 8-bit product, ASCII order. */
  byte: Float64Array;
}

/**
 * Single-direction hillshade from the shipped `shadeFromSlopeAspect`, plus the
 * pre-quantisation intensity.
 *
 * `HillshadeResult` exposes only the rounded byte, so `intensity` re-evaluates
 * the same closed-form expression on the same slope/aspect arrays. That is a
 * derivation, not a second implementation, and
 * `the shipped byte is exactly the rounded intensity on every fixture` pins it
 * as an identity so it cannot drift into a softer model the comparison would
 * silently prefer.
 */
function olvHillshade(g: OlvGrids, spec: FixtureSpec, sun: FixtureSun): OlvShade {
  const result = shadeFromSlopeAspect(g.tangent, g.aspectRad, g.coverage, spec.cols, spec.rows, {
    azimuthDeg: sun.azimuthDeg,
    altitudeDeg: sun.altitudeDeg,
    zFactor: sun.zFactor,
  });
  const zenith = (90 - sun.altitudeDeg) * DEG;
  const cosZen = Math.cos(zenith);
  const sinZen = Math.sin(zenith);
  const azMath = azimuthToMathRad(sun.azimuthDeg);
  const n = spec.cols * spec.rows;
  const intensity = new Float64Array(n);
  const byte = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const slopeRad = Math.atan(sun.zFactor * g.tangent[i]);
    intensity[i] =
      cosZen * Math.cos(slopeRad) + sinZen * Math.sin(slopeRad) * Math.cos(azMath - g.aspectRad[i]);
    byte[i] = result.shade[i];
  }
  return { intensity, byte };
}

/** Our multidirectional relief, shipped encoding, ASCII order. */
function olvMultiHillshade(g: OlvGrids, spec: FixtureSpec, sun: FixtureSun): Float64Array {
  const result = computeMultiHillshade(g.tangent, g.aspectRad, g.coverage, spec.cols, spec.rows, {
    altitudeDeg: sun.altitudeDeg,
    zFactor: sun.zFactor,
  });
  const out = new Float64Array(spec.cols * spec.rows);
  for (let i = 0; i < out.length; i++) out[i] = result.shade[i];
  return out;
}

// ── comparison ──────────────────────────────────────────────────────────────

/** Interior cells whose whole 3x3 Horn window is in-grid and carries data. */
function interiorIndices(spec: FixtureSpec): number[] {
  const idx: number[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) if (windowFullyValid(spec, r, c)) idx.push(r * spec.cols + c);
  }
  return idx;
}

/**
 * Border cells for the ANALYTIC legs, split into the edge ring and the corners.
 *
 * WHY THIS EXISTS. `interiorIndices` — and so `analyticIndices` — excludes every
 * border cell by construction, because a border cell's 3x3 window is not fully
 * in-grid. The consequence went unnoticed: the outer ring had NO closed-form
 * check, only agreement with gdaldem. That is a circularity precisely where it
 * matters most, because the kernel's border policy was deliberately copied FROM
 * gdaldem, corner asymmetry included (terrainDerivatives.ts). Agreement there is
 * therefore not independent corroboration — the two implementations are running
 * the same edge rule by construction, which is the exact failure mode this
 * file's three-way design exists to prevent. These selections restore the
 * missing third edge of the triangle: ours against a formula.
 *
 * Edge and corner are separate because the policy treats them differently. An
 * edge cell extrapolates the one axis that leaves the grid. A corner ALSO clamps
 * the along-edge axis, so a gradient component along that axis is halved there.
 *
 * Exclusions match `analyticIndices` in spirit: kink-straddling cells, because
 * no 3x3 estimator should reproduce a closed form across a discontinuity, and
 * anything within reach of a hole, because the closed form does not model hole
 * filling. The nodata exclusion is a deliberately conservative radius-2
 * neighbourhood — it covers both the window and the cells the extrapolation
 * reads — and the count is reported rather than absorbed.
 */
function analyticBorderIndices(spec: FixtureSpec): {
  edge: number[];
  corner: number[];
  excluded: Record<string, number>;
} {
  const edge: number[] = [];
  const corner: number[] = [];
  const excluded = { kink: 0, nearNodata: 0 };
  const clampR = (r: number) => (r < 0 ? 0 : r >= spec.rows ? spec.rows - 1 : r);
  const clampC = (c: number) => (c < 0 ? 0 : c >= spec.cols ? spec.cols - 1 : c);
  const nearNodata = (r: number, c: number): boolean => {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (isNodata(spec, clampR(r + dr), clampC(c + dc))) return true;
      }
    }
    return false;
  };
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      const onBorder = r === 0 || c === 0 || r === spec.rows - 1 || c === spec.cols - 1;
      if (!onBorder) continue;
      if (straddlesKink(spec, r, c)) {
        excluded.kink++;
        continue;
      }
      if (nearNodata(r, c)) {
        excluded.nearNodata++;
        continue;
      }
      const isCorner = (r === 0 || r === spec.rows - 1) && (c === 0 || c === spec.cols - 1);
      (isCorner ? corner : edge).push(r * spec.cols + c);
    }
  }
  return { edge, corner, excluded };
}

/**
 * True where the surface is LOCALLY LINEAR, so linear extrapolation of the
 * virtual neighbour reconstructs it exactly and the extrapolated border is
 * predicted to reproduce the closed form. Derived before the run, not fitted to
 * it: 2a−b is exact for an affine function, Horn is exact on a plane, and the
 * piecewise-planar families are affine away from their kink (which is excluded).
 *
 * A quadratic is NOT locally linear, and the error is derivable. For z = a·x²
 * with cell h, the virtual cell is 2z(x₀) − z(x₀+h) = a(x₀² − 2x₀h − h²) against
 * a true a(x₀ − h)² = a(x₀² − 2x₀h + h²), so it is low by 2ah². Carrying that
 * through the 1-2-1 weighting gives an edge dz/dx of 2a·x₀ + a·h against a true
 * 2a·x₀ — an error of a·h, where the interior central difference is EXACT on a
 * quadratic. So a curved fixture is predicted to diverge, by roughly a·h in
 * rise/run: 0.008 for convex-hill (a = −0.004, h = 2), 0.04 for concave-pit
 * (a = 0.004, h = 10), 0.003 for saddle (a = 0.006, h = 0.5). All far outside the
 * 0.01° tolerance, and none of it visible in the gdaldem leg.
 */
function locallyLinearSurface(spec: FixtureSpec): boolean {
  return spec.surface.kind !== 'quadratic';
}

/** Border cells. Only meaningful for a `-compute_edges` run. */
function borderIndices(spec: FixtureSpec): number[] {
  const idx: number[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      if (r === 0 || c === 0 || r === spec.rows - 1 || c === spec.cols - 1) idx.push(r * spec.cols + c);
    }
  }
  return idx;
}

/** Signed circular difference in (-180, 180]. 359 minus 1 is +2, not +358. */
function circularDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  // `(0 - 360) % 360` is NEGATIVE zero in JS, which then leaks into the recorded
  // bias and into any strict comparison. Collapsed here so identical bearings
  // report a difference of exactly 0.
  return d === 0 ? 0 : d;
}

/**
 * Absolute-error agreement over `idx`. Correct for slope (a magnitude) and for
 * the hillshade intensity and byte level; NOT for aspect.
 */
function linearAgreement(
  ours: ArrayLike<number>,
  ref: ArrayLike<number>,
  idx: readonly number[],
  tol: number,
): CrossCheckReport {
  const a = new Float64Array(idx.length);
  const b = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    a[k] = ours[idx[k]];
    b[k] = ref[idx[k]];
  }
  return crossCheck(a, b, { toleranceAbs: tol, minCells: MIN_CELLS });
}

/**
 * CIRCULAR agreement over `idx`, for bearings.
 *
 * The signed circular differences are compared against zero, which makes
 * `maxAbsDiff` the largest circular SEPARATION, `meanDiff` the circular bias and
 * `withinTolFraction` the fraction of bearings within tolerance. Feeding raw
 * bearings to `crossCheck` would score a 359-vs-1 pair as 358° apart.
 */
function circularAgreement(
  ours: ArrayLike<number>,
  ref: ArrayLike<number>,
  idx: readonly number[],
  tol: number,
): CrossCheckReport {
  const d = new Float64Array(idx.length);
  const zero = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) d[k] = circularDelta(ours[idx[k]], ref[idx[k]]);
  return crossCheck(d, zero, { toleranceAbs: tol, minCells: MIN_CELLS });
}

// ── the matrix run ──────────────────────────────────────────────────────────

type LegStatus = 'ok' | 'insufficient' | 'unavailable';

interface Leg {
  fixtureId: string;
  family: string;
  product: string;
  /** What the compared numbers are measured in. */
  unit: string;
  /** Which implementation produced the reference this leg compares against. */
  reference: 'analytic (closed form)' | 'GDAL 3.13.1';
  evidenceLevel: 'E2 (formula)' | 'E4 (cross-implementation)';
  metric: 'absolute' | 'circular';
  cellSet: string;
  cells: number;
  excluded: Record<string, number>;
  tolerance: number;
  maxAbsDiff: number | null;
  rmse: number | null;
  meanBias: number | null;
  withinTolFraction: number | null;
  verdict: string;
  /** Declared BEFORE the run, from reading both implementations. */
  expectation: 'agree' | 'documented-divergence';
  status: LegStatus;
  reason?: string;
  /**
   * True where `expectation` was corrected AFTER the first run of this file
   * rather than derived before it, so the record says so rather than letting a
   * corrected prediction read as a prediction that was right all along.
   *
   * No leg carries it today. The `-compute_edges` border legs did: they were
   * declared "agree", disagreed by 6 to 16 degrees, and were re-declared a
   * divergence. That divergence was then FIXED in `hornSlopeAspect` rather than
   * characterised, so those legs are back to expecting agreement and no longer
   * need the flag. It stays because the next such correction should be labelled
   * the same way — it is the mechanism, not a record of that one finding.
   */
  expectationRevisedAfterFirstRun?: boolean;
}

interface ReferenceRun {
  runId: string;
  fixtureId: string;
  product: string;
  status: 'ok' | 'failed' | 'unavailable';
  reason?: string;
  commandLine?: string;
  unit?: string;
  axisScaling?: string;
  output?: string;
}

interface ReferenceRecord {
  environment: {
    gdalinfoVersion: string;
    gdaldemResolvedPath: string;
    containerPinning: string;
    containerPinningReason: string;
    platform: string;
    architecture: string;
  };
  runs: ReferenceRun[];
}

const REF_RECORD: ReferenceRecord | null = existsSync(RUNS_PATH)
  ? (JSON.parse(readFileSync(RUNS_PATH, 'utf8')) as ReferenceRecord)
  : null;

const specById = new Map(FIXTURES.map((f) => [f.id, f]));
const demCache = new Map<string, AsciiGrid>();
const olvCache = new Map<string, OlvGrids>();

function demFor(spec: FixtureSpec): AsciiGrid {
  const hit = demCache.get(spec.id);
  if (hit) return hit;
  const dem = readAsciiGrid(resolve(FIXTURE_DIR, `${spec.id}.asc`));
  demCache.set(spec.id, dem);
  return dem;
}

/** OLV grids under the fixture's TRUE per-axis metres. */
function olvFor(spec: FixtureSpec): OlvGrids {
  const hit = olvCache.get(spec.id);
  if (hit) return hit;
  const m = cellMetres(spec);
  const g = computeOlv(spec, demFor(spec), m.x, m.y);
  olvCache.set(spec.id, g);
  return g;
}

const legs: Leg[] = [];
const notes: string[] = [];

/**
 * Corner samples pooled ACROSS fixtures, for the analytic corner legs.
 *
 * Pooled because there are only four corners per fixture and `MIN_CELLS` is 24 —
 * statistics over four cells are not a measurement, and this file already refuses
 * to record them as one. Pooling absolute ours-vs-closed-form differences across
 * fixtures is legitimate: every sample is the same quantity, a slope error in
 * degrees, and no fixture's truth leaks into another's.
 *
 * Split into a TREATMENT and a CONTROL group by a prediction made from the policy
 * alone, before any measurement. A corner clamps the along-edge (column, x) axis,
 * so it is predicted wrong exactly where the closed-form gradient has a non-zero
 * dz/dx component, and predicted EXACT where dz/dx is zero — halving zero is
 * still zero. The control group is what makes the treatment group's divergence
 * attributable to the along-edge clamp rather than to being a corner.
 */
const cornerAnalytic = {
  alongEdgeGradient: { ours: [] as number[], truth: [] as number[], fixtures: new Set<string>() },
  noAlongEdgeGradient: { ours: [] as number[], truth: [] as number[], fixtures: new Set<string>() },
};

function pushLeg(base: Omit<Leg, 'maxAbsDiff' | 'rmse' | 'meanBias' | 'withinTolFraction' | 'verdict' | 'status' | 'cells'>, report: CrossCheckReport | null, cells: number, reason?: string): void {
  if (!report) {
    legs.push({ ...base, cells, maxAbsDiff: null, rmse: null, meanBias: null, withinTolFraction: null,
      verdict: 'not-executed', status: 'unavailable', reason });
    return;
  }
  if (report.verdict === 'insufficient') {
    // Statistics over fewer than MIN_CELLS cells are not a measurement, and
    // crossCheck returns 0 for max/RMSE when nothing was compared. Recording
    // those zeros would read as perfect agreement, so they are nulled and the
    // cell count carries the reason instead.
    legs.push({ ...base, cells: report.count, maxAbsDiff: null, rmse: null, meanBias: null,
      withinTolFraction: null, verdict: 'insufficient', status: 'insufficient',
      reason: `${report.count} comparable cells (< ${MIN_CELLS})` });
    return;
  }
  legs.push({ ...base, cells: report.count, maxAbsDiff: report.maxAbsDiff, rmse: report.rmse,
    meanBias: report.meanDiff, withinTolFraction: report.withinTolFraction, verdict: report.verdict,
    status: 'ok', reason });
}

/**
 * Aspect comparison set: interior, away from kinks, above the preregistered
 * minimum slope, and where the REFERENCE actually wrote a bearing.
 *
 * The slope filter reads the CLOSED-FORM slope, never ours: selecting cells with
 * our own kernel would let a bug in it choose which cells get to judge it. The
 * reference filter drops cells where gdaldem wrote its undefined marker, counted
 * separately so a value-against-placeholder comparison cannot be mistaken for a
 * bearing disagreement.
 */
function aspectIndices(
  spec: FixtureSpec,
  ref: Float64Array | null,
  refUndefined: readonly number[],
): { idx: number[]; excluded: Record<string, number> } {
  const idx: number[] = [];
  const excluded = { kink: 0, belowMinSlope: 0, referenceUndefined: 0, analyticUndefined: 0 };
  for (const i of interiorIndices(spec)) {
    const r = Math.floor(i / spec.cols);
    const c = i % spec.cols;
    if (straddlesKink(spec, r, c)) {
      excluded.kink++;
      continue;
    }
    if (analyticSlopeDegrees(spec, r, c) < ASPECT_MIN_SLOPE_DEG) {
      excluded.belowMinSlope++;
      continue;
    }
    if (!Number.isFinite(analyticAspectDegrees(spec, r, c))) {
      excluded.analyticUndefined++;
      continue;
    }
    if (ref && refUndefined.includes(ref[i])) {
      excluded.referenceUndefined++;
      continue;
    }
    idx.push(i);
  }
  return { idx, excluded };
}

/** Interior cells away from a kink: the set the analytic legs may use. */
function analyticIndices(spec: FixtureSpec): { idx: number[]; excluded: Record<string, number> } {
  const idx: number[] = [];
  const excluded = { kink: 0 };
  for (const i of interiorIndices(spec)) {
    const r = Math.floor(i / spec.cols);
    const c = i % spec.cols;
    if (straddlesKink(spec, r, c)) {
      excluded.kink++;
      continue;
    }
    idx.push(i);
  }
  return { idx, excluded };
}

// Build every leg once, up front, so all tests read the same numbers and the
// results record cannot describe a different run than the assertions did.
if (REF_RECORD) {
  mkdirSync(OLV_DIR, { recursive: true });
  const olvHashes: string[] = [];

  const writeOlv = (name: string, spec: FixtureSpec, values: ArrayLike<number>, decimals: number): void => {
    const path = resolve(OLV_DIR, `${name}.asc`);
    writeAsciiGrid(path, spec, values, decimals);
    olvHashes.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  olv/${name}.asc`);
  };

  for (const run of REF_RECORD.runs) {
    const spec = specById.get(run.fixtureId);
    if (!spec) continue;
    const common = { fixtureId: spec.id, family: spec.family, product: run.product };
    if (run.status !== 'ok' || !run.output) {
      // A reference that was not produced is recorded as unavailable with the
      // operator's own reason. Never a zero, never an inferred pass.
      legs.push({ ...common, unit: run.unit ?? 'unknown', reference: 'GDAL 3.13.1',
        evidenceLevel: 'E4 (cross-implementation)', metric: 'absolute', cellSet: 'none', cells: 0,
        excluded: {}, tolerance: 0, maxAbsDiff: null, rmse: null, meanBias: null, withinTolFraction: null,
        verdict: 'not-executed', status: 'unavailable', expectation: 'agree',
        reason: run.reason ?? 'gdaldem run did not produce an output' });
      continue;
    }
    const ref = readAsciiGrid(resolve(MATRIX_DIR, run.output));
    const g = olvFor(spec);
    const interior = interiorIndices(spec);

    if (run.product === 'slope-deg' || run.product === 'slope-deg-edges') {
      const edges = run.product === 'slope-deg-edges';
      const an = analyticIndices(spec);
      const truth = new Float64Array(spec.cols * spec.rows);
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) truth[r * spec.cols + c] = analyticSlopeDegrees(spec, r, c);
      }
      pushLeg({ ...common, unit: 'degree', reference: 'analytic (closed form)', evidenceLevel: 'E2 (formula)',
        metric: 'absolute', cellSet: 'interior, full 3x3 window, off-kink', excluded: an.excluded,
        tolerance: FROZEN_TOLERANCES.slopeDeg, expectation: 'agree' },
        linearAgreement(g.slopeDeg, truth, an.idx, FROZEN_TOLERANCES.slopeDeg), an.idx.length);

      pushLeg({ ...common, unit: 'degree', reference: 'GDAL 3.13.1', evidenceLevel: 'E4 (cross-implementation)',
        metric: 'absolute', cellSet: 'interior, full 3x3 window', excluded: {},
        tolerance: FROZEN_TOLERANCES.slopeDeg, expectation: 'agree' },
        linearAgreement(g.slopeDeg, ref.values, interior, FROZEN_TOLERANCES.slopeDeg), interior.length);

      if (!edges) {
        // ANALYTIC border legs — the closed form, not gdaldem. Built on the
        // plain `slope-deg` run so they appear once per fixture, and they need no
        // reference output at all: the truth is a formula, so every fixture can
        // carry them, not just the five with a `-compute_edges` reference.
        //
        // These exist because the border was, until now, checked ONLY against
        // gdaldem — whose edge rule this kernel deliberately copies. See
        // `analyticBorderIndices` for why that is circular and what it hid.
        const ab = analyticBorderIndices(spec);
        const linear = locallyLinearSurface(spec);
        pushLeg({ ...common, product: 'slope-deg [border edge, analytic]', unit: 'degree',
          reference: 'analytic (closed form)', evidenceLevel: 'E2 (formula)', metric: 'absolute',
          cellSet: 'border ring minus corners, off-kink, clear of nodata', excluded: ab.excluded,
          tolerance: FROZEN_TOLERANCES.slopeDeg,
          // Predicted from the estimator, not fitted to the result: linear
          // extrapolation reconstructs an affine neighbour exactly, so a locally
          // linear surface must reproduce the closed form. A quadratic must not —
          // the edge dz/dx carries an a·h error the interior does not.
          expectation: linear ? 'agree' : 'documented-divergence' },
          linearAgreement(g.slopeDeg, truth, ab.edge, FROZEN_TOLERANCES.slopeDeg), ab.edge.length);

        // Corners are pooled across fixtures (four per fixture is below
        // MIN_CELLS), split by the a-priori prediction that only an along-edge
        // gradient component is damaged.
        for (const i of ab.corner) {
          const r = Math.floor(i / spec.cols);
          const c = i % spec.cols;
          const { dzdx } = analyticGradient(spec, r, c);
          const bucket = Math.abs(dzdx) > 1e-12
            ? cornerAnalytic.alongEdgeGradient
            : cornerAnalytic.noAlongEdgeGradient;
          bucket.ours.push(g.slopeDeg[i]);
          bucket.truth.push(truth[i]);
          bucket.fixtures.add(spec.id);
        }
      }

      if (edges) {
        // The `-compute_edges` boundary, isolated from the interior. Kept as its
        // own leg even though it now agrees: it is a different estimator regime
        // (a synthesised neighbour rather than a measured one), and folding it
        // into the interior figure would hide the next regression here the way
        // the interior-only checks hid the last one.
        //
        // THE HISTORY, because this leg is where the project's largest raster
        // defect was found and it should not read as a leg that always agreed.
        //
        // The a-priori expectation was "extrapolation and clamping coincide on a
        // locally linear surface, so only the curved fixture should diverge".
        // That was WRONG and the first run said so: every sloped border leg
        // disagreed, by 6 to 16 degrees. Mechanism, read off the two kernels
        // afterwards — gdaldem builds a virtual ring by linear extrapolation
        // (2*v[1] − v[2]), which on a plane reconstructs the true neighbour;
        // `hornSlopeAspect` CLAMPED, replicating the edge row/column, which left
        // the rise unchanged while halving the run. Our border slope was
        // therefore roughly HALVED — 9.9 degrees on a 19.3 degree plane — over
        // the 2*(cols+rows)−4 cells of every slope, aspect and hillshade raster.
        //
        // The kernel was then fixed to gdaldem's policy, which is why this leg
        // now expects agreement. Two details of that policy are worth stating,
        // because they are the reason agreement is EXACT rather than close:
        // gdaldem extrapolates PERPENDICULAR to an edge and CLAMPS ALONG it, so
        // at the four corners the along-edge gradient is still halved (its
        // first/last-line branch takes `jmin = j` at j = 0). We reproduce that
        // asymmetry deliberately; extrapolating symmetrically would be the
        // better estimator there but would diverge from the reference by up to
        // 12.7 degrees at those 4 cells. The tolerance was never widened — it is
        // the same frozen 0.01 degree the interior leg carries, and the residual
        // is now ~9e-4 degree, dominated by the 6-decimal ASCII round-trip.
        const border = borderIndices(spec);
        pushLeg({ ...common, product: `${run.product} [border only]`, unit: 'degree', reference: 'GDAL 3.13.1',
          evidenceLevel: 'E4 (cross-implementation)', metric: 'absolute',
          cellSet: 'border ring only (both extrapolate perpendicular, clamp along)', excluded: {},
          tolerance: FROZEN_TOLERANCES.slopeDeg,
          expectation: 'agree' },
          linearAgreement(g.slopeDeg, ref.values, border, FROZEN_TOLERANCES.slopeDeg), border.length);
      }
      writeOlv(`${spec.id}__${run.product}`, spec, g.slopeDeg, 6);
    } else if (run.product === 'slope-pct') {
      const an = analyticIndices(spec);
      const truth = new Float64Array(spec.cols * spec.rows);
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
          truth[r * spec.cols + c] = Math.tan((analyticSlopeDegrees(spec, r, c) * Math.PI) / 180) * 100;
        }
      }
      pushLeg({ ...common, unit: 'percent rise', reference: 'analytic (closed form)', evidenceLevel: 'E2 (formula)',
        metric: 'absolute', cellSet: 'interior, full 3x3 window, off-kink', excluded: an.excluded,
        tolerance: FROZEN_TOLERANCES.slopePercentPoints, expectation: 'agree' },
        linearAgreement(g.slopePct, truth, an.idx, FROZEN_TOLERANCES.slopePercentPoints), an.idx.length);
      pushLeg({ ...common, unit: 'percent rise', reference: 'GDAL 3.13.1', evidenceLevel: 'E4 (cross-implementation)',
        metric: 'absolute', cellSet: 'interior, full 3x3 window', excluded: {},
        tolerance: FROZEN_TOLERANCES.slopePercentPoints, expectation: 'agree' },
        linearAgreement(g.slopePct, ref.values, interior, FROZEN_TOLERANCES.slopePercentPoints), interior.length);
      writeOlv(`${spec.id}__${run.product}`, spec, g.slopePct, 6);
    } else if (run.product === 'aspect' || run.product === 'aspect-zero-flat') {
      // gdaldem marks an undefined bearing -9999 by default and 0 under
      // -zero_for_flat. Both are excluded from the bearing comparison and
      // counted, because comparing a bearing against a placeholder measures the
      // placeholder.
      const undef = run.product === 'aspect-zero-flat' ? [0] : [ref.nodata, NODATA];
      const truth = new Float64Array(spec.cols * spec.rows);
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) truth[r * spec.cols + c] = analyticAspectDegrees(spec, r, c);
      }
      const sel = aspectIndices(spec, ref.values, undef);
      pushLeg({ ...common, unit: 'compass degree (circular separation)', reference: 'analytic (closed form)',
        evidenceLevel: 'E2 (formula)', metric: 'circular',
        cellSet: `interior, off-kink, slope >= ${ASPECT_MIN_SLOPE_DEG} deg`, excluded: sel.excluded,
        tolerance: FROZEN_TOLERANCES.aspectCircularDeg, expectation: 'agree' },
        circularAgreement(g.aspectDeg, truth, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg), sel.idx.length);
      pushLeg({ ...common, unit: 'compass degree (circular separation)', reference: 'GDAL 3.13.1',
        evidenceLevel: 'E4 (cross-implementation)', metric: 'circular',
        cellSet: `interior, off-kink, slope >= ${ASPECT_MIN_SLOPE_DEG} deg, reference bearing defined`,
        excluded: sel.excluded, tolerance: FROZEN_TOLERANCES.aspectCircularDeg,
        // Declared from `gdaldem aspect --help` before the run, not from the
        // result: that subcommand accepts neither -xscale nor -yscale, so on a
        // degree grid its only expressible model is EQUAL spacing on both axes.
        // Off the equator that is not the metre frame, and ours is, so the two
        // cannot agree on the geographic fixture. The size of the gap is measured
        // by the dedicated pair of legs further down.
        expectation: spec.crs === 'geographic' ? 'documented-divergence' : 'agree' },
        circularAgreement(g.aspectDeg, ref.values, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg), sel.idx.length);
      writeOlv(`${spec.id}__${run.product}`, spec, g.aspectDeg, 6);
    } else if (run.product === 'hillshade-multi') {
      const sun = SUNS[0];
      const ours = olvMultiHillshade(g, spec, sun);
      pushLeg({ ...common, unit: '8-bit level', reference: 'GDAL 3.13.1', evidenceLevel: 'E4 (cross-implementation)',
        metric: 'absolute', cellSet: 'interior, full 3x3 window', excluded: {},
        tolerance: FROZEN_TOLERANCES.hillshadeByteLevels,
        // Declared from reading both sources BEFORE running. gdaldem's
        // multidirectional relief is the Mark (1992) weighted combination;
        // `computeMultiHillshade` averages max(0, h) over the same four
        // azimuths with its own 0.5 + 0.5*max(0, alignment) weights. Two
        // different models, so this leg measures how far apart they are — it is
        // not an agreement claim and no tolerance was chosen to make it one.
        //
        // The zero-gradient case is the one exception, and it is derivable
        // without running anything: where the gradient is zero every light
        // contributes the same cos(zenith), so both weighting schemes reduce to
        // that constant and only the byte-encoding offset is left.
        expectation: spec.surface.kind === 'constant' ? 'agree' : 'documented-divergence' },
        linearAgreement(ours, ref.values, interior, FROZEN_TOLERANCES.hillshadeByteLevels), interior.length);
      writeOlv(`${spec.id}__${run.product}`, spec, ours, 0);
    } else if (run.product.startsWith('hillshade-')) {
      const sun = SUNS.find((s) => s.id === run.product.slice('hillshade-'.length));
      if (!sun) continue;
      const ours = olvHillshade(g, spec, sun);
      // gdaldem clamps a self-shadowed cell to level 1 and saturates at 255, so
      // a cell at either rail carries no intensity information. Selected on the
      // REFERENCE's value, not on ours: filtering by our own output would let our
      // kernel choose which cells get to judge it.
      const unclamped = interior.filter((i) => ref.values[i] >= 2 && ref.values[i] <= 254);
      const clampedCount = interior.length - unclamped.length;
      const decoded = new Float64Array(spec.cols * spec.rows);
      for (let i = 0; i < decoded.length; i++) decoded[i] = (ref.values[i] - 1) / 254;

      pushLeg({ ...common, product: `${run.product} [intensity, pre-quantisation]`, unit: 'h (cosine, -1..1)',
        reference: 'GDAL 3.13.1', evidenceLevel: 'E4 (cross-implementation)', metric: 'absolute',
        cellSet: 'interior, reference level in 2..254 (neither rail)',
        excluded: { referenceClamped: clampedCount }, tolerance: FROZEN_TOLERANCES.hillshadeIntensity,
        expectation: 'agree' },
        linearAgreement(ours.intensity, decoded, unclamped, FROZEN_TOLERANCES.hillshadeIntensity), unclamped.length);

      pushLeg({ ...common, product: `${run.product} [byte, as shipped]`, unit: '8-bit level',
        reference: 'GDAL 3.13.1', evidenceLevel: 'E4 (cross-implementation)', metric: 'absolute',
        cellSet: 'interior, full 3x3 window', excluded: {},
        tolerance: FROZEN_TOLERANCES.hillshadeByteLevels, expectation: 'agree' },
        linearAgreement(ours.byte, ref.values, interior, FROZEN_TOLERANCES.hillshadeByteLevels), interior.length);
      writeOlv(`${spec.id}__${run.product}`, spec, ours.byte, 0);
    }
  }

  // ── the geographic anisotropy pair ────────────────────────────────────────
  //
  // The one fixture whose two horizontal axes have different metre lengths, run
  // BOTH ways so the divergence is attributable rather than averaged in.
  const geo = FIXTURES.find((f) => f.crs === 'geographic');
  if (geo) {
    const dem = demFor(geo);
    const isotropic = computeOlv(geo, dem, geo.cellsize, geo.cellsize);
    const aspectRun = REF_RECORD.runs.find((r) => r.fixtureId === geo.id && r.product === 'aspect' && r.status === 'ok');
    if (aspectRun?.output) {
      const ref = readAsciiGrid(resolve(MATRIX_DIR, aspectRun.output));
      const sel = aspectIndices(geo, ref.values, [ref.nodata, NODATA]);
      // gdaldem aspect accepts no -xscale/-yscale, so its only expressible model
      // is EQUAL spacing on both axes. Ours under the same assumption must match
      // it; that is what this leg checks.
      pushLeg({ fixtureId: geo.id, family: geo.family, product: 'aspect [equal-axis assumption, both sides]',
        unit: 'compass degree (circular separation)', reference: 'GDAL 3.13.1',
        evidenceLevel: 'E4 (cross-implementation)', metric: 'circular',
        cellSet: 'interior, above min slope', excluded: sel.excluded,
        tolerance: FROZEN_TOLERANCES.aspectCircularDeg, expectation: 'agree' },
        circularAgreement(isotropic.aspectDeg, ref.values, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg), sel.idx.length);

      // And the physically correct bearing against the same reference. This is
      // NOT an agreement claim: gdaldem cannot produce an anisotropic aspect at
      // all, so the figure below is the SIZE of the error a gdaldem geographic
      // aspect carries at this latitude, measured against our metre-frame result.
      const trueFrame = olvFor(geo);
      pushLeg({ fixtureId: geo.id, family: geo.family, product: 'aspect [true unequal metres vs gdaldem equal-degree]',
        unit: 'compass degree (circular separation)', reference: 'GDAL 3.13.1',
        evidenceLevel: 'E4 (cross-implementation)', metric: 'circular',
        cellSet: 'interior, above min slope', excluded: sel.excluded,
        tolerance: FROZEN_TOLERANCES.aspectCircularDeg, expectation: 'documented-divergence' },
        circularAgreement(trueFrame.aspectDeg, ref.values, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg), sel.idx.length);
    }
    notes.push(
      `gdaldem aspect accepts neither -xscale nor -yscale on GDAL 3.13.1, so an anisotropic ` +
      `geographic aspect reference is unavailable from the reference tool. gdaldem slope and ` +
      `gdaldem hillshade do accept them and were given ${GEO_METRES_PER_DEG_LON.toFixed(1)} m/deg ` +
      `longitude and ${GEO_METRES_PER_DEG_LAT} m/deg latitude at latitude ${GEO_CENTRE_LATITUDE_DEG}.`,
    );
  }

  // The two pooled analytic CORNER legs. Treatment and control, declared before
  // the run: a corner clamps the along-edge (column) axis, so it must diverge
  // from the closed form wherever dz/dx is non-zero and must reproduce it exactly
  // wherever dz/dx is zero. If the control group diverged too, the explanation
  // would be wrong — it would mean something other than the along-edge clamp is
  // damaging corners.
  for (const [key, group] of [
    ['along-edge gradient present', cornerAnalytic.alongEdgeGradient],
    ['no along-edge gradient (control)', cornerAnalytic.noAlongEdgeGradient],
  ] as const) {
    const idx = group.ours.map((_, k) => k);
    pushLeg({
      fixtureId: `pooled (${group.fixtures.size} fixtures)`, family: 'border corner',
      product: `slope-deg [border corner, analytic: ${key}]`, unit: 'degree',
      reference: 'analytic (closed form)', evidenceLevel: 'E2 (formula)', metric: 'absolute',
      cellSet: `four corners per fixture, pooled; ${key}`, excluded: {},
      tolerance: FROZEN_TOLERANCES.slopeDeg,
      expectation: key === 'along-edge gradient present' ? 'documented-divergence' : 'agree',
    }, linearAgreement(group.ours, group.truth, idx, FROZEN_TOLERANCES.slopeDeg), idx.length);
  }

  writeOrVerify(resolve(MATRIX_DIR, 'olv-SHA256SUMS'), olvHashes.sort().join('\n') + '\n', 'olv-SHA256SUMS');
}

const legsFor = (predicate: (l: Leg) => boolean): Leg[] => legs.filter(predicate);
const failing = (ls: Leg[]): string[] =>
  ls
    .filter((l) => l.status === 'ok' && l.expectation === 'agree' && l.verdict !== 'agree')
    .map(
      (l) =>
        `${l.fixtureId} / ${l.product} vs ${l.reference}: max |Δ| ${l.maxAbsDiff?.toPrecision(4)} ${l.unit} ` +
        `(tolerance ${l.tolerance}), RMSE ${l.rmse?.toPrecision(4)}, bias ${l.meanBias?.toPrecision(3)}, ` +
        `${((l.withinTolFraction ?? 0) * 100).toFixed(2)}% within, ${l.cells} cells`,
    );

const summarise = (ls: Leg[]): string =>
  ls
    .filter((l) => l.status === 'ok')
    .map(
      (l) =>
        `  ${l.fixtureId.padEnd(20)} ${l.product.padEnd(46)} ${l.reference.padEnd(22)} ` +
        `max ${(l.maxAbsDiff ?? 0).toExponential(3)} rmse ${(l.rmse ?? 0).toExponential(3)} ` +
        `bias ${(l.meanBias ?? 0).toExponential(3)} ${((l.withinTolFraction ?? 0) * 100).toFixed(2)}% n=${l.cells} ${l.verdict}`,
    )
    .join('\n');

describe('raster agreement matrix', () => {
  it('has a GDAL reference set with the version, executable path and container pinning recorded', () => {
    expect(REF_RECORD, 'run `node scripts/run-gdaldem-reference.mjs` first').not.toBeNull();
    const env = REF_RECORD!.environment;
    // Pinned rather than assumed: the whole matrix is a statement about ONE
    // reference build, and the claim register already cites this version.
    expect(env.gdalinfoVersion).toContain('GDAL 3.13.1');
    expect(env.gdaldemResolvedPath).toMatch(/gdaldem$/);
    // Recorded as not-executed rather than omitted. Docker is installed on this
    // host but the daemon is not running, so nothing was containerised and the
    // provenance says so.
    expect(env.containerPinning).toBe('not-executed');
    expect(env.containerPinningReason).toContain('Docker daemon is not running');
  });

  it('freezes every tolerance before any comparison, with a stated derivation', () => {
    // These values are asserted here so a later edit to FROZEN_TOLERANCES is a
    // visible, deliberate change to the pass criteria rather than a quiet one.
    // They were set from the derivations in the constant's comments, before any
    // leg in this file had been run.
    expect(FROZEN_TOLERANCES).toEqual({
      slopeDeg: 0.01,
      slopePercentPoints: 0.05,
      aspectCircularDeg: 0.25,
      hillshadeIntensity: 0.0025,
      hillshadeByteLevels: 2.0,
    });
    // The byte tolerance MUST be too coarse to see a half-level error, and the
    // intensity tolerance MUST be fine enough to see one. That relationship is
    // what makes the two legs independent, so it is asserted, not described.
    expect(HALF_LEVEL * 254).toBeLessThan(FROZEN_TOLERANCES.hillshadeByteLevels);
    expect(HALF_LEVEL).toBeLessThan(FROZEN_TOLERANCES.hillshadeIntensity);
    expect(HALF_LEVEL + 0.5 / 254).toBeGreaterThan(FROZEN_TOLERANCES.hillshadeIntensity);
  });

  it('covers the declared dimensions of the matrix', () => {
    // A matrix that quietly lost a dimension would still produce a long, healthy
    // looking table. Each dimension the brief asked for is counted here.
    const cellSizes = new Set(FIXTURES.filter((f) => f.crs === 'projected').map((f) => f.cellsize));
    expect(cellSizes.size, `cell sizes: ${[...cellSizes].join(', ')}`).toBeGreaterThanOrEqual(3);
    const extents = new Set(FIXTURES.map((f) => `${f.cols}x${f.rows}`));
    expect(extents.size, `extents: ${[...extents].join(', ')}`).toBeGreaterThanOrEqual(2);
    const nodataPatterns = new Set(FIXTURES.map((f) => f.nodata));
    // "more than one nodata pattern" — none plus at least two real ones.
    expect([...nodataPatterns].filter((p) => p !== 'none').length).toBeGreaterThanOrEqual(2);
    expect(new Set(FIXTURES.map((f) => f.crs))).toEqual(new Set(['projected', 'geographic']));
    // Positive and negative gradients on both axes.
    const grads = FIXTURES.filter((f) => f.surface.kind === 'plane').map((f) => f.surface.params);
    expect(grads.some((p) => (p.gx ?? 0) > 0), 'no positive X gradient').toBe(true);
    expect(grads.some((p) => (p.gx ?? 0) < 0), 'no negative X gradient').toBe(true);
    expect(grads.some((p) => (p.gy ?? 0) > 0), 'no positive Y gradient').toBe(true);
    expect(grads.some((p) => (p.gy ?? 0) < 0), 'no negative Y gradient').toBe(true);
    // Edge computation both on and off.
    const products = new Set(FIXTURES.flatMap((f) => f.products));
    expect(products.has('slope-deg')).toBe(true);
    expect(products.has('slope-deg-edges')).toBe(true);
    // Thirteen named families, all present.
    const families = new Set(FIXTURES.map((f) => f.family));
    expect(families.size).toBeGreaterThanOrEqual(12);
  });

  it('agrees with GDAL on slope, in degrees, across every fixture family', () => {
    const ls = legsFor((l) => l.product.startsWith('slope-deg') && l.reference === 'GDAL 3.13.1' && !l.product.includes('border'));
    expect(ls.length, 'no GDAL slope legs were built').toBeGreaterThan(20);
    console.log(`\nSLOPE (degree) ours vs GDAL 3.13.1 — E4:\n${summarise(ls)}`);
    expect(failing(ls), 'slope disagreements against GDAL').toEqual([]);
  });

  it('agrees with the closed form on slope, which is E2 and not cross-implementation', () => {
    const ls = legsFor((l) => l.product.startsWith('slope') && l.reference === 'analytic (closed form)');
    expect(ls.length).toBeGreaterThan(20);
    for (const l of ls) expect(l.evidenceLevel, l.fixtureId).toBe('E2 (formula)');
    console.log(`\nSLOPE ours vs closed form — E2, NOT cross-implementation:\n${summarise(ls)}`);
    expect(failing(ls), 'slope disagreements against the closed form').toEqual([]);
  });

  it('agrees with GDAL on slope expressed as percent rise, and records the unit', () => {
    const ls = legsFor((l) => l.product === 'slope-pct' && l.reference === 'GDAL 3.13.1');
    expect(ls.length).toBeGreaterThanOrEqual(4);
    // Unit recorded per leg, because degree and percent rise are numerically
    // unrelated: 45 degrees is 100 percent, and a leg that silently compared one
    // against the other would report a ~55 unit disagreement with no clue why.
    for (const l of ls) expect(l.unit).toBe('percent rise');
    console.log(`\nSLOPE (percent rise) ours vs GDAL 3.13.1 — E4:\n${summarise(ls)}`);
    expect(failing(ls), 'percent-rise slope disagreements against GDAL').toEqual([]);
  });

  it('agrees with GDAL on aspect as a CIRCULAR separation, over the whole compass rose', () => {
    const all = legsFor((l) => l.metric === 'circular' && l.reference === 'GDAL 3.13.1');
    const ls = all.filter((l) => l.expectation === 'agree');
    expect(ls.length).toBeGreaterThan(15);
    console.log(`\nASPECT (circular separation) ours vs GDAL 3.13.1 — E4:\n${summarise(all)}`);
    expect(failing(ls), 'aspect disagreements against GDAL').toEqual([]);
    // On the DEFAULT aspect legs, the ones agreeing must all be projected: if the
    // geographic divergence had been counted among them the figure above would be
    // a CRS mismatch dressed up as bearing agreement. The geographic fixture's
    // own equal-axis leg is exempt by name, because there both sides are
    // deliberately computed under gdaldem's equal-degree assumption.
    for (const l of ls) {
      if (l.product !== 'aspect' && l.product !== 'aspect-zero-flat') continue;
      const spec = specById.get(l.fixtureId)!;
      expect(spec.crs, `${l.fixtureId} was expected to agree despite a degree grid`).toBe('projected');
    }
  });

  it('scores 359 against 1 as two degrees apart, not 358', () => {
    // The metric itself, pinned. Every aspect figure in this file is meaningless
    // if this is a plain subtraction, and the aspect-rose-000 fixture straddles
    // the wraparound by construction, so the bug would show up as a handful of
    // ~360 degree outliers among thousands of perfect cells.
    expect(circularDelta(359, 1)).toBe(-2);
    expect(circularDelta(1, 359)).toBe(2);
    expect(circularDelta(0, 360)).toBe(0);
    expect(Math.abs(circularDelta(90, 270))).toBe(180);
    const rose = legsFor((l) => l.fixtureId === 'aspect-rose-000' && l.reference === 'GDAL 3.13.1' && l.metric === 'circular');
    expect(rose.length, 'the wraparound fixture produced no aspect leg').toBeGreaterThan(0);
    for (const l of rose) expect(l.maxAbsDiff, 'wraparound handled as a plain subtraction').toBeLessThan(1);
  });

  it('covers all four cardinal and all four intercardinal bearings', () => {
    const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const b of bearings) {
      const id = `aspect-rose-${String(b).padStart(3, '0')}`;
      const leg = legs.find((l) => l.fixtureId === id && l.reference === 'GDAL 3.13.1' && l.metric === 'circular');
      expect(leg, `no aspect comparison for bearing ${b}`).toBeDefined();
      expect(leg!.status, `bearing ${b}`).toBe('ok');
      expect(leg!.verdict, `bearing ${b}: ${leg!.maxAbsDiff} deg apart`).toBe('agree');
      // The fixture must actually point where it claims, or eight identical
      // planes would pass this and prove nothing about direction.
      const spec = specById.get(id)!;
      const mid = analyticAspectDegrees(spec, Math.floor(spec.rows / 2), Math.floor(spec.cols / 2));
      expect(Math.abs(circularDelta(mid, b)), `fixture ${id} does not face ${b}`).toBeLessThan(1e-6);
    }
  });

  it('records how each implementation represents an undefined aspect', () => {
    // Three different answers to "this cell has no downslope direction", on the
    // one fixture where every interior cell is exactly flat.
    const flat = specById.get('flat-plane')!;
    const g = olvFor(flat);
    const interior = interiorIndices(flat);

    const defRun = REF_RECORD!.runs.find((r) => r.fixtureId === 'flat-plane' && r.product === 'aspect')!;
    const zeroRun = REF_RECORD!.runs.find((r) => r.fixtureId === 'flat-plane' && r.product === 'aspect-zero-flat')!;
    const def = readAsciiGrid(resolve(MATRIX_DIR, defRun.output!));
    const zero = readAsciiGrid(resolve(MATRIX_DIR, zeroRun.output!));

    for (const i of interior) {
      expect(def.values[i], 'gdaldem default should mark a flat cell undefined').toBe(NODATA);
      expect(zero.values[i], 'gdaldem -zero_for_flat should write due north').toBe(0);
      // OURS. `hornSlopeAspect` writes 0 RADIANS at zero gradient, and 0 radians
      // in the math frame is EAST, which converts to compass 90. So on exactly
      // flat ground our aspect grid reads "due east" with no marker separating it
      // from a real easterly bearing. That is a finding, not a pass: the shipped
      // API has no way to express an undefined aspect, and a downstream consumer
      // cannot tell the two apart from the aspect grid alone. Pinned here so the
      // behaviour cannot change without this test noticing.
      expect(g.aspectDeg[i], 'our flat-ground aspect').toBe(90);
    }
    notes.push(
      'Undefined aspect: gdaldem writes -9999 by default and 0 (due north) under -zero_for_flat. ' +
      'hornSlopeAspect writes 0 radians in the math frame, which is compass 90 (due EAST), and carries ' +
      'no undefined marker; the caller must consult the slope grid to tell a flat cell from an easterly one.',
    );
    console.log(
      '\nUNDEFINED ASPECT — gdaldem default: -9999; gdaldem -zero_for_flat: 0 (north); ours: 90 (east, no marker).',
    );
  });

  it('excludes and counts the cells below the preregistered minimum slope', () => {
    // The cutoff is preregistered in the fixture generator, not chosen here, and
    // the exclusions are reported per leg rather than silently shrinking the
    // denominator.
    expect(ASPECT_MIN_SLOPE_DEG).toBe(0.5);
    const withExclusions = legsFor((l) => l.metric === 'circular' && (l.excluded.belowMinSlope ?? 0) > 0);
    expect(withExclusions.length, 'no fixture exercised the flat-ground exclusion').toBeGreaterThan(0);
    for (const l of legsFor((l) => l.metric === 'circular')) {
      expect(l.excluded.belowMinSlope, `${l.fixtureId} did not report its exclusion count`).toBeDefined();
    }
    console.log(
      `\nASPECT flat-ground exclusions (slope < ${ASPECT_MIN_SLOPE_DEG} deg):\n` +
        legsFor((l) => l.metric === 'circular' && l.reference === 'GDAL 3.13.1')
          .map((l) => `  ${l.fixtureId.padEnd(20)} kept ${String(l.cells).padStart(6)}  below-min ${String(l.excluded.belowMinSlope ?? 0).padStart(6)}  kink ${String(l.excluded.kink ?? 0).padStart(5)}  ref-undefined ${String(l.excluded.referenceUndefined ?? 0).padStart(5)}`)
          .join('\n'),
    );
  });

  it('agrees with GDAL on the hillshade ILLUMINATION MODEL, before quantisation', () => {
    const ls = legsFor((l) => l.product.includes('[intensity'));
    expect(ls.length).toBeGreaterThanOrEqual(10);
    for (const l of ls) expect(l.unit).toBe('h (cosine, -1..1)');
    console.log(`\nHILLSHADE illumination model (unquantised h) ours vs GDAL 3.13.1 — E4:\n${summarise(ls)}`);
    expect(failing(ls), 'hillshade illumination disagreements against GDAL').toEqual([]);
  });

  it('agrees with GDAL on the hillshade BYTE product, separately from the model', () => {
    const ls = legsFor((l) => l.product.includes('[byte'));
    expect(ls.length).toBeGreaterThanOrEqual(10);
    for (const l of ls) expect(l.unit).toBe('8-bit level');
    console.log(`\nHILLSHADE byte product (ours round(255h) vs gdaldem round(1+254h)) — E4:\n${summarise(ls)}`);
    expect(failing(ls), 'hillshade byte disagreements against GDAL').toEqual([]);
  });

  it('hides a sub-level shading error in the byte product but not in the intensity', () => {
    // THE SEPARATION, demonstrated rather than asserted in prose.
    //
    // A half-level intensity error is the largest fault the 8-bit encoding can
    // round away, and the byte tolerance has to be at least 2 levels to absorb
    // gdaldem's 1 + 254h offset. So a byte comparison CANNOT see this fault, and
    // if the intensity leg did not exist the error would ship. Both halves are
    // checked here: the byte leg still says "agree" with the fault injected, and
    // the intensity leg says "disagree".
    // `saddle`, NOT one of the planes. On a plane the slope and aspect are
    // constant, so h is a single number over the whole grid and the quantisation
    // error is one fixed offset — a demonstration there would turn on the luck of
    // that one rounding rather than on the encoding. `saddle` spans a wide range
    // of h, so the quantisation error covers the full +/- half level and the
    // demonstration generalises. The tolerances and the injected fault size are
    // unchanged; only the fixture is chosen to make the test mean something, and
    // `spans the full quantisation range` below asserts that it does.
    const spec = specById.get('saddle')!;
    const g = olvFor(spec);
    const sun = SUNS[0];
    const ours = olvHillshade(g, spec, sun);
    const runRec = REF_RECORD!.runs.find((r) => r.fixtureId === spec.id && r.product === `hillshade-${sun.id}`)!;
    const ref = readAsciiGrid(resolve(MATRIX_DIR, runRec.output!));
    const interior = interiorIndices(spec);
    const unclamped = interior.filter((i) => ref.values[i] >= 2 && ref.values[i] <= 254);
    expect(unclamped.length).toBeGreaterThan(1000);

    const decoded = new Float64Array(ours.intensity.length);
    for (let i = 0; i < decoded.length; i++) decoded[i] = (ref.values[i] - 1) / 254;

    const faultyIntensity = new Float64Array(ours.intensity.length);
    const faultyByte = new Float64Array(ours.intensity.length);
    for (let i = 0; i < faultyIntensity.length; i++) {
      const h = ours.intensity[i] + HALF_LEVEL;
      faultyIntensity[i] = h;
      faultyByte[i] = Math.max(0, Math.min(255, Math.round(255 * h)));
    }

    // Baseline: the un-faulted product agrees on both legs, so a failure below
    // is the injected fault and not something else.
    const baseIntensity = linearAgreement(ours.intensity, decoded, unclamped, FROZEN_TOLERANCES.hillshadeIntensity);
    expect(baseIntensity.verdict).toBe('agree');
    expect(linearAgreement(ours.byte, ref.values, interior, FROZEN_TOLERANCES.hillshadeByteLevels).verdict).toBe('agree');
    // The fixture must actually span the quantisation range, or the injected
    // half-level fault could land in slack that a different fixture would not
    // have. Asserted so the demonstration cannot quietly become a lucky one.
    expect(baseIntensity.maxAbsDiff, 'fixture does not span the quantisation range').toBeGreaterThan(0.4 / 254);

    const byteWithFault = linearAgreement(faultyByte, ref.values, interior, FROZEN_TOLERANCES.hillshadeByteLevels);
    const intensityWithFault = linearAgreement(faultyIntensity, decoded, unclamped, FROZEN_TOLERANCES.hillshadeIntensity);

    expect(byteWithFault.verdict, `byte leg saw a half-level fault it should be blind to: ${byteWithFault.summary}`).toBe('agree');
    expect(intensityWithFault.verdict, `intensity leg missed a half-level fault: ${intensityWithFault.summary}`).toBe('disagree');
    console.log(
      `\nENCODING SEPARATION on ${spec.id}, fault +${HALF_LEVEL.toPrecision(4)} h (= half a gdaldem level):\n` +
        `  byte leg      (tol ${FROZEN_TOLERANCES.hillshadeByteLevels} levels): ${byteWithFault.summary}\n` +
        `  intensity leg (tol ${FROZEN_TOLERANCES.hillshadeIntensity} h):      ${intensityWithFault.summary}`,
    );
  });

  it('keeps the shipped byte exactly the rounded intensity on every fixture', () => {
    // `intensity` exists only because HillshadeResult does not expose the
    // pre-rounding value. If it drifted from what shadeFromSlopeAspect computes,
    // every intensity figure above would describe a model the product does not
    // ship. Pinned as an identity, not as a tolerance.
    for (const spec of FIXTURES) {
      const g = olvFor(spec);
      for (const sun of SUNS) {
        const ours = olvHillshade(g, spec, sun);
        for (const i of interiorIndices(spec)) {
          const expected = Math.max(0, Math.min(255, Math.round(255 * ours.intensity[i])));
          expect(ours.byte[i], `${spec.id} / ${sun.id} cell ${i}`).toBe(expected);
        }
      }
    }
  });

  it('reports the multidirectional relief as a model divergence, not an agreement', () => {
    // Kept separate from single-direction hillshade because it IS a different
    // model on both sides: gdaldem -multidirectional is the Mark (1992) weighted
    // combination, computeMultiHillshade averages max(0, h) over the same four
    // azimuths with its own 0.5 + 0.5*max(0, alignment) weights. The figures
    // below are the size of that gap. Nothing here is tuned to make it small,
    // and no claim is promoted on the strength of it.
    const ls = legsFor((l) => l.product === 'hillshade-multi');
    expect(ls.length).toBeGreaterThanOrEqual(3);
    console.log(`\nMULTIDIRECTIONAL relief ours vs GDAL 3.13.1 — DIFFERENT MODELS, measured not claimed:\n${summarise(ls)}`);
    const sloped = ls.filter((l) => specById.get(l.fixtureId)!.surface.kind !== 'constant');
    expect(sloped.length).toBeGreaterThanOrEqual(3);
    for (const l of sloped) {
      expect(l.expectation).toBe('documented-divergence');
      // Asserted as a divergence so the day either model changes, this test
      // notices instead of a wide tolerance quietly absorbing it.
      expect(l.verdict, `${l.fixtureId} multidirectional now agrees; the recorded model difference is stale`).toBe('disagree');
    }
    // Zero gradient is where the two models provably coincide, so the flat
    // fixture agrees and only the encoding offset is left. Checked rather than
    // assumed: if it ever disagreed, the divergence would be in the shared part
    // of the model, not in the weighting.
    const flat = ls.find((l) => specById.get(l.fixtureId)!.surface.kind === 'constant');
    expect(flat, 'the flat fixture produced no multidirectional leg').toBeDefined();
    expect(flat!.verdict, 'the two models should coincide at zero gradient').toBe('agree');
    expect(flat!.maxAbsDiff!, 'a flat-ground gap larger than the encoding offset').toBeLessThanOrEqual(1);
  });

  it('separates the nodata halo, where the two implementations differ by POLICY', () => {
    // gdaldem propagates nodata: one masked cell blanks its whole 3x3
    // neighbourhood in the output. hornSlopeAspect substitutes the CENTRE value
    // for a non-finite neighbour and emits a real number. Neither is wrong, but
    // they are not comparable, so the halo is excluded from every agreement
    // figure and counted here instead.
    //
    // The consequence is worth stating plainly: around a hole our slope is biased
    // toward zero, because substituting the centre value flattens the window, and
    // nothing in the output marks those cells as estimated from partial data.
    const rows: string[] = [];
    let checked = 0;
    for (const spec of FIXTURES) {
      if (spec.nodata === 'none') continue;
      const run = REF_RECORD!.runs.find((r) => r.fixtureId === spec.id && r.product === 'slope-deg' && r.status === 'ok');
      if (!run?.output) continue;
      const ref = readAsciiGrid(resolve(MATRIX_DIR, run.output));
      const g = olvFor(spec);
      let halo = 0;
      let refBlank = 0;
      let oursValued = 0;
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
          if (!isHaloCell(spec, r, c)) continue;
          const i = r * spec.cols + c;
          halo++;
          if (ref.values[i] === ref.nodata) refBlank++;
          if (Number.isFinite(g.slopeDeg[i]) && g.coverage[i] === 1) oursValued++;
        }
      }
      expect(halo, `${spec.id} produced no halo cells`).toBeGreaterThan(0);
      // The policy difference, asserted: gdaldem blanks every halo cell, we
      // answer for every one of them.
      expect(refBlank, `${spec.id}: gdaldem did not blank the whole halo`).toBe(halo);
      expect(oursValued, `${spec.id}: we did not answer for the whole halo`).toBe(halo);
      rows.push(`  ${spec.id.padEnd(20)} pattern ${spec.nodata.padEnd(9)} halo ${String(halo).padStart(5)} cells: gdaldem blanks all, ours answers all`);
      checked++;
    }
    expect(checked, 'no nodata fixture was checked').toBeGreaterThanOrEqual(3);
    console.log(`\nNODATA POLICY divergence (excluded from every agreement figure):\n${rows.join('\n')}`);
    notes.push(
      'Nodata halo: gdaldem propagates nodata through the 3x3 window; hornSlopeAspect substitutes the centre ' +
      'value for a non-finite neighbour and returns a value. Around a hole our slope is therefore biased toward ' +
      'zero and the output carries no marker distinguishing those cells from fully-supported ones.',
    );
  });

  it('agrees with GDAL on the -compute_edges border ring, the matrix\'s largest closed finding', () => {
    // THE LARGEST FINDING THIS MATRIX PRODUCED, now closed. The single-fixture
    // checks could not see it because they compare interior cells only.
    //
    // What it was: under `-compute_edges` gdaldem synthesises a virtual ring
    // outside the grid by linear extrapolation (2*v[1] − v[2]), so on a plane it
    // reconstructs the true neighbour. `hornSlopeAspect` CLAMPED instead,
    // replicating the edge row or column, leaving the rise unchanged while
    // halving the run — so our border slope came out roughly HALVED, 9.9 degrees
    // on the 19.3 degree `slope-x-pos` plane, biased low over the whole outer
    // ring of every slope, aspect and hillshade raster: 2*(cols+rows)−4 cells,
    // whether or not a caller ever asked for computed edges.
    //
    // What changed: the kernel now uses gdaldem's policy, so this leg asserts
    // AGREEMENT. The assertions cover the whole ring rather than the verdict
    // alone: a fix that repaired the edges and left the corners wrong would still
    // pass a max- or mean-based figure over 220 cells.
    const ls = legsFor((l) => l.product.includes('border only'));
    expect(ls.length, 'no border legs were built').toBeGreaterThanOrEqual(4);
    console.log(`\n-compute_edges BORDER ring, both extrapolating — E4:\n${summarise(ls)}`);

    const sloped = ls.filter((l) => specById.get(l.fixtureId)!.surface.kind !== 'constant');
    expect(sloped.length, 'no sloped surface was tested at the border').toBeGreaterThanOrEqual(3);
    for (const l of ls) {
      expect(l.verdict, `${l.fixtureId}: the border ring disagrees again`).toBe('agree');
      // EVERY ring cell, not a fraction of them. This is what pins the four
      // corners, where gdaldem clamps along the edge and we reproduce that: a
      // symmetric-extrapolation kernel would diverge there by up to 12.7 degrees
      // and would fail here while still looking fine on max/rmse alone.
      expect(l.withinTolFraction, `${l.fixtureId}: some border cells are outside tolerance`).toBe(1);
      expect(l.maxAbsDiff!, `${l.fixtureId}: border gap exceeds the frozen tolerance`)
        .toBeLessThanOrEqual(l.tolerance);
    }
    // The halving was a factor-of-two error in DEGREES. Assert the residual is
    // now three orders of magnitude smaller, so a regression that reinstated
    // clamping could not pass by sitting just inside the tolerance.
    for (const l of sloped) {
      expect(l.maxAbsDiff!, `${l.fixtureId}: border residual is far larger than round-trip noise`)
        .toBeLessThan(0.01);
    }
    // The flat fixture agreed even while clamped (half of zero is zero), so it is
    // the control: it must still agree, and it proves nothing on its own.
    const flat = ls.filter((l) => specById.get(l.fixtureId)!.surface.kind === 'constant');
    expect(flat.length).toBeGreaterThanOrEqual(1);
    expect(failing(flat), 'the flat border should agree exactly').toEqual([]);
  });

  it('checks the border against the CLOSED FORM, not only against gdaldem', () => {
    // Closes the circularity in the leg above. That one compares our border to
    // gdaldem's, but the kernel's border rule was copied from gdaldem — so
    // agreement there is two implementations of one edge policy agreeing with
    // each other, which this file's three-way design exists to distrust. These
    // legs supply the missing edge of the triangle: ours against a formula.
    //
    // The finding, and it is not that everything is fine:
    //
    //  - On a LOCALLY LINEAR surface the extrapolated edge reproduces the closed
    //    form. Extrapolation is exact for an affine function, so this is the
    //    result the estimator entitles us to, and it is now measured rather than
    //    assumed.
    //  - On a QUADRATIC surface it does NOT. The edge dz/dx carries an a·h error
    //    (derivation in `locallyLinearSurface`) where the interior central
    //    difference is exact. The gdaldem leg cannot see this, because gdaldem
    //    makes the identical error.
    //  - At the CORNERS the along-edge axis is clamped, so the closed form is
    //    missed wherever the gradient has a component along that axis — and hit
    //    exactly where it does not. Both halves are asserted, because the control
    //    group is what pins the explanation to the clamp.
    const edgeLegs = legsFor((l) => l.product.includes('border edge, analytic'));
    expect(edgeLegs.length, 'no analytic border-edge legs were built').toBeGreaterThanOrEqual(10);
    console.log(`\nBORDER vs CLOSED FORM (E2) — the leg the gdaldem comparison cannot provide:\n${summarise(edgeLegs)}`);

    const linearEdge = edgeLegs.filter((l) => locallyLinearSurface(specById.get(l.fixtureId)!));
    const curvedEdge = edgeLegs.filter((l) => !locallyLinearSurface(specById.get(l.fixtureId)!));
    expect(linearEdge.length, 'no locally linear fixture reached the border-edge leg').toBeGreaterThanOrEqual(8);
    expect(curvedEdge.length, 'no curved fixture reached the border-edge leg').toBeGreaterThanOrEqual(2);
    // Locally linear: extrapolation is exact, so the closed form must be met.
    expect(failing(linearEdge), 'a locally linear border edge missed the closed form').toEqual([]);
    // Curved: it must NOT be met, and the gap is the cost of extrapolating.
    for (const l of curvedEdge) {
      expect(l.verdict, `${l.fixtureId}: curved border edge unexpectedly matches the closed form`).toBe('disagree');
    }

    const treat = legs.find((l) => l.product.includes('border corner, analytic: along-edge gradient present'))!;
    const ctrl = legs.find((l) => l.product.includes('border corner, analytic: no along-edge gradient'))!;
    expect(treat, 'the treatment corner leg was not built').toBeDefined();
    expect(ctrl, 'the control corner leg was not built').toBeDefined();
    console.log(`\nBORDER CORNERS vs CLOSED FORM (E2) — treatment and control:\n${summarise([treat, ctrl])}`);
    // The TREATMENT group is a genuine statistical leg: it diverges, and biased
    // LOW, the same direction the whole ring used to be, because clamping still
    // halves that one component.
    expect(treat.status, `treatment corners: ${treat.reason ?? ''}`).toBe('ok');
    expect(treat.verdict, 'the along-edge clamp stopped costing anything at the corners').toBe('disagree');
    expect(treat.meanBias!, 'corner bias is not negative').toBeLessThan(0);

    // The CONTROL group is asserted PER CELL rather than as a leg verdict. Only a
    // handful of fixtures have a zero along-edge gradient at their corners, so the
    // pooled control lands under MIN_CELLS and its leg is recorded as
    // `insufficient` with the count. The control claim is not statistical anyway:
    // it is that these specific cells are EXACT, which a cell-by-cell check states
    // more strongly than any pooled figure and without relaxing MIN_CELLS.
    const ctrlGroup = cornerAnalytic.noAlongEdgeGradient;
    expect(ctrlGroup.ours.length, 'no control corners were collected').toBeGreaterThanOrEqual(8);
    const ctrlOff = ctrlGroup.ours
      .map((v, k) => ({ k, d: Math.abs(v - ctrlGroup.truth[k]) }))
      .filter((x) => x.d > FROZEN_TOLERANCES.slopeDeg);
    expect(ctrlOff, 'a corner with no along-edge gradient missed the closed form').toEqual([]);
    // And the two groups must genuinely differ, or the split explains nothing.
    expect(treat.maxAbsDiff!, 'treatment corners are no worse than the control')
      .toBeGreaterThan(FROZEN_TOLERANCES.slopeDeg);

    notes.push(
      'Border vs closed form (E2): the extrapolated border edge reproduces the analytic slope on locally ' +
      'linear surfaces and diverges on quadratic ones by roughly a*cell in rise/run, an error the gdaldem ' +
      'leg cannot detect because gdaldem extrapolates identically. At the four corners the along-edge axis ' +
      'is clamped, so the analytic slope is missed wherever the gradient has an along-edge component ' +
      `(pooled max ${treat.maxAbsDiff?.toFixed(4)} deg, bias ${treat.meanBias?.toFixed(4)}) and met exactly ` +
      'where it does not. Both are consequences of matching gdaldem cell-for-cell and are the price of that ' +
      'choice, not defects in the extrapolation itself.',
    );
  });

  it('measures the geographic anisotropy gdaldem aspect cannot express', () => {
    // The finding: gdaldem slope and gdaldem hillshade take -xscale/-yscale, so
    // an unequal-metres geographic grid is expressible there. gdaldem aspect
    // takes neither, so its only model is equal spacing in DEGREES, which off the
    // equator is not the metre frame. Our kernel agrees with gdaldem under
    // gdaldem's assumption and diverges by the size measured below under the
    // physically correct one.
    const equal = legs.find((l) => l.product.includes('equal-axis assumption'));
    const truth = legs.find((l) => l.product.includes('true unequal metres'));
    expect(equal, 'the equal-axis leg was not built').toBeDefined();
    expect(truth, 'the unequal-metres leg was not built').toBeDefined();
    expect(equal!.verdict, `under gdaldem's own assumption: ${equal!.maxAbsDiff}`).toBe('agree');
    expect(truth!.expectation).toBe('documented-divergence');
    console.log(
      `\nGEOGRAPHIC anisotropy at latitude ${GEO_CENTRE_LATITUDE_DEG} ` +
        `(${GEO_METRES_PER_DEG_LON.toFixed(1)} m/deg lon vs ${GEO_METRES_PER_DEG_LAT} m/deg lat):\n` +
        `  ours (equal degree axes)   vs gdaldem aspect: max ${equal!.maxAbsDiff?.toPrecision(4)} deg — ${equal!.verdict}\n` +
        `  ours (true unequal metres) vs gdaldem aspect: max ${truth!.maxAbsDiff?.toPrecision(4)} deg — ${truth!.verdict}\n` +
        '  gdaldem aspect has no -xscale/-yscale: an anisotropic reference is UNAVAILABLE from the reference tool.',
    );
    // The divergence must be large enough to matter, or the fixture is at too
    // low a latitude to have tested anything.
    expect(truth!.maxAbsDiff!).toBeGreaterThan(1);
  });

  it('records which fixtures are blind to a row-order flip or an axis mirror', () => {
    // Guards the MATRIX, not the code. ASCII Grid writes the northern row first
    // while our kernel treats row+1 as north, so a row-order mistake is live, not
    // hypothetical, and it produces a plausible-looking grid (the v0.4.3 defect).
    // Some fixtures cannot possibly detect it — a constant surface and a pure
    // east-west gradient are unchanged by a north-south flip — so the honest
    // output is a per-fixture list, plus a floor on how many fixtures DO detect
    // it. A matrix where none did would be decorative.
    const detect: string[] = [];
    const blind: string[] = [];
    for (const spec of FIXTURES) {
      const run = REF_RECORD!.runs.find((r) => r.fixtureId === spec.id && r.product === 'aspect' && r.status === 'ok');
      if (!run?.output) continue;
      const ref = readAsciiGrid(resolve(MATRIX_DIR, run.output));
      const g = olvFor(spec);
      const sel = aspectIndices(spec, ref.values, [ref.nodata, NODATA]);
      if (sel.idx.length < MIN_CELLS) continue;
      const flipped = new Float64Array(ref.values.length);
      const mirrored = new Float64Array(ref.values.length);
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
          flipped[r * spec.cols + c] = ref.values[(spec.rows - 1 - r) * spec.cols + c];
          mirrored[r * spec.cols + c] = ref.values[r * spec.cols + (spec.cols - 1 - c)];
        }
      }
      const f = circularAgreement(g.aspectDeg, flipped, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg);
      const m = circularAgreement(g.aspectDeg, mirrored, sel.idx, FROZEN_TOLERANCES.aspectCircularDeg);
      const line = `  ${spec.id.padEnd(20)} flip ${f.verdict.padEnd(9)} (max ${f.maxAbsDiff.toFixed(2)} deg)  mirror ${m.verdict.padEnd(9)} (max ${m.maxAbsDiff.toFixed(2)} deg)`;
      if (f.verdict === 'disagree' && m.verdict === 'disagree') detect.push(line);
      else blind.push(line);
    }
    console.log(`\nROW-ORDER / MIRROR detectability — fixtures that DETECT both:\n${detect.join('\n')}`);
    console.log(`fixtures BLIND to at least one (recorded, not hidden):\n${blind.join('\n') || '  (none)'}`);
    // The requirement is structural, not a headcount. Any fixture whose aspect is
    // CONSTANT across the grid — every plane, including all eight rosette
    // fixtures — is inherently blind to both reflections, because reflecting a
    // constant grid returns the same grid. That is a property of a plane, not a
    // weakness to be counted away, and the measured result is that 6 of the 23
    // fixtures with an aspect leg detect both. So the fixtures that CAN detect it
    // are named, and each is required to.
    const detectors = ['convex-hill', 'concave-pit', 'saddle', 'nodata-scatter'];
    for (const id of detectors) {
      expect(detect.some((line) => line.trim().startsWith(id)), `${id} no longer detects both reflections`).toBe(true);
    }
    // Every FULLY-VALID projected plane must show up as blind, or the detection
    // test itself is broken and its "detections" mean nothing. A plane with a
    // nodata pattern is excluded from this rule: the hole makes the comparison
    // set asymmetric, so `nodata-island` and `thin-corridor` detect a reflection
    // through their MASK rather than through their aspect, which is a weaker but
    // real signal and is why they appear on the detecting side.
    for (const spec of FIXTURES) {
      if (spec.surface.kind !== 'plane' || spec.crs !== 'projected' || spec.nodata !== 'none') continue;
      const line = [...detect, ...blind].find((l) => l.trim().startsWith(spec.id));
      if (!line) continue;
      expect(blind, `${spec.id} is a plane and cannot detect a reflection of a constant aspect grid`).toContain(line);
    }
  });

  it('writes the results record with the exact command lines and output hashes', () => {
    const boundaries = legs
      .filter((l) => l.status === 'ok' && l.verdict !== 'agree')
      .map((l) => ({
        fixtureId: l.fixtureId,
        family: l.family,
        product: l.product,
        reference: l.reference,
        unit: l.unit,
        tolerance: l.tolerance,
        maxAbsDiff: l.maxAbsDiff,
        rmse: l.rmse,
        meanBias: l.meanBias,
        withinTolFraction: l.withinTolFraction,
        expected: l.expectation,
        // Three distinct things, kept distinct. A leg expected to agree that did
        // not is an open FINDING. One declared a model divergence from reading
        // both implementations before the run is a characterisation. One whose
        // expectation was CORRECTED after the first run is a divergence this
        // matrix discovered, and saying so is the difference between a prediction
        // that held and a prediction that was rewritten.
        kind:
          l.expectation === 'agree'
            ? 'unexpected disagreement'
            : l.expectationRevisedAfterFirstRun
            ? 'divergence found by this matrix (expectation corrected after the first run)'
            : 'model divergence declared before the run',
      }));

    const record = {
      generatedBy: 'tests/rasterAgreementMatrix.test.ts',
      promotes: 'nothing — docs/validation/claim-register.yaml and REFERENCE_SLOTS are untouched',
      evidenceNote:
        'Legs whose reference is "analytic (closed form)" are E2: one implementation against a formula, ' +
        'however many fixtures they span. Only the "GDAL 3.13.1" legs are cross-implementation (E4). ' +
        'The fixture count is not E4 breadth.',
      metricNote:
        'Slope uses plain absolute error, which is correct for a magnitude. Aspect uses circular separation ' +
        '(359 vs 1 is 2 apart). Hillshade is compared twice: unquantised intensity and shipped 8-bit level.',
      frozenTolerances: FROZEN_TOLERANCES,
      toleranceProvenance:
        'Every tolerance was fixed from a stated derivation before any comparison in this file was run, ' +
        'and none was widened afterwards. Derivations are in the FROZEN_TOLERANCES comments.',
      aspectMinSlopeDeg: ASPECT_MIN_SLOPE_DEG,
      minCellsPerLeg: MIN_CELLS,
      reference: REF_RECORD!.environment,
      commandLines: REF_RECORD!.runs.map((r) => ({ runId: r.runId, status: r.status, commandLine: r.commandLine ?? null, unit: r.unit ?? null, axisScaling: r.axisScaling ?? null })),
      notes,
      legs,
      boundaries,
    };
    mkdirSync(MATRIX_DIR, { recursive: true });
    writeOrVerify(resolve(MATRIX_DIR, 'results.json'), JSON.stringify(record, null, 2) + '\n', 'results.json');

    // The record has to describe a real run: every ok leg carries measured
    // statistics, and every unavailable leg carries a reason instead of a zero.
    for (const l of legs) {
      if (l.status === 'ok') {
        expect(Number.isFinite(l.maxAbsDiff!), `${l.fixtureId}/${l.product} has no measured max`).toBe(true);
        expect(l.cells, `${l.fixtureId}/${l.product} claims zero cells`).toBeGreaterThan(0);
      } else {
        expect(l.reason, `${l.fixtureId}/${l.product} is not ok but gives no reason`).toBeTruthy();
        expect(l.maxAbsDiff, `${l.fixtureId}/${l.product} substituted a number for a missing run`).toBeNull();
      }
    }
    expect(existsSync(resolve(MATRIX_DIR, 'gdal-SHA256SUMS'))).toBe(true);
    expect(existsSync(resolve(MATRIX_DIR, 'olv-SHA256SUMS'))).toBe(true);
    expect(existsSync(GDAL_DIR)).toBe(true);
    expect(existsSync(OLV_DIR)).toBe(true);
    console.log(`\n${legs.length} legs recorded, ${boundaries.length} outside tolerance (see results.json boundaries).`);
    for (const b of boundaries) {
      console.log(`  ${b.kind}: ${b.fixtureId} / ${b.product} vs ${b.reference} — max ${b.maxAbsDiff?.toPrecision(4)} ${b.unit} (tol ${b.tolerance})`);
    }
  });

  it('never substitutes a zero or an inferred pass for a comparison that did not run', () => {
    const notRun = legs.filter((l) => l.status !== 'ok');
    for (const l of notRun) {
      expect(l.verdict).not.toBe('agree');
      expect(['not-executed', 'insufficient']).toContain(l.verdict);
    }
    // And every gdaldem run that WAS attempted is accounted for in the legs, so a
    // silently dropped run cannot look like a run that was never scheduled.
    const attempted = new Set(REF_RECORD!.runs.map((r) => r.fixtureId));
    const covered = new Set(legs.map((l) => l.fixtureId));
    for (const id of attempted) expect(covered.has(id), `${id} has no leg`).toBe(true);
  });

  it('matches the committed evidence, or names what drifted', () => {
    // The record is the expectation, not the output. Numbers compare within a
    // tolerance so another machine's libm cannot red the release gate; a real
    // change to the OLV side still fails here and names the field.
    expect(evidenceDrift, evidenceDrift.join('\n')).toEqual([]);
  });

});
