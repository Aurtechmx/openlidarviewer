/**
 * invariantMeasurement.test.ts
 *
 * Metamorphic (invariance) tests for the measurement estimators. These check
 * relations that must hold when the INPUT is transformed, which covers the
 * cases where no exact oracle exists: the point-sample cut/fill integral has
 * no closed form over an arbitrary cloud, but its response to a rigid motion,
 * a uniform scale, or a reordering of the same points is fully determined.
 *
 * Targets: `distance` / `polylineLength` / `polygonPerimeter` /
 * `polygonAreaPlanar` / `polygonAreaHorizontal` (geometry.ts),
 * `polygonHorizontalArea` / `volumeCutFill` (volume.ts), `signedArea2D`
 * (polygonHygiene.ts) and `stockpileVolume` (stockpileVolume.ts).
 *
 * WHAT THE ESTIMATOR IS, AND WHICH RELATIONS FOLLOW. `volumeCutFill` is a 2.5D
 * height-field integral: it buckets each in-polygon point's Δz = z − referenceZ
 * and scales the sums by polygonArea / pointsInPolygon. So:
 *
 *   • rotation about the UP axis is a symmetry (heights untouched, footprint
 *     congruent) and is asserted;
 *   • rotation about X or Y is NOT a symmetry. Tipping the solid relative to
 *     the horizontal reference plane changes the volume above that plane, and
 *     the suite pins that it changes rather than asserting a false invariance;
 *   • vertical translation is a symmetry only when referenceZ moves with the
 *     cloud. Moving the cloud alone is pinned by the sharper arithmetic
 *     identity Δfill = footprintArea · Δz;
 *   • uniform scale s applied to cloud, polygon and referenceZ gives s³
 *     (area s², Δz s, point count unchanged).
 *
 * FIXTURE COORDINATES ARE DYADIC (multiples of 1/256, magnitudes below 2^15).
 * Every such value is exact in float32, and stays exact under translation by
 * another dyadic value and under scaling by a power of two. That keeps the
 * translation and power-of-two-scale relations free of float32 storage error,
 * so those cases measure the estimator rather than the buffer format. The
 * rotation and arbitrary-scale cases cannot be made exact and carry
 * tolerances sized from the observed deviations recorded beside each constant.
 *
 * RANDOMNESS. `Math.random` is banned in this repo; the transforms come from a
 * fixed-seed mulberry32 defined below, so every case is reproducible.
 */

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/render/navMath';
import {
  distance,
  polygonAreaHorizontal,
  polygonAreaPlanar,
  polygonPerimeter,
  polylineLength,
} from '../src/render/measure/geometry';
import { polygonHorizontalArea, volumeCutFill } from '../src/render/measure/volume';
import { signedArea2D } from '../src/render/measure/polygonHygiene';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';

// ── deterministic PRNG ──────────────────────────────────────────────────────

/** mulberry32. Fixed seed in, identical stream out, on every platform. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── tolerances, each sized from the measured worst case ─────────────────────

/** Rigid transforms of scalar lengths and planar areas. Observed worst 1.5e-15. */
const TOL_RIGID = 1e-13;
/** Rotation about up applied to the cut/fill integral. Observed worst 2.9e-16. */
const TOL_ROT_VOLUME = 1e-12;
/** Translation of a shoelace area, offsets to 1e6. Observed worst 1.5e-12. */
const TOL_TRANSLATE_AREA = 1e-11;
/**
 * Arbitrary (non-power-of-two) uniform scale of the cut/fill integral.
 * Observed worst 4.0e-9. The scaled cloud is re-quantised to float32, which
 * perturbs every Δz by up to |z|·2^-24; over ~1150 in-polygon points that
 * accumulates to roughly 1e-8 relative, so 1e-7 leaves one decade of headroom.
 */
const TOL_SCALE_F32 = 1e-7;
/**
 * The same scale sweep applied to `stockpileVolume`'s uncertainty band. The
 * band is roughly five times more sensitive to input quantisation than the
 * volume it qualifies, and the amplification is traceable rather than
 * mysterious: `basePlaneError` carries 16800 of the fixture's sigma of 16885,
 * and it is area x baseUncertainty, where baseUncertainty is the gap between
 * the ground band's mean (-10.3) and the low-percentile base (-14.33). A
 * float32 perturbation of the heights therefore lands on a difference of two
 * nearby values, amplified by 14.33 / 4.04 = 3.5. Measured over 200 scales in
 * [0.2, 5.2]: volume 2.8e-8, meanThickness 2.8e-8, baseZ 4.7e-8,
 * baseUncertainty 1.6e-7, sigma 1.6e-7, relativeError 1.3e-7. The power-of-two
 * cases below are exact, which is what confirms this is quantisation of the
 * scaled cloud and not a defect in the relation.
 */
