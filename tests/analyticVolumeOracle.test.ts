/**
 * analyticVolumeOracle.test.ts
 *
 * A closed-form oracle for `volumeCutFill` (src/render/measure/volume.ts) and
 * for `stockpileVolume` with an explicit base plane. No third-party tool is the
 * reference here. Every expected number is an integral solved on paper, and
 * every one of those integrals is checked against two independent numerical
 * quadratures before any assertion uses it.
 *
 * THE ESTIMATOR. `volumeCutFill` buckets each in-polygon point's
 * dz = z - referenceZ into a fill sum (dz >= 0) and a cut sum (dz < 0), then
 * multiplies each by polygonArea / pointsInPolygon. It therefore reports
 *
 *     fill = A * mean_i(max(0, dz_i)),   cut = A * mean_i(max(0, -dz_i))
 *
 * so its answer is the polygon area times a SAMPLE mean, not an integral. Every
 * property measured below follows from that one line.
 *
 * THE FOOTPRINT IS A POLYGON, so the primitives are height fields over a square
 * S = [-a, a] x [-a, a] with A = 4a^2. A cone or a cylinder would need its
 * circular base approximated by an n-gon, and the resulting error would be an
 * artifact of that approximation rather than a property of the estimator.
 *
 * PRIMITIVES AND CLOSED FORMS (integrals over S of the height field):
 *
 *   1. FLAT CAP        z = h                       V = A*h
 *   2. TILTED PLANE    z = c + p*x + q*y           V = A*(c + p*cx + q*cy)
 *   3. SQUARE PYRAMID  z = h*(1 - t/a), t = max(|x|,|y|)      V = A*h/3
 *   4. FRUSTUM         z = h for t <= b, falling linearly to 0 at t = a
 *                                                  V = (4h/3)*(a^2 + a*b + b^2)
 *   5. PARABOLOID      z = h*(1 - (x^2+y^2)/R^2)   V = A*h*(1 - 2a^2/(3R^2))
 *   6. SADDLE          z = h*x*y/a^2               V = 0, fill = cut = A*h/8
 *
 * DERIVATION 3, 4 AND THE ELEVATED PLANE. Over S the variable t = max(|x|,|y|)
 * has P(t <= s) = (2s)^2/(2a)^2 = s^2/a^2, hence density f(t) = 2t/a^2 on
 * [0, a] and mean 2a/3. So the pyramid integrates to A*h*(1 - (2a/3)/a) = A*h/3.
 *
 * The frustum's height is g(t) = h for t <= b and g(t) = h*(a - t)/(a - b) for
 * b < t <= a. Then
 *
 *   E[g] = int_0^b h*(2t/a^2) dt + int_b^a h*(a-t)/(a-b) * (2t/a^2) dt
 *        = h*b^2/a^2 + (2h/(a^2*(a-b))) * (a^3/6 - a*b^2/2 + b^3/3)
 *        = (h/(a^2*(a-b))) * (b^2*(a-b) + a^3/3 - a*b^2 + 2b^3/3)
 *        = (h/(a^2*(a-b))) * (a^3 - b^3)/3
 *        = h*(a^2 + a*b + b^2)/(3a^2)                        [a^3-b^3 factored]
 *
 *   V = A*E[g] = (4h/3)*(a^2 + a*b + b^2)
 *
 * which reduces to A*h/3 at b = 0 and to A*h at b = a, and is the prismatoid
 * form (h/3)*(A1 + sqrt(A1*A2) + A2) with A1 = 4a^2 and A2 = 4b^2.
 *
 * For the pyramid cut by a plane at z0 in [0, h], write tau = 1 - z0/h. The
 * region above the plane is t < a*tau, and
 *
 *   E[max(0, z - z0)] = int_0^{a*tau} h*(tau - t/a)*(2t/a^2) dt = h*tau^3/3
 *
 * so fill = A*h*tau^3/3, the volume of the similar pyramid of height h*tau and
 * half-width a*tau. Cut follows from cut = fill - net and net = A*(h/3 - z0).
 *
 * PARABOLOID AND SADDLE. Over S, mean(x^2) = mean(y^2) = a^2/3 gives
 * V = A*h*(1 - 2a^2/(3R^2)); R > a*sqrt(2) keeps z > 0 across S. For the saddle
 * x and y are independent and mean|x| = mean|y| = a/2, so mean|x*y| = a^2/4,
 * mean|z| = h/4, and by antisymmetry fill = cut = A*h/8 with net exactly 0. The
 * saddle is the only primitive here that tests the cut/fill SPLIT rather than
 * the sum.
 *
 * EXPECTED ACCURACY. The samples are cell centres of an n x n lattice, so the
 * estimator evaluates a midpoint Riemann sum. For n even the lattice moments are
 * exact in closed form:
 *
 *   |x| takes a*(2k+1)/n, k = 0..n/2-1, each with weight 2/n
 *   t = max(|x|,|y|) takes a*(2k+1)/n with weight 4*(2k+1)/n^2
 *   mean(|x|)   = a/2                    (exact, no n dependence)
 *   mean(x^2)   = (a^2/3)*(1 - 1/n^2)
 *   mean(t)     = (2a/3)*(1 - 1/n^2)
 *
 * so the flat cap, the tilted plane over S and the saddle are EXACT on this
 * lattice, while the pyramid overshoots by exactly 2/n^2 relative and the
 * paraboloid by (2a^2/(3R^2))/(n^2*(1 - 2a^2/(3R^2))) relative. Those two are
 * predictions made before running, and the density sweep checks them. Assertion
 * bounds for the non-exact primitives come from the measured convergence, not
 * from a number picked to make the suite pass.
 *
 * Pure Node. No DOM, no three.js, no I/O, no Math.random (a fixed-seed mulberry32
 * drives the jitter case so the numbers reproduce to the digit).
 */

import { describe, it, expect } from 'vitest';
import { volumeCutFill } from '../src/render/measure/volume';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';
import type { Vec3 } from '../src/render/navMath';

// ── deterministic PRNG ────────────────────────────────────────────────────────

