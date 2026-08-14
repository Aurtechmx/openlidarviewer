/**
 * tests/volumeSyntheticTruth.test.ts
 *
 * SYNTHETIC KNOWN-TRUTH validation for the point-sample volume estimator
 * (`volumeCutFill`, src/render/measure/volume.ts) and the stockpile
 * estimator built on it (`stockpileVolume`, src/render/measure/
 * stockpileVolume.ts).
 *
 * Claims under test: VOL-POINT-SAMPLE, VOL-STOCKPILE.
 *
 * WHAT THIS FILE IS. Every scene below is an analytic solid whose volume
 * is known in closed form (V = A·h, ∫∫ s·x dA, L²H/3, πR²H/3), sampled by
 * a REGULAR cell-centre lattice — the ideal uniform-density cloud the
 * estimator's own docstring assumes. The assertions are the closed-form
 * numbers, not recorded outputs.
 *
 * WHAT THIS FILE IS NOT. Synthetic validation is not field validation.
 * A perfect lattice over an analytic solid removes exactly the things
 * that break real surveys — occlusion, scan-line correlation, registration
 * drift, ground/vegetation confusion, base-surface truth. Agreement here
 * bounds the ESTIMATOR's numerics; it says nothing about accuracy against
 * a surveyed stockpile. See the failure-mode section: the estimator is
 * numerically exact on scenes it is designed for and silently wrong by
 * tens of percent on scenes it is not, with no field in the result that
 * would let a caller tell the two apart.
 *
 * Sampling convention: cell CENTRES at x_i = (i + ½)·spacing. With a
 * spacing that is a negative power of two and a footprint whose corners
 * land on lattice boundaries, every sample coordinate is binary-exact in
 * Float32 and the lattice is exactly symmetric about the footprint
 * centre — so the sample mean of any LINEAR field equals its exact area
 * average, and linear scenes below are exact to float precision rather
 * than to a quadrature tolerance.
 *
 * Pure Node: no DOM, no three.js, no network.
 */

import { describe, test, expect } from 'vitest';
import { volumeCutFill } from '../src/render/measure/volume';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';
import type { Vec3 } from '../src/render/navMath';

const Z_UP: Vec3 = [0, 0, 1];

/** Cell-centre coordinates spanning [0, n·spacing]: (i + ½)·spacing. */
function centres(n: number, spacing: number, origin = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(origin + (i + 0.5) * spacing);
  return out;
}

/** Pack triples into the interleaved Float32Array the estimator takes. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

/** Sample z = f(x, y) on the cell-centre lattice of an [0,W]×[0,H] footprint. */
function lattice(
  nx: number,
  ny: number,
  spacing: number,
  f: (x: number, y: number) => number,
  originX = 0,
  originY = 0,
): Array<[number, number, number]> {
  const xs = centres(nx, spacing, originX);
  const ys = centres(ny, spacing, originY);
  const out: Array<[number, number, number]> = [];
  for (const x of xs) for (const y of ys) out.push([x, y, f(x, y)]);
  return out;
}

/** Axis-aligned rectangle footprint [0,w]×[0,h] as polygon vertices. */
function rect(w: number, h: number, x0 = 0, y0 = 0): Vec3[] {
  return [
    [x0, y0, 0],
    [x0 + w, y0, 0],
    [x0 + w, y0 + h, 0],
    [x0, y0 + h, 0],
  ];
}

/** Relative error helper — the assertion currency for the analytic scenes. */
function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

// ── VOL-POINT-SAMPLE — closed-form solids ───────────────────────────────────

