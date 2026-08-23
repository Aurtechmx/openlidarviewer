/**
 * tests/profileMetamorphic.test.ts
 *
 * Metamorphic coverage for the profile sampler's geometry. Each test relates
 * `sampleProfile`'s output on one reference scene to its output on the SAME
 * scene after a rigid rotation, a translation, an endpoint swap, or a uniform
 * scale. These are internal consistency properties, not an independent
 * measurement: `profileAnalyticalFixtures.test.ts` remains the evidence for the
 * sampler's numbers. What this file adds is that those numbers follow the scene
 * when the scene moves, which a set of Z-up-only fixtures cannot show.
 *
 * Two facts about the reference (Z-up) frame are asserted directly, because a
 * sampler wrong the same way in every frame would satisfy every relation below:
 *
 *   - the corridor is a capsule CLOSED at both endpoints (a point past an end
 *     is held to its distance from that endpoint, not to its perpendicular
 *     offset), and
 *   - the section frame's lateral axis is the right-handed `up x along`.
 *
 * Every other assertion here is a relation between two sampler runs.
 *
 * Determinism: the cloud is a hard-coded lattice of dyadic (power-of-two
 * denominator) coordinates, so packing it into a Float32Array is lossless and
 * the reference run carries no quantisation error of its own. No random numbers.
 */

import { describe, it, expect } from 'vitest';
import { sampleProfile, type ProfileSample } from '../src/render/measure/profileSampler';
import {
  buildProfileFrame,
  projectPointToProfile,
} from '../src/render/measure/profileGeometry';

type V3 = [number, number, number];
/** Row-major 3x3. */
type Mat3 = readonly [V3, V3, V3];

const Z_UP: V3 = [0, 0, 1];

