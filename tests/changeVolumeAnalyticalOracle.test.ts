/**
 * changeVolumeAnalyticalOracle.test.ts
 *
 * CHANGE-VOLUME against a CLOSED-FORM oracle. Every expected number below is
 * an integral solved on paper over an analytic pair of surfaces; none of it is
 * the implementation's own arithmetic restated, so a test passing here says the
 * reported cut/fill agrees with the mathematics rather than with itself.
 *
 * The estimator under test is a cell-centre (midpoint) Riemann sum over the
 * DEM of difference: V = Σ (b − a)·cellArea, taken over cells whose |Δ| clears
 * the level of detection. Three properties of that rule carry the fixtures:
 *
 *   1. Midpoint quadrature is EXACT for any function linear in x and y (the
 *      odd part of a cell integrates to zero about the cell centre), so a pair
 *      of planes has a bit-exact answer: footprint area × separation.
 *   2. For a quadratic surface it is exact up to a defect that is itself
 *      closed-form. Over a footprint of side L at cell size s, the surface
 *      c + k(x² + y²) integrates to c·L² + k·L⁴/6, while the cell-centre sum
 *      returns c·L² + k(L⁴ − L²s²)/6. The difference, k·L²s²/6, is exact — not
 *      an error bound — which turns "the volume is about right" into an
 *      equality, and predicts that halving the cell size quarters the defect.
 *   3. A surface differenced against ITSELF has true volume exactly zero, so
 *      whatever comes back is pure numerical error and must be zero.
 *
 * The LoD threshold is part of the contract, not an inconvenience: the reported
 * volume is the analytic integral restricted to the above-LoD region, and the
 * fixtures state the excluded mass in closed form rather than tolerating it.
 *
 * Pure data. No DOM, no I/O, no randomness — every figure here is reproducible
 * to the digit.
 */

import { describe, it, expect } from 'vitest';
import { detectChange, type ChangeGrid } from '../src/terrain/change/changeDetection';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { compareDtms } from '../src/terrain/change/compareDtms';

/**
 * A grid sampling `f` at CELL CENTRES, with the footprint centred on the
 * origin. Centring is load-bearing for the symmetric fixtures: it is what makes
 * the odd terms of a tilted or saddle-shaped surface cancel exactly.
 */
function analyticGrid(
  cols: number,
  rows: number,
  cellSizeM: number,
  f: (x: number, y: number) => number,
): ChangeGrid {
  const spanX = cols * cellSizeM;
  const spanY = rows * cellSizeM;
  const values = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cellSizeM - spanX / 2;
      const y = (j + 0.5) * cellSizeM - spanY / 2;
      values[j * cols + i] = f(x, y);
    }
  }
  return { width: cols, height: rows, cellSizeM, values };
}

/** A flat reference epoch at height 0 — the datum every fixture measures from. */
const flat = (cols: number, rows: number, cellSizeM: number) =>
  analyticGrid(cols, rows, cellSizeM, () => 0);

/**
 * ── Fixture A. Two planes at a constant separation ─────────────────────────
 *
 * The one case with no discretisation error at all: the volume between two
 * parallel planes is footprint area × separation, and both factors are exactly
 * representable, so the answer is bit-exact rather than close.
 *
 *   40 × 25 cells at 2 m  →  80 m × 50 m = 4000 m² footprint
 *   separation 0.5 m      →  4000 × 0.5 = 2000 m³
 */
