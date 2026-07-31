#!/usr/bin/env node
/**
 * generate-raster-fixtures.mjs — the fixture matrix for the slope / aspect /
 * hillshade cross-implementation comparisons.
 *
 * WHAT THIS BROADENS. `scripts/make-slope-fixture.mjs` builds ONE analytic DEM
 * (120x100, 1 m cells, one quadratic surface) and the three E4 comparisons all
 * run on it. One fixture cannot separate "our Horn kernel is right" from "our
 * Horn kernel is right on a smooth quadratic at 1 m in a projected CRS with no
 * holes". This script writes a family of fixtures that vary the surface shape,
 * the cell size, the grid extent, the gradient sign, the nodata pattern and the
 * horizontal unit, so each of those becomes a separately reported result instead
 * of an untested assumption.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE LEVEL — READ THIS BEFORE COUNTING FIXTURES
 * ─────────────────────────────────────────────────────────────────────────────
 * An analytic fixture compared against its own closed-form gradient is E2: one
 * implementation against a formula. Compared against a synthetic surface it is
 * E3. It is E4 only when a SECOND INDEPENDENT IMPLEMENTATION produced the
 * reference. Every comparison in this matrix is therefore labelled with the
 * reference that produced it (`analytic` or `GDAL`), and the number of fixtures
 * here says nothing about E4 breadth on its own. `scripts/run-gdaldem-reference.mjs`
 * is what turns a fixture into a cross-implementation comparison.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROW ORDER — the hazard that has already shipped a defect once
 * ─────────────────────────────────────────────────────────────────────────────
 * ESRI ASCII Grid writes the NORTHERNMOST row first. `hornSlopeAspect` treats
 * row+1 as NORTH. Everything in this file is in ASCII-Grid order (row 0 =
 * north); the consuming test flips on the way in and back on the way out. The
 * v0.4.3 aspect mirror recorded in `src/terrain/ground/terrainDerivatives.ts`
 * came from getting this wrong, and a directional product lit from the wrong
 * flank still looks like terrain, so the surfaces below are deliberately free of
 * mirror symmetry wherever a symmetric one would have hidden a flip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ASCII GRID
 * ─────────────────────────────────────────────────────────────────────────────
 * Reading a GeoTIFF in Node needs a dependency this project would carry in its
 * SBOM forever, and this host has neither rasterio nor the osgeo Python
 * bindings. AAIGrid is a documented text format GDAL reads and writes natively,
 * it diffs in review, and parsing it is a few lines with no dependency.
 *
 * Deterministic: no clock, no randomness, no network. Re-running rewrites byte
 * identical files.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything this matrix produces lives here. */
export const MATRIX_DIR = resolve(ROOT, 'validation/cross-implementation/raster-matrix');
export const FIXTURE_DIR = resolve(MATRIX_DIR, 'fixtures');

/** Sentinel written into the DEM and expected back from gdaldem's float outputs. */
export const NODATA = -9999;

/**
 * Decimal places used when writing a DEM. Fixed rather than "as many as a
 * double has" for two reasons: the committed files stay reviewable, and both
 * implementations then read the SAME truncated surface, so a difference between
 * them cannot be a difference in how much of a decimal expansion each parser
 * kept. Six places on surfaces whose relief is order 1-100 m is far below every
 * tolerance in `tests/rasterAgreementMatrix.test.ts`.
 */
const DEM_DECIMALS = 6;

/**
 * Metres per degree used by the geographic fixture.
 *
 * These are the fixed values `gdaldem`'s own documentation suggests for a
 * lat/lon DEM (its `-s 111120` hint), not a geodetically exact conversion. The
 * point of the fixture is that the two horizontal axes have DIFFERENT metre
 * lengths and that both implementations are told the same two numbers; a more
 * precise ellipsoidal figure would not change what is being tested and would
 * make the closed form depend on a datum this comparison does not exercise.
 *
 * `gdaldem slope` and `gdaldem hillshade` accept `-xscale`/`-yscale`, so the
 * anisotropy is expressible there. `gdaldem aspect` accepts NEITHER, which is a
 * limit of the reference tool and is recorded as such rather than worked around.
 */
export const GEO_METRES_PER_DEG_LAT = 110540;
export const GEO_CENTRE_LATITUDE_DEG = 45;
export const GEO_METRES_PER_DEG_LON =
  111320 * Math.cos((GEO_CENTRE_LATITUDE_DEG * Math.PI) / 180);

