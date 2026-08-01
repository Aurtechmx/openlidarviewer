/**
 * terrainDerivatives.test.ts — Horn slope/aspect.
 */

import { describe, it, expect } from 'vitest';
import {
  hornSlopeAspect,
  hornSlope,
  synthesisedNeighbourMask,
  countSynthesisedNeighbours,
} from '../src/terrain/ground/terrainDerivatives';

describe('hornSlopeAspect', () => {
  it('is ~0 on a flat surface', () => {
    const z = new Float32Array(9).fill(10);
    const { slope } = hornSlopeAspect(z, 3, 3, 1);
    for (const s of slope) expect(s).toBeCloseTo(0, 6);
  });

  it('recovers a known constant gradient (plane tilted along +x)', () => {
    // z = 2*x over a 3x3 grid, cell size 1 → dz/dx = 2, slope = 2.
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c;
    const { slope } = hornSlopeAspect(z, 3, 3, 1);
    expect(slope[4]).toBeCloseTo(2, 5); // centre cell
  });

  it('scales slope with cell size', () => {
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c;
    expect(hornSlope(z, 3, 3, 2)[4]).toBeCloseTo(1, 5); // half the slope at 2 m cells
  });

  it('zScale converts a native-unit rise so a foot-CRS grid reports the true slope', () => {
    // A plane rising 1 unit per 1 cell of X. If the cell size is expressed in
    // METRES but the rise is in FEET (a state-plane-feet DTM), the raw ratio is
    // feet/metre and reads 1/0.3048 ≈ 3.28× too steep. zScale = 0.3048 (feet→m)
    // restores the true slope. aspect is a direction and must be untouched.
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = c; // rise 1 per cell
    const cellMetres = 1;
    const native = hornSlope(z, 3, 3, cellMetres)[4]; // feet-over-metre, uncorrected
    expect(native).toBeCloseTo(1, 5);
    const feetToM = 0.3048;
    const corrected = hornSlopeAspect(z, 3, 3, cellMetres, cellMetres, feetToM);
    expect(corrected.slope[4]).toBeCloseTo(feetToM, 5); // true rise/run
    // aspect (downslope, +x rise ⇒ points −x ⇒ math angle π) is unchanged by zScale.
    const unscaled = hornSlopeAspect(z, 3, 3, cellMetres, cellMetres, 1);
    expect(corrected.aspect[4]).toBeCloseTo(unscaled.aspect[4], 6);
  });

  it('is isotropic: a diagonal ramp reads the same magnitude as an axis ramp', () => {
    const axis = new Float32Array(9);
    const diag = new Float32Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        axis[r * 3 + c] = c; // slope 1 along x
        diag[r * 3 + c] = (r + c) / Math.SQRT2; // slope 1 along the diagonal
      }
    expect(hornSlope(diag, 3, 3, 1)[4]).toBeCloseTo(hornSlope(axis, 3, 3, 1)[4], 5);
  });

  it('per-axis cell metres: a +x ramp scales with X only, a +y ramp with Y only', () => {
    const xRamp = new Float32Array(9);
    const yRamp = new Float32Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        xRamp[r * 3 + c] = 2 * c; // gradient 2 along east–west
        yRamp[r * 3 + c] = 2 * r; // gradient 2 along north–south
      }
    // dz/dx = 2 / cellMetresX — the Y metres are irrelevant for a pure x-ramp.
    expect(hornSlope(xRamp, 3, 3, 2, 99)[4]).toBeCloseTo(1, 5);
    expect(hornSlope(xRamp, 3, 3, 1, 99)[4]).toBeCloseTo(2, 5);
    // dz/dy = 2 / cellMetresY — the X metres are irrelevant for a pure y-ramp.
    expect(hornSlope(yRamp, 3, 3, 99, 2)[4]).toBeCloseTo(1, 5);
    expect(hornSlope(yRamp, 3, 3, 99, 1)[4]).toBeCloseTo(2, 5);
  });

  it('defaults cellMetresY to cellMetresX (backward compatible with the scalar form)', () => {
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c + r;
    const scalar = hornSlopeAspect(z, 3, 3, 2);
    const explicit = hornSlopeAspect(z, 3, 3, 2, 2);
    expect(Array.from(scalar.slope)).toEqual(Array.from(explicit.slope));
    expect(Array.from(scalar.aspect)).toEqual(Array.from(explicit.aspect));
  });
});

