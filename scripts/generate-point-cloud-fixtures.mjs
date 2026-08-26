#!/usr/bin/env node
/**
 * generate-point-cloud-fixtures.mjs — the synthetic point clouds behind the
 * PDAL cross-implementation studies.
 *
 * WHAT THIS IS FOR. Every cross-implementation comparison this repository has
 * run so far starts from a DEM: `scripts/generate-raster-fixtures.mjs` writes
 * grids and `scripts/run-gdaldem-reference.mjs` compares raster kernels. That
 * says nothing about the path a field survey actually takes, which starts at
 * returns and ends at a product. These fixtures are point clouds, and the
 * reference implementation on the other side is PDAL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE LEVEL — READ BEFORE COUNTING FIXTURES
 * ─────────────────────────────────────────────────────────────────────────────
 * A synthetic scene whose ground membership is known by construction gives an
 * E3 leg: one implementation against a generator this project also wrote. It is
 * E4 only where a SECOND INDEPENDENT IMPLEMENTATION produced the reference, and
 * that is `scripts/run-pdal-reference.mjs`. The fixture count says nothing about
 * E4 breadth on its own, and neither does the fact that these are point clouds
 * rather than grids: a synthetic cloud is not a survey.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CSV, AND WHY THE COMMITTED BYTES ARE THE INPUT
 * ─────────────────────────────────────────────────────────────────────────────
 * Writing LAS from Node would need either a dependency this project would carry
 * in its SBOM forever or a hand-rolled writer whose bugs would be indexed into
 * the study. PDAL's `readers.text` reads CSV natively, it diffs in review, and
 * it is the same handful of lines to parse on our side.
 *
 * The consuming test READS THESE FILES rather than regenerating the points in
 * memory. That is deliberate: both implementations then start from one set of
 * bytes, so a disagreement cannot be a disagreement about how each side
 * reconstructed the cloud. Coordinates are written at three decimals (a
 * millimetre), which is far below every tolerance in the studies and round-trips
 * through `toFixed(3)` / `parseFloat` unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RETURN NUMBERS ARE WRITTEN ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `filters.smrf` defaults to `returns: "last,only"`. Given a cloud with no
 * return dimensions it warns and silently proceeds over every point, which makes
 * the comparison depend on a fallback path rather than on a stated parameter.
 * Every fixture point is written as return 1 of 1 — an "only" return — so the
 * default selects all of them for a reason that is on the page. Our filter has
 * no concept of return number, so this is also the only configuration under
 * which the two sides see the same population.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT EACH FIXTURE FAMILY IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * The five classified scenes vary the axes on which two SMRF implementations
 * are known to be able to differ, one axis at a time:
 *
 *   plane-buildings    the baseline. Gentle uniform slope, unambiguous objects.
 *                      A disagreement here is a disagreement about the core.
 *   rolling-buildings  curvature. A progressive opening over a curved surface
 *                      cuts real terrain if the slope-scaled threshold grows
 *                      too slowly, and the two sides grow it from the same
 *                      formula but not necessarily over the same window ladder.
 *   ridge-buildings    a 30 % V ridge. Steep ground is where a threshold cap
 *                      changes the answer, and where a shared formula stops
 *                      being the whole story.
 *   plane-lowblunders  gross below-ground returns. Our classifier is ONE-SIDED
 *                      (anything at or under the opened surface is ground);
 *                      SMRF as published tests |Δz|. This family is the one that
 *                      makes that difference visible instead of leaving it in a
 *                      docstring.
 *   plane-gap          a rectangular hole with no returns. Both sides inpaint
 *                      the minimum-elevation grid before opening it, and they
 *                      inpaint it differently (nearest-finite here, a smoother
 *                      fill in SMRF as published). The hole is where that shows.
 *
 * The three bare-earth scenes carry no objects and one return per cell, placed
 * at the cell CENTRE. They are the input to the DTM study, and the regular
 * layout is the whole point of them.
 *
 * The three DSM scenes (`role: surface`) keep that cell-centred layout for the
 * same estimator reason, but stack returns ABOVE the ground return on a subset
 * of cells — a flat roof and a facade midpoint over building footprints, a
 * canopy over vegetation clumps. Every above-ground return is still placed at
 * the cell centre, so the disc and the square hold the same set and the cell
 * MAXIMUM (the DSM) is comparable at the same tolerance as the minimum (the
 * DTM). The stacking is what makes DSM differ from DTM; without it the two
 * products coincide and the max study would only re-test the min study's grid.
 *
 * WHY THE DTM FIXTURES ARE GRIDDED, AND WHAT THAT COSTS. PDAL's `writers.gdal`
 * is a RADIUS estimator: a cell takes its value from every point within
 * `radius` of the cell centre, default `resolution * sqrt(2)`. `rasterizeDtm`
 * is a CELL estimator: a point contributes to the one cell it falls in. A disc
 * is not a square, so on a scattered cloud over sloping ground the two cannot
 * agree exactly however the parameters are set, and any tolerance wide enough
 * to absorb the difference (of order the terrain slope times the radius, so
 * decimetres on a 30 % flank) would be far too wide to catch a real fault.
 *
 * One return per cell centre with `radius` set below half a cell removes that
 * confound: each cell's disc then holds exactly the one return that falls in
 * that cell, both estimators reduce to the same value, and the comparison can
 * run at a tolerance near float32 spacing. What it tests is the georeferencing
 * — grid origin, cell indexing, and row order, which is where the v0.4.3 aspect
 * mirror came from — and NOT the aggregation over a realistic cloud. That
 * second question is left open rather than answered with a tolerance that could
 * not fail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DETERMINISM
 * ─────────────────────────────────────────────────────────────────────────────
 * No clock, no `Math.random`, no network. Positions are jittered by an explicit
 * 32-bit LCG seeded per fixture, so re-running rewrites byte-identical files.
 * A regenerated fixture that differs from the committed one is a defect in this
 * script, and `pdal-SHA256SUMS` plus `fixtures.json` are what catch it.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the PDAL studies produce lives here. */