/** Build an interleaved x/y/z Float32Array from a list of [x,y,z] tuples. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

function applyMat(m: Mat3, v: V3): V3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  const row = (r: number): V3 => [
    a[r][0] * b[0][0] + a[r][1] * b[1][0] + a[r][2] * b[2][0],
    a[r][0] * b[0][1] + a[r][1] * b[1][1] + a[r][2] * b[2][1],
    a[r][0] * b[0][2] + a[r][1] * b[1][2] + a[r][2] * b[2][2],
  ];
  return [row(0), row(1), row(2)];
}

function rotX(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}
function rotY(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}
function rotZ(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function add(v: V3, t: V3): V3 {
  return [v[0] + t[0], v[1] + t[1], v[2] + t[2]];
}
function scaled(v: V3, k: number): V3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** Largest absolute coordinate, floored at 1: the scale a point's float error rides on. */
function magnitude(p: V3): number {
  return Math.max(1, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
}

// ── The reference scene ──────────────────────────────────────────────────────
//
// Section a -> b along +X, 48 units long, 25 bins, so `binStep` is exactly 2.
// Corridor half-width 1.5. Every corridor point sits on a bin CENTRE at a
// lateral offset of at most 0.875, leaving 1.0 of margin to the nearest bin
// boundary and 0.625 to the band edge. Those margins are what let the per-bin
// counts be compared EXACTLY across transforms: the float32 quantisation an
// oblique rotation introduces is bounded by 3.3e-6 and measures 1.1e-6 at these
// coordinate magnitudes (see ROTATED_TOL), five orders of magnitude below the
// smallest margin, so no point can cross a bin boundary or the band edge.

const REF_A: V3 = [0, 0, 0];
const REF_B: V3 = [48, 0, 0];
const SAMPLES = 25;
const BIN_STEP = 2;
const BAND = 1.5;
/** Bins deliberately left with no corridor point, so the run carries NaN gaps. */
const EMPTY_BINS = new Set([7, 8, 9, 17]);
/** Populated bins whose corridor also holds one class-5 (high vegetation) return. */
const VEG_BINS = new Set([1, 5, 13, 21]);
/** Populated bins that also carry off-corridor strays at a lateral offset of 4. */
const STRAY_BINS = new Set([3, 12, 21]);

/** Deterministic per-bin ground elevation. Multiples of 0.25 in [1, 3.5]. */
function baseHeight(bin: number): number {
  return 1 + 0.25 * ((bin * 5) % 11);
}

/**
 * The reference cloud, in the Z-up frame. Four populations:
 *
 *   corridor    3 returns per populated bin, on the bin centre, at lateral
 *               -0.875 / 0 / +0.875 and elevations base / base+0.125 /
 *               base+0.375.
 *   vegetation  1 class-5 return 8 units above the ground in VEG_BINS, inside
 *               the corridor, so it feeds the bin unless classification is
 *               supplied.
 *   strays      lateral offset 4.0 (2.5 outside the band) at elevation 900.
 *               Rejected by the corridor test in every frame.
 *   decoys      past the ends: chainage 49.375 (3 returns) and -1.375 (2), at
 *               lateral offsets of 1.25 or 1.375. Each is inside the INFINITE
 *               band of half-width 1.5 yet outside the capsule, its distance to
 *               the nearer endpoint being 1.858 or 1.944. The two ends carry
 *               different counts on purpose, so a corridor capped at only one
 *               end changes the accepted set under an endpoint swap.
 */
function referenceScene(): { points: V3[]; classes: number[] } {
  const points: V3[] = [];
  const classes: number[] = [];
  const push = (p: V3, cls: number): void => {
    points.push(p);
    classes.push(cls);
  };
  for (let bin = 0; bin < SAMPLES; bin++) {
    if (EMPTY_BINS.has(bin)) continue;
    const x = bin * BIN_STEP;
    const h = baseHeight(bin);
    push([x, -0.875, h], 2);
    push([x, 0, h + 0.125], 2);
    push([x, 0.875, h + 0.375], 2);
    if (VEG_BINS.has(bin)) push([x, 0.25, h + 8], 5);
    if (STRAY_BINS.has(bin)) {
      push([x, 4, 900], 2);
      push([x, -4, 900], 2);
    }
  }
  push([49.375, 1.375, 500], 2);
  push([49.375, -1.375, 500.25], 2);
  push([49.375, 1.25, 500.5], 2);
  push([-1.375, 1.375, -500], 2);
  push([-1.375, -1.375, -500.25], 2);
  return { points, classes };
}

const SCENE = referenceScene();

/** Corridor count the reference frame gives a bin, with no classification gate. */
function expectedCount(bin: number): number {
  if (EMPTY_BINS.has(bin)) return 0;
  return 3 + (VEG_BINS.has(bin) ? 1 : 0);
}

/** Sample the scene after applying `xform` to every point; a, b and up as given. */
function runTransformed(
  xform: (p: V3) => V3,
  a: V3,
  b: V3,
  up: V3,
  band: number,
  opts: { classified?: boolean; percentile?: number } = {},
): ProfileSample[] {
  return sampleProfile({
    a,
    b,
    up,
    positions: pack(SCENE.points.map(xform)),
    samples: SAMPLES,
    bandWidth: band,
    groundPercentile: opts.percentile ?? 0,
    classification: opts.classified ? Uint8Array.from(SCENE.classes) : null,
  });
}

/**
 * The reference run. `groundPercentile: 0` is the strict floor, so a height is
 * an ORDER STATISTIC of the corridor rather than an interpolation between two
 * of them. That matters for the exactness claims below: the type-7
 * interpolation `lo*(1-w) + hi*w` is not exactly equivariant under translation
 * or under a non-dyadic scale, whereas selecting a member of the set is. The
 * interpolating path is exercised separately at percentile 25.
 */
const REFERENCE = runTransformed((p) => p, REF_A, REF_B, Z_UP, BAND);

// ── Tolerances ───────────────────────────────────────────────────────────────
//
// FLOAT64_TOL: the sampler's scalars (`distance`, and a height once the
// percentile interpolates) are float64 throughout, and `projectPointToProfile`
// reads the float64 tuples directly, never a Float32Array. Reassociating a dot
// product or a linear interpolation costs a few ulps of the result magnitude.
// The largest magnitude compared below at this tolerance is the section length,
// 48, whose ulp is 7.1e-15; a few of those with headroom is 1e-12. Where the
// compared magnitude is larger (a stray point at 900, a scene scaled by 1000)
// the bound is applied RELATIVELY rather than widened for everything.
// Measured worst cases: 1.4e-14 on a bin distance under an oblique rotation,
// 7.1e-15 on a horizontal length, 3.9e-16 relative on a point projection. Every
// other FLOAT64_TOL relation in this file came out bit-exact (residual 0).
const FLOAT64_TOL = 1e-12;
//
// ROTATED_TOL: an oblique rotation sends dyadic coordinates to irrational ones,
// which the Float32Array packing then rounds, so it applies only to quantities
// the sampler reads out of `positions`. Every ACCEPTED point of the reference
// scene has |coordinate| <= 48.2, so its rotated components land in the binade
// [32, 64) at worst, where the float32 ulp is 2^-18 = 3.8e-6 and the rounding
// error is at most half of that, 1.9e-6. A height is a unit-vector dot product
// of three such components, so its error is bounded by sqrt(3) * 1.9e-6 =
// 3.3e-6. 1e-5 is that bound with a factor of 3 of headroom. Measured worst
// cases over the four rotations of this scene: 1.1e-6 on a per-bin height at
// the strict floor, 7.1e-7 at percentile 25, and 1.5e-6 for a translation
// applied in an oblique frame (both legs quantised, so twice the error).
const ROTATED_TOL = 1e-5;

/** Assert two sample series agree, bin for bin, on which bins are gaps. */
function expectSameGaps(actual: ProfileSample[], expected: ProfileSample[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Number.isNaN(actual[i].height)).toBe(Number.isNaN(expected[i].height));
  }
}