describe('VOL-POINT-SAMPLE — prism over a non-rectangular footprint (V = A·h)', () => {
  // A right triangle footprint (legs 12 m and 8 m ⇒ A = 48 m²) carrying a
  // constant 2.5 m slab. Exact volume 48 × 2.5 = 120 m³. The existing
  // analytical fixtures only cover rectangles; the shoelace area and the
  // ray-cast inside test have to agree on a diagonal edge for this to land.
  const polygon: Vec3[] = [
    [0, 0, 0],
    [12, 0, 0],
    [0, 8, 0],
  ];
  const height = 2.5;
  const pts = lattice(96, 64, 0.125, () => height).filter(
    // Keep only samples strictly inside the triangle (y < 8 − (2/3)x), so the
    // count that normalises area-per-point is the triangle's, not the box's.
    ([x, y]) => y < 8 - (2 / 3) * x,
  );
  const res = volumeCutFill({ polygon, referenceZ: 0, up: Z_UP, positions: pack(pts) });

  test('footprint area is the exact shoelace triangle area', () => {
    // Exact rational area — the shoelace sum is a float sum of exact halves.
    expect(res.footprintArea).toBeCloseTo(48, 9);
  });

  test('fill equals A·h = 120 m³ (constant-height field ⇒ exact)', () => {
    // A constant field has zero quadrature error by construction: the
    // estimator is area × mean(Δz) and mean(Δz) ≡ h exactly. Tolerance is
    // pure Float32 storage of 2.5 (exact) and the area sum — 1e-9 relative.
    expect(relErr(res.fill, 120)).toBeLessThan(1e-9);
    expect(res.cut).toBe(0);
    expect(res.net).toBeCloseTo(120, 6);
  });
});

describe('VOL-POINT-SAMPLE — wedge under a tilted plane (∫∫ s·x dA)', () => {
  // z = s·x over a 10 m × 10 m footprint, s = 0.25 ⇒
  //   V = ∫₀¹⁰∫₀¹⁰ 0.25x dy dx = 10 · 0.25 · 50 = 125 m³.
  const s = 0.25;
  const pts = lattice(40, 40, 0.25, (x) => s * x);
  const res = volumeCutFill({
    polygon: rect(10, 10),
    referenceZ: 0,
    up: Z_UP,
    positions: pack(pts),
  });

  test('fill equals the exact wedge integral, 125 m³', () => {
    // A symmetric lattice reproduces the mean of a LINEAR field exactly
    // (mean x = 5 m to the last bit, every coordinate binary-exact), so the
    // estimator has no quadrature error here at all. Tolerance 1e-9 relative
    // covers only Float32 storage of the packed z values.
    expect(relErr(res.fill, 125)).toBeLessThan(1e-9);
    expect(res.cut).toBe(0);
    expect(res.pointsInPolygon).toBe(1600);
  });
});

describe('VOL-POINT-SAMPLE — tilted plane crossing the reference (analytic cut/fill split)', () => {
  // z = s·(x − 5) over [0,10]², s = 0.4. Above the plane only for x > 5:
  //   fill = ∫₅¹⁰∫₀¹⁰ 0.4(x−5) dy dx = 10 · 0.4 · 12.5 = 50 m³
  //   cut  = 50 m³ by symmetry, net = 0.
  const s = 0.4;
  const pts = lattice(40, 40, 0.25, (x) => s * (x - 5));
  const res = volumeCutFill({
    polygon: rect(10, 10),
    referenceZ: 0,
    up: Z_UP,
    positions: pack(pts),
  });

  test('fill and cut are each 50 m³ and the net cancels', () => {
    // The positive part of a linear field has a KINK at x = 5, so the lattice
    // mean is no longer exact — this is a midpoint rule across a corner, error
    // O(h²) with h = 0.25 m. Observed error is ~1e-3 relative; the 0.5 %
    // tolerance leaves headroom without hiding a real regression (a broken
    // area-per-point normalisation moves these by tens of percent).
    expect(relErr(res.fill, 50)).toBeLessThan(5e-3);
    expect(relErr(res.cut, 50)).toBeLessThan(5e-3);
    // Net is the difference of two symmetric errors ⇒ far tighter than each.
    expect(Math.abs(res.net)).toBeLessThan(0.05); // 0.1 % of either side
  });
});