export const PIPELINE_DIR = resolve(ROOT, 'validation/cross-implementation/pdal-pipeline');
export const FIXTURE_DIR = resolve(PIPELINE_DIR, 'fixtures');

/**
 * Decimals used for X, Y and Z. Fixed rather than "as many as a double has" so
 * the committed files stay reviewable and so both implementations parse the SAME
 * truncated coordinates. A millimetre is three orders of magnitude below the
 * tightest tolerance in either study.
 */
export const COORD_DECIMALS = 3;

/** Ground sampling density, returns per square metre, before objects. */
export const GROUND_DENSITY = 4;

/** Every fixture covers this square, in metres, with its origin at (0, 0). */
export const EXTENT_M = 50;

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants).
 *
 * Written out rather than imported so the fixture bytes depend on nothing that
 * can be upgraded underneath them. Returns a float in [0, 1).
 */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Round to the committed coordinate precision. */
const q = (v) => Math.round(v * 10 ** COORD_DECIMALS) / 10 ** COORD_DECIMALS;

/**
 * The bare-earth surfaces. Each takes metres east and north and returns a
 * height in metres, on a base of 100 m so the study never runs on values near
 * zero (a scale error is invisible at the origin).
 */
export const SURFACES = {
  /** Uniform 5.4 % tilt. No symmetry axis, so a mirrored frame would show. */
  plane: (x, y) => 100 + 0.05 * x + 0.02 * y,
  /**
   * Rolling terrain with two incommensurate wavelengths plus a drift, so no
   * translation of the grid maps the surface onto itself.
   */
  rolling: (x, y) => 100 + 3 * Math.sin((2 * Math.PI * x) / 25) * Math.cos((2 * Math.PI * y) / 31) + 0.02 * x,
  /**
   * A V ridge at x = 25 with 30 % flanks and a slight along-ridge fall, so the
   * two flanks are not reflections of one another.
   */
  ridge: (x, y) => 100 + 0.3 * Math.abs(x - 25) + 0.01 * y,
};

/**
 * Flat-roof buildings, as (x0, y0, width, depth, height) in metres. Height is
 * measured from the local ground, so a building on the ridge flank is still a
 * building. Chosen to sit well clear of one another and of the extent border:
 * a structure clipped by the edge would test the edge policy, which is a
 * different question from the one these fixtures ask.
 */