/** Total accepted points: every accepted point lands in exactly one bin. */
function totalCount(series: ProfileSample[]): number {
  return series.reduce((acc, s) => acc + (s.count ?? 0), 0);
}

describe('profile sampler: anchored facts in the reference frame', () => {
  it('gives every populated bin exactly its corridor points and every empty bin a NaN gap', () => {
    expect(REFERENCE).toHaveLength(SAMPLES);
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(REFERENCE[bin].count).toBe(expectedCount(bin));
      expect(Number.isNaN(REFERENCE[bin].height)).toBe(EMPTY_BINS.has(bin));
      expect(REFERENCE[bin].distance).toBe(bin * BIN_STEP);
    }
  });

  it('closes the corridor at BOTH endpoints, so the beyond-end returns are rejected', () => {
    // The five decoys sit inside the infinite band of half-width 1.5 and would
    // clamp into the first and last bins if the corridor were not capped. Bins
    // 0 and 24 holding exactly their three corridor returns is the statement
    // that the corridor is a capsule; the transforms below carry it to every
    // other frame.
    expect(REFERENCE[0].count).toBe(3);
    expect(REFERENCE[SAMPLES - 1].count).toBe(3);
    expect(REFERENCE[0].height).toBe(baseHeight(0));
    expect(REFERENCE[SAMPLES - 1].height).toBe(baseHeight(SAMPLES - 1));
  });

  it('rejects the off-corridor strays, so no bin reads their elevation', () => {
    for (const bin of STRAY_BINS) {
      expect(REFERENCE[bin].count).toBe(expectedCount(bin));
    }
    for (const sample of REFERENCE) {
      if (Number.isNaN(sample.height)) continue;
      expect(sample.height).toBeGreaterThan(0);
      expect(sample.height).toBeLessThan(20);
    }
  });

  it('orients the lateral axis as the right-handed up x along', () => {
    // up = +Z and along = +X give lateral = Z x X = +Y, so a point on the +Y
    // side of the section has a POSITIVE lateral offset. Every signed-offset
    // relation below is anchored on this.
    const frame = buildProfileFrame(REF_A, REF_B, Z_UP);
    expect(frame.lateral[0]).toBe(0);
    expect(frame.lateral[1]).toBe(1);
    expect(frame.lateral[2]).toBe(0);
    expect(projectPointToProfile(frame, [24, 0.875, 3]).lateralOffset).toBeGreaterThan(0);
    expect(projectPointToProfile(frame, [24, -0.875, 3]).lateralOffset).toBeLessThan(0);
  });
});