describe('VOL-POINT-SAMPLE — square pyramid (V = L²H/3)', () => {
  // z = H·(1 − max(|u|,|v|)/(L/2)), u = x−5, v = y−5, L = 10, H = 3.
  // Analytic V = 100 · 3 / 3 = 100 m³.
  //
  // The lattice mean is also known in closed form. max(|u|,|v|) takes the
  // value m_k = 0.125 + 0.25k on 4(2k+1) cells (k = 0…19), so
  //   Σ = 4 Σ (2k+1)(0.125+0.25k) = 5330, mean = 5330/1600 = 3.33125
  // against the exact area mean 10/3 = 3.3333…, giving a lattice volume of
  //   100 · 3(1 − 3.33125/5) = 100.125 m³  (+0.125 % of the analytic answer).
  const L = 10;
  const H = 3;
  const pts = lattice(40, 40, 0.25, (x, y) => {
    const r = Math.max(Math.abs(x - 5), Math.abs(y - 5));
    return H * (1 - r / (L / 2));
  });
  const res = volumeCutFill({
    polygon: rect(L, L),
    referenceZ: 0,
    up: Z_UP,
    positions: pack(pts),
  });

  test('matches the hand-derived LATTICE volume 100.125 m³ to float precision', () => {
    // This is the estimator's exact arithmetic answer for this sample set —
    // no quadrature slack. 1e-6 relative is Float32 storage of the z field.
    expect(relErr(res.fill, 100.125)).toBeLessThan(1e-6);
  });

  test('matches the ANALYTIC pyramid volume 100 m³ within the midpoint-rule error', () => {
    // 0.2 % bounds the +0.125 % midpoint bias derived above with margin for
    // Float32 rounding, and is far below the ~1 % scale at which a genuine
    // integration bug would show.
    expect(relErr(res.fill, 100)).toBeLessThan(2e-3);
    expect(res.cut).toBe(0);
  });
});

describe('VOL-POINT-SAMPLE — right circular cone (V = πR²H/3)', () => {
  // z = max(0, H(1 − r/R)) with R = 5, H = 3 ⇒ V = π·25·3/3 = 25π ≈ 78.5398 m³.
  // Footprint: a 256-gon inscribed in the circle. Its shoelace area is
  // (n/2)R² sin(2π/n) = πR²·(1 − 3.1e-5), i.e. the polygon discretisation
  // costs 0.003 % — below the quadrature error and stated here rather than
  // absorbed silently.
  const R = 5;
  const H = 3;
  const N_GON = 256;
  const polygon: Vec3[] = [];
  for (let i = 0; i < N_GON; i++) {
    const t = (2 * Math.PI * i) / N_GON;
    polygon.push([R * Math.cos(t), R * Math.sin(t), 0]);
  }
  const pts = lattice(
    80,
    80,
    0.125,
    (x, y) => {
      const r = Math.hypot(x, y);
      return r >= R ? 0 : H * (1 - r / R);
    },
    -5,
    -5,
  );
  const res = volumeCutFill({ polygon, referenceZ: 0, up: Z_UP, positions: pack(pts) });

  test('polygon area is the inscribed 256-gon area, not πR²', () => {
    const gonArea = (N_GON / 2) * R * R * Math.sin((2 * Math.PI) / N_GON);
    expect(relErr(res.footprintArea, gonArea)).toBeLessThan(1e-9);
    expect(res.footprintArea).toBeLessThan(Math.PI * R * R); // inscribed ⇒ smaller
  });

  test('fill equals 25π m³ within the apex/rim quadrature error', () => {
    // Two O(h) error sources: the conical apex (a point kink) and the rim,
    // where lattice cells straddle the polygon edge. 1 % bounds both at
    // h = 0.125 m; observed error is well inside it. A cone is the harshest
    // shape here precisely because neither kink is grid-aligned.
    expect(relErr(res.fill, 25 * Math.PI)).toBeLessThan(1e-2);
    expect(res.cut).toBe(0);
  });
});

// ── VOL-POINT-SAMPLE — registered failure modes ─────────────────────────────
//
// Register: failureModes: ["density gradient", "missing footprint quadrant",
// "sloped/curved base"]. Each scene asserts the estimator's ACTUAL current
// behaviour, in closed form, and asserts that the result object exposes
// nothing that would let a caller detect the error.