// ── Border policy ───────────────────────────────────────────────────────────
//
// The kernel extrapolates a virtual neighbour (2a − b) PERPENDICULAR to an edge
// and CLAMPS ALONG it — gdaldem's `-compute_edges` policy. Before this, every
// border cell clamped on both axes, which left the rise across the Horn window
// unchanged while halving the run, so the whole outer ring read roughly HALF its
// true slope. tests/rasterAgreementMatrix.test.ts measures that against GDAL;
// these are the same contract stated on grids small enough to compute by hand,
// plus the cases the matrix has no fixture for (thin grids, holes at the edge).
describe('hornSlopeAspect — border cells extrapolate instead of clamping', () => {
  /** z = 2·c on a 5x5 unit grid: a plane of slope 2 along +x, flat along y. */
  const xPlane = () => {
    const z = new Float32Array(25);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) z[r * 5 + c] = 2 * c;
    return z;
  };
  /** z = 2·r: slope 2 along +y, flat along x. */
  const yPlane = () => {
    const z = new Float32Array(25);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) z[r * 5 + c] = 2 * r;
    return z;
  };
  const at = (a: Float32Array, r: number, c: number) => a[r * 5 + c];

  it('a border cell on a plane now reports the SAME slope as the interior', () => {
    // The regression this guards: each of these read 1 instead of 2.
    const { slope } = hornSlopeAspect(xPlane(), 5, 5, 1);
    expect(at(slope, 2, 2), 'interior').toBeCloseTo(2, 5);
    expect(at(slope, 2, 0), 'west edge, gradient runs across it').toBeCloseTo(2, 5);
    expect(at(slope, 2, 4), 'east edge').toBeCloseTo(2, 5);
    // The north and south rows never lost anything on an x-plane — their east and
    // west neighbours are real cells — so they are the control.
    expect(at(slope, 0, 2), 'north row, control').toBeCloseTo(2, 5);
    expect(at(slope, 4, 2), 'south row, control').toBeCloseTo(2, 5);
  });

  it('keeps gdaldem\'s corner asymmetry: the ALONG-edge axis is still clamped', () => {
    // Deliberate, and the reason is interop rather than accuracy. gdaldem's
    // first/last-line branch extrapolates the outside ROW but takes `jmin = j` at
    // j = 0, so at a corner the column axis is replicated and a gradient running
    // along that axis is halved. Reproducing it buys cell-exact agreement with
    // the reference on the whole ring; extrapolating symmetrically would be the
    // better estimator here but would diverge from gdaldem by up to 12.7 deg at
    // these four cells. If that trade is ever revisited, this is the test to
    // change — and the border legs in the agreement matrix will move with it.
    const xs = hornSlopeAspect(xPlane(), 5, 5, 1).slope;
    for (const [r, c] of [[0, 0], [0, 4], [4, 0], [4, 4]] as const) {
      expect(at(xs, r, c), `corner (${r},${c}), x-gradient clamped along the edge`).toBeCloseTo(1, 5);
    }
    // Perpendicular to the edge the corner is fully extrapolated, so a y-gradient
    // is recovered at the very same cells. The asymmetry is per-axis, not a
    // blanket corner penalty.
    const ys = hornSlopeAspect(yPlane(), 5, 5, 1).slope;
    for (const [r, c] of [[0, 0], [0, 4], [4, 0], [4, 4]] as const) {
      expect(at(ys, r, c), `corner (${r},${c}), y-gradient extrapolated`).toBeCloseTo(2, 5);
    }
  });

  it('a grid too thin to extrapolate falls back to clamping, still finite', () => {
    // Extrapolation needs two cells along the axis. gdaldem guards the same way
    // (nXSize >= 2 && nYSize >= 2); below that there is no inward neighbour to
    // reflect through, so the axis clamps and no NaN escapes.
    const allFinite = (a: Float32Array) => Array.from(a).every((v) => Number.isFinite(v));
    const row = new Float32Array([0, 2, 4, 6]); // 4x1 — one row, gradient along x
    const rowOut = hornSlopeAspect(row, 4, 1, 1);
    expect(allFinite(rowOut.slope) && allFinite(rowOut.aspect)).toBe(true);
    expect(rowOut.slope[1], 'interior of a single row still differentiates').toBeCloseTo(2, 5);

    const col = new Float32Array([0, 2, 4, 6]); // 1x4 — one column, gradient along y
    const colOut = hornSlopeAspect(col, 1, 4, 1);
    expect(allFinite(colOut.slope) && allFinite(colOut.aspect)).toBe(true);
    expect(colOut.slope[1], 'interior of a single column still differentiates').toBeCloseTo(2, 5);

    const one = hornSlopeAspect(new Float32Array([7]), 1, 1, 1);
    expect(Array.from(one.slope)).toEqual([0]); // nothing to differentiate
    expect(Array.from(one.aspect)).toEqual([0]);
  });

  it('a hole in the inward cell degrades the extrapolation to a clamp, never to NaN', () => {
    // The finiteness contract is unchanged: finite wherever the centre is finite.
    // An extrapolation needs BOTH operands, so a missing inward neighbour falls
    // back to the edge value — the old clamp — rather than extrapolating off a
    // substituted centre, which would throw the border further than clamping did.
    const z = xPlane();
    z[2 * 5 + 1] = Number.NaN; // the inward neighbour of the west-edge cell (2,0)
    const { slope, aspect } = hornSlopeAspect(z, 5, 5, 1);
    expect(Array.from(slope).every((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(aspect).every((v) => Number.isFinite(v))).toBe(true);
    // Hand-computed: the two flanking rows still extrapolate to ±2 while the
    // holed middle row contributes a clamped 0, giving dz/dx = 1 and dz/dy = 0.
    expect(at(slope, 2, 0)).toBeCloseTo(1, 5);
    // The cell whose own centre is the hole reports nothing, as before.
    expect(at(slope, 2, 1)).toBe(0);
  });

  it('leaves every interior cell byte-identical to the pre-change kernel', () => {
    // The fix was scoped to out-of-grid reads. An interior 3x3 window contains no
    // such read, so a change visible here would mean the edit leaked inward —
    // which is what the agreement matrix's separate interior leg also watches.
    const z = new Float32Array(49);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) z[r * 7 + c] = Math.sin(r * 0.6) * 3 + c * c * 0.25;
    const { slope } = hornSlopeAspect(z, 7, 7, 1.5);
    // Recomputed directly from the Horn formula on the real neighbours.
    for (let r = 1; r < 6; r++) {
      for (let c = 1; c < 6; c++) {
        const v = (rr: number, cc: number) => z[rr * 7 + cc];
        const dzdx = (v(r - 1, c + 1) + 2 * v(r, c + 1) + v(r + 1, c + 1)
          - (v(r - 1, c - 1) + 2 * v(r, c - 1) + v(r + 1, c - 1))) / (8 * 1.5);
        const dzdy = (v(r + 1, c - 1) + 2 * v(r + 1, c) + v(r + 1, c + 1)
          - (v(r - 1, c - 1) + 2 * v(r - 1, c) + v(r - 1, c + 1))) / (8 * 1.5);
        expect(slope[r * 7 + c], `interior (${r},${c})`).toBeCloseTo(Math.hypot(dzdx, dzdy), 5);
      }
    }
  });
});