// ── Invariant 1: rigid rotation ──────────────────────────────────────────────

interface Orientation {
  readonly name: string;
  /** null = the reference Z-up frame. */
  readonly m: Mat3 | null;
  /** True when the matrix holds only 0 and +/-1, so it acts on float exactly. */
  readonly exact: boolean;
}

const ROTATIONS: readonly Orientation[] = [
  // Z-up to Y-up: (x, y, z) -> (x, z, -y). Entries are 0 and +/-1, so both the
  // rotation and the Float32Array packing of its output are lossless.
  {
    name: 'Z-up to Y-up (-90 degrees about X)',
    m: [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    exact: true,
  },
  // Z-up to X-up: the cyclic permutation (x, y, z) -> (z, x, y), a 120-degree
  // rotation about [1, 1, 1]. Also lossless.
  {
    name: 'Z-up to X-up (120 degrees about [1,1,1])',
    m: [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    exact: true,
  },
  {
    name: 'oblique yaw 37 / pitch 23 / roll 61',
    m: mulMat(mulMat(rotZ(37), rotY(23)), rotX(61)),
    exact: false,
  },
  {
    name: 'oblique yaw -114.5 / roll 41.75',
    m: mulMat(rotZ(-114.5), rotX(41.75)),
    exact: false,
  },
];

const ORIENTATIONS: readonly Orientation[] = [
  { name: 'reference Z-up frame', m: null, exact: true },
  ...ROTATIONS,
];

/** Apply an orientation, treating a null matrix as the identity. */
function orient(o: Orientation, v: V3): V3 {
  return o.m ? applyMat(o.m, v) : v;
}

describe('Invariant 1: rigid rotation of the whole scene', () => {
  it.each(ROTATIONS)('is orthonormal and right-handed: $name', (rot) => {
    const m = rot.m!;
    // R R^T = I to within float64 rounding of a three-term dot product.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const d = m[i][0] * m[j][0] + m[i][1] * m[j][1] + m[i][2] * m[j][2];
        expect(d).toBeCloseTo(i === j ? 1 : 0, 14);
      }
    }
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    expect(det).toBeCloseTo(1, 14);
  });

  it.each(ROTATIONS)('leaves chainage, counts and heights unchanged: $name', (rot) => {
    const tol = rot.exact ? FLOAT64_TOL : ROTATED_TOL;
    const out = runTransformed(
      (p) => orient(rot, p),
      orient(rot, REF_A),
      orient(rot, REF_B),
      orient(rot, Z_UP),
      BAND,
    );
    for (let bin = 0; bin < SAMPLES; bin++) {
      // Counts are the sharpest signal available: they are integers, so
      // "unchanged" needs no tolerance at all.
      expect(out[bin].count).toBe(REFERENCE[bin].count);
      expect(Math.abs(out[bin].distance - REFERENCE[bin].distance)).toBeLessThan(FLOAT64_TOL);
      if (Number.isNaN(REFERENCE[bin].height)) continue;
      expect(Math.abs(out[bin].height - REFERENCE[bin].height)).toBeLessThan(tol);
    }
    expectSameGaps(out, REFERENCE);
  });

  it.each(ROTATIONS)('leaves the interpolating percentile unchanged too: $name', (rot) => {
    // Percentile 25 lands between two order statistics for a 3- or 4-point
    // corridor, so this covers the interpolating branch the strict floor skips.
    const tol = rot.exact ? FLOAT64_TOL : ROTATED_TOL;
    const base = runTransformed((p) => p, REF_A, REF_B, Z_UP, BAND, { percentile: 25 });
    const out = runTransformed(
      (p) => orient(rot, p),
      orient(rot, REF_A),
      orient(rot, REF_B),
      orient(rot, Z_UP),
      BAND,
      { percentile: 25 },
    );
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(out[bin].count).toBe(base[bin].count);
      if (Number.isNaN(base[bin].height)) continue;
      expect(Math.abs(out[bin].height - base[bin].height)).toBeLessThan(tol);
    }
    expectSameGaps(out, base);
  });

  it.each(ROTATIONS)(
    'leaves every point projection (chainage, signed lateral offset, height) unchanged: $name',
    (rot) => {
      // A proper rotation carries `up x along` to `R up x R along`, so the
      // SIGNED lateral offset is preserved, not merely its magnitude. The
      // reference frame's handedness is anchored above, so this transports it.
      //
      // FLOAT64_TOL applies even to the oblique rotations here: this path never
      // touches a Float32Array, so the only error is float64 rounding of the
      // rotation and of the projection's dot products.
      const refFrame = buildProfileFrame(REF_A, REF_B, Z_UP);
      const rotFrame = buildProfileFrame(
        orient(rot, REF_A),
        orient(rot, REF_B),
        orient(rot, Z_UP),
      );
      expect(Math.abs(rotFrame.horizontalLength - refFrame.horizontalLength)).toBeLessThan(
        FLOAT64_TOL,
      );
      for (const p of SCENE.points) {
        const ref = projectPointToProfile(refFrame, p);
        const got = projectPointToProfile(rotFrame, orient(rot, p));
        // Strays and decoys reach |coordinate| 900, four binades above the
        // accepted points, so their dot products carry proportionally more
        // error. Ride the bound on the point's own magnitude rather than
        // widening it for everything.
        const bound = FLOAT64_TOL * magnitude(p);
        expect(Math.abs(got.chainage - ref.chainage)).toBeLessThan(bound);
        expect(Math.abs(got.lateralOffset - ref.lateralOffset)).toBeLessThan(bound);
        expect(Math.abs(got.height - ref.height)).toBeLessThan(bound);
        expect(
          Math.abs(Math.abs(got.lateralOffset) - Math.abs(ref.lateralOffset)),
        ).toBeLessThan(bound);
      }
    },
  );

  it('rotates the classified run the same way, keeping the same returns excluded', () => {
    const classifiedRef = runTransformed((p) => p, REF_A, REF_B, Z_UP, BAND, { classified: true });
    // The class gate is doing work: each vegetation bin loses exactly one return.
    for (const bin of VEG_BINS) {
      expect(classifiedRef[bin].count).toBe(expectedCount(bin) - 1);
    }
    for (const rot of ROTATIONS) {
      const out = runTransformed(
        (p) => orient(rot, p),
        orient(rot, REF_A),
        orient(rot, REF_B),
        orient(rot, Z_UP),
        BAND,
        { classified: true },
      );
      for (let bin = 0; bin < SAMPLES; bin++) {
        expect(out[bin].count).toBe(classifiedRef[bin].count);
      }
      expectSameGaps(out, classifiedRef);
    }
  });
});