export const BUILDINGS = [
  { x0: 6, y0: 8, w: 9, d: 7, h: 5.5 },
  { x0: 30, y0: 12, w: 8, d: 6, h: 4.0 },
  { x0: 18, y0: 33, w: 11, d: 8, h: 7.0 },
];

/** Roof returns per square metre. Denser than ground, as a real roof is. */
const ROOF_DENSITY = 8;

/** Vegetation clumps: count, radius, and the height band above ground. */
const VEG_CLUMPS = 26;
const VEG_RADIUS_M = 1.8;
const VEG_POINTS_PER_CLUMP = 14;
const VEG_MIN_H = 1.2;
const VEG_MAX_H = 8.0;

/** The rectangular no-return hole used by the gap fixture, in metres. */
export const GAP_RECT = { x0: 20, y0: 20, x1: 32, y1: 32 };

/** Gross below-ground blunders: how many, and how far under the surface. */
export const BLUNDER_COUNT = 30;
export const BLUNDER_DEPTH_M = 4;

/**
 * The fixture matrix.
 *
 * `role` separates what a fixture is FOR from what it contains, because the two
 * studies want different things: `classification` scenes carry objects and feed
 * the ground-filter study, `bare-earth` scenes are entirely ground and feed the
 * DTM study, where objects would only re-test the classifier.
 */
export const FIXTURES = [
  { id: 'pc-01-plane-buildings', datasetId: 'OLV-DS-007-PC-PLANE-BUILDINGS', surface: 'plane', role: 'classification', layout: 'scattered', objects: true, gap: false, blunders: false, seed: 1001 },
  { id: 'pc-02-rolling-buildings', datasetId: 'OLV-DS-008-PC-ROLLING-BUILDINGS', surface: 'rolling', role: 'classification', layout: 'scattered', objects: true, gap: false, blunders: false, seed: 1002 },
  { id: 'pc-03-ridge-buildings', datasetId: 'OLV-DS-009-PC-RIDGE-BUILDINGS', surface: 'ridge', role: 'classification', layout: 'scattered', objects: true, gap: false, blunders: false, seed: 1003 },
  { id: 'pc-04-plane-lowblunders', datasetId: 'OLV-DS-010-PC-PLANE-LOWBLUNDERS', surface: 'plane', role: 'classification', layout: 'scattered', objects: true, gap: false, blunders: true, seed: 1004 },
  { id: 'pc-05-plane-gap', datasetId: 'OLV-DS-011-PC-PLANE-GAP', surface: 'plane', role: 'classification', layout: 'scattered', objects: true, gap: true, blunders: false, seed: 1005 },
  { id: 'pc-06-bare-plane', datasetId: 'OLV-DS-012-PC-BARE-PLANE', surface: 'plane', role: 'bare-earth', layout: 'cell-centred', objects: false, gap: false, blunders: false, seed: 1006 },
  { id: 'pc-07-bare-rolling', datasetId: 'OLV-DS-013-PC-BARE-ROLLING', surface: 'rolling', role: 'bare-earth', layout: 'cell-centred', objects: false, gap: false, blunders: false, seed: 1007 },
  { id: 'pc-08-bare-ridge', datasetId: 'OLV-DS-014-PC-BARE-RIDGE', surface: 'ridge', role: 'bare-earth', layout: 'cell-centred', objects: false, gap: false, blunders: false, seed: 1008 },
  // ── DSM (top-surface) scenes ────────────────────────────────────────────────
  // These feed the DSM study, which mirrors the DTM study with min -> max. They
  // are cell-centred like the bare-earth scenes, for the SAME reason: PDAL's
  // writers.gdal is a radius estimator and buildDsm is a cell estimator, and a
  // disc only equals a square when every cell's returns sit inside a disc smaller
  // than the cell. So every return is placed AT the cell centre (`objects: true`,
  // `layout: cell-centred-structured`), with a subset of cells carrying returns
  // ABOVE the ground return — a flat roof, a facade midpoint, or a canopy — so
  // the cell's maximum is genuinely above its minimum and the study exercises the
  // upper-surface selection rather than re-testing the bare-earth georeferencing.
  // A scattered scene with structure (pc-01..05) could NOT be used here: on
  // scattered returns the disc and the square disagree and no tolerance near
  // float32 spacing could hold, which is the same reason the DTM fixtures are
  // gridded.
  { id: 'pc-09-plane-structures', datasetId: 'OLV-DS-015-PC-PLANE-STRUCTURES', surface: 'plane', role: 'surface', layout: 'cell-centred-structured', objects: true, gap: false, blunders: false, seed: 1009 },
  { id: 'pc-10-rolling-structures', datasetId: 'OLV-DS-016-PC-ROLLING-STRUCTURES', surface: 'rolling', role: 'surface', layout: 'cell-centred-structured', objects: true, gap: false, blunders: false, seed: 1010 },
  { id: 'pc-11-ridge-structures', datasetId: 'OLV-DS-017-PC-RIDGE-STRUCTURES', surface: 'ridge', role: 'surface', layout: 'cell-centred-structured', objects: true, gap: false, blunders: false, seed: 1011 },
];