// ── The synthesised-neighbour marker ────────────────────────────────────────
//
// The honesty gap this closes: a slope computed from nine measured neighbours and
// one computed partly from an extrapolated or substituted value are the same
// float in the output. The agreement matrix says so about the nodata halo in as
// many words — it "carries no marker distinguishing those cells from
// fully-supported ones" — and the outer ring has the same problem.
describe('synthesisedNeighbourMask — which derivative cells leaned on a non-measurement', () => {
  const grid = (cols: number, rows: number, f: (r: number, c: number) => number) => {
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = f(r, c);
    return z;
  };
  const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

  it('flags exactly the outer ring on a hole-free grid', () => {
    const [cols, rows] = [7, 5];
    const m = synthesisedNeighbourMask(grid(cols, rows, (r, c) => r + c), cols, rows);
    expect(count(m)).toBe(2 * (cols + rows) - 4); // 20
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const onRing = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
        expect(m[r * cols + c], `(${r},${c})`).toBe(onRing ? 1 : 0);
      }
    }
    // Same identity the agreement matrix uses for the affected-cell count.
    expect(count(m)).toBe(2 * (cols + rows) - 4);
    expect(countSynthesisedNeighbours(grid(cols, rows, () => 1), cols, rows)).toBe(20);
  });

  it('flags the halo around a void, not just the ring', () => {
    const [cols, rows] = [7, 7];
    const z = grid(cols, rows, () => 10);
    z[3 * cols + 3] = Number.NaN; // one hole dead centre
    const m = synthesisedNeighbourMask(z, cols, rows);
    // The hole's eight neighbours are interior yet leaned on a substituted value.
    for (const [r, c] of [[2, 2], [2, 3], [2, 4], [3, 2], [3, 4], [4, 2], [4, 3], [4, 4]] as const) {
      expect(m[r * cols + c], `halo (${r},${c}) should be flagged`).toBe(1);
    }
    // The hole itself is NOT flagged: it has no derivative to qualify.
    expect(m[3 * cols + 3]).toBe(0);
    expect(count(m)).toBe(2 * (cols + rows) - 4 + 8); // ring + halo, no overlap here
  });

  it('leaves a fully-supported interior unflagged, so the marker means something', () => {
    // A marker that fired everywhere would be as useless as one that never fired.
    const [cols, rows] = [40, 30];
    const m = synthesisedNeighbourMask(grid(cols, rows, (r, c) => Math.sin(r) + c), cols, rows);
    const interior = (cols - 2) * (rows - 2);
    expect(count(m)).toBe(cols * rows - interior);
    expect(interior).toBeGreaterThan(count(m)); // the flag is the exception, not the rule
  });

  it('degenerate grids do not throw and flag nothing that has no derivative', () => {
    expect(synthesisedNeighbourMask(new Float32Array(0), 0, 0)).toHaveLength(0);
    expect(countSynthesisedNeighbours(new Float32Array(0), 5, 0)).toBe(0);
    // A single cell is its own border, but it IS finite and does get a slope (0).
    expect(Array.from(synthesisedNeighbourMask(new Float32Array([4]), 1, 1))).toEqual([1]);
    // An all-void grid has no derivatives anywhere, so nothing to qualify.
    expect(countSynthesisedNeighbours(grid(4, 4, () => Number.NaN), 4, 4)).toBe(0);
  });
});