const TOL_SCALE_BAND = 1e-6;
/**
 * Reordering the point buffer. Observed worst 1.9e-14 over 1144 in-polygon
 * points, 3.4e-15 over 24080. The bound for naive summation is N·ε, i.e.
 * ~2.5e-13 at N = 1144, and `net` amplifies that by fill/|net|.
 */
const TOL_PERMUTATION = 1e-12;

// ── assertion helpers ───────────────────────────────────────────────────────

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}

/**
 * Relative-closeness assertion that THROWS rather than calling `expect`, so the
 * negative controls at the bottom of the file can wrap the identical call in
 * `expect(...).toThrow()` and prove the check rejects a wrong relation.
 */
function assertRelClose(actual: number, expected: number, tol: number, label: string): void {
  const rd = relDiff(actual, expected);
  if (!(rd <= tol)) {
    throw new Error(
      `${label}: relative deviation ${rd.toExponential(3)} exceeds ${tol.toExponential(3)} ` +
        `(actual ${actual}, expected ${expected})`,
    );
  }
}

/** Closeness against an explicit magnitude scale, for quantities that cancel. */
function assertScaledClose(
  actual: number,
  expected: number,
  scale: number,
  tol: number,
  label: string,
): void {
  const ad = Math.abs(actual - expected);
  if (!(ad <= tol * Math.abs(scale))) {
    throw new Error(
      `${label}: deviation ${ad.toExponential(3)} exceeds ${(tol * Math.abs(scale)).toExponential(3)} ` +
        `(actual ${actual}, expected ${expected}, scale ${scale})`,
    );
  }
}

// ── linear algebra ──────────────────────────────────────────────────────────

type Mat3 = readonly [Vec3, Vec3, Vec3];

/** Rodrigues rotation matrix about an arbitrary axis. */
function rotation(axis: Vec3, angle: number): Mat3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  const x = axis[0] / len;
  const y = axis[1] / len;
  const z = axis[2] / len;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

function apply(m: Mat3, p: Vec3): Vec3 {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
  ];
}

function translate(p: Vec3, d: Vec3): Vec3 {
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}

function scaled(p: Vec3, s: number): Vec3 {
  return [p[0] * s, p[1] * s, p[2] * s];
}

/** Snap to a multiple of 1/256; see the dyadic note in the file docstring. */
const q = (v: number): number => Math.round(v * 256) / 256;

// ── polygon fixture and guarded point generation ────────────────────────────

interface Edge {
  readonly nx: number;
  readonly ny: number;
  readonly vx: number;
  readonly vy: number;
}

/** Convex regular n-gon centred on the origin, dyadic vertices. */
function regularRing(n: number, radius: number, phase: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    out.push([q(radius * Math.cos(a)), q(radius * Math.sin(a)), 0]);
  }
  return out;
}

/** Outward unit normals of a convex ring, anchored at each edge's start. */
function edgesOf(ring: ReadonlyArray<Vec3>): Edge[] {
  const out: Edge[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    out.push({ nx: dy / len, ny: -dx / len, vx: a[0], vy: a[1] });
  }
  return out;
}

/**
 * max_i n_i · (p − v_i) for a convex ring. Negative inside, and its magnitude
 * is a lower bound on the distance from p to the ring in both directions, so
 * rejecting |value| <= guard leaves every generated point at least `guard`
 * clear of the boundary. Without that band, a point sitting a nanometre inside
 * an edge can cross it under a rotation and change `pointsInPolygon`, which
 * would read as a broken invariance instead of a boundary coin-flip.
 */
function outsideMeasure(edges: ReadonlyArray<Edge>, x: number, y: number): number {
  let m = -Infinity;
  for (const e of edges) {
    const v = e.nx * (x - e.vx) + e.ny * (y - e.vy);
    if (v > m) m = v;
  }
  return m;
}

interface Cloud {
  readonly xyz: Float64Array;
  readonly count: number;
}

function buildCloud(
  seed: number,
  ring: ReadonlyArray<Vec3>,
  span: number,
  height: (x: number, y: number) => number,
  target: number,
  guard = 1e-3,
): Cloud {
  const rng = makeRng(seed);
  const edges = edgesOf(ring);
  const pts: number[] = [];
  while (pts.length < target * 3) {
    const x = q((rng() * 2 - 1) * span);
    const y = q((rng() * 2 - 1) * span);
    if (Math.abs(outsideMeasure(edges, x, y)) <= guard) continue;
    pts.push(x, y, q(height(x, y)));
  }
  return { xyz: Float64Array.from(pts), count: pts.length / 3 };
}