/**
 * Cell size of the `cell-centred` layout, metres. It is the DTM study's cell
 * size on both sides, and the layout only means anything alongside it.
 */
export const DTM_CELL_M = 1;

const inRect = (x, y, r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
const inBuilding = (x, y, b) => x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.d;

/**
 * Build one fixture's points and its by-construction ground labels.
 *
 * Returns `{ points, truth }` where `points` is `[{x, y, z}]` already rounded to
 * the committed precision and `truth[i]` is `1` for a return generated as
 * bare earth. Point ORDER is generation order and is the order written to disk;
 * both implementations key on it, and the reader verifies the coordinates line
 * up rather than trusting that they do.
 */
export function buildFixture(spec) {
  const rnd = lcg(spec.seed);
  const surface = SURFACES[spec.surface];
  const points = [];
  const truth = [];

  if (spec.layout === 'cell-centred') {
    // One return per cell, at the cell centre, in row-major order from the
    // south-west corner. No jitter and no seed use: the layout is the fixture.
    const n = Math.round(EXTENT_M / DTM_CELL_M);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const x = (col + 0.5) * DTM_CELL_M;
        const y = (row + 0.5) * DTM_CELL_M;
        points.push({ x: q(x), y: q(y), z: q(surface(x, y)) });
        truth.push(1);
      }
    }
    return { points, truth };
  }

  if (spec.layout === 'cell-centred-structured') {
    // The DSM scenes. Every return is placed AT a cell centre so a disc of
    // radius < half a cell and the square cell hold the SAME returns, exactly as
    // the bare-earth scenes arrange it. What differs is that some cells stack
    // returns ABOVE the ground return, so the cell maximum (the DSM) sits above
    // the cell minimum (the DTM) and the study tests upper-surface selection.
    const n = Math.round(EXTENT_M / DTM_CELL_M);
    // Vegetation clumps are drawn first, so the LCG sequence that fixes the
    // committed bytes does not depend on the cell iteration below.
    const clumps = [];
    for (let c = 0; c < VEG_CLUMPS; c++) {
      clumps.push({
        cx: 2 + rnd() * (EXTENT_M - 4),
        cy: 2 + rnd() * (EXTENT_M - 4),
        h: VEG_MIN_H + rnd() * (VEG_MAX_H - VEG_MIN_H),
      });
    }
    const r2 = VEG_RADIUS_M * VEG_RADIUS_M;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const x = (col + 0.5) * DTM_CELL_M;
        const y = (row + 0.5) * DTM_CELL_M;
        const g = surface(x, y);
        // Ground return — ALWAYS, so every cell is covered on both sides and the
        // study never speaks to empty-cell handling, which it does not test.
        points.push({ x: q(x), y: q(y), z: q(g) });
        truth.push(1);
        const b = BUILDINGS.find((bb) => inBuilding(x, y, bb));
        if (b) {
          // A flat roof at a constant height above the building corner's ground
          // (as a roof follows the building, not the terrain), plus a facade
          // return halfway between ground and roof. Three returns in the cell, so
          // the maximum must be selected rather than being the only value.
          const roof = surface(b.x0, b.y0) + b.h;
          const mid = (g + roof) / 2;
          points.push({ x: q(x), y: q(y), z: q(mid) });
          truth.push(0);
          points.push({ x: q(x), y: q(y), z: q(roof) });
          truth.push(0);
          continue;
        }
        // A canopy return where a vegetation clump covers this cell centre.
        // Squared distance so the boundary test needs no sqrt and stays exact.
        const clump = clumps.find((cl) => {
          const dx = x - cl.cx;
          const dy = y - cl.cy;
          return dx * dx + dy * dy <= r2;
        });
        if (clump) {
          points.push({ x: q(x), y: q(y), z: q(g + clump.h) });
          truth.push(0);
        }
      }
    }
    return { points, truth };
  }

  // ── bare earth ────────────────────────────────────────────────────────────
  const groundCount = Math.round(EXTENT_M * EXTENT_M * GROUND_DENSITY);
  for (let i = 0; i < groundCount; i++) {
    const x = rnd() * EXTENT_M;
    const y = rnd() * EXTENT_M;
    if (spec.gap && inRect(x, y, GAP_RECT)) continue;
    // A ground return that fell on a roof footprint is occluded by it. Dropping
    // it is what a real scan does and it keeps the roof from sitting over a
    // bare-earth return that no sensor could have seen.
    if (spec.objects && BUILDINGS.some((b) => inBuilding(x, y, b))) continue;
    points.push({ x: q(x), y: q(y), z: q(surface(x, y)) });
    truth.push(1);
  }

  if (spec.objects) {
    // ── roofs ───────────────────────────────────────────────────────────────
    for (const b of BUILDINGS) {
      const n = Math.round(b.w * b.d * ROOF_DENSITY);
      for (let i = 0; i < n; i++) {
        const x = b.x0 + rnd() * b.w;
        const y = b.y0 + rnd() * b.d;
        // Flat roof at a constant height above the ground under the building's
        // corner, not above each return: a roof follows the building, not the
        // terrain.
        points.push({ x: q(x), y: q(y), z: q(surface(b.x0, b.y0) + b.h) });
        truth.push(0);
      }
    }
    // ── vegetation ──────────────────────────────────────────────────────────
    for (let c = 0; c < VEG_CLUMPS; c++) {
      const cx = 2 + rnd() * (EXTENT_M - 4);
      const cy = 2 + rnd() * (EXTENT_M - 4);
      if (spec.gap && inRect(cx, cy, GAP_RECT)) continue;
      if (BUILDINGS.some((b) => inBuilding(cx, cy, b))) continue;
      for (let i = 0; i < VEG_POINTS_PER_CLUMP; i++) {
        const x = cx + (rnd() * 2 - 1) * VEG_RADIUS_M;
        const y = cy + (rnd() * 2 - 1) * VEG_RADIUS_M;
        const h = VEG_MIN_H + rnd() * (VEG_MAX_H - VEG_MIN_H);
        points.push({ x: q(x), y: q(y), z: q(surface(x, y) + h) });
        truth.push(0);
      }
    }
  }

  if (spec.blunders) {
    // ── gross low returns ───────────────────────────────────────────────────
    // Labelled 0 by construction: a multipath return four metres under the
    // terrain is not bare earth, whatever a one-sided classifier decides.
    for (let i = 0; i < BLUNDER_COUNT; i++) {
      const x = rnd() * EXTENT_M;
      const y = rnd() * EXTENT_M;
      points.push({ x: q(x), y: q(y), z: q(surface(x, y) - BLUNDER_DEPTH_M) });
      truth.push(0);
    }
  }

  return { points, truth };
}