// ── Invariant 2: translation ─────────────────────────────────────────────────

/**
 * Translation with a nonzero component along every `up` used below. Dyadic, so
 * translating the dyadic reference cloud stays exactly representable in float32
 * and the Z-up leg of the comparison carries no packing error.
 */
const SHIFT: V3 = [3.5, -2.25, 6.75];

describe('Invariant 2: translating the whole scene', () => {
  it.each(ORIENTATIONS)(
    'shifts every finite height by the up-component of the translation and nothing else: $name',
    (o) => {
      const tol = o.exact ? FLOAT64_TOL : ROTATED_TOL;
      const a = orient(o, REF_A);
      const b = orient(o, REF_B);
      const up = orient(o, Z_UP);
      const base = runTransformed((p) => orient(o, p), a, b, up, BAND);
      const shifted = runTransformed(
        (p) => add(orient(o, p), SHIFT),
        add(a, SHIFT),
        add(b, SHIFT),
        up,
        BAND,
      );
      // `up` is normalised inside the sampler, so the height shift is the
      // projection of the translation onto the unit up axis.
      const dh = dot(SHIFT, up) / Math.hypot(up[0], up[1], up[2]);
      expect(Math.abs(dh)).toBeGreaterThan(1);

      for (let bin = 0; bin < SAMPLES; bin++) {
        expect(shifted[bin].count).toBe(base[bin].count);
        expect(Math.abs(shifted[bin].distance - base[bin].distance)).toBeLessThan(FLOAT64_TOL);
        if (Number.isNaN(base[bin].height)) continue;
        expect(Math.abs(shifted[bin].height - (base[bin].height + dh))).toBeLessThan(tol);
      }
      expectSameGaps(shifted, base);
    },
  );

  it('leaves chainage and signed lateral offset untouched for every point', () => {
    const baseFrame = buildProfileFrame(REF_A, REF_B, Z_UP);
    const shiftedFrame = buildProfileFrame(add(REF_A, SHIFT), add(REF_B, SHIFT), Z_UP);
    for (const p of SCENE.points) {
      const ref = projectPointToProfile(baseFrame, p);
      const got = projectPointToProfile(shiftedFrame, add(p, SHIFT));
      const bound = FLOAT64_TOL * magnitude(p);
      expect(Math.abs(got.chainage - ref.chainage)).toBeLessThan(bound);
      expect(Math.abs(got.lateralOffset - ref.lateralOffset)).toBeLessThan(bound);
      expect(Math.abs(got.height - (ref.height + SHIFT[2]))).toBeLessThan(bound);
    }
  });

  it('shifts an interpolating percentile by the same amount', () => {
    // At percentile 25 a height is `lo*(1-w) + hi*w`, which is not exactly
    // translation-equivariant in float64: the two roundings differ. The
    // residual is a few ulps of the shifted height (at most 20 here, ulp
    // 3.6e-15), far inside FLOAT64_TOL. Measured worst case: 0.
    const base = runTransformed((p) => p, REF_A, REF_B, Z_UP, BAND, { percentile: 25 });
    const shifted = runTransformed(
      (p) => add(p, SHIFT),
      add(REF_A, SHIFT),
      add(REF_B, SHIFT),
      Z_UP,
      BAND,
      { percentile: 25 },
    );
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(shifted[bin].count).toBe(base[bin].count);
      if (Number.isNaN(base[bin].height)) continue;
      expect(Math.abs(shifted[bin].height - (base[bin].height + SHIFT[2]))).toBeLessThan(
        FLOAT64_TOL,
      );
    }
    expectSameGaps(shifted, base);
  });
});