describe('FAILURE MODE — density gradient biases the wedge by −30 %', () => {
  // Same wedge as above (true 125 m³), but sampled 4× denser on the LOW half.
  //   low half  x ∈ [0,5]  spacing 0.125 ⇒ 40 columns, mean x = 2.5
  //   high half x ∈ [5,10] spacing 0.5   ⇒ 10 columns, mean x = 7.5
  //   40 rows in y for both halves.
  // Sample mean x = (1600·2.5 + 400·7.5)/2000 = 3.5 ⇒ mean z = 0.875
  //   ⇒ reported volume = 100 · 0.875 = 87.5 m³ (true 125 m³, −30 %).
  const s = 0.25;
  // Both halves share one y lattice (40 rows) so the density ratio is purely
  // the x spacing: 0.125 m below x = 5, 0.5 m above it.
  const ys = centres(40, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(40, 0.125)) for (const y of ys) pts.push([x, y, s * x]);
  for (const x of centres(10, 0.5, 5)) for (const y of ys) pts.push([x, y, s * x]);
  const res = volumeCutFill({
    polygon: rect(10, 10),
    referenceZ: 0,
    up: Z_UP,
    positions: pack(pts),
  });

  test('reports 87.5 m³ against a true 125 m³ — exactly the hand-derived bias', () => {
    expect(res.pointsInPolygon).toBe(2000);
    expect(relErr(res.fill, 87.5)).toBeLessThan(1e-9);
    expect(res.fill / 125).toBeCloseTo(0.7, 9); // −30 %
  });

  test('the result exposes no signal of the gradient — one averaged density only', () => {
    // densityNative is a single footprint-wide average (2000/100 = 20 pts/m²),
    // identical to what a perfectly uniform 20 pts/m² cloud would report. The
    // 4:1 gradient that caused a 30 % error is invisible in the result object.
    expect(res.densityNative).toBeCloseTo(20, 9);
    expect(res.validity).toBe('ok');
    expect(res.skippedNonFinite).toBe(0);
    // No uncertainty field exists on VolumeResult at all — confirmed by shape.
    expect(Object.keys(res)).not.toContain('sigma');
  });
});

describe('FAILURE MODE — missing footprint quadrant invents material (+33 %)', () => {
  // A 10 m × 10 m footprint. Three quadrants carry a 2 m slab; the fourth is
  // genuinely EMPTY GROUND at the reference height — and is also unscanned,
  // so no sample reports its zero. True volume = 75 m² · 2 m = 150 m³.
  // The estimator normalises by points-inside, so it spreads the observed
  // 2 m thickness over the whole 100 m² footprint: 200 m³ (+33.3 %).
  const ys = centres(40, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(40, 0.25)) {
    for (const y of ys) {
      if (x > 5 && y > 5) continue; // unscanned, unbuilt quadrant
      pts.push([x, y, 2]);
    }
  }
  const res = volumeCutFill({
    polygon: rect(10, 10),
    referenceZ: 0,
    up: Z_UP,
    positions: pack(pts),
  });

  test('reports 200 m³ against a true 150 m³ — the exact 4/3 over-report', () => {
    expect(res.pointsInPolygon).toBe(1200);
    expect(relErr(res.fill, 200)).toBeLessThan(1e-9);
    expect(res.fill / 150).toBeCloseTo(4 / 3, 9);
  });

  test('coverage is reported as a scalar density that cannot express a hole', () => {
    // 1200/100 = 12 pts/m². A cloud with a quarter of its footprint missing is
    // indistinguishable here from an even cloud at 12 pts/m².
    expect(res.densityNative).toBeCloseTo(12, 9);
    expect(res.validity).toBe('ok');
  });
});