/** mulberry32. Fixed seed, so every jittered figure below reproduces exactly. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── geometry under test ──────────────────────────────────────────────────────

/** Half-width of the square footprint. A = 4a^2 = 1 m^2. */
const A_HALF = 0.5;
const AREA = 4 * A_HALF * A_HALF;

type Field = (x: number, y: number) => number;

interface Primitive {
  readonly name: string;
  readonly z: Field;
  /** Reference plane height fed to the estimator. */
  readonly refZ: number;
  /** Closed-form volume above the reference plane over S. */
  readonly fill: number;
  /** Closed-form volume below the reference plane over S. */
  readonly cut: number;
  /**
   * Exact expectation of the estimator on an n x n cell-centre lattice, from the
   * lattice moments in the file docstring. This is what the estimator SHOULD
   * return bit-for-bit up to Float32 storage; the gap between it and the closed
   * form is quadrature error, which lets the two be reported separately.
   */
  readonly lattice: (n: number) => { readonly fill: number; readonly cut: number };
}

const FLAT_H = 1;
const TILT_C = 2;
const TILT_P = 0.6;
const TILT_Q = -0.4;
const PYR_H = 1.2;
const FRU_H = 1.5;
const FRU_B = 0.2;
const PAR_H = 2;
const PAR_R = 1;
const SAD_H = 1.6;

const tMax: Field = (x, y) => Math.max(Math.abs(x), Math.abs(y));

/** Frustum height as a function of t = max(|x|,|y|). */
function frustumHeight(t: number): number {
  if (t <= FRU_B) return FRU_H;
  return (FRU_H * (A_HALF - t)) / (A_HALF - FRU_B);
}

/**
 * Exact lattice expectation of g(t) for t = max(|x|,|y|) on an n x n cell-centre
 * lattice with n even: t takes a*(2k+1)/n with weight 4*(2k+1)/n^2.
 */
function latticeMaxRadial(g: (t: number) => number, n: number): number {
  const m = n / 2;
  let sum = 0;
  for (let k = 0; k < m; k++) sum += (2 * k + 1) * g((A_HALF * (2 * k + 1)) / n);
  return (4 / (n * n)) * sum;
}

/** Lattice fill/cut for a height field that depends only on t, at plane z0. */
function latticeRadialSplit(
  g: (t: number) => number,
  n: number,
  z0: number,
): { fill: number; cut: number } {
  return {
    fill: AREA * latticeMaxRadial((t) => Math.max(0, g(t) - z0), n),
    cut: AREA * latticeMaxRadial((t) => Math.max(0, z0 - g(t)), n),
  };
}

const PRIMITIVES: ReadonlyArray<Primitive> = [
  {
    name: 'flat cap',
    z: () => FLAT_H,
    refZ: 0,
    fill: AREA * FLAT_H,
    cut: 0,
    lattice: (n) => latticeRadialSplit(() => FLAT_H, n, 0),
  },
  {
    name: 'tilted plane',
    z: (x, y) => TILT_C + TILT_P * x + TILT_Q * y,
    refZ: 0,
    // Centroid of S is the origin, so the integral is A*c.
    fill: AREA * TILT_C,
    cut: 0,
    // mean(x) = mean(y) = 0 exactly on a symmetric lattice, so no n dependence.
    lattice: () => ({ fill: AREA * TILT_C, cut: 0 }),
  },
  {
    name: 'square pyramid',
    z: (x, y) => PYR_H * (1 - tMax(x, y) / A_HALF),
    refZ: 0,
    fill: (AREA * PYR_H) / 3,
    cut: 0,
    lattice: (n) => latticeRadialSplit((t) => PYR_H * (1 - t / A_HALF), n, 0),
  },
  {
    name: 'frustum',
    z: (x, y) => frustumHeight(tMax(x, y)),
    refZ: 0,
    fill: ((4 * FRU_H) / 3) * (A_HALF * A_HALF + A_HALF * FRU_B + FRU_B * FRU_B),
    cut: 0,
    lattice: (n) => latticeRadialSplit(frustumHeight, n, 0),
  },
  {
    name: 'paraboloid',
    z: (x, y) => PAR_H * (1 - (x * x + y * y) / (PAR_R * PAR_R)),
    refZ: 0,
    fill: AREA * PAR_H * (1 - (2 * A_HALF * A_HALF) / (3 * PAR_R * PAR_R)),
    cut: 0,
    // mean(x^2) = (a^2/3)*(1 - 1/n^2) on the lattice, twice over for x^2 + y^2.
    lattice: (n) => ({
      fill:
        AREA *
        PAR_H *
        (1 - ((2 * A_HALF * A_HALF) / (3 * PAR_R * PAR_R)) * (1 - 1 / (n * n))),
      cut: 0,
    }),
  },
  {
    name: 'saddle',
    z: (x, y) => (SAD_H * x * y) / (A_HALF * A_HALF),
    refZ: 0,
    fill: (AREA * SAD_H) / 8,
    cut: (AREA * SAD_H) / 8,
    // mean|x| = a/2 exactly and x, y are independent on the lattice, so the
    // positive half of the |x*y| mass is a^2/8 with no n dependence.
    lattice: () => ({ fill: (AREA * SAD_H) / 8, cut: (AREA * SAD_H) / 8 }),
  },
];

// ── independent numerical quadrature ─────────────────────────────────────────

interface Quadrature {
  readonly fill: number;
  readonly cut: number;
}

/** Composite midpoint rule, n x n cells over S. */
function integrateMidpoint(z: Field, n: number, refZ: number): Quadrature {
  const h = (2 * A_HALF) / n;
  const cell = h * h;
  let fill = 0;
  let cut = 0;
  for (let i = 0; i < n; i++) {
    const x = -A_HALF + (i + 0.5) * h;
    for (let j = 0; j < n; j++) {
      const d = z(x, -A_HALF + (j + 0.5) * h) - refZ;
      if (d >= 0) fill += d;
      else cut -= d;
    }
  }
  return { fill: fill * cell, cut: cut * cell };
}