// ── Border policy: what extrapolation COSTS on noisy ground ─────────────────
//
// Every border fixture in tests/rasterAgreementMatrix.test.ts is an analytic
// SMOOTH surface — planes, a ridge, quadratics. Real LiDAR ground is noisy, and
// on noisy ground the choice of border policy is a bias-variance trade, not a
// straight win. That trade is measured here so it is recorded rather than
// discovered later:
//
//   clamping      preserves the interior noise level and costs ~50% BIAS
//   extrapolating removes the bias and costs 2x the noise
//
// Both follow from the algebra. At a left-edge cell the Horn numerator reduces to
// 2(S1 - S0) with the virtual column substituted, so dz/dx = (S1 - S0)/(4h)
// against an interior (S_{c+1} - S_{c-1})/(8h), where Sk is a 1-2-1 weighted
// column sum with Var = 6*sigma^2. Same numerator spread, half the divisor:
// Var(edge) = 4 * Var(interior), i.e. 2x the SD. Clamping instead leaves the
// divisor at 8h and the expectation at G/2 — full variance suppression, half the
// signal. On the top and bottom rows clamping replicates a row, turning the 1-2-1
// weights into (3,1) and raising the SD by sqrt(10/6) = 1.29x.
//
// MSE therefore crosses over near sigma = G*cell/1.5: extrapolation wins on
// moderate terrain at survey-grade noise, and LOSES on near-flat noisy ground,
// where there is almost no bias to remove. Extrapolation remains the kernel's
// policy because the bias it removes is systematic and directional — always low,
// at every terrain scale — while the noise it adds is symmetric and averages out.
// The losing regime is measured below rather than left to be rediscovered.
describe('hornSlopeAspect — the border bias-variance trade on noisy ground', () => {
  const N = 64;
  const CELL = 1;
  const TRIALS = 600;

  /**
   * The SUPERSEDED policy, kept only as the comparison baseline. It is a
   * characterisation baseline, not a second implementation of the shipped
   * kernel: its entire job is to represent what edge-clamping did so the trade
   * can be quantified against it.
   */
  function clampSlope(z: Float32Array, cols: number, rows: number, cell: number): Float64Array {
    const out = new Float64Array(cols * rows);
    const at = (r: number, c: number): number =>
      z[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dzdx =
          (at(r - 1, c + 1) + 2 * at(r, c + 1) + at(r + 1, c + 1) -
            (at(r - 1, c - 1) + 2 * at(r, c - 1) + at(r + 1, c - 1))) / (8 * cell);
        const dzdy =
          (at(r + 1, c - 1) + 2 * at(r + 1, c) + at(r + 1, c + 1) -
            (at(r - 1, c - 1) + 2 * at(r - 1, c) + at(r - 1, c + 1))) / (8 * cell);
        out[r * cols + c] = Math.hypot(dzdx, dzdy);
      }
    }
    return out;
  }

  // Seeded LCG + Box-Muller. Math.random would make this test irreproducible,
  // which for a statistical claim would make it worthless.
  const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s >>> 8) / 16777216;
    };
  };
  const gauss = (u: () => number): number =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());

  /** Per-cell statistics ACROSS trials, so `sd` is noise and nothing else. */
  function probe(G: number, sigma: number, cells: ReadonlyArray<readonly [number, number]>) {
    const ex: number[][] = cells.map(() => []);
    const cl: number[][] = cells.map(() => []);
    for (let t = 0; t < TRIALS; t++) {
      const u = rng(9001 + t * 7919);
      const z = new Float32Array(N * N);
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) z[r * N + c] = G * c * CELL + sigma * gauss(u);
      const e = hornSlope(z, N, N, CELL, CELL, 1);
      const k = clampSlope(z, N, N, CELL);
      cells.forEach(([r, c], i) => {
        ex[i].push(e[r * N + c]);
        cl[i].push(k[r * N + c]);
      });
    }
    const st = (a: number[]) => {
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
      const rmse = Math.sqrt(a.reduce((s, x) => s + (x - G) ** 2, 0) / a.length);
      return { bias: m - G, sd, rmse };
    };
    return cells.map((_, i) => ({ extrap: st(ex[i]), clamp: st(cl[i]) }));
  }

  it('extrapolation removes the ~50% edge bias and pays 2x the noise for it', () => {
    const G = 0.2; // ~11 degrees, and large enough that hypot ~ |dz/dx|
    const [interior, edge] = probe(G, 0.02, [[32, 32], [32, 0]] as const);

    // Clamping: the full halving, and NO variance penalty. Both halves matter —
    // if it were merely noisier the old behaviour would have been defensible.
    expect(edge.clamp.bias / G, 'clamped edge bias is not ~ -1/2 of the gradient')
      .toBeGreaterThan(-0.6);
    expect(edge.clamp.bias / G).toBeLessThan(-0.4);
    expect(edge.clamp.sd / interior.clamp.sd, 'clamping changed the edge noise level')
      .toBeLessThan(1.15);

    // Extrapolation: unbiased, at twice the noise. The 2x is derived, not fitted
    // (Var scales 4x because the divisor halves), so the band is tight.
    expect(Math.abs(edge.extrap.bias / G), 'extrapolated edge is not ~unbiased').toBeLessThan(0.05);
    const ratio = edge.extrap.sd / interior.extrap.sd;
    expect(ratio, `edge/interior noise ratio ${ratio.toFixed(2)} left the derived 2x band`)
      .toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.4);

    // At survey-grade noise on this gradient, removing the bias wins outright.
    expect(edge.extrap.rmse, 'extrapolation should win here').toBeLessThan(edge.clamp.rmse);
  });

  it('records the regime where extrapolation is WORSE: near-flat, noisy ground', () => {
    // The limit of the border fix. With G ~ 1 degree and 5 cm noise there is
    // almost no bias to recover, so doubling the noise is a net loss in MSE. The
    // smooth fixtures in the agreement matrix cannot show this regime, so the
    // border reads as unambiguously better there and on this ground it is not.
    // What still favours extrapolation is the CHARACTER of the error: clamping was
    // systematically low everywhere, at every terrain scale.
    const [edge] = probe(0.02, 0.05, [[32, 0]] as const);
    expect(edge.clamp.rmse, 'the near-flat noisy regression has disappeared')
      .toBeLessThan(edge.extrap.rmse);
  });

  it('confirms the fix does essentially nothing at the four corners', () => {
    // The cost of matching gdaldem cell-for-cell, in the units that matter. The
    // corner clamps the along-edge axis under BOTH policies, so an x-gradient is
    // halved there either way and the corner keeps almost all of its old error.
    const G = 0.2;
    const [corner] = probe(G, 0.02, [[0, 0]] as const);
    expect(Math.abs(corner.clamp.bias / G), 'corner was not ~half-biased before').toBeGreaterThan(0.4);
    expect(Math.abs(corner.extrap.bias / G), 'the corner is no longer ~half-biased — did the policy change?')
      .toBeGreaterThan(0.4);
    // Improvement at the corner is a few percent, against ~78% at the edges.
    expect(corner.extrap.rmse / corner.clamp.rmse).toBeGreaterThan(0.9);
  });
});