describe('Fixture A — parallel planes 0.5 m apart over 4000 m² (exactly 2000 m³)', () => {
  const CELLS_X = 40;
  const CELLS_Y = 25;
  const CELL_M = 2;
  const FOOTPRINT_M2 = CELLS_X * CELL_M * (CELLS_Y * CELL_M); // 4000
  const SEPARATION_M = 0.5;

  it('returns the area × separation product exactly, with every cell counted', () => {
    const before = analyticGrid(CELLS_X, CELLS_Y, CELL_M, () => 10);
    const after = analyticGrid(CELLS_X, CELLS_Y, CELL_M, () => 10 + SEPARATION_M);
    const { stats } = detectChange(before, after, { levelOfDetectionM: 0.1 });

    expect(stats.gainVolumeM3).toBe(FOOTPRINT_M2 * SEPARATION_M); // 2000, bit-exact
    expect(stats.lossVolumeM3).toBe(0);
    expect(stats.netVolumeM3).toBe(2000);
    expect(stats.gained).toBe(CELLS_X * CELLS_Y);
    expect(stats.lost).toBe(0);
  });

  it('is invariant to grid refinement: the same slab on a 1 m raster is the same 2000 m³', () => {
    // Same 80 m × 50 m footprint, four times as many cells, each a quarter the
    // area. A volume that moved here would mean the cell area and the cell
    // count are not each other's inverse.
    const before = analyticGrid(80, 50, 1, () => 10);
    const after = analyticGrid(80, 50, 1, () => 10 + SEPARATION_M);
    expect(detectChange(before, after, { levelOfDetectionM: 0.1 }).stats.gainVolumeM3).toBe(2000);
  });

  it('scales with cell AREA: doubling the cell size at fixed dimensions quadruples the volume', () => {
    // 40 × 25 cells at 4 m spans 160 m × 100 m = 16000 m²; × 0.5 m = 8000 m³.
    // A linear (rather than squared) area would return 4000.
    const before = analyticGrid(CELLS_X, CELLS_Y, 4, () => 10);
    const after = analyticGrid(CELLS_X, CELLS_Y, 4, () => 10 + SEPARATION_M);
    expect(detectChange(before, after, { levelOfDetectionM: 0.1 }).stats.gainVolumeM3).toBe(8000);
  });

  it('scales linearly with separation: doubling the gap doubles the volume', () => {
    const before = analyticGrid(CELLS_X, CELLS_Y, CELL_M, () => 10);
    const after = analyticGrid(CELLS_X, CELLS_Y, CELL_M, () => 11);
    expect(detectChange(before, after, { levelOfDetectionM: 0.1 }).stats.gainVolumeM3).toBe(4000);
  });
});

/**
 * ── Fixture B. A tilted plane against a flat one ───────────────────────────
 *
 * Midpoint quadrature is exact for a linear surface, so tilting the upper plane
 * about the footprint centroid moves not one cubic metre: ∫∫ (c + αx) dA over a
 * footprint symmetric in x is c·A, whatever α is. The tilt is chosen so the
 * thinnest edge (0.5 − 0.005 × 40 = 0.3 m) still clears the 0.1 m LoD, keeping
 * every cell in the integral.
 */
describe('Fixture B — tilt about the centroid leaves the volume at 2000 m³', () => {
  it('matches the flat-slab answer for a plane tilted 0.5 % across the footprint', () => {
    const before = flat(40, 25, 2);
    const after = analyticGrid(40, 25, 2, (x) => 0.5 + 0.005 * x);
    const { stats } = detectChange(before, after, { levelOfDetectionM: 0.1 });

    // Float32 grid storage is the only error source; the quadrature has none.
    expect(stats.gainVolumeM3).toBeCloseTo(2000, 4);
    expect(Math.abs(stats.gainVolumeM3 - 2000) / 2000).toBeLessThan(1e-6);
    expect(stats.gained).toBe(1000);
    expect(stats.lost).toBe(0);
  });
});

/**
 * ── Fixture C. A quadratic dome against a plane ────────────────────────────
 *
 * Surface: b − a = c + k(x² + y²) over a square footprint of side L, centred.
 *
 *   true volume     V  = c·L² + k·L⁴/6
 *   cell-centre sum Vₛ = c·L² + k·(L⁴ − L²s²)/6
 *   quadrature defect  = V − Vₛ = k·L²s²/6      (exact, not a bound)
 *
 * With c = 1 m, k = 0.01 m⁻¹, L = 32 m:
 *   V  = 1024 + 1747.626666… = 2771.626666… m³
 *   Vₛ(s = 0.5 m) = 2771.2 m³, defect 0.426666… m³ (0.0154 % low)
 *
 * The offset c keeps the shallowest point (1 m at the apex of the bowl) well
 * clear of the LoD so the integral runs over the whole footprint.
 */