/**
 * Composite 2-point Gauss-Legendre, m x m cells over S (4 nodes per cell). A
 * genuinely different rule from the midpoint sum: different node positions,
 * different weights, different error constant, and exact for any polynomial of
 * degree <= 3 per axis within a cell. Agreement between the two is what makes
 * the closed forms above trustworthy rather than assumed.
 */
function integrateGauss(z: Field, m: number, refZ: number): Quadrature {
  const h = (2 * A_HALF) / m;
  const g = (h / 2) * (1 / Math.sqrt(3));
  const w = (h / 2) * (h / 2);
  const offsets = [-g, g];
  let fill = 0;
  let cut = 0;
  for (let i = 0; i < m; i++) {
    const cx = -A_HALF + (i + 0.5) * h;
    for (let j = 0; j < m; j++) {
      const cy = -A_HALF + (j + 0.5) * h;
      for (const dx of offsets) {
        for (const dy of offsets) {
          const d = z(cx + dx, cy + dy) - refZ;
          if (d >= 0) fill += d;
          else cut -= d;
        }
      }
    }
  }
  return { fill: fill * w, cut: cut * w };
}

// ── clouds ───────────────────────────────────────────────────────────────────

/** Cell centres of an n x n lattice over S, heights from `z`. */
function latticeCloud(z: Field, n: number): Float32Array {
  const h = (2 * A_HALF) / n;
  const out = new Float32Array(n * n * 3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = -A_HALF + (i + 0.5) * h;
    for (let j = 0; j < n; j++) {
      const y = -A_HALF + (j + 0.5) * h;
      out[k++] = x;
      out[k++] = y;
      out[k++] = z(x, y);
    }
  }
  return out;
}

/**
 * Cell centres displaced by up to `amp` cell widths in each axis. The amplitude
 * stays below half a cell so no sample can cross the footprint boundary, which
 * keeps `pointsInPolygon` equal to n*n and isolates the sampling-position effect
 * from an inclusion-count effect.
 */
function jitteredCloud(z: Field, n: number, rng: () => number, amp: number): Float32Array {
  const h = (2 * A_HALF) / n;
  const out = new Float32Array(n * n * 3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -A_HALF + (i + 0.5) * h + (rng() - 0.5) * 2 * amp * h;
      const y = -A_HALF + (j + 0.5) * h + (rng() - 0.5) * 2 * amp * h;
      out[k++] = x;
      out[k++] = y;
      out[k++] = z(x, y);
    }
  }
  return out;
}

/** Cell centres of an m x m lattice over the right half [0, a] x [-a, a]. */
function rightHalfCloud(z: Field, m: number): Float32Array {
  const hx = A_HALF / m;
  const hy = (2 * A_HALF) / m;
  const out = new Float32Array(m * m * 3);
  let k = 0;
  for (let i = 0; i < m; i++) {
    const x = (i + 0.5) * hx;
    for (let j = 0; j < m; j++) {
      const y = -A_HALF + (j + 0.5) * hy;
      out[k++] = x;
      out[k++] = y;
      out[k++] = z(x, y);
    }
  }
  return out;
}

function concatClouds(...parts: ReadonlyArray<Float32Array>): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Apply a per-point map to an interleaved buffer, returning a new buffer. */
function mapCloud(
  src: Float32Array,
  fn: (x: number, y: number, z: number) => readonly [number, number, number],
): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const [x, y, z] = fn(src[i], src[i + 1], src[i + 2]);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}

function squarePolygon(half: number, zValue: number): Vec3[] {
  return [
    [-half, -half, zValue],
    [half, -half, zValue],
    [half, half, zValue],
    [-half, half, zValue],
  ];
}

// ── comparison ───────────────────────────────────────────────────────────────

interface Deviation {
  readonly abs: number;
  readonly relPct: number;
}

function deviation(observed: number, oracle: number): Deviation {
  const abs = observed - oracle;
  return { abs, relPct: oracle === 0 ? Number.NaN : (abs / oracle) * 100 };
}

/**
 * The single comparison gate every assertion in this file goes through,
 * including the negative control. Throws with both figures when the observed
 * value is further than `relTol` (a fraction, not a percent) from the oracle.
 */
function assertAgainstOracle(
  observed: number,
  oracle: number,
  relTol: number,
  label: string,
): Deviation {
  const d = deviation(observed, oracle);
  const rel = Math.abs(d.abs) / Math.abs(oracle);
  if (!(rel <= relTol)) {
    throw new Error(
      `${label}: observed ${observed.toPrecision(12)} vs oracle ${oracle.toPrecision(12)}, ` +
        `relative ${(rel * 100).toPrecision(6)}% exceeds the ${(relTol * 100).toPrecision(6)}% bound`,
    );
  }
  return d;
}

function fmt(v: number, digits = 9): string {
  return Number.isFinite(v) ? v.toPrecision(digits) : String(v);
}

const DENSITIES = [20, 40, 80, 160, 400] as const;
const FINEST = DENSITIES[DENSITIES.length - 1];

/** Run the estimator over the square footprint with the primitive's plane. */
function runPrimitive(p: Primitive, positions: Float32Array) {
  return volumeCutFill({
    polygon: squarePolygon(A_HALF, p.refZ),
    referenceZ: p.refZ,
    positions,
  });
}

// ── 1. the closed forms, verified independently ──────────────────────────────