// Mutation-testing follow-up: the degenerate-input guard
// `if (n === 0 || !(cellMetresX > 0) || !(cellMetresY > 0)) return` accounted for
// 17 surviving mutants — every clause could be flipped or dropped without a test
// noticing. A bad cell size must yield a zero field, never a divide-by-zero
// Infinity/NaN slope that would propagate into confidence, RMSE bands and VRM.
describe('hornSlopeAspect — degenerate inputs return a zero field, never NaN/Infinity', () => {
  const ramp = () => {
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = c;
    return z;
  };
  const allFinite = (a: Float32Array) => Array.from(a).every((v) => Number.isFinite(v));

  it('an empty grid (cols or rows 0) yields empty fields', () => {
    const a = hornSlopeAspect(new Float32Array(0), 0, 0, 1);
    expect(a.slope).toHaveLength(0);
    expect(a.aspect).toHaveLength(0);
    expect(hornSlopeAspect(new Float32Array(0), 0, 5, 1).slope).toHaveLength(0);
    expect(hornSlopeAspect(new Float32Array(0), 5, 0, 1).slope).toHaveLength(0);
  });

  it('a zero or negative X cell size yields all-zero slope, not Infinity', () => {
    for (const bad of [0, -1]) {
      const { slope } = hornSlopeAspect(ramp(), 3, 3, bad);
      expect(allFinite(slope)).toBe(true);
      expect(Array.from(slope).every((v) => v === 0)).toBe(true);
    }
  });

  it('a zero or negative Y cell size yields all-zero slope, not Infinity', () => {
    for (const bad of [0, -1]) {
      const { slope } = hornSlopeAspect(ramp(), 3, 3, 1, bad);
      expect(allFinite(slope)).toBe(true);
      expect(Array.from(slope).every((v) => v === 0)).toBe(true);
    }
  });

  it('a NaN cell size is rejected by the same guard', () => {
    const { slope } = hornSlopeAspect(ramp(), 3, 3, Number.NaN);
    expect(allFinite(slope)).toBe(true);
    expect(Array.from(slope).every((v) => v === 0)).toBe(true);
  });

  it('a valid grid still computes a non-zero slope (the guard is not over-eager)', () => {
    const { slope } = hornSlopeAspect(ramp(), 3, 3, 1);
    expect(slope[4]).toBeCloseTo(1, 5);
  });
});