describe('Fixture C — quadratic dome: the estimator equals the closed-form midpoint sum', () => {
  const L = 32;
  const C = 1.0;
  const K = 0.01;
  const trueVolume = C * L * L + (K * L ** 4) / 6; // 2771.62666…
  const midpointVolume = (s: number) => C * L * L + (K * (L ** 4 - L * L * s * s)) / 6;
  const defect = (s: number) => (K * L * L * s * s) / 6;

  const domeVolume = (s: number) => {
    const n = Math.round(L / s);
    const before = flat(n, n, s);
    const after = analyticGrid(n, n, s, (x, y) => C + K * (x * x + y * y));
    return detectChange(before, after, { levelOfDetectionM: 0.1 }).stats.gainVolumeM3;
  };

  it('reproduces the closed-form cell-centre sum at 0.5 m to nine significant figures', () => {
    const got = domeVolume(0.5);
    expect(midpointVolume(0.5)).toBeCloseTo(2771.2, 9); // the hand-solved value
    expect(Math.abs(got - midpointVolume(0.5)) / midpointVolume(0.5)).toBeLessThan(1e-8);
  });

  it('sits BELOW the true integral by exactly the analytic quadrature defect', () => {
    // A midpoint sum under-reads a convex surface, and by a known amount:
    // 0.01 × 32² × 0.5² / 6 = 0.426666… m³ out of 2771.6 m³.
    const got = domeVolume(0.5);
    expect(got).toBeLessThan(trueVolume);
    expect(trueVolume - got).toBeCloseTo(defect(0.5), 4);
    expect(defect(0.5)).toBeCloseTo(0.4266666667, 9);
  });

  it('quarters that defect when the cell size is halved (the s² convergence law)', () => {
    // The defect is k·L²s²/6, so it is second order in the cell size: the
    // 1 m → 0.5 m → 0.25 m ladder must fall 4× at each step. A first-order
    // (or zeroth-order) integration rule cannot produce this ratio.
    const coarse = trueVolume - domeVolume(1);
    const medium = trueVolume - domeVolume(0.5);
    const fine = trueVolume - domeVolume(0.25);

    expect(coarse).toBeCloseTo(defect(1), 4); // 1.706666… m³
    expect(medium).toBeCloseTo(defect(0.5), 4); // 0.426666… m³
    expect(fine).toBeCloseTo(defect(0.25), 4); // 0.106666… m³
    expect(coarse / medium).toBeCloseTo(4, 3);
    expect(medium / fine).toBeCloseTo(4, 3);
  });
});

/**
 * ── Fixture D. A cone against a plane ──────────────────────────────────────
 *
 * z = H(1 − r/R) inside r < R, flat outside — the textbook stockpile. Its
 * volume is πR²H/3, and with R = 20 m, H = 5 m that is 2094.3951… m³. The
 * footprint is circular, so the raster cannot follow the boundary; the cone
 * vanishes there, which is why the discretisation costs so little.
 */
describe('Fixture D — cone of radius 20 m, height 5 m (πR²H/3 = 2094.395 m³)', () => {
  const R = 20;
  const H = 5;
  const cone = (s: number, lod: number) => {
    const span = 2 * R + 4; // a margin of flat ground all round
    const n = Math.round(span / s);
    const before = flat(n, n, s);
    const after = analyticGrid(n, n, s, (x, y) => {
      const r = Math.hypot(x, y);
      return r < R ? H * (1 - r / R) : 0;
    });
    return detectChange(before, after, { levelOfDetectionM: lod }).stats.gainVolumeM3;
  };

  it('converges on the closed-form cone volume, and refining the raster improves it', () => {
    const exact = (Math.PI * R * R * H) / 3;
    expect(exact).toBeCloseTo(2094.3951024, 6);

    const coarse = cone(1, 0);
    const fine = cone(0.25, 0);
    expect(Math.abs(coarse - exact) / exact).toBeLessThan(1e-4); // 0.0017 %
    expect(Math.abs(fine - exact) / exact).toBeLessThan(1e-5); // 0.000025 %
    expect(Math.abs(fine - exact)).toBeLessThan(Math.abs(coarse - exact));
  });

  it('under a 0.1 m LoD returns the TRUNCATED cone, itself closed-form', () => {
    // The LoD excises the rim where the cone is shallower than 0.1 m, i.e.
    // everything beyond r₀ = R(1 − LoD/H) = 19.6 m. What remains integrates to
    //   2πH(r₀²/2 − r₀³/3R) = 2091.915… m³,
    // 2.48 m³ (0.12 %) below the full cone. The reported volume tracks the
    // truncated integral, not the full one — the threshold is a real bias, and
    // the fixture names its size instead of absorbing it into a tolerance.
    const lod = 0.1;
    const r0 = R * (1 - lod / H);
    const truncated = 2 * Math.PI * H * ((r0 * r0) / 2 - (r0 * r0 * r0) / (3 * R));
    const full = (Math.PI * R * R * H) / 3;

    expect(truncated).toBeCloseTo(2091.9153386, 6);
    expect(full - truncated).toBeCloseTo(2.4797638, 6);

    const got = cone(0.5, lod);
    expect(Math.abs(got - truncated) / truncated).toBeLessThan(1e-4);
    expect(got).toBeLessThan(full);
  });
});