/**
 * Preregistered sun positions for the hillshade legs. Frozen here, passed
 * explicitly on every gdaldem command line and read by the test from this one
 * definition, so neither side can be lit by its own default.
 *
 * Chosen to span the failure modes a single 315/45 configuration cannot see:
 * `nw-default` is the cartographic baseline both tools default to; `ne-low` is a
 * low sun from the opposite side of north with a vertical exaggeration, which is
 * where a sign error in the alignment term shows up; `south-high` puts the sun
 * on the other side of the grid entirely with a high altitude, which shrinks the
 * directional term and exposes an error in the flat-ground constant instead.
 */
export const SUNS = [
  { id: 'nw-default', azimuthDeg: 315, altitudeDeg: 45, zFactor: 1 },
  { id: 'ne-low', azimuthDeg: 45, altitudeDeg: 20, zFactor: 2 },
  { id: 'south-high', azimuthDeg: 180, altitudeDeg: 65, zFactor: 1 },
];

/**
 * Minimum slope, in degrees, below which aspect is EXCLUDED from the aspect
 * comparison. Preregistered: aspect is undefined on flat ground, so a cell that
 * is flat to within numerical noise has no bearing to agree about, and the tools
 * represent "no bearing" three different ways (see the test's notes on gdaldem's
 * -9999, its -zero_for_flat 0, and our 0 radians). Cells below this cutoff are
 * counted and reported separately, never silently dropped.
 *
 * WHY 0.5 AND NOT SOMETHING SMALLER. An aspect error is the gradient error
 * divided by the gradient magnitude, so it blows up as the surface flattens: a
 * 1e-6 error in a gradient of 0.0087 rise/run (0.5°) is 0.007° of bearing, but
 * the same gradient error at 0.05° of slope is 0.07°, and at 0.005° it is 0.7°.
 * A cutoff low enough to include near-critical cells would make the reported
 * bearing agreement a statement about float32 noise near a saddle point rather
 * than about either implementation.
 */
export const ASPECT_MIN_SLOPE_DEG = 0.5;

// ── surfaces ────────────────────────────────────────────────────────────────
//
// Each surface is a function of METRE offsets from the grid centre and has a
// closed-form gradient in metres per metre. `kink(xm, ym)` marks the locus where
// the surface is not differentiable; a cell whose 3x3 Horn window straddles a
// kink has no analytic gradient and is excluded from the analytic leg only (the
// GDAL leg still covers it, because both implementations run the same kernel
// over the same numbers there).

const SURFACES = {
  /** z = k. Zero gradient everywhere: the degenerate case for aspect. */
  constant: {
    height: (p, xm, ym) => p.k + 0 * xm + 0 * ym,
    grad: () => ({ dzdx: 0, dzdy: 0 }),
    kinked: () => false,
  },
  /** z = k + gx·x + gy·y. Constant gradient; exact under Horn by construction. */
  plane: {
    height: (p, xm, ym) => p.k + p.gx * xm + p.gy * ym,
    grad: (p) => ({ dzdx: p.gx, dzdy: p.gy }),
    kinked: () => false,
  },
  /** z = k + a·x² + b·y² + c·x·y. a != b breaks an axis transpose; c breaks both mirrors. */
  quadratic: {
    height: (p, xm, ym) => p.k + p.a * xm * xm + p.b * ym * ym + p.c * xm * ym,
    grad: (p, xm, ym) => ({
      dzdx: 2 * p.a * xm + p.c * ym,
      dzdy: 2 * p.b * ym + p.c * xm,
    }),
    // Horn is a FIRST-order estimator on a second-order surface, so it does not
    // reproduce the closed-form gradient exactly. It is exact at the centre of a
    // symmetric window for the pure quadratic terms and carries an O(cell²)
    // error otherwise, which is why the analytic slope tolerance below has to be
    // read against the cell size rather than as an absolute truth claim.
    kinked: () => false,
  },
  /** z = k + s·|x| + t·y. A ridge (s<0) or a valley (s>0) with a crest line at x = 0. */
  absridge: {
    height: (p, xm, ym) => p.k + p.s * Math.abs(xm) + p.t * ym,
    grad: (p, xm) => ({ dzdx: p.s * Math.sign(xm), dzdy: p.t }),
    // The crest itself and its neighbours: a 3x3 window that spans x = 0 sees
    // both flanks and averages them, which is not the one-sided gradient.
    kinked: (p, xm, cellMetresX) => Math.abs(xm) < 1.5 * cellMetresX,
  },
  /** z = k + h·floor(x / w) + t·y. Flat terraces separated by vertical risers. */
  step: {
    height: (p, xm, ym) => p.k + p.h * Math.floor(xm / p.w) + p.t * ym,
    grad: (p) => ({ dzdx: 0, dzdy: p.t }),
    // Any window whose columns do not all sit on one terrace straddles a riser.
    kinked: (p, xm, cellMetresX) => {
      const here = Math.floor(xm / p.w);
      return (
        Math.floor((xm - cellMetresX) / p.w) !== here ||
        Math.floor((xm + cellMetresX) / p.w) !== here
      );
    },
  },
};