describe('closed forms verified by two independent quadratures', () => {
  it(
    'midpoint (2000x2000) and 2-point Gauss-Legendre (1000x1000 cells) both reproduce every closed form',
    () => {
      const lines = [
        'primitive        closed form      midpoint 2000    gauss-legendre   |mid-cf|/cf   |gl-cf|/cf',
      ];
      for (const p of PRIMITIVES) {
        const mid = integrateMidpoint(p.z, 2000, p.refZ);
        const gl = integrateGauss(p.z, 1000, p.refZ);
        const relMid = Math.abs(mid.fill - p.fill) / p.fill;
        const relGl = Math.abs(gl.fill - p.fill) / p.fill;
        lines.push(
          `${p.name.padEnd(16)} ${fmt(p.fill).padEnd(16)} ${fmt(mid.fill).padEnd(16)} ` +
            `${fmt(gl.fill).padEnd(16)} ${relMid.toExponential(3).padEnd(13)} ${relGl.toExponential(3)}`,
        );
        // Both rules land on the closed form. The midpoint residual is the
        // O(1/n^2) lattice bias the docstring predicts (2/n^2 = 5e-7 for the
        // pyramid at n = 2000); Gauss-Legendre carries a different, smaller one.
        expect(relMid).toBeLessThan(1e-6);
        expect(relGl).toBeLessThan(1e-6);
        if (p.cut > 0) {
          expect(Math.abs(mid.cut - p.cut) / p.cut).toBeLessThan(1e-6);
          expect(Math.abs(gl.cut - p.cut) / p.cut).toBeLessThan(1e-6);
        } else {
          expect(mid.cut).toBe(0);
          expect(gl.cut).toBe(0);
        }
      }
      console.log(['', 'ORACLE VERIFICATION', ...lines, ''].join('\n'));
    },
    180_000,
  );

  it('the lattice expectations agree with the hand-derived moment formulas', () => {
    for (const n of DENSITIES) {
      // mean(t) = (2a/3)*(1 - 1/n^2): the pyramid lattice fill is A*h*(1/3 + 2/(3n^2)).
      const pyramid = PRIMITIVES[2].lattice(n).fill;
      const predicted = AREA * PYR_H * (1 / 3 + 2 / (3 * n * n));
      expect(Math.abs(pyramid - predicted) / predicted).toBeLessThan(1e-12);
      // The frustum lattice value must sit between the pyramid's and the cap's.
      const frustum = PRIMITIVES[3].lattice(n).fill;
      expect(frustum).toBeGreaterThan(pyramid);
      expect(frustum).toBeLessThan(AREA * FRU_H);
    }
  });
});

// ── 2. OLV against the closed forms at the finest density ────────────────────

describe('volumeCutFill against the closed forms', () => {
  it(`reproduces every primitive at ${FINEST}x${FINEST} samples`, () => {
    const lines = [
      'primitive        quantity  closed form      OLV              abs error        rel error %',
    ];
    // Bounds are read off the density sweep below. The flat cap, the tilted
    // plane and the saddle are lattice-exact, so their only error is Float32
    // storage of the heights; the three curved/ridged fields carry the
    // predicted O(1/n^2) midpoint bias on top of that.
    const bounds: Record<string, number> = {
      'flat cap': 1e-7,
      'tilted plane': 1e-7,
      'square pyramid': 2e-5,
      frustum: 2e-5,
      paraboloid: 2e-6,
      saddle: 1e-6,
    };
    for (const p of PRIMITIVES) {
      const r = runPrimitive(p, latticeCloud(p.z, FINEST));
      expect(r.validity).toBe('ok');
      expect(r.pointsInPolygon).toBe(FINEST * FINEST);
      expect(r.footprintArea).toBeCloseTo(AREA, 12);
      const dFill = assertAgainstOracle(r.fill, p.fill, bounds[p.name], `${p.name} fill`);
      lines.push(
        `${p.name.padEnd(16)} ${'fill'.padEnd(9)} ${fmt(p.fill).padEnd(16)} ${fmt(r.fill).padEnd(16)} ` +
          `${dFill.abs.toExponential(3).padEnd(16)} ${dFill.relPct.toExponential(3)}`,
      );
      if (p.cut > 0) {
        const dCut = assertAgainstOracle(r.cut, p.cut, bounds[p.name], `${p.name} cut`);
        lines.push(
          `${p.name.padEnd(16)} ${'cut'.padEnd(9)} ${fmt(p.cut).padEnd(16)} ${fmt(r.cut).padEnd(16)} ` +
            `${dCut.abs.toExponential(3).padEnd(16)} ${dCut.relPct.toExponential(3)}`,
        );
      } else {
        expect(r.cut).toBe(0);
      }
    }
    console.log(['', `OLV VS CLOSED FORM AT ${FINEST}x${FINEST}`, ...lines, ''].join('\n'));
  });

  it('the saddle nets to zero while fill and cut are each A*h/8', () => {
    const saddle = PRIMITIVES[5];
    const r = runPrimitive(saddle, latticeCloud(saddle.z, 200));
    // Net is a difference of two equal quantities, so it is bounded in ABSOLUTE
    // terms against the fill magnitude rather than relatively against zero.
    expect(Math.abs(r.net)).toBeLessThan(1e-6 * saddle.fill);
    assertAgainstOracle(r.fill, (AREA * SAD_H) / 8, 1e-6, 'saddle fill');
    assertAgainstOracle(r.cut, (AREA * SAD_H) / 8, 1e-6, 'saddle cut');
  });
});

// ── 3. density sweep and convergence ─────────────────────────────────────────