describe('FAILURE MODE — sloped base: net survives, cut/fill do not', () => {
  // A 0.2 m blanket of material lying on ground tilted at 0.5 m/m across a
  // 10 m × 10 m footprint: surface z = 0.5x + 0.2, true material 100·0.2 = 20 m³.
  // The estimator only accepts a HORIZONTAL reference. Take the best possible
  // one — the mean ground height, 2.5 m:
  //   g(x) = 0.5x − 2.3, positive for x > 4.6
  //   fill = 100 · (1/10)∫₄.₆¹⁰ (0.5x − 2.3) dx = 100 · 0.729 = 72.9 m³
  //   cut  = fill − 20 = 52.9 m³
  //   net  = 20 m³ exactly — the linear base averages out of the DIFFERENCE.
  const pts = lattice(40, 40, 0.25, (x) => 0.5 * x + 0.2);
  const res = volumeCutFill({
    polygon: rect(10, 10),
    referenceZ: 2.5,
    up: Z_UP,
    positions: pack(pts),
  });

  test('net is the true 20 m³ — the horizontal-base error cancels in the difference', () => {
    // Linear field, symmetric lattice ⇒ the net is exact to float precision.
    expect(relErr(res.net, 20)).toBeLessThan(1e-6);
  });

  test('fill alone over-reports the material by 3.6× (72.9 vs 20 m³)', () => {
    // fill/cut inherit the KINK at x = 4.6 (not on a lattice line), so this is
    // again a midpoint rule across a corner: 1 % tolerance at h = 0.25 m.
    expect(relErr(res.fill, 72.9)).toBeLessThan(1e-2);
    expect(relErr(res.cut, 52.9)).toBeLessThan(1e-2);
    expect(res.fill / 20).toBeGreaterThan(3);
  });

  test('nothing in the result says the base was wrong', () => {
    expect(res.validity).toBe('ok');
    expect(res.skippedNonFinite).toBe(0);
  });
});

// ── VOL-STOCKPILE — closed-form pile + band ─────────────────────────────────

describe('VOL-STOCKPILE — flat-topped pile on a flat apron, explicit base', () => {
  // Footprint 20 m × 20 m (400 m²). A 12 m × 12 m flat-topped pile 3 m high
  // sits at [4,16]²; the rest of the footprint is apron ground at z = 0.
  // Lattice: spacing 0.25 ⇒ 80 × 80 = 6400 samples, of which the pile holds
  // 48 × 48 = 2304 (exactly 36 % — the pile is 144/400 of the footprint).
  //
  // Closed form, base explicit at 0:
  //   volume   = 400 · 3 · 0.36                    = 432 m³   (= 144 · 3, exact)
  //   σ(thick) = 3·√(0.36·0.64)                    = 1.44 m
  //   sampling = 400 · 1.44 / √6400                = 7.2 m³
  //   base     = 0 (explicit) ⇒ σ = 7.2 m³, ±1.667 %
  const ys = centres(80, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(80, 0.25)) {
    for (const y of ys) {
      const onPile = x > 4 && x < 16 && y > 4 && y < 16;
      pts.push([x, y, onPile ? 3 : 0]);
    }
  }
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });

  test('volume is the exact 432 m³ (144 m² × 3 m)', () => {
    expect(res.breakdown.pointsInPolygon).toBe(6400);
    // Constant-per-region field on an exactly proportional lattice ⇒ no
    // quadrature error; 1e-6 relative is Float32 storage only.
    expect(relErr(res.volume, 432)).toBeLessThan(1e-6);
    expect(res.cut).toBe(0);
  });

  test('the band is the hand-derived 7.2 m³ 1σ, all of it sampling error', () => {
    expect(relErr(res.breakdown.thicknessStdDev, 1.44)).toBeLessThan(1e-6);
    expect(relErr(res.breakdown.samplingError, 7.2)).toBeLessThan(1e-6);
    expect(res.breakdown.basePlaneError).toBe(0); // explicit base ⇒ no base term
    expect(relErr(res.sigma, 7.2)).toBeLessThan(1e-6);
    expect(res.relativeError).toBeCloseTo(7.2 / 432, 9);
    expect(res.low).toBeCloseTo(432 - 7.2, 4);
    expect(res.high).toBeCloseTo(432 + 7.2, 4);
  });

  test('grades HIGH on this ideal scene, and still carries the standing caveats', () => {
    // 6400 pts ≥ 100, relErr 1.7 % ≤ 5 %, density 16 pts/m² ≥ 5, unit known.
    expect(res.confidence).toBe('high');
    expect(res.caveats.some((c) => c.includes('not a triangulated'))).toBe(true);
    expect(res.caveats.some((c) => c.includes('spatially independent'))).toBe(true);
  });
});