// ── nodata patterns ─────────────────────────────────────────────────────────

const NODATA_PATTERNS = {
  /** Every cell carries data. */
  none: () => false,
  /**
   * A solid rectangular hole in the interior. Tests the halo of cells whose
   * Horn window touches the hole, where the two implementations have DIFFERENT
   * policies (GDAL propagates nodata; ours substitutes the centre value).
   */
  island: (spec, row, col) => {
    const r0 = Math.floor(spec.rows * 0.35);
    const r1 = Math.floor(spec.rows * 0.55);
    const c0 = Math.floor(spec.cols * 0.4);
    const c1 = Math.floor(spec.cols * 0.65);
    return row >= r0 && row <= r1 && col >= c0 && col <= c1;
  },
  /**
   * Sparse single-cell holes on a fixed lattice — a second, structurally
   * different nodata pattern. One solid block and one scatter exercise different
   * things: the block has a long boundary with a clean interior, the scatter
   * makes almost every cell a halo cell, so it measures how much of the grid one
   * implementation would answer for and the other would not.
   */
  scatter: (spec, row, col) => (row * 7 + col * 11) % 23 === 0,
  /**
   * Only a five-row band of valid data, everything else nodata. Leaves exactly
   * one row of fully-valid 3x3 windows, so it is the narrowest case a 3x3
   * estimator can answer at all.
   */
  corridor: (spec, row) => {
    const r0 = Math.floor(spec.rows / 2) - 2;
    return row < r0 || row > r0 + 4;
  },
};

// ── the matrix ──────────────────────────────────────────────────────────────
//
// DIMENSIONS COVERED, and where each is varied:
//   cell size      0.5 / 2.0 / 10.0 m, and 0.001 degrees on the geographic case
//   extent         48x40, 64x48, 96x72, 128x100
//   gradient sign  slope-x-pos / slope-x-neg, slope-y-pos / slope-y-neg
//   nodata         none / island / scatter / corridor
//   edges          `-compute_edges` on the runs marked `edges: true`
//   CRS            projected metric on all but `geographic-plane`
//
// `products` names the gdaldem runs the reference script performs for that
// fixture. Every fixture gets slope-degree, aspect and the baseline hillshade;
// the more expensive variants are spread across the matrix rather than run
// everywhere, so the committed output tree stays reviewable.
//
// `tpi` (gdaldem TPI = centre minus the mean of the 8 neighbours) is added to a
// cross-section of the matrix: every surface shape (constant, plane, quadratic,
// absridge, step), all four nodata patterns, and both the projected and the
// geographic grid. TPI takes no horizontal scaling — it is a raw-Z neighbourhood
// operation — so the geographic fixture, which `gdaldem aspect` could not express,
// is fully expressible for TPI and is included to record exactly that.

const PROJ = { xll: 500000, yll: 4600000 };

/** One entry per aspect bearing: a plane whose downslope points that way. */
function aspectRose() {
  const out = [];
  for (let b = 0; b < 360; b += 45) {
    const m = 0.4; // rise/run, well above the flat-ground cutoff
    const rad = (b * Math.PI) / 180;
    // Downslope unit vector in (east, north) is (sin b, cos b), so the gradient
    // is its negation scaled by the slope magnitude.
    out.push({
      id: `aspect-rose-${String(b).padStart(3, '0')}`,
      family: 'aspect rosette',
      note: `plane whose downslope bearing is ${b}° (cardinal and intercardinal coverage, and the 0/360 wraparound at b=0)`,
      cols: 48,
      rows: 40,
      cellsize: 1,
      crs: 'projected',
      ...PROJ,
      surface: {
        kind: 'plane',
        params: { k: 200, gx: -m * Math.sin(rad), gy: -m * Math.cos(rad) },
      },
      nodata: 'none',
      products: ['slope-deg', 'aspect', 'hillshade-nw-default'],
    });
  }
  return out;
}