/** Materialise the cloud through a transform into the Float32Array the API takes. */
function emit(cloud: Cloud, fn: (p: Vec3) => Vec3): Float32Array {
  const out = new Float32Array(cloud.count * 3);
  for (let i = 0; i < cloud.count; i++) {
    const p = fn([cloud.xyz[i * 3], cloud.xyz[i * 3 + 1], cloud.xyz[i * 3 + 2]]);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

const identity = (p: Vec3): Vec3 => p;

/** Fisher-Yates over a copy of an interleaved xyz buffer. */
function shufflePoints(src: Float32Array, rng: () => number): Float32Array {
  const n = src.length / 3;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const out = new Float32Array(src.length);
  for (let i = 0; i < n; i++) {
    out[i * 3] = src[order[i] * 3];
    out[i * 3 + 1] = src[order[i] * 3 + 1];
    out[i * 3 + 2] = src[order[i] * 3 + 2];
  }
  return out;
}

// ── shared fixtures ─────────────────────────────────────────────────────────

const HEX = regularRing(6, 40, 0.17);
const HEPT = regularRing(7, 37.25, 0.4);
const SURFACE = (x: number, y: number): number =>
  8 + 18 * Math.sin(x / 11) * Math.cos(y / 13) + 0.4 * x - 0.25 * y;
/** Straddles the reference plane, so both `fill` and `cut` are exercised. */
const CLOUD = buildCloud(0x51ed, HEX, 60, SURFACE, 4000);
const REF_Z = 8;
/** Entirely above z = 0, the precondition for the Δfill = area · Δz identity. */
const ABOVE = buildCloud(0x77aa, HEX, 60, (x, y) => 30 + 10 * Math.sin(x / 9) * Math.cos(y / 12), 3000);

const BASE = volumeCutFill({ polygon: HEX, referenceZ: REF_Z, positions: emit(CLOUD, identity) });
const ABOVE_BASE = volumeCutFill({ polygon: HEX, referenceZ: 0, positions: emit(ABOVE, identity) });

// ── case tables ─────────────────────────────────────────────────────────────

const UP_ANGLES = Array.from({ length: 12 }, (_, i) => (i / 12) * 2 * Math.PI + 0.031);

const RIGID_CASES = ((): { seed: number; m: Mat3; t: Vec3 }[] => {
  const rng = makeRng(0x9a17);
  return Array.from({ length: 16 }, (_, i) => ({
    seed: i,
    m: rotation([rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1], rng() * 2 * Math.PI),
    t: [(rng() * 2 - 1) * 900, (rng() * 2 - 1) * 900, (rng() * 2 - 1) * 900] as Vec3,
  }));
})();

const POINT_PAIRS = ((): { a: Vec3; b: Vec3 }[] => {
  const rng = makeRng(0x3f21);
  return Array.from({ length: 32 }, () => ({
    a: [(rng() * 2 - 1) * 90, (rng() * 2 - 1) * 90, (rng() * 2 - 1) * 90] as Vec3,
    b: [(rng() * 2 - 1) * 90, (rng() * 2 - 1) * 90, (rng() * 2 - 1) * 90] as Vec3,
  }));
})();

/** Exact in binary: the relations below hold bit for bit at these factors. */
const POW2_SCALES = [0.25, 0.5, 2, 4, 8];

const FREE_SCALES = ((): number[] => {
  const rng = makeRng(0x4242);
  return Array.from({ length: 12 }, () => 0.2 + rng() * 5);
})();

const DYADIC_SHIFTS = ((): Vec3[] => {
  const rng = makeRng(0x07);
  return Array.from(
    { length: 12 },
    () => [q((rng() * 2 - 1) * 500), q((rng() * 2 - 1) * 500), q((rng() * 2 - 1) * 200)] as Vec3,
  );
})();

// ── 1. DISTANCE ─────────────────────────────────────────────────────────────

describe('metamorphic: distance', () => {
  it('the fixture pairs are non-degenerate', () => {
    for (const { a, b } of POINT_PAIRS) expect(distance(a, b)).toBeGreaterThan(1);
  });

  it.each(RIGID_CASES.map((c) => [c.seed, c] as const))(
    'HOLDS: invariant under rigid transform %i (arbitrary 3D rotation + translation)',
    (_seed, c) => {
      for (const { a, b } of POINT_PAIRS) {
        const ta = translate(apply(c.m, a), c.t);
        const tb = translate(apply(c.m, b), c.t);
        assertRelClose(distance(ta, tb), distance(a, b), TOL_RIGID, 'distance rigid');
      }
    },
  );

  it.each(POW2_SCALES)('HOLDS: d(s·a, s·b) is bitwise s·d(a, b) at s = %f', (s) => {
    for (const { a, b } of POINT_PAIRS) {
      expect(distance(scaled(a, s), scaled(b, s))).toBe(distance(a, b) * s);
    }
  });

  it.each(FREE_SCALES)('HOLDS: d scales linearly at arbitrary s = %f', (s) => {
    for (const { a, b } of POINT_PAIRS) {
      assertRelClose(
        distance(scaled(a, s), scaled(b, s)),
        distance(a, b) * s,
        TOL_RIGID,
        'distance scale',
      );
    }
  });

  it.each(RIGID_CASES.map((c) => [c.seed, c] as const))(
    'HOLDS: polyline total and polygon perimeter are rigid-invariant, case %i',
    (_seed, c) => {
      const moved = HEX.map((p) => translate(apply(c.m, p), c.t));
      assertRelClose(polygonPerimeter(moved), polygonPerimeter(HEX), TOL_RIGID, 'perimeter rigid');
      assertRelClose(
        polylineLength(moved).total,
        polylineLength(HEX).total,
        TOL_RIGID,
        'polyline rigid',
      );
    },
  );

  it.each(POW2_SCALES)('HOLDS: perimeter scales as s at s = %f', (s) => {
    assertRelClose(
      polygonPerimeter(HEX.map((p) => scaled(p, s))),
      polygonPerimeter(HEX) * s,
      TOL_RIGID,
      'perimeter scale',
    );
  });
});

// ── 2. AREA ─────────────────────────────────────────────────────────────────

describe('metamorphic: area', () => {
  const XY = HEPT.map((p) => ({ x: p[0], y: p[1] }));
  const AREA_XY = polygonHorizontalArea(XY);

  it('the fixture ring encloses a non-trivial area', () => {
    expect(AREA_XY).toBeGreaterThan(1000);
  });

  it.each([1, 1e2, 1e3, 1e4, 1e5, 1e6])(
    'HOLDS: planimetric area invariant under horizontal translation, offsets to %f',
    (mag) => {
      const rng = makeRng(0x63);
      for (let k = 0; k < 12; k++) {
        const dx = (rng() * 2 - 1) * mag;
        const dy = (rng() * 2 - 1) * mag;
        assertRelClose(
          polygonHorizontalArea(XY.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
          AREA_XY,
          TOL_TRANSLATE_AREA,
          `area translate ${mag}`,
        );
      }
    },
  );

  it.each(UP_ANGLES)(
    'HOLDS: planimetric area invariant under rotation about up, theta = %f',
    (theta) => {
      const m = rotation([0, 0, 1], theta);
      const rot = HEPT.map((p) => apply(m, p));
      assertRelClose(
        polygonHorizontalArea(rot.map((p) => ({ x: p[0], y: p[1] }))),
        AREA_XY,
        TOL_RIGID,
        'area rotate about up (2D helper)',
      );
      assertRelClose(
        polygonAreaHorizontal(rot, [0, 0, 1]),
        AREA_XY,
        TOL_RIGID,
        'area rotate about up (Newell)',
      );
    },
  );

  it.each(FREE_SCALES)('HOLDS: A(s·P) = s²·A(P) at s = %f', (s) => {
    assertRelClose(
      polygonHorizontalArea(XY.map((p) => ({ x: p.x * s, y: p.y * s }))),
      AREA_XY * s * s,
      TOL_RIGID,
      'area scale',
    );
    assertRelClose(
      polygonAreaHorizontal(
        HEPT.map((p) => scaled(p, s)),
        [0, 0, 1],
      ),
      AREA_XY * s * s,
      TOL_RIGID,
      'area scale (Newell)',
    );
  });

  it('CONTRACT: the area helpers return an unsigned magnitude, so winding cannot change them', () => {
    // Pinned from the implementations, not assumed: polygonHorizontalArea and
    // polygonAreaHorizontal both wrap the shoelace/Newell sum in Math.abs, and
    // polygonAreaPlanar takes a vector magnitude. All three are winding-blind,
    // as is volumeCutFill (its footprint comes from validatePolygon's
    // absoluteArea and its inside test is the winding-free even-odd rule).
    const reversedXY = [...XY].reverse();
    const reversedRing = [...HEPT].reverse();
    expect(polygonHorizontalArea(reversedXY)).toBe(AREA_XY);
    expect(polygonAreaHorizontal(reversedRing, [0, 0, 1])).toBe(
      polygonAreaHorizontal(HEPT, [0, 0, 1]),
    );
    expect(polygonAreaPlanar(reversedRing)).toBe(polygonAreaPlanar(HEPT));
    expect(
      volumeCutFill({
        polygon: [...HEX].reverse(),
        referenceZ: REF_Z,
        positions: emit(CLOUD, identity),
      }).fill,
    ).toBe(BASE.fill);
  });

  it('CONTRACT: signedArea2D is the signed quantity and flips exactly under reversal', () => {
    const signed = signedArea2D(XY);
    expect(signed).not.toBe(0);
    expect(signedArea2D([...XY].reverse())).toBe(-signed);
    // The unsigned helper and the signed one agree in magnitude.
    assertRelClose(AREA_XY, Math.abs(signed), TOL_RIGID, 'shoelace agreement');
  });

  it.each(RIGID_CASES.map((c) => [c.seed, c] as const))(
    'HOLDS: own-plane (Newell) area is invariant under any rigid transform, case %i',
    (_seed, c) => {
      const moved = HEPT.map((p) => translate(apply(c.m, p), c.t));
      assertRelClose(polygonAreaPlanar(moved), polygonAreaPlanar(HEPT), TOL_RIGID, 'planar rigid');
    },
  );

  it.each([0, 15, 30, 45, 60, 75])(
    'HOLDS: projected area of a ring tilted %i deg off horizontal is cos(tilt) times its own-plane area',
    (deg) => {
      // The complement of the rotation-about-up invariance: a tilt is NOT a
      // symmetry of the map-plane area, and the factor it changes by is fixed.
      const rad = (deg * Math.PI) / 180;
      const tilted = HEPT.map((p) => apply(rotation([1, 0, 0], rad), p));
      assertRelClose(
        polygonAreaHorizontal(tilted, [0, 0, 1]),
        polygonAreaPlanar(HEPT) * Math.cos(rad),
        TOL_RIGID,
        `tilt ${deg}`,
      );
    },
  );
});

// ── 3. VOLUME ───────────────────────────────────────────────────────────────

describe('metamorphic: volumeCutFill', () => {
  it('the fixture exercises both sides of the reference plane', () => {
    expect(BASE.validity).toBe('ok');
    expect(BASE.pointsInPolygon).toBeGreaterThan(1000);
    expect(BASE.fill).toBeGreaterThan(0);
    expect(BASE.cut).toBeGreaterThan(0);
  });

  it.each(UP_ANGLES)(
    'HOLDS: invariant under rotation about the up axis (cloud and polygon together), theta = %f',
    (theta) => {
      const m = rotation([0, 0, 1], theta);
      const r = volumeCutFill({
        polygon: HEX.map((p) => apply(m, p)),
        referenceZ: REF_Z,
        positions: emit(CLOUD, (p) => apply(m, p)),
      });
      expect(r.pointsInPolygon).toBe(BASE.pointsInPolygon);
      assertRelClose(r.footprintArea, BASE.footprintArea, TOL_ROT_VOLUME, 'rotZ area');
      assertRelClose(r.fill, BASE.fill, TOL_ROT_VOLUME, 'rotZ fill');
      assertRelClose(r.cut, BASE.cut, TOL_ROT_VOLUME, 'rotZ cut');
      assertScaledClose(r.net, BASE.net, BASE.fill + BASE.cut, TOL_ROT_VOLUME, 'rotZ net');
    },
  );

  it.each([5, 10, 30])(
    'PINNED: tipping the scene %i deg about X is NOT a symmetry of a horizontal-plane estimator',
    (deg) => {
      // Rotating about X tilts the solid relative to the reference plane, so
      // the volume above that plane legitimately changes. Asserting invariance
      // here would be asserting a false relation; this pins that it moves, and
      // so confirms the relations above are testing a live quantity.
      const m = rotation([1, 0, 0], (deg * Math.PI) / 180);
      const r = volumeCutFill({
        polygon: HEX.map((p) => apply(m, p)),
        referenceZ: REF_Z,
        positions: emit(CLOUD, (p) => apply(m, p)),
      });
      expect(r.validity).toBe('ok');
      expect(relDiff(r.fill, BASE.fill)).toBeGreaterThan(0.05);
    },
  );

  it.each(DYADIC_SHIFTS.map((d, i) => [i, d] as const))(
    'HOLDS: invariant when cloud, polygon AND referenceZ translate together, case %i',
    (_i, d) => {
      const r = volumeCutFill({
        polygon: HEX.map((p) => translate(p, d)),
        referenceZ: REF_Z + d[2],
        positions: emit(CLOUD, (p) => translate(p, d)),
      });
      expect(r.pointsInPolygon).toBe(BASE.pointsInPolygon);
      assertRelClose(r.fill, BASE.fill, TOL_PERMUTATION, 'translate-together fill');
      assertRelClose(r.cut, BASE.cut, TOL_PERMUTATION, 'translate-together cut');
      assertScaledClose(
        r.net,
        BASE.net,
        BASE.fill + BASE.cut,
        TOL_PERMUTATION,
        'translate-together net',
      );
    },
  );

  it('the all-above fixture has no material below the plane', () => {
    expect(ABOVE_BASE.validity).toBe('ok');
    expect(ABOVE_BASE.cut).toBe(0);
    expect(ABOVE_BASE.pointsInPolygon).toBeGreaterThan(500);
  });

  it.each([1, 3, 16, 64])(
    'HOLDS: raising the cloud by %i with the plane held fixed adds exactly footprintArea · dz to fill',
    (t) => {
      // The sharper half of the vertical-translation relation: it pins the
      // arithmetic of the estimator rather than a symmetry. Valid only while
      // every in-polygon point stays above the plane, which the ABOVE fixture
      // guarantees (its heights start at 20 and the shift is upward).
      const r = volumeCutFill({
        polygon: HEX,
        referenceZ: 0,
        positions: emit(ABOVE, (p) => [p[0], p[1], p[2] + t]),
      });
      expect(r.pointsInPolygon).toBe(ABOVE_BASE.pointsInPolygon);
      expect(r.cut).toBe(0);
      assertRelClose(
        r.fill,
        ABOVE_BASE.fill + ABOVE_BASE.footprintArea * t,
        TOL_PERMUTATION,
        `fill shift ${t}`,
      );
    },
  );

  it.each(POW2_SCALES)(
    'HOLDS: uniform scale of cloud, polygon and referenceZ gives bitwise s³ at s = %f',
    (s) => {
      const r = volumeCutFill({
        polygon: HEX.map((p) => scaled(p, s)),
        referenceZ: REF_Z * s,
        positions: emit(CLOUD, (p) => scaled(p, s)),
      });
      expect(r.pointsInPolygon).toBe(BASE.pointsInPolygon);
      expect(r.footprintArea).toBe(BASE.footprintArea * s * s);
      expect(r.fill).toBe(BASE.fill * s * s * s);
      expect(r.cut).toBe(BASE.cut * s * s * s);
      expect(r.medianAbsDelta).toBe(BASE.medianAbsDelta * s);
    },
  );

  it.each(FREE_SCALES)('HOLDS: V(s) = s³·V at arbitrary s = %f', (s) => {
    const r = volumeCutFill({
      polygon: HEX.map((p) => scaled(p, s)),
      referenceZ: REF_Z * s,
      positions: emit(CLOUD, (p) => scaled(p, s)),
    });
    expect(r.pointsInPolygon).toBe(BASE.pointsInPolygon);
    assertRelClose(r.footprintArea, BASE.footprintArea * s * s, TOL_RIGID, 'scale area');
    assertRelClose(r.fill, BASE.fill * s ** 3, TOL_SCALE_F32, 'scale fill');
    assertRelClose(r.cut, BASE.cut * s ** 3, TOL_SCALE_F32, 'scale cut');
  });

  // PERMUTATION. Bitwise stability was measured, not assumed. Reordering the
  // buffer reorders a naive floating-point sum, and the sums do move: with a
  // reference plane that is not a dyadic rational the observed worst relative
  // deviation was 1.9e-14 over 1144 in-polygon points. It is 0 when every Δz
  // happens to be exactly representable, which is why the block below uses a
  // non-dyadic referenceZ instead of the shared fixture's integer plane; a
  // bitwise assertion would pass only by accident of the fixture.
  describe('permutation', () => {
    const PERM_REF_Z = 8.137424242;
    const SRC = emit(CLOUD, identity);
    const PERM_BASE = volumeCutFill({ polygon: HEX, referenceZ: PERM_REF_Z, positions: SRC });

    it.each([0, 1, 2, 3, 4, 5, 6, 7])('HOLDS to tolerance: shuffle %i', (trial) => {
      const rng = makeRng(0xc0de + trial);
      const r = volumeCutFill({
        polygon: HEX,
        referenceZ: PERM_REF_Z,
        positions: shufflePoints(SRC, rng),
      });
      expect(r.pointsInPolygon).toBe(PERM_BASE.pointsInPolygon);
      expect(r.footprintArea).toBe(PERM_BASE.footprintArea);
      assertRelClose(r.fill, PERM_BASE.fill, TOL_PERMUTATION, 'permute fill');
      assertRelClose(r.cut, PERM_BASE.cut, TOL_PERMUTATION, 'permute cut');
      assertScaledClose(
        r.net,
        PERM_BASE.net,
        PERM_BASE.fill + PERM_BASE.cut,
        TOL_PERMUTATION,
        'permute net',
      );
    });

    it('PINNED: medianAbsDelta is bitwise permutation-stable below the 10 000 reservoir cap', () => {
      for (let trial = 0; trial < 4; trial++) {
        const r = volumeCutFill({
          polygon: HEX,
          referenceZ: PERM_REF_Z,
          positions: shufflePoints(SRC, makeRng(0xfeed + trial)),
        });
        expect(r.pointsInPolygon).toBeLessThan(10_000);
        expect(r.medianAbsDelta).toBe(PERM_BASE.medianAbsDelta);
      }
    });

    it('PINNED: medianAbsDelta is NOT permutation-stable above the reservoir cap', () => {
      // volume.ts reservoir-samples |Δz| into a 10 000-slot buffer once more
      // than that many points land inside the footprint, drawing slots from a
      // fixed-seed xorshift keyed to encounter order. Reordering the buffer
      // therefore selects a different sample and moves the median, while the
      // fill/cut sums stay within summation noise. Measured at 24 080 inside
      // points: median deviates by ~1.7e-2 relative, fill by 3.4e-15.
      const big = buildCloud(0xbeef, HEX, 44, SURFACE, 45_000);
      const src = emit(big, identity);
      const base = volumeCutFill({ polygon: HEX, referenceZ: PERM_REF_Z, positions: src });
      expect(base.pointsInPolygon).toBeGreaterThan(10_000);

      let medianMoved = false;
      for (let trial = 0; trial < 4; trial++) {
        const r = volumeCutFill({
          polygon: HEX,
          referenceZ: PERM_REF_Z,
          positions: shufflePoints(src, makeRng(0xabc + trial)),
        });
        expect(r.pointsInPolygon).toBe(base.pointsInPolygon);
        assertRelClose(r.fill, base.fill, TOL_PERMUTATION, 'big permute fill');
        assertRelClose(r.cut, base.cut, TOL_PERMUTATION, 'big permute cut');
        if (r.medianAbsDelta !== base.medianAbsDelta) medianMoved = true;
        // The drift is a resampling effect, not divergence: it stays small
        // against the median itself.
        expect(relDiff(r.medianAbsDelta, base.medianAbsDelta)).toBeLessThan(0.1);
      }
      expect(medianMoved).toBe(true);
    });
  });
});

// ── 4. STOCKPILE ────────────────────────────────────────────────────────────

describe('metamorphic: stockpileVolume', () => {
  const SP_BASE = stockpileVolume({ polygon: HEX, positions: emit(CLOUD, identity) });

  it('the fixture produces a real band', () => {
    expect(SP_BASE.validity).toBe('ok');
    expect(SP_BASE.volume).toBeGreaterThan(0);
    expect(SP_BASE.sigma).toBeGreaterThan(0);
  });

  it.each(UP_ANGLES)('HOLDS: invariant under rotation about the up axis, theta = %f', (theta) => {
    const m = rotation([0, 0, 1], theta);
    const r = stockpileVolume({
      polygon: HEX.map((p) => apply(m, p)),
      positions: emit(CLOUD, (p) => apply(m, p)),
    });
    assertRelClose(r.volume, SP_BASE.volume, TOL_ROT_VOLUME, 'stockpile rotZ volume');
    assertRelClose(r.sigma, SP_BASE.sigma, TOL_ROT_VOLUME, 'stockpile rotZ sigma');
    assertRelClose(
      r.breakdown.baseZ,
      SP_BASE.breakdown.baseZ,
      TOL_ROT_VOLUME,
      'stockpile rotZ baseZ',
    );
  });

  it.each([-37, 12, 250])(
    'HOLDS: invariant under a vertical shift of %i, since the inferred base follows the cloud',
    (t) => {
      // The default base mode is lowest-percentile of the inside heights, so
      // the reference plane translates with the cloud and the pile volume is
      // unchanged. This is the "cloud and plane move together" relation with
      // the plane supplied implicitly.
      const r = stockpileVolume({
        polygon: HEX,
        positions: emit(CLOUD, (p) => [p[0], p[1], p[2] + t]),
      });
      assertRelClose(r.volume, SP_BASE.volume, TOL_PERMUTATION, 'stockpile shift volume');
      assertRelClose(r.sigma, SP_BASE.sigma, TOL_PERMUTATION, 'stockpile shift sigma');
      assertRelClose(
        r.breakdown.baseZ,
        SP_BASE.breakdown.baseZ + t,
        TOL_PERMUTATION,
        'stockpile shift baseZ',
      );
    },
  );

  it.each(POW2_SCALES)(
    'HOLDS: volume is bitwise s³ and relativeError is invariant at s = %f',
    (s) => {
      const r = stockpileVolume({
        polygon: HEX.map((p) => scaled(p, s)),
        positions: emit(CLOUD, (p) => scaled(p, s)),
      });
      expect(r.volume).toBe(SP_BASE.volume * s * s * s);
      expect(r.sigma).toBe(SP_BASE.sigma * s * s * s);
      expect(r.breakdown.footprintArea).toBe(SP_BASE.breakdown.footprintArea * s * s);
      expect(r.breakdown.meanThickness).toBe(SP_BASE.breakdown.meanThickness * s);
      // A ratio of two quantities that both scale as s³ carries no units.
      expect(r.relativeError).toBe(SP_BASE.relativeError);
    },
  );

  it.each(FREE_SCALES)('HOLDS: volume is s³ at arbitrary s = %f', (s) => {
    const r = stockpileVolume({
      polygon: HEX.map((p) => scaled(p, s)),
      positions: emit(CLOUD, (p) => scaled(p, s)),
    });
    expect(r.breakdown.pointsInPolygon).toBe(SP_BASE.breakdown.pointsInPolygon);
    assertRelClose(r.volume, SP_BASE.volume * s ** 3, TOL_SCALE_F32, 'stockpile scale volume');
    assertRelClose(
      r.breakdown.meanThickness,
      SP_BASE.breakdown.meanThickness * s,
      TOL_SCALE_F32,
      'stockpile scale meanThickness',
    );
    // The band quantities get the wider TOL_SCALE_BAND; see its docstring for
    // where the extra factor comes from.
    assertRelClose(r.sigma, SP_BASE.sigma * s ** 3, TOL_SCALE_BAND, 'stockpile scale sigma');
    assertRelClose(
      r.breakdown.baseUncertainty,
      SP_BASE.breakdown.baseUncertainty * s,
      TOL_SCALE_BAND,
      'stockpile scale baseUncertainty',
    );
    assertRelClose(
      r.relativeError,
      SP_BASE.relativeError,
      TOL_SCALE_BAND,
      'stockpile scale relativeError',
    );
  });

  it('CHARACTERISED: the band is more scale-sensitive than the volume, and both stay bounded', () => {
    // Guards the tolerance split above: if a future change made the band and
    // the volume equally stable, or made either drift past its bound, this
    // records it instead of the split silently becoming folklore.
    const rng = makeRng(0x5150);
    let worstVolume = 0;
    let worstBand = 0;
    for (let k = 0; k < 60; k++) {
      const s = 0.2 + rng() * 5;
      const r = stockpileVolume({
        polygon: HEX.map((p) => scaled(p, s)),
        positions: emit(CLOUD, (p) => scaled(p, s)),
      });
      worstVolume = Math.max(worstVolume, relDiff(r.volume, SP_BASE.volume * s ** 3));
      worstBand = Math.max(worstBand, relDiff(r.sigma, SP_BASE.sigma * s ** 3));
    }
    expect(worstVolume).toBeLessThan(TOL_SCALE_F32);
    expect(worstBand).toBeLessThan(TOL_SCALE_BAND);
    expect(worstBand).toBeGreaterThan(worstVolume);
  });
});

// ── 5. NEGATIVE CONTROLS ────────────────────────────────────────────────────

describe('metamorphic: negative controls', () => {
  // Each control feeds a deliberately wrong right-hand side through the SAME
  // assertion helper the positive tests use, and requires it to reject. A
  // suite whose checks cannot fail proves nothing about the ones that pass.

  it('rejects s² where the volume relation is s³', () => {
    const s = 2;
    const r = volumeCutFill({
      polygon: HEX.map((p) => scaled(p, s)),
      referenceZ: REF_Z * s,
      positions: emit(CLOUD, (p) => scaled(p, s)),
    });
    assertRelClose(r.fill, BASE.fill * s ** 3, TOL_SCALE_F32, 'control ok');
    expect(() => assertRelClose(r.fill, BASE.fill * s ** 2, TOL_SCALE_F32, 'control s^2')).toThrow(
      /relative deviation/,
    );
    expect(() => assertRelClose(r.fill, BASE.fill * s ** 4, TOL_SCALE_F32, 'control s^4')).toThrow(
      /relative deviation/,
    );
  });

  it('rejects a halved coefficient in fill-shift = footprintArea · dz', () => {
    const t = 16;
    const r = volumeCutFill({
      polygon: HEX,
      referenceZ: 0,
      positions: emit(ABOVE, (p) => [p[0], p[1], p[2] + t]),
    });
    assertRelClose(
      r.fill,
      ABOVE_BASE.fill + ABOVE_BASE.footprintArea * t,
      TOL_PERMUTATION,
      'control ok',
    );
    expect(() =>
      assertRelClose(
        r.fill,
        ABOVE_BASE.fill + ABOVE_BASE.footprintArea * t * 0.5,
        TOL_PERMUTATION,
        'control half-coefficient',
      ),
    ).toThrow(/relative deviation/);
    // A tolerance loose enough to admit a wrong coefficient would be the real
    // failure mode, so pin how far off the wrong answer actually is.
    expect(relDiff(r.fill, ABOVE_BASE.fill + ABOVE_BASE.footprintArea * t * 0.5)).toBeGreaterThan(
      0.1,
    );
  });

  it('rejects s² where the distance relation is s', () => {
    const s = 3;
    const { a, b } = POINT_PAIRS[0];
    const d = distance(scaled(a, s), scaled(b, s));
    assertRelClose(d, distance(a, b) * s, TOL_RIGID, 'control ok');
    expect(() => assertRelClose(d, distance(a, b) * s * s, TOL_RIGID, 'control s^2')).toThrow(
      /relative deviation/,
    );
  });

  it('rejects a single perturbed point in the permutation relation', () => {
    // Shuffling must not change the sums; changing one height must. Without
    // this the permutation test could pass against a stub that ignores input.
    const src = emit(CLOUD, identity);
    const perturbed = shufflePoints(src, makeRng(0x1111));
    perturbed[2] = perturbed[2] + 25;
    const r = volumeCutFill({ polygon: HEX, referenceZ: REF_Z, positions: perturbed });
    expect(() => assertRelClose(r.fill, BASE.fill, TOL_PERMUTATION, 'control perturbed')).toThrow(
      /relative deviation/,
    );
  });

  it('the scaled-close helper rejects a deviation past its scale', () => {
    assertScaledClose(1.0000001, 1, 1000, 1e-6, 'control ok');
    expect(() => assertScaledClose(1.1, 1, 1, 1e-6, 'control')).toThrow(/deviation/);
  });
});