describe('VOL-STOCKPILE — inferred base recovers the same pile on flat ground', () => {
  // Same scene, but the base is INFERRED from the lowest 5 % of inside heights
  // instead of given. On a flat apron the 5th percentile is exactly 0 and both
  // base-uncertainty terms (ground scatter, systematic ground-mean bias)
  // vanish, so the inferred answer must equal the explicit one to the bit.
  const ys = centres(80, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(80, 0.25)) {
    for (const y of ys) {
      const onPile = x > 4 && x < 16 && y > 4 && y < 16;
      pts.push([x, y, onPile ? 3 : 0]);
    }
  }
  const res = stockpileVolume({ polygon: rect(20, 20), positions: pack(pts), up: Z_UP });

  test('base lands at 0 with zero uncertainty; volume is still 432 m³', () => {
    expect(res.breakdown.baseZ).toBeCloseTo(0, 9);
    expect(res.breakdown.baseUncertainty).toBeCloseTo(0, 9);
    expect(relErr(res.volume, 432)).toBeLessThan(1e-6);
    expect(relErr(res.sigma, 7.2)).toBeLessThan(1e-6);
  });

  test('inferring the base is disclosed even when it happens to be perfect', () => {
    expect(res.caveats.some((c) => c.includes('inferred from the lowest ground points'))).toBe(
      true,
    );
  });
});

describe('VOL-STOCKPILE — pyramidal pile against the analytic L²H/3', () => {
  // A square pyramid pile: base 12 m × 12 m, apex 4.5 m, on a 20 m × 20 m
  // footprint of flat apron. True material = 144 · 4.5 / 3 = 216 m³.
  const ys = centres(80, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(80, 0.25)) {
    for (const y of ys) {
      const r = Math.max(Math.abs(x - 10), Math.abs(y - 10));
      pts.push([x, y, r >= 6 ? 0 : 4.5 * (1 - r / 6)]);
    }
  }
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });

  test('volume matches 216 m³ within the midpoint-rule error', () => {
    // Same midpoint bias as the standalone pyramid (+0.1 % order, positive
    // because the L∞ cone is convex in the sampled direction); 0.5 % tolerance.
    expect(relErr(res.volume, 216)).toBeLessThan(5e-3);
  });

  test('the band is wider than the flat-top scene relative to a smaller volume', () => {
    // Thickness varies continuously here (σ ≈ 0.96 m against the flat top's
    // 1.44 m — a tapering pile actually has LESS spread than a two-level one),
    // but the same absolute sampling error now sits on a 216 m³ volume instead
    // of 432 m³, so the RELATIVE band is the wider figure. The honest reading
    // is that σ(thickness) tracks height dispersion, not pile complexity.
    expect(res.breakdown.thicknessStdDev).toBeGreaterThan(0.9);
    expect(res.relativeError).toBeGreaterThan(7.2 / 432);
  });
});

// ── VOL-STOCKPILE — registered failure modes ────────────────────────────────
//
// Register: failureModes: ["non-uniform density", "coverage gaps",
// "base-surface error"].