/** The fixture matrix. Frozen data: the test reads it, it is not derived at test time. */
export const FIXTURES = [
  {
    id: 'flat-plane',
    family: 'flat plane',
    note: 'zero gradient everywhere; aspect is undefined and the three tools represent that differently',
    cols: 64,
    rows: 48,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'constant', params: { k: 100 } },
    nodata: 'none',
    products: [
      'slope-deg',
      'slope-pct',
      'slope-deg-edges',
      'aspect',
      'aspect-zero-flat',
      'hillshade-nw-default',
      'hillshade-ne-low',
      'hillshade-south-high',
      'hillshade-multi',
      'tpi',
    ],
  },
  {
    id: 'slope-x-pos',
    family: 'constant X slope',
    note: 'z rises eastward; smallest cell size in the matrix',
    cols: 64,
    rows: 48,
    cellsize: 0.5,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 50, gx: 0.35, gy: 0 } },
    nodata: 'none',
    products: ['slope-deg', 'slope-pct', 'slope-deg-edges', 'aspect', 'hillshade-nw-default', 'hillshade-ne-low'],
  },
  {
    id: 'slope-x-neg',
    family: 'constant X slope',
    note: 'the same magnitude with the sign reversed, on a different extent; a sign error that cancels on one is visible across the pair',
    cols: 96,
    rows: 72,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 50, gx: -0.35, gy: 0 } },
    nodata: 'none',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'hillshade-south-high'],
  },
  {
    id: 'slope-y-pos',
    family: 'constant Y slope',
    note: 'z rises northward; largest cell size in the matrix',
    cols: 64,
    rows: 48,
    cellsize: 10,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 50, gx: 0, gy: 0.22 } },
    nodata: 'none',
    products: ['slope-deg', 'slope-deg-edges', 'aspect', 'hillshade-nw-default'],
  },
  {
    id: 'slope-y-neg',
    family: 'constant Y slope',
    note: 'north-south gradient reversed; this is the pair that a row-order flip mirrors',
    cols: 96,
    rows: 72,
    cellsize: 0.5,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 50, gx: 0, gy: -0.22 } },
    nodata: 'none',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'hillshade-ne-low'],
  },
  {
    id: 'oblique-plane',
    family: 'oblique plane',
    note: 'both components non-zero and unequal, largest extent; an axis transpose changes every value',
    cols: 128,
    rows: 100,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 80, gx: 0.3, gy: -0.12 } },
    nodata: 'none',
    products: [
      'slope-deg',
      'slope-pct',
      'aspect',
      'hillshade-nw-default',
      'hillshade-ne-low',
      'hillshade-south-high',
      'hillshade-multi',
      'tpi',
    ],
  },
  {
    id: 'convex-hill',
    family: 'convex quadratic hill',
    note: 'curvature of one sign; Horn is a first-order estimator so the analytic leg carries a real O(cell squared) error here',
    cols: 96,
    rows: 72,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'quadratic', params: { k: 150, a: -0.004, b: -0.0026, c: -0.0009 } },
    nodata: 'none',
    // `slope-deg-edges` is here DELIBERATELY, and it is the only CURVED surface
    // that carries it. The other `-compute_edges` runs sit on planes and
    // piecewise-planar surfaces, where gdaldem's edge extrapolation and our edge
    // clamp happen to give the same answer because a linear surface extrapolates
    // exactly. On a quadratic they cannot both be right, so this is where the
    // edge-policy boundary is measured rather than assumed away.
    products: ['slope-deg', 'slope-deg-edges', 'aspect', 'hillshade-nw-default', 'hillshade-south-high', 'hillshade-multi', 'tpi'],
  },
  {
    id: 'concave-pit',
    family: 'concave pit',
    note: 'curvature of the other sign at the coarsest cell size; aspect points inward everywhere, so it sweeps all 360 degrees',
    cols: 64,
    rows: 48,
    cellsize: 10,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'quadratic', params: { k: 20, a: 0.004, b: 0.0026, c: 0.0009 } },
    nodata: 'none',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'hillshade-ne-low', 'tpi'],
  },
  {
    id: 'ridge',
    family: 'ridge',
    note: 'sharp crest at x = 0 plus a north-south tilt; the crest has no derivative, so it is excluded from the analytic leg and kept in the GDAL leg',
    cols: 64,
    rows: 48,
    cellsize: 0.5,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'absridge', params: { k: 120, s: -0.4, t: 0.05 } },
    nodata: 'none',
    products: ['slope-deg', 'slope-deg-edges', 'aspect', 'hillshade-nw-default', 'hillshade-ne-low', 'tpi'],
  },
  {
    id: 'valley',
    family: 'valley',
    note: 'the ridge inverted at a coarser cell size; a sign error in the gradient magnitude cannot cancel across the ridge/valley pair',
    cols: 96,
    rows: 72,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'absridge', params: { k: 60, s: 0.4, t: -0.05 } },
    nodata: 'none',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default'],
  },
  {
    id: 'saddle',
    family: 'saddle',
    note: 'opposite curvature on the two axes at the finest cell size; the centre is a critical point where slope goes to zero and aspect turns over',
    cols: 128,
    rows: 100,
    cellsize: 0.5,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'quadratic', params: { k: 100, a: 0.006, b: -0.0035, c: 0.0004 } },
    nodata: 'none',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'hillshade-south-high', 'tpi'],
  },
  {
    id: 'terrace-step',
    family: 'terrace / step',
    note: 'flat treads with vertical risers; the discontinuity is where a 3x3 estimator is least well defined and where two implementations most easily diverge',
    cols: 64,
    rows: 48,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'step', params: { k: 40, h: 3, w: 16, t: 0.02 } },
    nodata: 'none',
    products: ['slope-deg', 'slope-pct', 'aspect', 'aspect-zero-flat', 'hillshade-nw-default', 'hillshade-multi', 'tpi'],
  },
  {
    id: 'nodata-island',
    family: 'nodata island',
    note: 'oblique plane with a solid rectangular hole; the halo around the hole is where the nodata POLICIES differ, not the arithmetic',
    cols: 96,
    rows: 72,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 80, gx: 0.3, gy: -0.12 } },
    nodata: 'island',
    products: ['slope-deg', 'aspect', 'aspect-zero-flat', 'hillshade-nw-default', 'tpi'],
  },
  {
    id: 'nodata-scatter',
    family: 'nodata island',
    note: 'second nodata pattern: sparse single-cell holes on a fixed lattice, so almost every cell is a halo cell',
    cols: 64,
    rows: 48,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'quadratic', params: { k: 150, a: -0.004, b: -0.0026, c: -0.0009 } },
    nodata: 'scatter',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'tpi'],
  },
  {
    id: 'thin-corridor',
    family: 'thin valid corridor',
    note: 'five valid rows, so exactly one row of fully-valid 3x3 windows survives; the narrowest input a 3x3 estimator can answer at all',
    cols: 64,
    rows: 48,
    cellsize: 2,
    crs: 'projected',
    ...PROJ,
    surface: { kind: 'plane', params: { k: 80, gx: 0.3, gy: -0.12 } },
    nodata: 'corridor',
    products: ['slope-deg', 'aspect', 'hillshade-nw-default', 'tpi'],
  },
  {
    id: 'geographic-plane',
    family: 'geographic grid, unequal metres per axis',
    note: 'lat/lon cells at latitude 45, where one degree of longitude is ~0.71 of one degree of latitude in metres; slope and hillshade take -xscale/-yscale, aspect does not',
    cols: 64,
    rows: 48,
    cellsize: 0.001,
    crs: 'geographic',
    xll: -100,
    // Centred on GEO_CENTRE_LATITUDE_DEG so the single cos(latitude) factor both
    // tools are given is the factor at the middle of the grid.
    yll: GEO_CENTRE_LATITUDE_DEG - (48 * 0.001) / 2,
    surface: { kind: 'plane', params: { k: 300, gx: 0.3, gy: -0.12 } },
    nodata: 'none',
    products: ['slope-deg', 'slope-pct', 'aspect', 'hillshade-nw-default', 'hillshade-ne-low', 'tpi'],
  },
  ...aspectRose(),
];