describe('sampling density', () => {
  it('error falls as the lattice refines, matching the predicted quadrature bias', () => {
    const lines = [
      'primitive        n      OLV fill         abs error        rel error %   lattice rel %  OLV-vs-lattice',
    ];
    const measured: Record<string, number[]> = {};
    for (const p of PRIMITIVES) {
      const rels: number[] = [];
      for (const n of DENSITIES) {
        const r = runPrimitive(p, latticeCloud(p.z, n));
        expect(r.pointsInPolygon).toBe(n * n);
        const d = deviation(r.fill, p.fill);
        const lat = p.lattice(n);
        const latRelPct = ((lat.fill - p.fill) / p.fill) * 100;
        const vsLattice = Math.abs(r.fill - lat.fill) / lat.fill;
        rels.push(Math.abs(d.abs) / p.fill);
        lines.push(
          `${p.name.padEnd(16)} ${String(n).padEnd(6)} ${fmt(r.fill).padEnd(16)} ` +
            `${d.abs.toExponential(3).padEnd(16)} ${d.relPct.toExponential(3).padEnd(13)} ` +
            `${latRelPct.toExponential(3).padEnd(14)} ${vsLattice.toExponential(3)}`,
        );
        // The estimator must land on the EXACT lattice expectation. Anything
        // beyond Float32 storage error here would be an implementation defect
        // rather than quadrature error.
        expect(vsLattice).toBeLessThan(1e-6);
      }
      measured[p.name] = rels;
    }
    console.log(['', 'DENSITY CONVERGENCE (fill)', ...lines, ''].join('\n'));

    // Second-order convergence for the two primitives whose lattice bias is
    // known in closed form: doubling n must quarter the error. The final step is
    // 160 -> 400 (a factor of 2.5), so it is checked at 2.5^2 = 6.25.
    for (const name of ['square pyramid', 'paraboloid']) {
      const rels = measured[name];
      for (let i = 1; i < rels.length; i++) {
        const step = DENSITIES[i] / DENSITIES[i - 1];
        const ratio = rels[i - 1] / rels[i];
        expect(ratio).toBeGreaterThan(step * step * 0.9);
        expect(ratio).toBeLessThan(step * step * 1.1);
      }
      // Monotone decrease, so no primitive can hide a floor that stops shrinking.
      for (let i = 1; i < rels.length; i++) expect(rels[i]).toBeLessThan(rels[i - 1]);
    }
    // The frustum has a slope discontinuity at t = b, so its rate is measured
    // rather than derived; it must still shrink at every step.
    const fru = measured['frustum'];
    for (let i = 1; i < fru.length; i++) expect(fru[i]).toBeLessThan(fru[i - 1]);
  });

  it('the pyramid relative error is the predicted 2/n^2', () => {
    for (const n of DENSITIES) {
      const r = runPrimitive(PRIMITIVES[2], latticeCloud(PRIMITIVES[2].z, n));
      const rel = (r.fill - PRIMITIVES[2].fill) / PRIMITIVES[2].fill;
      const predicted = 2 / (n * n);
      expect(Math.abs(rel - predicted) / predicted).toBeLessThan(0.01);
    }
  });

  it('the paraboloid relative error is the predicted (2a^2/3R^2)/(n^2*(1-2a^2/3R^2))', () => {
    const k = (2 * A_HALF * A_HALF) / (3 * PAR_R * PAR_R);
    for (const n of DENSITIES) {
      const r = runPrimitive(PRIMITIVES[4], latticeCloud(PRIMITIVES[4].z, n));
      const rel = (r.fill - PRIMITIVES[4].fill) / PRIMITIVES[4].fill;
      const predicted = k / (n * n * (1 - k));
      expect(Math.abs(rel - predicted) / predicted).toBeLessThan(0.01);
    }
  });
});

// ── 4. irregular sampling ────────────────────────────────────────────────────

describe('irregular sampling', () => {
  it('a jittered lattice keeps the same sample count and stays near the closed form', () => {
    const lines = ['primitive        n      jitter  OLV fill         rel error %'];
    for (const p of PRIMITIVES) {
      for (const amp of [0.25, 0.45]) {
        const rng = mulberry32(0x5eed_1234);
        const n = 200;
        const r = runPrimitive(p, jitteredCloud(p.z, n, rng, amp));
        expect(r.pointsInPolygon).toBe(n * n);
        const d = deviation(r.fill, p.fill);
        lines.push(
          `${p.name.padEnd(16)} ${String(n).padEnd(6)} ${String(amp).padEnd(7)} ` +
            `${fmt(r.fill).padEnd(16)} ${d.relPct.toExponential(3)}`,
        );
        // Bound read off the measured table: jitter turns the systematic lattice
        // bias into an O(1/sqrt(N)) scatter, which at N = 40 000 is well inside
        // a tenth of a percent for every primitive here.
        assertAgainstOracle(r.fill, p.fill, 1e-3, `${p.name} fill (jitter ${amp})`);
      }
    }
    console.log(['', 'JITTERED LATTICE (n = 200, fixed seed)', ...lines, ''].join('\n'));
  });

  it('a one-sided density biases the tilted plane by exactly A*p*(sample centroid x)', () => {
    // Base lattice over the whole square plus a second lattice over the right
    // half only, so the sample centroid moves to a known x while the polygon
    // centroid stays at the origin.
    const p = PRIMITIVES[1];
    const lines = ['n_full  n_half  E[x] predicted  OLV fill         truth            bias          bias %'];
    for (const [nFull, mHalf] of [
      [100, 100],
      [100, 141],
      [200, 100],
    ] as const) {
      const nOne = nFull * nFull;
      const nTwo = mHalf * mHalf;
      // The right-half lattice is symmetric about x = a/2, so its mean x is a/2
      // exactly, and the combined sample mean is a weighted average with 0.
      const meanX = (A_HALF / 2) * (nTwo / (nOne + nTwo));
      const predictedBias = AREA * TILT_P * meanX;
      const positions = concatClouds(latticeCloud(p.z, nFull), rightHalfCloud(p.z, mHalf));
      const r = runPrimitive(p, positions);
      expect(r.pointsInPolygon).toBe(nOne + nTwo);
      const bias = r.fill - p.fill;
      lines.push(
        `${String(nFull).padEnd(7)} ${String(mHalf).padEnd(7)} ${fmt(meanX).padEnd(15)} ` +
          `${fmt(r.fill).padEnd(16)} ${fmt(p.fill).padEnd(16)} ${fmt(bias, 6).padEnd(13)} ` +
          `${((bias / p.fill) * 100).toFixed(4)}`,
      );
      // MEASURED PROPERTY: the estimator reports A times the height at the
      // SAMPLE centroid, not at the polygon centroid, so a one-sided density
      // shifts the answer by A * gradient . (sample centroid - polygon centroid).
      // Refining the lattice does not remove it; only rebalancing the sample does.
      assertAgainstOracle(bias, predictedBias, 1e-5, 'one-sided density bias');
    }
    console.log(['', 'ONE-SIDED DENSITY BIAS (tilted plane, dz/dx = 0.6)', ...lines, ''].join('\n'));
  });

  it('the one-sided bias does not shrink when both lattices refine together', () => {
    // Every other error in this file is quadrature error and falls as O(1/n^2).
    // This one does not fall at all: refining both lattices in proportion leaves
    // the sample centroid where it was, so the bias is a fixed 3.75 % of truth.
    // Density is not the cure for a density gradient.
    const p = PRIMITIVES[1];
    const lines = ['n_full  n_half  points     OLV fill         bias %'];
    const biases: number[] = [];
    for (const n of [50, 100, 200, 400]) {
      const positions = concatClouds(latticeCloud(p.z, n), rightHalfCloud(p.z, n));
      const r = runPrimitive(p, positions);
      const biasPct = ((r.fill - p.fill) / p.fill) * 100;
      biases.push(biasPct);
      lines.push(
        `${String(n).padEnd(7)} ${String(n).padEnd(7)} ${String(2 * n * n).padEnd(10)} ` +
          `${fmt(r.fill).padEnd(16)} ${biasPct.toFixed(6)}`,
      );
    }
    console.log(['', 'ONE-SIDED DENSITY BIAS UNDER REFINEMENT', ...lines, ''].join('\n'));
    // A*p*(a/4) / (A*c) = 0.6 * 0.125 / 2 = 3.75 %, independent of n.
    for (const b of biases) expect(Math.abs(b - 3.75)).toBeLessThan(1e-4);
    // 64x the points changes nothing.
    expect(Math.abs(biases[biases.length - 1] - biases[0])).toBeLessThan(1e-4);
  });

  it('the one-sided bias on the pyramid is measured, not assumed away', () => {
    const p = PRIMITIVES[2];
    const positions = concatClouds(latticeCloud(p.z, 200), rightHalfCloud(p.z, 200));
    const r = runPrimitive(p, positions);
    const relPct = ((r.fill - p.fill) / p.fill) * 100;
    console.log(
      `\nONE-SIDED DENSITY BIAS (square pyramid): OLV ${fmt(r.fill)} vs truth ${fmt(p.fill)}, ` +
        `${relPct.toFixed(4)}%\n`,
    );
    // The pyramid is symmetric about the polygon centroid, so doubling the
    // density of one half leaves the mean height unchanged to lattice precision.
    // The bias a density gradient causes is proportional to the height field's
    // gradient at the centroid, which is zero here in the mean.
    expect(Math.abs(relPct)).toBeLessThan(0.05);
  });
});