describe('FAILURE MODE — a coverage gap over-reports 25 % and still grades HIGH', () => {
  // The 432 m³ pile again, but a 4 m × 20 m strip of the footprint (x > 16) is
  // unscanned — 20 % of the area, containing NO pile. Remaining samples:
  //   N = 6400 − 16·80 = 5120, of which 2304 sit on the pile ⇒ 45 %.
  //   volume = 400 · 3 · 0.45 = 540 m³ against a true 432 m³ (+25 %).
  //   σ(thick) = 3√(0.45·0.55) = 1.492…, sampling = 400σ/√5120 ≈ 8.34 m³
  //   ⇒ relative error ≈ 1.5 %, density 12.8 pts/m² ⇒ graded HIGH.
  const ys = centres(80, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(80, 0.25)) {
    if (x > 16) continue; // unscanned strip
    for (const y of ys) {
      const onPile = x > 4 && x < 16 && y > 4 && y < 16;
      pts.push([x, y, onPile ? 3 : 0]);
    }
  }
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });
  const p = 2304 / 5120;
  const expectedSigma = (400 * 3 * Math.sqrt(p * (1 - p))) / Math.sqrt(5120);

  test('reports 540 m³ for a 432 m³ pile — the exact hand-derived +25 %', () => {
    expect(res.breakdown.pointsInPolygon).toBe(5120);
    expect(relErr(res.volume, 540)).toBeLessThan(1e-6);
    expect(res.volume / 432).toBeCloseTo(1.25, 6);
  });

  test('the ±band is ~1.5 % and the grade is HIGH — the band does not see the gap', () => {
    // This is the honest finding this scene exists to record: the uncertainty
    // model quantifies SAMPLING SCATTER and BASE HEIGHT, neither of which is
    // sensitive to where the samples are. A 25 % spatial bias passes through
    // untouched and the confidence tier rises rather than falls.
    expect(relErr(res.sigma, expectedSigma)).toBeLessThan(1e-6);
    expect(res.relativeError).toBeLessThan(0.02);
    expect(res.confidence).toBe('high');
    // The true 432 m³ lies BELOW the −1σ bound of the reported band: the
    // interval does not contain the answer and never had a mechanism to.
    expect(res.low).toBeGreaterThan(432);
  });
});

describe('FAILURE MODE — non-uniform density over-reports the pile by 43 %', () => {
  // The flat-topped 432 m³ pile again. A density gradient that is CORRELATED
  // with the geometry — 4× denser over the pile footprint [4,16] than over the
  // apron — is the realistic case (an operator walks the pile, not the yard).
  //   dense columns: 12 m at 0.0625 m ⇒ 192; sparse: 8 m at 0.25 m ⇒ 32
  //   rows: 80 at 0.25 m. N = 224 · 80 = 17 920.
  //   pile samples = 192 · 48 = 9 216 ⇒ fraction 0.514285…
  //   volume = 400 · 3 · 0.514285… = 617.142857… m³ (true 432 m³, +42.9 %).
  //
  // The contrast case is asserted below: a density gradient UNCORRELATED with
  // the geometry costs nothing. The estimator is biased by correlation between
  // density and thickness, not by non-uniformity as such.
  const ys = centres(80, 0.25);
  const xs = [...centres(16, 0.25), ...centres(192, 0.0625, 4), ...centres(16, 0.25, 16)];
  const pts: Array<[number, number, number]> = [];
  for (const x of xs) {
    for (const y of ys) {
      const onPile = x > 4 && x < 16 && y > 4 && y < 16;
      pts.push([x, y, onPile ? 3 : 0]);
    }
  }
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });

  test('reports 617.14 m³ for a 432 m³ pile — the exact hand-derived +42.9 %', () => {
    expect(res.breakdown.pointsInPolygon).toBe(17920);
    expect(relErr(res.volume, (400 * 3 * 9216) / 17920)).toBeLessThan(1e-6);
    expect(res.volume / 432).toBeGreaterThan(1.4);
  });

  test('the denser sample makes the band NARROWER while the error grows', () => {
    // More points ⇒ smaller σ/√N ⇒ a tighter interval around a more wrong
    // number. The reported density (44.8 pts/m²) is the very figure that earns
    // the HIGH grade, and no caveat mentions the gradient.
    expect(res.relativeError).toBeLessThan(0.01);
    expect(res.confidence).toBe('high');
    expect(res.caveats.some((c) => c.toLowerCase().includes('density'))).toBe(false);
    expect(res.low).toBeGreaterThan(432);
  });

  test('the same 4× gradient costs nothing when it is uncorrelated with the pile', () => {
    // Symmetric pyramidal pile (true 216 m³), 4× denser on x < 10. Because the
    // pile is symmetric about x = 10, over-weighting one half re-weights two
    // identical thickness distributions and the mean is unchanged.
    const pile = (x: number, y: number): number => {
      const r = Math.max(Math.abs(x - 10), Math.abs(y - 10));
      return r >= 6 ? 0 : 4.5 * (1 - r / 6);
    };
    const sym: Array<[number, number, number]> = [];
    for (const x of centres(160, 0.0625)) for (const y of ys) sym.push([x, y, pile(x, y)]);
    for (const x of centres(40, 0.25, 10)) for (const y of ys) sym.push([x, y, pile(x, y)]);
    const symRes = stockpileVolume({
      polygon: rect(20, 20),
      positions: pack(sym),
      up: Z_UP,
      base: { mode: 'explicit', z: 0 },
    });
    // Within the same 0.5 % midpoint-rule tolerance the uniform pyramid needed.
    expect(relErr(symRes.volume, 216)).toBeLessThan(5e-3);
  });
});