describe('terrainDerivatives — new-code mutation coverage (v0.6.3)', () => {
  const ramp = (cols = 3, rows = 3) => {
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = c;
    return z;
  };
  const allZero = (a: Float32Array) => Array.from(a).every((v) => v === 0);

  // The cell-size guard is PER AXIS. The X==Y==0 case cannot tell a `> 0` guard
  // from a `>= 0` one, because Y (defaulted to X) fires either way. A zero X
  // beside a valid Y must still be rejected, or dz/dx divides by zero.
  it('rejects a zero or negative X cell size while Y is valid', () => {
    for (const badX of [0, -1]) {
      expect(allZero(hornSlopeAspect(ramp(), 3, 3, badX, 5).slope)).toBe(true);
    }
  });
  it('rejects a zero or negative Y cell size while X is valid', () => {
    for (const badY of [0, -1]) {
      expect(allZero(hornSlopeAspect(ramp(), 3, 3, 5, badY).slope)).toBe(true);
    }
  });

  // A non-positive or non-finite zScale must fall back to 1, never scale the
  // slope by a bad factor: 0 would flatten it, a negative would invert its
  // sign, and +Infinity would blow it up.
  it('an invalid zScale falls back to 1, not a bad scale', () => {
    const base = hornSlope(ramp(), 3, 3, 1, 1, 1)[4];
    expect(base).toBeGreaterThan(0);
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(hornSlope(ramp(), 3, 3, 1, 1, bad)[4]).toBeCloseTo(base, 6);
    }
  });
  it('a valid zScale multiplies the slope linearly', () => {
    const base = hornSlope(ramp(), 3, 3, 1, 1, 1)[4];
    expect(hornSlope(ramp(), 3, 3, 1, 1, 2)[4]).toBeCloseTo(base * 2, 6);
    expect(hornSlope(ramp(), 3, 3, 1, 1, 0.5)[4]).toBeCloseTo(base * 0.5, 6);
  });

  // An interior cell must use the interior kernel, not a column-edge branch. A
  // plane cannot catch a branch that mis-routes interior cells, because linear
  // extrapolation is exact; z = c^2 is not linear, so the interior Horn slope at
  // (2,2) of a 5x5 is exactly 4 only through the real interior window.
  it('an interior cell on a curved grid uses the interior kernel (z = c^2 gives slope 4)', () => {
    const cols = 5;
    const rows = 5;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = c * c;
    const { slope } = hornSlopeAspect(z, cols, rows, 1);
    expect(slope[2 * cols + 2]).toBeCloseTo(4, 6);
  });
});
