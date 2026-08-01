/**
 * terrainTruth.oracleCoverage.test.ts — audit + gap-fill for the analytic
 * terrain oracle suite.
 *
 * This file does two things:
 *
 *   1. Documents, cell by cell, the coverage of the (surface × validation)
 *      matrix the terrain oracle is meant to guarantee, pointing at the
 *      existing spec that owns each covered cell so the map stays checkable
 *      against the actual files rather than trusted on faith.
 *   2. Adds tests ONLY for the cells that were genuinely empty. Every test
 *      below derives its expected value from closed-form calculus or from
 *      the algorithm's own documented mechanics (Horn's kernel, SMRF's
 *      opening + despike, type-7 quantiles) — never from running the code
 *      and pinning whatever came out.
 *
 * ── COVERAGE MAP ────────────────────────────────────────────────────────
 *
 * Columns: ground labels (GL) · DTM elevations (DTM) · slope (SL) ·
 * aspect (AS) · hillshade (HS) · no-data handling (ND) · edge artifacts (EA)
 *
 *   Surface          GL   DTM  SL   AS   HS   ND   EA   Notes
 *   ───────────────  ───  ───  ───  ───  ───  ───  ───  ─────────────────
 *   flat plane       OK   OK   OK   NEW  OK   n/a  OK   AS: aspect was
 *                                                        never asserted on
 *                                                        a flat field
 *                                                        (dz=0 → aspect=0
 *                                                        by construction);
 *                                                        closed below.
 *   tilted plane     OK   OK   OK*  OK*  OK   n/a  OK   SL/AS: single-probe
 *                                                        coverage existed
 *                                                        (terrainTruth.
 *                                                        surface.test.ts);
 *                                                        NEW extends it to
 *                                                        every cell in the
 *                                                        raster (not just
 *                                                        one), through the
 *                                                        real point-cloud →
 *                                                        rasterizeDtm →
 *                                                        hornSlopeAspect
 *                                                        pipeline. Border/
 *                                                        corner MECHANICS
 *                                                        are already
 *                                                        exhaustively
 *                                                        covered at the
 *                                                        kernel level in
 *                                                        terrainDerivatives.
 *                                                        test.ts — not
 *                                                        repeated here,
 *                                                        only relied upon.
 *   paraboloid       --   NEW  NEW  NEW  --   n/a  --   Existed only for
 *                                                        CONTOUR geometry
 *                                                        (contourAnalytic
 *                                                        Validation.test.ts,
 *                                                        benchmark/contour
 *                                                        Correctness.test.ts)
 *                                                        via a hand-built
 *                                                        grid — never
 *                                                        through the point-
 *                                                        cloud → DTM →
 *                                                        Horn pipeline.
 *                                                        Closed-form exact
 *                                                        on interior cells
 *                                                        (derivation
 *                                                        below). GL/EA left
 *                                                        as an acknowledged
 *                                                        gap (see final
 *                                                        report, not a
 *                                                        blocker for this
 *                                                        pass).
 *   ridge            --   OK   --   OK   --   n/a  --   DTM: terrainTruth.
 *                                                        dtm.test.ts
 *                                                        (crest location).
 *                                                        AS: terrainTruth.
 *                                                        surface.test.ts
 *                                                        (flip across
 *                                                        crest). SL
 *                                                        magnitude and GL
 *                                                        left as an
 *                                                        acknowledged,
 *                                                        deprioritised gap
 *                                                        — not in the
 *                                                        task's candidate
 *                                                        list, and the
 *                                                        ridge's Gaussian
 *                                                        profile is only
 *                                                        approximately (not
 *                                                        exactly) recovered
 *                                                        by Horn, which
 *                                                        would need its own
 *                                                        truncation-error
 *                                                        derivation.
 *   depression       --   OK   --   OK   --   n/a  --   Same shape as
 *                                                        ridge (valley for
 *                                                        DTM/AS; pit's own
 *                                                        radial aspect is
 *                                                        qualitatively the
 *                                                        same claim the
 *                                                        NEW paraboloid
 *                                                        test proves
 *                                                        exactly). GL/SL
 *                                                        left as an
 *                                                        acknowledged gap.
 *   step edge        n/a  OK   NEW  NEW  --   n/a  NEW  DTM: terrainTruth.
 *                                                        dtm.test.ts
 *                                                        (terrace risers —
 *                                                        exact z jump). The
 *                                                        DERIVATIVE at a
 *                                                        riser was never
 *                                                        checked: NEW below
 *                                                        pins the exact
 *                                                        Horn "smear" a
 *                                                        discrete step
 *                                                        produces.
 *   low outliers     NEW  NEW  n/a  n/a  n/a  n/a  n/a  groundFilterDespike.
 *                                                        test.ts already
 *                                                        covers the despike
 *                                                        FLOOR on one
 *                                                        artificially large
 *                                                        cell; it never
 *                                                        checks per-point
 *                                                        isGround, never
 *                                                        runs on a multi-
 *                                                        cell grid, and
 *                                                        never follows the
 *                                                        result into
 *                                                        rasterizeDtm. NEW
 *                                                        closes all three.
 *   no-data boundary NEW* OK   NEW  NEW  --   OK   NEW  DTM/ND: terrainTruth.
 *                                                        dtm.test.ts
 *                                                        ("sparse & edge-
 *                                                        clipped"). GL/SL
 *                                                        near the boundary
 *                                                        were never
 *                                                        checked: NEW below.
 *                                                        GL*: classifyGround
 *                                                        Smrf has no
 *                                                        caller-supplied
 *                                                        grid (unlike
 *                                                        rasterizeDtm), so
 *                                                        it cannot be
 *                                                        handed a genuine
 *                                                        hole beside real
 *                                                        data — only its
 *                                                        own self-contained
 *                                                        grid edge. The NEW
 *                                                        test verifies that
 *                                                        edge exactly; see
 *                                                        its comment and
 *                                                        the final report
 *                                                        for the honest
 *                                                        limit.
 *
 * "--" = out of scope for this pass (see the final report's honesty note —
 * these are deprioritised, not un-testable). "n/a" = the cell doesn't apply
 * to that surface (e.g. hillshade is a pure function of slope/aspect,
 * already validated against analytic Lambert values in terrainTruth.
 * hillshade.test.ts and reliefShading.test.ts on flat/tilted/N-E-S-W
 * fields; re-deriving Lambert shading per surface would exercise no new
 * code path, so it is deliberately not repeated per row).
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { classifyGroundSmrf, type GroundFilterParams } from '../src/terrain/ground/groundFilter';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import {
  flatPlane,
  uniformSlope,
  paraboloid,
  terrace,
  allGround,
  gridFor,
} from './fixtures/terrainScenes';

const RAD = 180 / Math.PI;

/** Wrap an angle (deg) to [0, 360). */
function wrap360(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Flat plane — aspect (the one column the existing suite left silent)
// ═══════════════════════════════════════════════════════════════════════

describe('Flat plane — aspect is exactly 0 (undefined direction), everywhere', () => {
  it('every cell, border included: dz/dx = dz/dy = 0 exactly -> aspect = 0', () => {
    // A constant field extrapolates to itself at the border (virt(a,b,c) with
    // a===b===z0 gives 2*z0-z0 = z0), so there is no cell — interior or
    // border — where the Horn window sees anything but z0. slope and aspect
    // are therefore EXACT zero, not just close to it.
    const EXTENT = { nx: 16, ny: 16, spacing: 1 } as const;
    const grid = gridFor(EXTENT);
    const pts = flatPlane(33, EXTENT);
    const raster = rasterizeDtm(pts, allGround(pts), { grid });
    const { slope, aspect } = hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
    for (let i = 0; i < slope.length; i++) {
      expect(slope[i]).toBe(0);
      expect(aspect[i]).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Tilted plane — slope/aspect constancy across the WHOLE domain
// ═══════════════════════════════════════════════════════════════════════
//
// terrainTruth.surface.test.ts proves the analytic value at one interior
// probe cell per case. What it doesn't prove is that the value is the SAME
// everywhere a uniformly tilted plane promises it should be — including the
// straight border (which terrainDerivatives.test.ts already showed, at the
// raw-kernel level, extrapolates EXACTLY on a planar surface) and the four
// corners (which the same file shows keep gdaldem's along-edge clamp, so an
// x-axis tilt reads HALF its gradient there while a y-axis tilt does not —
// the row-edge branch that fires at every corner extrapolates the ROW
// direction and clamps the COLUMN direction, so an x-gradient loses signal
// at a corner and a y-gradient never touches the clamped axis at all).
// This test re-derives that exact split analytically and confirms it holds
// end to end through the real fixture -> rasterizeDtm -> hornSlopeAspect
// pipeline, not just on a hand-built grid.

describe('Tilted plane — slope and aspect are constant across every cell (not just one probe)', () => {
  const EXTENT = { nx: 16, ny: 16, spacing: 1 } as const;
  const grid = gridFor(EXTENT);
  const gradient = 0.4;
  const z0 = 10;

  function rasterFor(axis: 'x' | 'y') {
    const pts = uniformSlope({ ...EXTENT, gradient, axis, z0 });
    const raster = rasterizeDtm(pts, allGround(pts), { grid });
    return hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
  }

  it('axis x: slope = gradient everywhere except the 4 corners (gradient/2 there); aspect = 180 deg (west) everywhere', () => {
    const { slope, aspect } = rasterFor('x');
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const i = row * grid.cols + col;
        const isCorner = (row === 0 || row === grid.rows - 1) && (col === 0 || col === grid.cols - 1);
        const expected = isCorner ? gradient / 2 : gradient;
        expect(slope[i], `slope(${row},${col})`).toBeCloseTo(expected, 5);
        // Direction is unaffected by the corner clamp: dz/dy stays exactly 0
        // there too (the surface never varies with y), so aspect is 180 deg
        // regardless of whether the magnitude is halved.
        const deg = wrap360(aspect[i] * RAD);
        expect(Math.abs(deg - 180), `aspect(${row},${col})`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('axis y: slope = gradient and aspect = 270 deg (south) everywhere, corners included', () => {
    // The row-edge branch that fires at every corner extrapolates ROWS
    // (perpendicular to a row edge) — exactly the direction a y-axis tilt
    // varies along — and only clamps COLUMNS, which this surface is flat
    // along. So there is no asymmetric cell at all for this axis.
    const { slope, aspect } = rasterFor('y');
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const i = row * grid.cols + col;
        expect(slope[i], `slope(${row},${col})`).toBeCloseTo(gradient, 5);
        const deg = wrap360(aspect[i] * RAD);
        expect(Math.abs(deg - 270), `aspect(${row},${col})`).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Paraboloid — closed-form slope and aspect (genuinely missing)
// ═══════════════════════════════════════════════════════════════════════
//
// z = base + a·((x-cx)² + (y-cy)²) is SEPARABLE (no xy cross term), so
// Horn's 1-2-1 weighted central difference is exact for it, not merely
// close: the y-weighted sum in the dz/dx numerator is identical on the
// west and east columns and cancels, leaving (fx(x+h)-fx(x-h))/(2h) for the
// quadratic fx(u) = a(u-cx)² — a central difference whose truncation error
// (proportional to the third derivative) is identically zero for a
// quadratic. The full derivation is in the fixture's docstring
// (tests/fixtures/terrainScenes.ts, `paraboloid`). What follows is the
// arithmetic:
//   dz/dx = 2a(x-cx), dz/dy = 2a(y-cy)
//   slope = |grad z| = 2|a|·r,  r = hypot(x-cx, y-cy)
//   aspect (a>0, bowl)  = atan2(cy-y, cx-x)  (points TOWARD the centre)
//   aspect (a<0, dome)  = atan2(y-cy, x-cx)  (points AWAY from the centre)

describe('Paraboloid — Horn slope/aspect match the closed form exactly (interior cells)', () => {
  const EXTENT = { nx: 25, ny: 25, spacing: 1 } as const; // odd -> centre on a node
  const grid = gridFor(EXTENT);
  const A = 0.1;
  const BASE = 50;
  const CX = 12;
  const CY = 12;

  function rasterFor(a: number) {
    const pts = paraboloid({ ...EXTENT, a, base: BASE });
    return rasterizeDtm(pts, allGround(pts), { grid });
  }

  it('bowl (a > 0): slope = 2a·r, aspect points toward the centre', () => {
    const raster = rasterFor(A);
    const { slope, aspect } = hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
    const idx = (col: number, row: number) => row * grid.cols + col;

    // Float32 storage of z (base ~50-79, a·r² term) bounds precision to
    // roughly 1e-5 relative -> 1e-3 absolute on values of this magnitude;
    // the tolerance below reflects that storage, not a fitted number.
    const probes: Array<[number, number]> = [
      [15, 12], // dx=3, dy=0
      [12, 15], // dx=0, dy=3
      [15, 15], // dx=3, dy=3
      [9, 9], // dx=-3, dy=-3
      [20, 20], // dx=8, dy=8
    ];
    for (const [col, row] of probes) {
      const dx = col - CX;
      const dy = row - CY;
      const r = Math.hypot(dx, dy);
      const expectedSlope = 2 * A * r;
      const i = idx(col, row);
      expect(slope[i], `slope(${col},${row})`).toBeCloseTo(expectedSlope, 3);
      if (r > 0) {
        const expectedAspectDeg = wrap360(Math.atan2(CY - row, CX - col) * RAD);
        const actualDeg = wrap360(aspect[i] * RAD);
        const diff = Math.min(Math.abs(actualDeg - expectedAspectDeg), 360 - Math.abs(actualDeg - expectedAspectDeg));
        expect(diff, `aspect(${col},${row})`).toBeLessThanOrEqual(0.5);
      }
    }

    // At the exact centre node, dz/dx = dz/dy = 0 exactly (dx=dy=0), so the
    // kernel takes its literal "no gradient" branch: aspect = 0, not NaN.
    expect(slope[idx(CX, CY)]).toBeCloseTo(0, 5);
    expect(aspect[idx(CX, CY)]).toBe(0);

    // DTM sanity, folded in here since the raster is already built: the
    // centre reads `base` and is the global minimum of a bowl.
    expect(raster.z[idx(CX, CY)]).toBeCloseTo(BASE, 4);
    let minI = 0;
    for (let i = 1; i < raster.z.length; i++) if (raster.z[i] < raster.z[minI]) minI = i;
    expect(minI).toBe(idx(CX, CY));
  });

  it('dome (a < 0): aspect points away from the centre', () => {
    const domeA = -A;
    const raster = rasterFor(domeA);
    const { slope, aspect } = hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
    const idx = (col: number, row: number) => row * grid.cols + col;
    const col = 15;
    const row = 12; // dx=3, dy=0, due east of the centre
    const dx = col - CX;
    const r = Math.abs(dx);
    const i = idx(col, row);
    expect(slope[i]).toBeCloseTo(2 * Math.abs(domeA) * r, 3);
    // Downhill points away from the centre: due east of it is aspect 0 deg.
    const deg = wrap360(aspect[i] * RAD);
    expect(Math.min(deg, 360 - deg)).toBeLessThanOrEqual(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Step edge — the Horn "smear" a discrete riser produces
// ═══════════════════════════════════════════════════════════════════════
//
// terrace() with axis 'x' gives z(col) = BASE + floor(col/W)*H, independent
// of row. At an interior riser (col = kW), Horn's dz/dx collapses (the
// row-weighted sums on the east and west columns are identical and cancel)
// to (z(c+1) - z(c-1)) / (2*cell). One cell before the riser (c = kW-1):
// z(c+1) = BASE+kH (first cell of the new tread), z(c-1) = BASE+(k-1)H
// (still the old tread, since W >= 2) -> dz/dx = H/2. One cell after the
// riser (c = kW) the SAME algebra gives H/2 again — the discrete jump of H
// spreads into a SYMMETRIC spike of H/(2·cell) on both flanking cells,
// instead of the tread's true 0 or a genuine infinity. That spike, and its
// exact size, is the "edge artifact" a step produces.

describe('Step edge — exact Horn slope/aspect spike flanking a single riser', () => {
  const EXTENT = { nx: 24, ny: 24, spacing: 1 } as const;
  const grid = gridFor(EXTENT);
  const BASE = 200;
  const H = 6; // step height
  const W = 12; // one riser at col 12 (steps: cols 0-11, cols 12-23)
  const ROW = 12; // interior row, clear of the raster's own border

  const pts = terrace({ ...EXTENT, base: BASE, stepHeight: H, stepWidthNodes: W, axis: 'x' });
  const raster = rasterizeDtm(pts, allGround(pts), { grid });
  const { slope, aspect } = hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
  const at = (col: number) => ROW * grid.cols + col;

  it('tread interiors read the true 0 slope, well clear of the riser', () => {
    expect(slope[at(5)]).toBeCloseTo(0, 5); // deep in the lower tread
    expect(slope[at(18)]).toBeCloseTo(0, 5); // deep in the upper tread
  });

  it('the two cells flanking the riser both read exactly H/2, not 0 and not infinity', () => {
    const expected = H / 2; // = 3
    expect(slope[at(11)], 'last cell of the lower tread').toBeCloseTo(expected, 4);
    expect(slope[at(12)], 'first cell of the upper tread').toBeCloseTo(expected, 4);
    // atan(3) ~= 71.6 deg -- a spurious near-cliff reading where the true
    // surface is two flat treads and one true step.
    expect(Math.atan(expected) * RAD).toBeGreaterThan(70);
  });

  it('the artifact does not smear past the immediately flanking cells', () => {
    expect(slope[at(10)]).toBeCloseTo(0, 5);
    expect(slope[at(13)]).toBeCloseTo(0, 5);
  });

  it('aspect at the flanking cells still reads the correct (west, downhill) direction', () => {
    // dz/dy = 0 (terrace is row-independent), dz/dx = +H/2 (rises east) ->
    // downhill west, same convention as the tilted-plane truth tests.
    for (const col of [11, 12]) {
      const deg = wrap360(aspect[at(col)] * RAD);
      expect(Math.abs(deg - 180), `aspect at col ${col}`).toBeLessThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Low outliers — ground labels AND the final DTM, across a real grid
// ═══════════════════════════════════════════════════════════════════════
//
// groundFilterDespike.test.ts already proves the floorPercentile mechanism
// on one artificially large cell holding every return; it checks only the
// internal `groundSurface` value, never a per-point `isGround` label, never
// a multi-cell grid, and never what rasterizeDtm does with the result. This
// closes those three gaps on a realistic scene: a 16x16 flat plane with two
// widely separated cells that each carry a genuine below-ground blunder.
//
// The classifier's actual contract (read from groundFilter.ts): a return is
// ground when `v - groundSurface[cell] <= tol`. That is a ONE-SIDED test —
// it rejects returns too far ABOVE the surface, but never rejects a return
// BELOW it. So the blunder itself is always accepted as "ground" by design;
// the hazard floorPercentile actually guards against is the mirror image —
// an unfiltered blunder drags `groundSurface` itself down to the blunder's
// depth (grayscale morphological opening removes peaks, not pits, so it
// does not self-correct), which then makes every GENUINE return in that
// cell read as "too far above" the crater and get wrongly rejected.

describe('Low outliers — a below-ground blunder corrupts ground labels, not because it is admitted but because real ground is evicted', () => {
  const EXTENT = { nx: 16, ny: 16, spacing: 1 } as const;
  const Z0 = 50;
  const BLUNDER_DEPTH = 50; // return sits 50 m below the true flat plane
  const PIT_NODES: Array<[number, number]> = [
    [4, 4],
    [11, 11],
  ];

  /** Flat plane plus, at each pit node, one duplicate clean return and one
   *  below-ground blunder (3 returns total in that cell -- >= 3 is the
   *  documented floor at which floorPercentile's despike guarantee kicks
   *  in; see groundFilter.ts's GUARANTEE comment). */
  function buildScene(): {
    points: TerrainPoint[];
    originalIdx: number[];
    dupIdx: number[];
    blunderIdx: number[];
  } {
    const points = flatPlane(Z0, EXTENT);
    const originalIdx = PIT_NODES.map(([i, j]) => j * EXTENT.nx + i);
    const dupIdx: number[] = [];
    const blunderIdx: number[] = [];
    for (const [i, j] of PIT_NODES) {
      dupIdx.push(points.length);
      points.push({ x: i, y: j, z: Z0 });
      blunderIdx.push(points.length);
      points.push({ x: i, y: j, z: Z0 - BLUNDER_DEPTH });
    }
    return { points, originalIdx, dupIdx, blunderIdx };
  }

  const PARAMS: GroundFilterParams = {
    cellSizeM: 1,
    maxWindowCells: 2,
    slope: 0.15,
    elevationThresholdM: 0.5,
    scalingFactorM: 0,
  };

  it('without despike (floorPercentile 0): the crater persists and evicts the real ground returns in that cell', () => {
    const { points, originalIdx, dupIdx, blunderIdx } = buildScene();
    const res = classifyGroundSmrf(points, { ...PARAMS, floorPercentile: 0 });
    for (const [k, [i, j]] of PIT_NODES.entries()) {
      const cell = j * res.cols + i;
      // Grayscale opening removes peaks, not pits: an isolated single-cell
      // low blunder survives the morphological pass at its own cell exactly
      // (see groundFilter.ts's LOW-OUTLIER DESPIKE doc), so the crater
      // reads the strict minimum untouched.
      expect(res.groundSurface[cell], `groundSurface pit ${k}`).toBeCloseTo(Z0 - BLUNDER_DEPTH, 5);
      // Both genuine returns are now ~50 m ABOVE the crater floor, far past
      // tol (0.5 m) -> wrongly rejected.
      expect(res.isGround[originalIdx[k]], `original return, pit ${k}`).toBe(0);
      expect(res.isGround[dupIdx[k]], `duplicate return, pit ${k}`).toBe(0);
      // The blunder itself sits exactly ON the (corrupted) surface -> kept.
      expect(res.isGround[blunderIdx[k]], `blunder itself, pit ${k}`).toBe(1);
    }
    // Control: a cell far from either pit is untouched.
    const farCell = 0 * res.cols + 0;
    expect(res.groundSurface[farCell]).toBeCloseTo(Z0, 5);
  });

  it('with despike (floorPercentile 10, n=3 >= the guarantee floor): the crater is ignored and every genuine return is kept', () => {
    const { points, originalIdx, dupIdx, blunderIdx } = buildScene();
    const res = classifyGroundSmrf(points, { ...PARAMS, floorPercentile: 10 });
    for (const [k, [i, j]] of PIT_NODES.entries()) {
      const cell = j * res.cols + i;
      expect(res.groundSurface[cell], `groundSurface pit ${k}`).toBeCloseTo(Z0, 5);
      expect(res.isGround[originalIdx[k]], `original return, pit ${k}`).toBe(1);
      expect(res.isGround[dupIdx[k]], `duplicate return, pit ${k}`).toBe(1);
      // The despike protects NEIGHBOURING real ground, not the blunder's
      // own elevation -- it is still a below-surface return, so it is still
      // accepted as ground by the one-sided tolerance test. That is the
      // documented contract, not a residual bug.
      expect(res.isGround[blunderIdx[k]], `blunder itself, pit ${k}`).toBe(1);
    }
  });

  it('DTM aggregation, not ground classification, is what protects the final elevation: median survives the blunder, mean does not', () => {
    // Use the FIXED classification (despike on) so every point at the pit
    // cell -- 2 clean + 1 blunder -- is offered to rasterizeDtm as ground.
    const { points } = buildScene();
    const res = classifyGroundSmrf(points, { ...PARAMS, floorPercentile: 10 });
    const grid = gridFor(EXTENT);

    const mean = rasterizeDtm(points, res.isGround, { grid, aggregation: 'mean' });
    const median = rasterizeDtm(points, res.isGround, { grid, aggregation: 'median' });

    for (const [i, j] of PIT_NODES) {
      const cell = j * grid.cols + i;
      // mean of [Z0, Z0, Z0-50] = Z0 - 50/3.
      expect(mean.z[cell]).toBeCloseTo(Z0 - BLUNDER_DEPTH / 3, 4);
      // type-7 median of 3 sorted values is the exact middle one: Z0.
      expect(median.z[cell]).toBeCloseTo(Z0, 5);
    }
    // Control cell: both aggregations agree away from the outliers.
    const controlCell = 0 * grid.cols + 0;
    expect(mean.z[controlCell]).toBeCloseTo(Z0, 5);
    expect(median.z[controlCell]).toBeCloseTo(Z0, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. No-data boundary — ground labels and the slope artifact it produces
// ═══════════════════════════════════════════════════════════════════════
//
// terrainTruth.dtm.test.ts already proves the DTM/no-data-handling columns
// for an edge-clipped FLAT plane. Neither ground labels nor slope near the
// boundary were checked anywhere, and only a tilted (non-degenerate) plane
// makes the slope artifact visible. The boundary is built by filtering
// uniformSlope's own output, not a new fixture.

describe('No-data boundary on a tilted plane — ground labels and the slope artifact it leaves behind', () => {
  const EXTENT = { nx: 24, ny: 24, spacing: 1 } as const;
  const grid = gridFor(EXTENT);
  const gradient = 0.4;
  const z0 = 10;
  const KEEP_COLS = 16; // columns 0..15 carry data; 16..23 do not
  const ROW = 12; // interior row

  const full = uniformSlope({ ...EXTENT, gradient, axis: 'x', z0 });
  const clipped = full.filter((p) => p.x < KEEP_COLS);

  it('ground labels: every covered return still classifies as ground (modest window)', () => {
    // ARCHITECTURE NOTE (found while deriving this, not assumed): unlike
    // rasterizeDtm, classifyGroundSmrf takes no caller-supplied grid — it
    // derives cols/rows from the offered points' own extent. Feeding it
    // only the covered subset therefore gives it a SELF-CONTAINED grid with
    // no empty cell at all: column 15 becomes its own right grid edge, not
    // a hole next to more data. There is no way, from the public API, to
    // hand the classifier a wider grid with a genuine no-data region beside
    // real data — that concept only exists at the rasterizeDtm layer (see
    // the slope test below, and terrainTruth.dtm.test.ts's edge-clipped
    // DTM cases, both of which DO pass an explicit wider grid). So what
    // this test actually verifies is exactness on that self-contained
    // grid's own edge, with a window modest enough to stay in the regime
    // this repo's own morphOpen is exact on.
    //
    // Confirmed exact by direct construction: for a monotonic ramp, opening
    // (min-filter then max-filter, both windowed and range-clamped at the
    // grid edge) reproduces the original value at every cell whenever
    // maxWindowCells stays low enough that the classifier's PROGRESSIVE
    // per-radius loop (groundFilter.ts: each radius reopens the running
    // "work" surface, not the original, so cuts can compound across radii)
    // never triggers a cut. Radii 1 and 2 verified analytically zero-cut
    // here; radius 3+ starts compounding near this same edge and is out of
    // scope for this exactness claim.
    const PARAMS: GroundFilterParams = {
      cellSizeM: 1,
      maxWindowCells: 2,
      slope: 0.2,
      elevationThresholdM: 0.5,
      scalingFactorM: 0,
    };
    const res = classifyGroundSmrf(clipped, PARAMS);
    expect(res.isGround.length).toBe(clipped.length);
    expect(Array.from(res.isGround).every((v) => v === 1)).toBe(true);
  });

  it('slope: the column immediately adjacent to the no-data edge reads HALF the true gradient', () => {
    // At col = KEEP_COLS-1 = 15 the east neighbours (col 16) are NaN in the
    // raw raster, so hornSlopeAspect's "non-finite neighbour -> centre
    // value" rule substitutes e = z(15) for all three east-column window
    // slots. The Horn numerator collapses to
    //   dz/dx = (4·z(15) - 4·z(14)) / (8·cell) = (z(15)-z(14))/2 = gradient/2
    // -- an artifact of the SAME shape as the true-grid-border halving
    // (terrainDerivatives.test.ts), but produced by a different mechanism
    // (degrade-to-centre on a hole, not perimeter extrapolation), and
    // located at an INTERIOR raster cell, two full columns before the
    // raster's own true border.
    const raster = rasterizeDtm(clipped, allGround(clipped), { grid });
    const { slope, aspect } = hornSlopeAspect(raster.z, grid.cols, grid.rows, grid.cellSizeM);
    const at = (col: number) => ROW * grid.cols + col;

    expect(slope[at(KEEP_COLS - 1)], 'boundary-adjacent column').toBeCloseTo(gradient / 2, 4);
    // Two columns in, both neighbours are still real data -> full recovery.
    expect(slope[at(KEEP_COLS - 2)], 'one column further in').toBeCloseTo(gradient, 4);

    // Direction survives the magnitude artifact at the boundary too.
    const degAtBoundary = wrap360(aspect[at(KEEP_COLS - 1)] * RAD);
    expect(Math.abs(degAtBoundary - 180)).toBeLessThanOrEqual(0.5);
  });
});