// ── Invariant 3: endpoint reversal ───────────────────────────────────────────

describe('Invariant 3: swapping the section endpoints', () => {
  const reversed = runTransformed((p) => p, REF_B, REF_A, Z_UP, BAND);

  it('keeps the horizontal length and the bin spacing', () => {
    expect(reversed).toHaveLength(SAMPLES);
    const refLen = REFERENCE[SAMPLES - 1].distance;
    expect(Math.abs(reversed[SAMPLES - 1].distance - refLen)).toBeLessThan(FLOAT64_TOL);
    expect(
      Math.abs(
        buildProfileFrame(REF_B, REF_A, Z_UP).horizontalLength -
          buildProfileFrame(REF_A, REF_B, Z_UP).horizontalLength,
      ),
    ).toBeLessThan(FLOAT64_TOL);
  });

  it('keeps the accepted point set: the corridor is a symmetric capsule', () => {
    // Every accepted point lands in exactly one bin, so the sum of the counts
    // IS the size of the accepted set. Distance to a segment does not depend on
    // which endpoint is called `a`, so the two sets have the same size; a
    // corridor capped at only one end would not, since the two ends of this
    // scene carry three and two beyond-end returns respectively.
    expect(totalCount(reversed)).toBe(totalCount(REFERENCE));
    // Sharper, because no point of this scene sits on a bin boundary (see the
    // tie test below): the reversed counts are the reference counts read
    // backwards, so the sets agree bin by bin and not merely in total.
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(reversed[bin].count).toBe(REFERENCE[SAMPLES - 1 - bin].count);
    }
  });

  it('maps chainage to L - s and mirrors the heights and the NaN gaps', () => {
    const L = REFERENCE[SAMPLES - 1].distance;
    for (let bin = 0; bin < SAMPLES; bin++) {
      const mirror = SAMPLES - 1 - bin;
      expect(Math.abs(reversed[bin].distance - (L - REFERENCE[mirror].distance))).toBeLessThan(
        FLOAT64_TOL,
      );
      expect(Number.isNaN(reversed[bin].height)).toBe(Number.isNaN(REFERENCE[mirror].height));
      if (Number.isNaN(REFERENCE[mirror].height)) continue;
      expect(Math.abs(reversed[bin].height - REFERENCE[mirror].height)).toBeLessThan(FLOAT64_TOL);
    }
  });

  it('flips the sign of every point lateral offset and reflects its chainage', () => {
    const fwd = buildProfileFrame(REF_A, REF_B, Z_UP);
    const rev = buildProfileFrame(REF_B, REF_A, Z_UP);
    const L = fwd.horizontalLength;
    for (const p of SCENE.points) {
      const f = projectPointToProfile(fwd, p);
      const r = projectPointToProfile(rev, p);
      const bound = FLOAT64_TOL * magnitude(p);
      expect(Math.abs(r.chainage - (L - f.chainage))).toBeLessThan(bound);
      // lateral = up x along, and `along` flips, so the offset flips with it.
      expect(Math.abs(r.lateralOffset + f.lateralOffset)).toBeLessThan(bound);
      expect(Math.abs(Math.abs(r.lateralOffset) - Math.abs(f.lateralOffset))).toBeLessThan(bound);
      // Height is read along `up`, which the swap does not touch.
      expect(r.height).toBe(f.height);
    }
  });

  it('assigns a boundary tie to the higher bin in BOTH directions, so ties do not mirror', () => {
    // Bin assignment is `Math.round(along / binStep)`, and Math.round breaks a
    // .5 tie upward (toward +Infinity). A point at chainage 3 with binStep 2
    // therefore joins bin 2, not bin 1. Reversed, that point has chainage 45,
    // whose ratio 22.5 also rounds UP, to bin 23, while the mirror of bin 2 is
    // bin 22. So the reversed series is NOT an exact mirror for a point sitting
    // on a bin boundary, and the tie direction is why, not float error. The
    // properties that DO hold: the accepted set is unchanged, and the two
    // assignments differ by exactly one bin, always in the same direction.
    const args = { up: Z_UP, samples: SAMPLES, bandWidth: BAND };
    const tie = pack([[3, 0, 5]]);
    const fwd = sampleProfile({ ...args, positions: tie, a: REF_A, b: REF_B });
    const rev = sampleProfile({ ...args, positions: tie, a: REF_B, b: REF_A });
    const hitBin = (s: ProfileSample[]): number => s.findIndex((x) => (x.count ?? 0) > 0);
    expect(totalCount(fwd)).toBe(1);
    expect(totalCount(rev)).toBe(1);
    expect(hitBin(fwd)).toBe(2);
    expect(hitBin(rev)).toBe(23);
    expect(hitBin(rev)).toBe(SAMPLES - 1 - hitBin(fwd) + 1);
    // Half a bin away from any boundary the mirror is exact, which is what lets
    // the reference scene above assert a bin-by-bin mirror.
    const clear = pack([[4, 0, 5]]);
    const cf = sampleProfile({ ...args, positions: clear, a: REF_A, b: REF_B });
    const cr = sampleProfile({ ...args, positions: clear, a: REF_B, b: REF_A });
    expect(hitBin(cr)).toBe(SAMPLES - 1 - hitBin(cf));
  });
});