/**
 * Serialise a fixture to the exact CSV bytes PDAL and the test both read.
 *
 * `ReturnNumber` and `NumberOfReturns` are both 1 on every row: see the note at
 * the head of this file on why the return dimensions are present at all.
 */
export function fixtureCsv(points) {
  const lines = ['X,Y,Z,ReturnNumber,NumberOfReturns'];
  for (const p of points) {
    lines.push(
      `${p.x.toFixed(COORD_DECIMALS)},${p.y.toFixed(COORD_DECIMALS)},${p.z.toFixed(COORD_DECIMALS)},1,1`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Truth labels as one `1`/`0` per point on a single line. */
export function truthText(truth) {
  return truth.join('') + '\n';
}

/**
 * Parse a committed fixture CSV back into points.
 *
 * Shared by `scripts/run-pdal-reference.mjs` (to check PDAL returned the same
 * cloud in the same order) and by the consuming test (which never regenerates).
 * Refuses a malformed row rather than skipping it: a silently dropped row would
 * shift every index after it and misalign both sides of the comparison.
 */
export function parseFixtureCsv(text) {
  const lines = text.split('\n');
  if (lines[0] !== 'X,Y,Z,ReturnNumber,NumberOfReturns') {
    throw new Error(`unexpected fixture header: ${JSON.stringify(lines[0])}`);
  }
  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const f = line.split(',');
    if (f.length !== 5) throw new Error(`fixture row ${i} has ${f.length} fields, expected 5`);
    const x = Number(f[0]);
    const y = Number(f[1]);
    const z = Number(f[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`fixture row ${i} holds a non-finite coordinate`);
    }
    points.push({ x, y, z });
  }
  return points;
}

/** Truth labels back out of the committed file, as a Uint8Array. */
export function parseTruth(text) {
  const body = text.trim();
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '0' && c !== '1') throw new Error(`truth file holds ${JSON.stringify(c)} at ${i}`);
    out[i] = c === '1' ? 1 : 0;
  }
  return out;
}