/**
 * ── Fixture E. A saddle, where the true net change is zero by symmetry ─────
 *
 * b − a = γ·x·y is bilinear, so midpoint quadrature integrates it exactly, and
 * over a footprint symmetric in both axes the four lobes cancel: the net volume
 * is exactly zero while gain and loss are each large. A sign error anywhere in
 * the accumulation shows up here as a net that is not zero.
 */
describe('Fixture E — saddle: gain and loss cancel to a net of zero', () => {
  it('reports equal gain and loss counts and a net indistinguishable from zero', () => {
    const before = flat(40, 40, 1);
    const after = analyticGrid(40, 40, 1, (x, y) => 0.002 * x * y);
    const { stats } = detectChange(before, after, { levelOfDetectionM: 0.1 });

    expect(stats.gained).toBe(stats.lost);
    expect(stats.gained).toBeGreaterThan(400); // the fixture is not trivially empty
    expect(stats.gainVolumeM3).toBeGreaterThan(100);
    expect(stats.netVolumeM3).toBeCloseTo(0, 9);
    expect(Math.abs(stats.netVolumeM3)).toBeLessThan(stats.gainVolumeM3 * 1e-9);
  });
});

/**
 * ── Fixture F. A surface against itself ────────────────────────────────────
 *
 * The strictest oracle available: the true answer is exactly zero, so anything
 * non-zero is numerical error with nothing to hide behind.
 */
describe('Fixture F — a surface differenced against itself is exactly zero', () => {
  it('yields zero volume, zero changed cells, and a difference grid of exact zeros', () => {
    const rough = (x: number, y: number) =>
      12 + 3 * Math.sin(x / 7) + 2 * Math.cos(y / 5) + 0.4 * x - 0.17 * y;
    const before = analyticGrid(32, 32, 1.5, rough);
    const after = analyticGrid(32, 32, 1.5, rough);
    const result = detectChange(before, after, { levelOfDetectionM: 0.1 });

    expect(result.stats.gainVolumeM3).toBe(0);
    expect(result.stats.lossVolumeM3).toBe(0);
    expect(result.stats.netVolumeM3).toBe(0);
    expect(result.stats.gained).toBe(0);
    expect(result.stats.lost).toBe(0);
    expect(result.stats.unchanged).toBe(32 * 32);
    expect(result.stats.meanAbsChangeM).toBe(0);
    for (let i = 0; i < result.diff.length; i++) expect(result.diff[i]).toBe(0);
  });
});

/**
 * ── Fixture G. The same physical slab described in feet ────────────────────
 *
 * A volume is a physical quantity, so restating the geometry in another linear
 * unit may not change it. The cell AREA converts by the square of the unit
 * factor while the height converts by the factor itself, and the fixture is
 * built so a missing square (or a missing height conversion) lands far from
 * 2000 m³ rather than near it.
 */
describe('Fixture G — a foot-unit grid gives the same 2000 m³ as the metre grid', () => {
  it('converts cell area by the square of the unit factor and height by the factor', () => {
    const FT = 0.3048;
    const cellFt = 2 / FT; // a 2 m cell expressed in feet
    const riseFt = 0.5 / FT; // a 0.5 m lift expressed in feet
    const before = analyticGrid(40, 25, cellFt, () => 10);
    const after = analyticGrid(40, 25, cellFt, () => 10 + riseFt);
    const { stats } = detectChange(before, after, {
      levelOfDetectionM: 0.1,
      horizontalUnitToMetres: FT,
    });

    expect(stats.gainVolumeM3).toBeCloseTo(2000, 3);
    expect(Math.abs(stats.gainVolumeM3 - 2000) / 2000).toBeLessThan(1e-6);
    expect(stats.gained).toBe(1000); // the LoD is metres, so every cell still clears it
  });
});