// ── Invariant 4: uniform scale ───────────────────────────────────────────────

describe('Invariant 4: scaling the scene and the corridor by the same factor', () => {
  it('scales distances and heights by exactly k for a power-of-two k = 0.5', () => {
    // Every step of the walk is scale-covariant and multiplying a float64 by
    // 0.5 is exact at these magnitudes (no rounding, no over/underflow), so
    // this relation holds BIT-EXACTLY. Asserted with toBe rather than a
    // tolerance: any drift here is a defect, not float noise.
    const k = 0.5;
    const out = runTransformed(
      (p) => scaled(p, k),
      scaled(REF_A, k),
      scaled(REF_B, k),
      Z_UP,
      BAND * k,
    );
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(out[bin].count).toBe(REFERENCE[bin].count);
      expect(out[bin].distance).toBe(REFERENCE[bin].distance * k);
      if (Number.isNaN(REFERENCE[bin].height)) continue;
      expect(out[bin].height).toBe(REFERENCE[bin].height * k);
    }
    expectSameGaps(out, REFERENCE);
  });

  it('scales distances and heights by k for k = 1000', () => {
    // 1000 is not a power of two, so the sampler's arithmetic on scaled inputs
    // can round differently from scaling the reference result. The residual is
    // then a few ulps of the SCALED quantity, so the bound is relative:
    // 1e-12 of the expected value (at the largest compared magnitude, 48000,
    // that is 4.8e-8 against a float64 ulp of 7.3e-12), plus FLOAT64_TOL so an
    // expected value of 0 still has a bound. Measured worst case relative
    // residual: 0, the scale came out exact for this scene.
    const k = 1000;
    const out = runTransformed(
      (p) => scaled(p, k),
      scaled(REF_A, k),
      scaled(REF_B, k),
      Z_UP,
      BAND * k,
    );
    for (let bin = 0; bin < SAMPLES; bin++) {
      expect(out[bin].count).toBe(REFERENCE[bin].count);
      const wantDistance = REFERENCE[bin].distance * k;
      expect(Math.abs(out[bin].distance - wantDistance)).toBeLessThan(
        FLOAT64_TOL * Math.abs(wantDistance) + FLOAT64_TOL,
      );
      if (Number.isNaN(REFERENCE[bin].height)) continue;
      const wantHeight = REFERENCE[bin].height * k;
      expect(Math.abs(out[bin].height - wantHeight)).toBeLessThan(
        FLOAT64_TOL * Math.abs(wantHeight) + FLOAT64_TOL,
      );
    }
    expectSameGaps(out, REFERENCE);
  });

  it('keeps every classification decision unchanged at both scales', () => {
    const classifiedRef = runTransformed((p) => p, REF_A, REF_B, Z_UP, BAND, { classified: true });
    for (const k of [0.5, 1000]) {
      const out = runTransformed(
        (p) => scaled(p, k),
        scaled(REF_A, k),
        scaled(REF_B, k),
        Z_UP,
        BAND * k,
        { classified: true },
      );
      for (let bin = 0; bin < SAMPLES; bin++) {
        expect(out[bin].count).toBe(classifiedRef[bin].count);
      }
      expectSameGaps(out, classifiedRef);
      // The gate still removes the vegetation returns, at every scale.
      for (const bin of VEG_BINS) {
        expect(out[bin].count).toBe(expectedCount(bin) - 1);
      }
    }
  });

  it('scales the corridor rejections with the scene: strays and decoys stay out', () => {
    for (const k of [0.5, 1000]) {
      const out = runTransformed(
        (p) => scaled(p, k),
        scaled(REF_A, k),
        scaled(REF_B, k),
        Z_UP,
        BAND * k,
      );
      expect(out[0].count).toBe(3);
      expect(out[SAMPLES - 1].count).toBe(3);
      for (const bin of STRAY_BINS) {
        expect(out[bin].count).toBe(expectedCount(bin));
      }
    }
  });
});