export const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

/** Repo-relative path of a fixture's CSV, as the study manifests cite it. */
export const fixtureCsvPath = (id) =>
  `validation/cross-implementation/pdal-pipeline/fixtures/${id}.csv`;

/** Repo-relative path of a fixture's by-construction labels. */
export const fixtureTruthPath = (id) =>
  `validation/cross-implementation/pdal-pipeline/fixtures/${id}.truth`;

function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const manifest = [];
  for (const spec of FIXTURES) {
    const { points, truth } = buildFixture(spec);
    const csv = fixtureCsv(points);
    const tru = truthText(truth);
    writeFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), csv, 'utf8');
    writeFileSync(resolve(FIXTURE_DIR, `${spec.id}.truth`), tru, 'utf8');
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    manifest.push({
      id: spec.id,
      datasetId: spec.datasetId,
      role: spec.role,
      layout: spec.layout,
      surface: spec.surface,
      seed: spec.seed,
      extentMetres: EXTENT_M,
      groundDensityPerSqM: GROUND_DENSITY,
      hasObjects: spec.objects,
      hasGap: spec.gap,
      hasLowBlunders: spec.blunders,
      pointCount: points.length,
      truthGroundCount: truth.reduce((a, b) => a + b, 0),
      minZ,
      maxZ,
      csv: `fixtures/${spec.id}.csv`,
      csvSha256: sha256Of(csv),
      truth: `fixtures/${spec.id}.truth`,
      truthSha256: sha256Of(tru),
    });
    process.stdout.write(`${spec.id}: ${points.length} points\n`);
  }

  const record = {
    generatedBy: 'scripts/generate-point-cloud-fixtures.mjs',
    evidenceNote:
      'Synthetic scenes whose ground membership is known by construction. Comparing our filter ' +
      'against these labels is E3. The cross-implementation (E4) reference is PDAL, produced by ' +
      'scripts/run-pdal-reference.mjs.',
    coordinateDecimals: COORD_DECIMALS,
    extentMetres: EXTENT_M,
    groundDensityPerSqM: GROUND_DENSITY,
    buildings: BUILDINGS,
    gapRect: GAP_RECT,
    blunderCount: BLUNDER_COUNT,
    blunderDepthMetres: BLUNDER_DEPTH_M,
    fixtures: manifest,
  };
  writeFileSync(resolve(PIPELINE_DIR, 'fixtures.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

  const sums = manifest
    .flatMap((f) => [`${f.csvSha256}  ${f.csv}`, `${f.truthSha256}  ${f.truth}`])
    .join('\n');
  writeFileSync(resolve(PIPELINE_DIR, 'fixture-SHA256SUMS'), sums + '\n', 'utf8');
  process.stdout.write(`\n${manifest.length} fixtures written to ${FIXTURE_DIR}\n`);
}

/** Read a committed fixture from disk, as bytes-on-disk rather than regenerated. */
export function readFixture(id) {
  const csv = readFileSync(resolve(FIXTURE_DIR, `${id}.csv`), 'utf8');
  const tru = readFileSync(resolve(FIXTURE_DIR, `${id}.truth`), 'utf8');
  return { points: parseFixtureCsv(csv), truth: parseTruth(tru) };
}

if (isCliEntry(import.meta.url)) {
  main();
}