// ── 5. rigid motions and scale ───────────────────────────────────────────────

/**
 * Lattice size for the invariance work. A transform cannot remove the
 * quadrature error the lattice already carries, so each transformed result is
 * compared against the UNTRANSFORMED result of the same lattice; the reference
 * is separately pinned to its exact lattice expectation so the pair is anchored
 * to the mathematics rather than to itself.
 */
const N_INV = 120;

describe('invariance', () => {
  it('is invariant to rotation about the up axis when cloud and polygon rotate together', () => {
    for (const p of PRIMITIVES) {
      const base = latticeCloud(p.z, N_INV);
      const reference = runPrimitive(p, base);
      assertAgainstOracle(
        reference.fill,
        p.lattice(N_INV).fill,
        1e-6,
        `${p.name} unrotated reference vs lattice expectation`,
      );
      for (const deg of [31.7, 45, 137.5]) {
        const th = (deg * Math.PI) / 180;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        const rotated = mapCloud(base, (x, y, z) => [x * cs - y * sn, x * sn + y * cs, z]);
        const poly = squarePolygon(A_HALF, p.refZ).map(
          (v): Vec3 => [v[0] * cs - v[1] * sn, v[0] * sn + v[1] * cs, v[2]],
        );
        const r = volumeCutFill({ polygon: poly, referenceZ: p.refZ, positions: rotated });
        expect(r.pointsInPolygon).toBe(reference.pointsInPolygon);
        expect(r.footprintArea).toBeCloseTo(AREA, 9);
        // Rotation leaves every height untouched and the shoelace area is
        // rotation-invariant, so only the polygon area's last bits can move.
        assertAgainstOracle(r.fill, reference.fill, 1e-9, `${p.name} fill rotated ${deg} deg`);
      }
    }
  });

  it('is invariant to a modest translation of cloud, polygon and referenceZ', () => {
    const tx = 12.5;
    const ty = -7.25;
    const tz = 3.5;
    for (const p of PRIMITIVES) {
      const base = latticeCloud(p.z, N_INV);
      const reference = runPrimitive(p, base);
      const moved = mapCloud(base, (x, y, z) => [x + tx, y + ty, z + tz]);
      const poly = squarePolygon(A_HALF, p.refZ).map(
        (v): Vec3 => [v[0] + tx, v[1] + ty, v[2] + tz],
      );
      const r = volumeCutFill({ polygon: poly, referenceZ: p.refZ + tz, positions: moved });
      expect(r.pointsInPolygon).toBe(N_INV * N_INV);
      // Not bit-exact: storing z + 3.5 in Float32 spends mantissa bits on the
      // offset, so dz comes back rounded. The bound is the measured size of that.
      assertAgainstOracle(r.fill, reference.fill, 1e-6, `${p.name} fill translated`);
    }
  });

  it('records how far a Float32 buffer can be translated before the heights quantise', () => {
    // CHARACTERISATION, not an invariance claim. `positions` is a Float32Array,
    // so a large vertical offset costs mantissa bits: the spacing of Float32 at
    // 2^22 is 0.5, which is comparable to the primitive's own height. The module
    // contract says local render-space, and this measures what that contract buys.
    // Error is taken against the zero-offset run, so the lattice's own quadrature
    // error cancels and what remains is the storage effect alone.
    const p = PRIMITIVES[2];
    const base = latticeCloud(p.z, N_INV);
    const lines = ['z offset        OLV fill         vs offset 0 %    vs closed form %'];
    const errs: number[] = [];
    let atZero = Number.NaN;
    for (const tz of [0, 1, 1024, 65536, 1_048_576, 4_194_304]) {
      const moved = mapCloud(base, (x, y, z) => [x, y, z + tz]);
      const poly = squarePolygon(A_HALF, p.refZ).map((v): Vec3 => [v[0], v[1], v[2] + tz]);
      const r = volumeCutFill({ polygon: poly, referenceZ: p.refZ + tz, positions: moved });
      if (tz === 0) atZero = r.fill;
      const d = deviation(r.fill, atZero);
      errs.push(Math.abs(r.fill - atZero) / atZero);
      lines.push(
        `${String(tz).padEnd(15)} ${fmt(r.fill).padEnd(16)} ${d.relPct.toExponential(3).padEnd(16)} ` +
          `${deviation(r.fill, p.fill).relPct.toExponential(3)}`,
      );
    }
    console.log(
      ['', `FLOAT32 VERTICAL OFFSET (square pyramid, n = ${N_INV})`, ...lines, ''].join('\n'),
    );
    // Pinned behaviour: negligible near the origin, ruinous at UTM northing scale.
    expect(errs[0]).toBe(0);
    expect(errs[1]).toBeLessThan(1e-6);
    expect(errs[errs.length - 1]).toBeGreaterThan(0.01);
  });

  it('scales as s^3 under a uniform similarity transform', () => {
    const lines = [
      'primitive        s      OLV fill         s^3 * reference  rel error %   vs s^3 * closed form %',
    ];
    for (const p of PRIMITIVES) {
      const base = latticeCloud(p.z, N_INV);
      const reference = runPrimitive(p, base);
      for (const s of [0.25, 2.5, 8]) {
        const scaled = mapCloud(base, (x, y, z) => [x * s, y * s, z * s]);
        const poly = squarePolygon(A_HALF * s, p.refZ * s);
        const r = volumeCutFill({ polygon: poly, referenceZ: p.refZ * s, positions: scaled });
        const expected = reference.fill * s * s * s;
        expect(r.footprintArea).toBeCloseTo(AREA * s * s, 9);
        const d = deviation(r.fill, expected);
        lines.push(
          `${p.name.padEnd(16)} ${String(s).padEnd(6)} ${fmt(r.fill).padEnd(16)} ` +
            `${fmt(expected).padEnd(16)} ${d.relPct.toExponential(3).padEnd(13)} ` +
            `${deviation(r.fill, p.fill * s * s * s).relPct.toExponential(3)}`,
        );
        assertAgainstOracle(r.fill, expected, 1e-6, `${p.name} fill at scale ${s}`);
      }
    }
    console.log(['', 'UNIFORM SCALE', ...lines, ''].join('\n'));
  });
});