// ── geometry helpers ────────────────────────────────────────────────────────

/** Metres spanned by one cell along each axis. Equal except on a geographic grid. */
export function cellMetres(spec) {
  if (spec.crs === 'geographic') {
    return {
      x: spec.cellsize * GEO_METRES_PER_DEG_LON,
      y: spec.cellsize * GEO_METRES_PER_DEG_LAT,
    };
  }
  return { x: spec.cellsize, y: spec.cellsize };
}

/**
 * Cell-centre offset from the grid centre, in METRES, for a fixture.
 *
 * `row` is ASCII-Grid order: row 0 is the NORTHERNMOST row, so northing
 * DECREASES as row increases. Expressing the offset in metres (not in the
 * grid's own horizontal unit) is what lets the geographic fixture reuse the same
 * surface definitions and the same closed-form gradients as the projected ones.
 */
export function cellOffsetMetres(spec, row, col) {
  const m = cellMetres(spec);
  const x = ((col + 0.5) - spec.cols / 2) * m.x;
  const y = ((spec.rows - row - 0.5) - spec.rows / 2) * m.y;
  return { x, y };
}

/** True where the fixture's nodata pattern masks this cell out. */
export function isNodata(spec, row, col) {
  return NODATA_PATTERNS[spec.nodata](spec, row, col);
}