/**
 * ── Fixture H. What the level of detection removes ─────────────────────────
 *
 * Half the footprint rises 0.5 m, half rises 0.05 m under a 0.1 m LoD. The
 * reported volume is the integral over the above-LoD half ALONE — deliberate,
 * per the module's honesty contract — and the excluded mass is exactly the
 * sub-LoD half. Stating both numbers is the point: the reported figure is a
 * lower bound on the true surface-to-surface volume, by a knowable amount.
 */
describe('Fixture H — the LoD truncation is a closed-form under-report', () => {
  it('integrates the above-LoD half exactly and drops the sub-LoD half entirely', () => {
    const cols = 40;
    const rows = 20;
    const before = flat(cols, rows, 1);
    const values = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) values[j * cols + i] = j < rows / 2 ? 0.05 : 0.5;
    }
    const after: ChangeGrid = { width: cols, height: rows, cellSizeM: 1, values };
    const { stats } = detectChange(before, after, { levelOfDetectionM: 0.1 });

    // 400 cells × 1 m² × 0.5 m = 200 m³, bit-exact.
    expect(stats.gainVolumeM3).toBe(200);
    expect(stats.gained).toBe(400);
    // The other 400 cells are classified unchanged, withholding 400 × 0.05 = 20 m³
    // — the true surface-to-surface volume is 220 m³, and the reported 200 m³ is
    // 9.09 % low by construction.
    expect(stats.unchanged).toBe(400);
    const excluded = 400 * 1 * 0.05;
    expect(excluded).toBe(20);
    expect(excluded / (stats.gainVolumeM3 + excluded)).toBeCloseTo(0.0909090909, 9);
  });
});

/**
 * ── Fixture I. Cut and fill side by side ───────────────────────────────────
 *
 * Left half up 0.5 m, right half down 0.25 m, both exactly representable, so
 * gain, loss and net are all bit-exact and the net = gain − loss identity is
 * checked on numbers with no rounding in them.
 */
describe('Fixture I — a cut/fill step: 200 m³ gained, 100 m³ lost, 100 m³ net', () => {
  it('separates gain from loss and nets them exactly', () => {
    const cols = 40;
    const rows = 20;
    const before = flat(cols, rows, 1);
    const values = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) values[j * cols + i] = i < cols / 2 ? 0.5 : -0.25;
    }
    const after: ChangeGrid = { width: cols, height: rows, cellSizeM: 1, values };
    const { stats } = detectChange(before, after, { levelOfDetectionM: 0.1 });

    expect(stats.gainVolumeM3).toBe(200); // 400 × 1 × 0.5
    expect(stats.lossVolumeM3).toBe(100); // 400 × 1 × 0.25, reported positive
    expect(stats.netVolumeM3).toBe(100);
    expect(stats.netVolumeM3).toBe(stats.gainVolumeM3 - stats.lossVolumeM3);
    expect(stats.maxGainM).toBe(0.5);
    expect(stats.maxLossM).toBe(-0.25);
  });
});

/**
 * ── Fixture J. The same oracle through the shipping entry point ────────────
 *
 * `compareDtms` is what the application calls. The closed-form answer has to
 * survive the DtmGrid → ChangeGrid adaptation and the co-registration check,
 * or the number verified above is not the number a user sees.
 */
describe('Fixture J — the closed form survives the compareDtms bridge', () => {
  const dtm = (cols: number, rows: number, height: number): DtmGrid => {
    const n = cols * rows;
    return {
      z: new Float32Array(n).fill(height),
      confidence: new Float32Array(n).fill(100),
      coverage: new Uint8Array(n).fill(1),
      counts: new Uint32Array(n).fill(1),
      interpDistanceCells: new Float32Array(n),
      cols,
      rows,
      cellSizeM: 2,
      originH1: 0,
      originH2: 0,
      crs: 'EPSG:32612',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      sourcePointCount: n,
      analyzedPointCount: n,
      meanConfidence: 100,
      warnings: [],
    };
  };

  it('reports 2000 m³ for the parallel-plane pair and co-registers cleanly', () => {
    const cmp = compareDtms(dtm(40, 25, 10), dtm(40, 25, 10.5), { levelOfDetectionM: 0.1 });
    expect(cmp.coregistered).toBe(true);
    expect(cmp.result.stats.gainVolumeM3).toBe(2000);
    expect(cmp.result.stats.netVolumeM3).toBe(2000);
  });
});