// ── 6. elevated base plane ───────────────────────────────────────────────────

describe('elevated reference plane', () => {
  it('splits the pyramid into A*h*tau^3/3 above and the complement below', () => {
    const z0 = 0.45;
    const tau = 1 - z0 / PYR_H;
    const fillTruth = (AREA * PYR_H * tau * tau * tau) / 3;
    const netTruth = AREA * (PYR_H / 3 - z0);
    const cutTruth = fillTruth - netTruth;
    const field: Field = (x, y) => PYR_H * (1 - tMax(x, y) / A_HALF);
    const lines = ['n      OLV fill         truth fill       OLV cut          truth cut        fill %      cut %'];
    for (const n of [80, 200, 400]) {
      const r = volumeCutFill({
        polygon: squarePolygon(A_HALF, z0),
        referenceZ: z0,
        positions: latticeCloud(field, n),
      });
      expect(r.pointsInPolygon).toBe(n * n);
      const df = deviation(r.fill, fillTruth);
      const dc = deviation(r.cut, cutTruth);
      lines.push(
        `${String(n).padEnd(6)} ${fmt(r.fill).padEnd(16)} ${fmt(fillTruth).padEnd(16)} ` +
          `${fmt(r.cut).padEnd(16)} ${fmt(cutTruth).padEnd(16)} ` +
          `${df.relPct.toExponential(3).padEnd(11)} ${dc.relPct.toExponential(3)}`,
      );
      // The estimator must sit on the exact lattice expectation for the raised
      // plane too, which is the sharper of the two checks. Against the CLOSED
      // FORM the error is not monotone in n here: the level set t = a*tau falls
      // at a different position between lattice lines at each n, so the sign of
      // the residual alternates. The lattice expectation tracks that exactly,
      // which is why the tight check is made against it.
      const lat = latticeRadialSplit((t) => PYR_H * (1 - t / A_HALF), n, z0);
      assertAgainstOracle(r.fill, lat.fill, 1e-6, `raised-plane pyramid fill lattice (n=${n})`);
      assertAgainstOracle(r.cut, lat.cut, 1e-6, `raised-plane pyramid cut lattice (n=${n})`);
    }
    console.log(['', `ELEVATED PLANE, SQUARE PYRAMID (z0 = ${z0}, tau = ${tau})`, ...lines, ''].join('\n'));

    // Against the closed form at the finest lattice. Bound from the table above.
    const fine = volumeCutFill({
      polygon: squarePolygon(A_HALF, z0),
      referenceZ: z0,
      positions: latticeCloud(field, 400),
    });
    assertAgainstOracle(fine.fill, fillTruth, 5e-4, 'raised-plane pyramid fill');
    assertAgainstOracle(fine.cut, cutTruth, 5e-4, 'raised-plane pyramid cut');
    // Net is a difference of two quantities each about twice its size, so the
    // same absolute error reads as a larger relative one. Bound measured, not guessed.
    assertAgainstOracle(fine.net, netTruth, 2e-4, 'raised-plane pyramid net');
  });

  it('splits a ramp exactly when the crossing line falls on a lattice boundary', () => {
    // z = c + p*x with q = 0, so the plane at z0 cuts the square along
    // x0 = (z0 - c)/p and both parts integrate in closed form:
    //   fill = a*p*(a - x0)^2,   cut = a*p*(x0 + a)^2.
    const field: Field = (x) => TILT_C + TILT_P * x;
    for (const [z0, n] of [
      [TILT_C, 200],
      [TILT_C + 0.09, 400],
      [TILT_C + 0.09, 200],
    ] as const) {
      const x0 = (z0 - TILT_C) / TILT_P;
      const fillTruth = A_HALF * TILT_P * (A_HALF - x0) * (A_HALF - x0);
      const cutTruth = A_HALF * TILT_P * (x0 + A_HALF) * (x0 + A_HALF);
      const r = volumeCutFill({
        polygon: squarePolygon(A_HALF, z0),
        referenceZ: z0,
        positions: latticeCloud(field, n),
      });
      // x0 sits on a cell boundary at these n, so the lattice mean of the
      // positive part equals the exact integral and only Float32 storage separates
      // the two.
      assertAgainstOracle(r.fill, fillTruth, 1e-5, `ramp fill (z0=${z0}, n=${n})`);
      assertAgainstOracle(r.cut, cutTruth, 1e-5, `ramp cut (z0=${z0}, n=${n})`);
    }
  });
});