describe('FAILURE MODE — base-surface error on sloped ground widens the band, then over-reports anyway', () => {
  // The flat-topped 3 m pile, but the apron now slopes at 0.05 m/m across the
  // 20 m footprint (ground from 0 to 1 m, mean 0.5 m). The true material above
  // the LOCAL ground is unchanged: 144 m² × 3 m = 432 m³.
  // A single horizontal base inferred from the low percentile sits near the
  // downhill toe, so the whole uphill apron is counted as pile.
  const ys = centres(80, 0.25);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(80, 0.25)) {
    for (const y of ys) {
      const ground = 0.05 * x;
      const onPile = x > 4 && x < 16 && y > 4 && y < 16;
      pts.push([x, y, ground + (onPile ? 3 : 0)]);
    }
  }
  const res = stockpileVolume({ polygon: rect(20, 20), positions: pack(pts), up: Z_UP });

  test('the systematic base term fires — baseUncertainty is not the scatter', () => {
    // On sloped ground the ground band's MEAN sits above the low-percentile
    // base; that gap is the systematic term the module documents, and it must
    // dominate the (zero) scatter of a noiseless apron.
    expect(res.breakdown.baseUncertainty).toBeGreaterThan(0.05);
    expect(res.breakdown.basePlaneError).toBeGreaterThan(res.breakdown.samplingError);
  });

  test('the volume still over-reports, and the widened band is what discloses it', () => {
    expect(res.volume).toBeGreaterThan(432);
    // Honest reading: the band grew because the base is uncertain, and here it
    // is wide enough to reach the truth. That is the mechanism working — it is
    // NOT a guarantee, as the coverage-gap scene above shows.
    expect(res.low).toBeLessThan(res.volume);
    expect(res.confidence === 'medium' || res.confidence === 'low').toBe(true);
  });
});

describe('VOL-STOCKPILE — sparse footprint is refused a confident grade', () => {
  // 64 samples over 400 m² — below the MIN_RELIABLE_POINTS floor of 100.
  const ys = centres(8, 2.5);
  const pts: Array<[number, number, number]> = [];
  for (const x of centres(8, 2.5)) for (const y of ys) pts.push([x, y, 1]);
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });

  test('grades LOW and says how few points landed inside, whatever the band says', () => {
    expect(res.breakdown.pointsInPolygon).toBe(64);
    expect(res.confidence).toBe('low');
    expect(res.caveats.some((c) => c.includes('Only 64 points'))).toBe(true);
    // The band itself is misleadingly tight (a constant field has zero
    // thickness scatter ⇒ σ = 0); the point FLOOR, not the band, is what
    // catches this case.
    expect(res.sigma).toBeCloseTo(0, 9);
  });
});

describe('VOL-STOCKPILE — an empty footprint reports zeros, not a volume', () => {
  const pts: Array<[number, number, number]> = [
    [100, 100, 5],
    [101, 100, 5],
  ];
  const res = stockpileVolume({
    polygon: rect(20, 20),
    positions: pack(pts),
    up: Z_UP,
    base: { mode: 'explicit', z: 0 },
  });

  test('no inside points ⇒ zeroed result with the footprint area preserved', () => {
    expect(res.volume).toBe(0);
    expect(res.sigma).toBe(0);
    expect(res.breakdown.footprintArea).toBeCloseTo(400, 6);
    expect(res.caveats.some((c) => c.includes('No points fell inside'))).toBe(true);
  });
});