/** Surface height at a cell centre, or NaN on a nodata cell. */
export function heightAt(spec, row, col) {
  if (isNodata(spec, row, col)) return Number.NaN;
  const { x, y } = cellOffsetMetres(spec, row, col);
  const s = SURFACES[spec.surface.kind];
  // Rounded to the precision actually written to disk, so the closed form and
  // both implementations are all talking about the same surface.
  return roundTo(s.height(spec.surface.params, x, y), DEM_DECIMALS);
}

/** Closed-form gradient in metres per metre, in the (east, north) frame. */
export function analyticGradient(spec, row, col) {
  const { x, y } = cellOffsetMetres(spec, row, col);
  return SURFACES[spec.surface.kind].grad(spec.surface.params, x, y);
}

/** Closed-form slope in DEGREES at a cell centre. */
export function analyticSlopeDegrees(spec, row, col) {
  const { dzdx, dzdy } = analyticGradient(spec, row, col);
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

/**
 * Closed-form aspect in COMPASS DEGREES clockwise from north (0 = north,
 * 90 = east), which is what `gdaldem aspect` emits. NaN where the gradient is
 * exactly zero: that has no downslope direction, and returning 0 there would
 * read as "due north" rather than "undefined".
 */
export function analyticAspectDegrees(spec, row, col) {
  const { dzdx, dzdy } = analyticGradient(spec, row, col);
  if (dzdx === 0 && dzdy === 0) return Number.NaN;
  const mathDeg = (Math.atan2(-dzdy, -dzdx) * 180) / Math.PI;
  return (((90 - mathDeg) % 360) + 360) % 360;
}

/**
 * True where a 3x3 Horn window centred here straddles a kink in the surface, so
 * the closed-form gradient is not what ANY 3x3 estimator should return. Excludes
 * such cells from the ANALYTIC leg only; the GDAL leg still covers them, because
 * there both implementations are running the same kernel over the same numbers
 * and are entitled to agree.
 */
export function straddlesKink(spec, row, col) {
  const { x } = cellOffsetMetres(spec, row, col);
  const m = cellMetres(spec);
  return SURFACES[spec.surface.kind].kinked(spec.surface.params, x, m.x);
}

/** All nine cells of the Horn window exist in-grid and carry data. */
export function windowFullyValid(spec, row, col) {
  if (row < 1 || col < 1 || row > spec.rows - 2 || col > spec.cols - 2) return false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (isNodata(spec, row + dr, col + dc)) return false;
    }
  }
  return true;
}

/**
 * Centre carries data but at least one neighbour does not — the HALO.
 *
 * This is the set where the two implementations differ by POLICY rather than by
 * arithmetic: `gdaldem` propagates nodata (verified on this host: a single
 * one-cell hole blanks its whole 3x3 neighbourhood in the output), while
 * `hornSlopeAspect` substitutes the centre value for a non-finite neighbour and
 * emits a real number. Neither is wrong, but they are not comparable, so the
 * halo is counted and reported instead of being folded into an agreement figure.
 */