// ── 7. stockpileVolume with an explicit base ─────────────────────────────────

describe('stockpileVolume with an explicit base plane', () => {
  it('returns the same closed-form volumes as volumeCutFill', () => {
    const lines = ['primitive        closed form      stockpile        rel error %   matches volumeCutFill'];
    for (const p of PRIMITIVES) {
      const positions = latticeCloud(p.z, FINEST);
      const polygon = squarePolygon(A_HALF, p.refZ);
      const s = stockpileVolume({
        polygon,
        positions,
        base: { mode: 'explicit', z: p.refZ },
      });
      const v = volumeCutFill({ polygon, referenceZ: p.refZ, positions });
      expect(s.validity).toBe('ok');
      expect(s.breakdown.baseZ).toBe(p.refZ);
      expect(s.breakdown.baseUncertainty).toBe(0);
      // An explicit base carries no base-plane term, so the whole band is the
      // sampling term: sigma = area * sigma(thickness) / sqrt(N).
      expect(s.breakdown.basePlaneError).toBe(0);
      expect(s.sigma).toBeCloseTo(s.breakdown.samplingError, 12);
      const same = s.volume === v.fill;
      const d = deviation(s.volume, p.fill);
      lines.push(
        `${p.name.padEnd(16)} ${fmt(p.fill).padEnd(16)} ${fmt(s.volume).padEnd(16)} ` +
          `${d.relPct.toExponential(3).padEnd(13)} ${same}`,
      );
      expect(same).toBe(true);
      const bounds: Record<string, number> = {
        'flat cap': 1e-7,
        'tilted plane': 1e-7,
        'square pyramid': 2e-5,
        frustum: 2e-5,
        paraboloid: 2e-6,
        saddle: 1e-6,
      };
      assertAgainstOracle(s.volume, p.fill, bounds[p.name], `stockpile ${p.name}`);
      if (p.cut > 0) assertAgainstOracle(s.cut, p.cut, bounds[p.name], `stockpile ${p.name} cut`);
    }
    console.log(['', `STOCKPILE (explicit base) AT ${FINEST}x${FINEST}`, ...lines, ''].join('\n'));
  });

  it('reports the flat cap as a 1 x 1 x 1 m cube with a zero-width band', () => {
    const positions = latticeCloud(() => FLAT_H, 200);
    const polygon = squarePolygon(A_HALF, 0);
    const s = stockpileVolume({ polygon, positions, base: { mode: 'explicit', z: 0 } });
    assertAgainstOracle(s.volume, 1, 1e-7, 'unit cube volume');
    // A constant-thickness pile has zero thickness variance, so the sampling
    // term vanishes and the band collapses.
    expect(s.breakdown.thicknessStdDev).toBeLessThan(1e-6);
    expect(s.sigma).toBeLessThan(1e-6);
  });

  it('carries the pyramid volume through to the elevated explicit base', () => {
    const z0 = 0.45;
    const tau = 1 - z0 / PYR_H;
    const fillTruth = (AREA * PYR_H * tau * tau * tau) / 3;
    const field: Field = (x, y) => PYR_H * (1 - tMax(x, y) / A_HALF);
    const s = stockpileVolume({
      polygon: squarePolygon(A_HALF, z0),
      positions: latticeCloud(field, 400),
      base: { mode: 'explicit', z: z0 },
    });
    assertAgainstOracle(s.volume, fillTruth, 5e-4, 'stockpile raised-plane pyramid');
  });
});

// ── 8. negative control ──────────────────────────────────────────────────────

describe('negative control', () => {
  it('rejects a deliberately wrong closed form through the same comparison gate', () => {
    const p = PRIMITIVES[2];
    const r = runPrimitive(p, latticeCloud(p.z, FINEST));
    // The correct oracle is A*h/3. A*h/2 is the classic wrong one: 50 % high.
    const wrong = (AREA * PYR_H) / 2;
    expect(() => assertAgainstOracle(r.fill, wrong, 2e-5, 'pyramid fill (WRONG oracle A*h/2)')).toThrow(
      /exceeds the/,
    );
    // The same call with the right oracle passes, so the gate discriminates
    // rather than throwing on everything.
    expect(() => assertAgainstOracle(r.fill, p.fill, 2e-5, 'pyramid fill')).not.toThrow();
    // And a 0.1 % error is caught too, which is the resolution the tight bounds
    // above actually rely on.
    expect(() =>
      assertAgainstOracle(r.fill, p.fill * 1.001, 2e-5, 'pyramid fill (0.1 % off)'),
    ).toThrow(/exceeds the/);
  });

  it('rejects a wrong frustum form and a wrong saddle split', () => {
    const fru = PRIMITIVES[3];
    const rf = runPrimitive(fru, latticeCloud(fru.z, 200));
    // Treating the frustum as a full prism of height h ignores the taper.
    expect(() => assertAgainstOracle(rf.fill, AREA * FRU_H, 2e-5, 'frustum (WRONG: A*h)')).toThrow();
    const sad = PRIMITIVES[5];
    const rs = runPrimitive(sad, latticeCloud(sad.z, 200));
    // A*h/4 is the mean |z| times area, twice the true one-sided mass.
    expect(() => assertAgainstOracle(rs.fill, (AREA * SAD_H) / 4, 1e-6, 'saddle (WRONG: A*h/4)')).toThrow();
  });
});