export function isHaloCell(spec, row, col) {
  if (isNodata(spec, row, col)) return false;
  if (row < 1 || col < 1 || row > spec.rows - 2 || col > spec.cols - 2) return false;
  return !windowFullyValid(spec, row, col);
}

// ── writing ─────────────────────────────────────────────────────────────────

function roundTo(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** ESRI ASCII Grid text for a fixture, row 0 = northernmost. */
function asciiGridText(spec) {
  const lines = [
    `ncols ${spec.cols}`,
    `nrows ${spec.rows}`,
    `xllcorner ${spec.xll}`,
    `yllcorner ${spec.yll}`,
    `cellsize ${spec.cellsize}`,
    `NODATA_value ${NODATA}`,
  ];
  for (let row = 0; row < spec.rows; row++) {
    const cells = new Array(spec.cols);
    for (let col = 0; col < spec.cols; col++) {
      const z = heightAt(spec, row, col);
      cells[col] = Number.isFinite(z) ? z.toFixed(DEM_DECIMALS) : String(NODATA);
    }
    lines.push(cells.join(' '));
  }
  return lines.join('\n') + '\n';
}

/**
 * WKT for the geographic fixture's sidecar .prj.
 *
 * AAIGrid carries no CRS of its own. Without this, `gdaldem` cannot tell a
 * degree grid from a metre grid, and the fixture whose entire point is that the
 * horizontal unit is degrees would be read as metres. Written as WKT1 because
 * that is what the AAIGrid driver's .prj sidecar is defined to hold.
 */
const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const manifest = [];
  for (const spec of FIXTURES) {
    const path = resolve(FIXTURE_DIR, `${spec.id}.asc`);
    writeFileSync(path, asciiGridText(spec), 'utf8');
    if (spec.crs === 'geographic') {
      writeFileSync(resolve(FIXTURE_DIR, `${spec.id}.prj`), WGS84_WKT + '\n', 'utf8');
    }
    const m = cellMetres(spec);
    let nodataCells = 0;
    let comparable = 0;
    let halo = 0;
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        if (isNodata(spec, r, c)) nodataCells++;
        else if (windowFullyValid(spec, r, c)) comparable++;
        else if (isHaloCell(spec, r, c)) halo++;
      }
    }
    manifest.push({
      id: spec.id,
      family: spec.family,
      note: spec.note,
      cols: spec.cols,
      rows: spec.rows,
      cellsize: spec.cellsize,
      crs: spec.crs,
      horizontalUnit: spec.crs === 'geographic' ? 'degree' : 'metre',
      cellMetresX: m.x,
      cellMetresY: m.y,
      surface: spec.surface,
      nodataPattern: spec.nodata,
      nodataCells,
      comparableCells: comparable,
      haloCells: halo,
      products: spec.products,
    });
    process.stdout.write(
      `${spec.id.padEnd(20)} ${String(spec.cols).padStart(4)}x${String(spec.rows).padEnd(4)} ` +
        `cell ${String(spec.cellsize).padStart(6)} ${spec.crs.padEnd(10)} ` +
        `nodata ${String(nodataCells).padStart(5)} comparable ${String(comparable).padStart(6)} halo ${String(halo).padStart(5)}\n`,
    );
  }
  writeFileSync(
    resolve(MATRIX_DIR, 'fixtures.json'),
    JSON.stringify(
      {
        note:
          'Fixture matrix for the slope/aspect/hillshade agreement comparisons. ' +
          'An analytic fixture compared against its own closed form is E2, not E4; ' +
          'only the legs whose reference is GDAL are cross-implementation.',
        nodata: NODATA,
        demDecimals: DEM_DECIMALS,
        suns: SUNS,
        aspectMinSlopeDeg: ASPECT_MIN_SLOPE_DEG,
        geographic: {
          centreLatitudeDeg: GEO_CENTRE_LATITUDE_DEG,
          metresPerDegLon: GEO_METRES_PER_DEG_LON,
          metresPerDegLat: GEO_METRES_PER_DEG_LAT,
        },
        fixtures: manifest,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  process.stdout.write(`\n${FIXTURES.length} fixtures written to ${FIXTURE_DIR}\n`);
}

// Only write files when run directly; the test imports the surface definitions.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
