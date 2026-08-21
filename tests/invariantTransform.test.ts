/**
 * invariantTransform.test.ts - the algebraic invariants of the placement
 * transform in src/registration/transformStore.ts.
 *
 * That module's header states three properties: the transform is composed in
 * Float64 so repeated placement does not accumulate Float32 drift, undo
 * restores the exact previous placement, and reset returns to identity with the
 * original coordinates recoverable. This suite pins each as a relation that
 * holds for arbitrary rigid transforms rather than for one hand-picked example.
 *
 * Every bound below was measured before it was asserted; the measured figure
 * sits next to each tolerance so a future regression is visible as a number and
 * not just as a red test. Rotations come from a seeded PRNG, never from the
 * platform's nondeterministic source, so each measurement replays exactly.
 *
 * Relation 6 is a negative control: the assertions used for the positive cases
 * are re-run against a non-rotation and against a Float32 evaluation of the
 * same arithmetic, and are required to reject both.
 *
 * Relation 7 covers the reading path rather than the arithmetic: place()
 * evaluates from a cached copy of the current placement, which is required to
 * be bitwise the same as evaluating the placement itself.
 */

import { describe, it, expect } from 'vitest';
import { compose, IDENTITY, TransformStore, type Mat3, type RigidTransform, type Vec3 } from '../src/registration/transformStore';

/** mulberry32, fixed seed: a failing case replays exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x0117a1de;
const SAMPLES = 512;

/** Uniform random rotation via Shoemake's unit-quaternion sampling. */
function randomRotation(r: () => number): Mat3 {
  const u1 = r(), u2 = r(), u3 = r();
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  const x = s1 * Math.sin(2 * Math.PI * u2);
  const y = s1 * Math.cos(2 * Math.PI * u2);
  const z = s2 * Math.sin(2 * Math.PI * u3);
  const w = s2 * Math.cos(2 * Math.PI * u3);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function randomTransform(r: () => number, span = 1000): RigidTransform {
  return { R: randomRotation(r), t: [(r() - 0.5) * span, (r() - 0.5) * span, (r() - 0.5) * span] };
}

function transpose(R: Mat3): Mat3 {
  return [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
}

/**
 * The inverse of a rigid transform {R,t} is {R^T, -R^T t}. transformStore.ts
 * exports no inverse, so the relations are checked against this construction.
 */
function inverse(T: RigidTransform): RigidTransform {
  const Rt = transpose(T.R);
  return {
    R: Rt,
    t: [
      -(Rt[0][0] * T.t[0] + Rt[0][1] * T.t[1] + Rt[0][2] * T.t[2]),
      -(Rt[1][0] * T.t[0] + Rt[1][1] * T.t[1] + Rt[1][2] * T.t[2]),
      -(Rt[2][0] * T.t[0] + Rt[2][1] * T.t[1] + Rt[2][2] * T.t[2]),
    ],
  };
}

/** Mirrors TransformStore.place() so a round trip can be run off the store. */
function applyTo(T: RigidTransform, p: Vec3): Vec3 {
  const { R, t } = T;
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}

/** The same evaluation rounded to Float32 at every step, for relation 6. */
function applyTo32(T: RigidTransform, p: Vec3): Vec3 {
  const f = Math.fround;
  const { R, t } = T;
  const row = (i: 0 | 1 | 2): number =>
    f(f(f(f(R[i][0]) * f(p[0])) + f(f(R[i][1]) * f(p[1]))) + f(f(f(R[i][2]) * f(p[2])) + f(t[i])));
  return [row(0), row(1), row(2)];
}

/** max |R^T R - I| over all nine elements: departure from orthonormality. */
function orthoDeviation(R: Mat3): number {
  const Rt = transpose(R);
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const v = Rt[i][0] * R[0][j] + Rt[i][1] * R[1][j] + Rt[i][2] * R[2][j];
      worst = Math.max(worst, Math.abs(v - (i === j ? 1 : 0)));
    }
  }
  return worst;
}

function det(R: Mat3): number {
  return (
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
  );
}

function matDeviation(a: Mat3, b: Mat3): number {
  let worst = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(a[i][j] - b[i][j]));
  return worst;
}

function vecDeviation(a: Vec3, b: Vec3): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** max element-wise departure of a transform from IDENTITY, over R and t. */
function identityDeviation(T: RigidTransform): number {
  return Math.max(matDeviation(T.R, IDENTITY.R), vecDeviation(T.t, IDENTITY.t));
}

/**
 * The shared "this composes to identity" assertion. Relation 6 drives a
 * non-rotation through this same function and requires it to throw, so the
 * positive results are not the output of an assertion that cannot fail.
 *
 * The rotation and translation parts carry separate tolerances because their
 * error scales differ: the rotation part is unit-magnitude, while the
 * translation part cancels two terms of size |t| and so scales with |t|.
 */
function expectComposesToIdentity(T: RigidTransform, rotTol: number, transTol: number): void {
  const round = compose(T, inverse(T));
  expect(matDeviation(round.R, IDENTITY.R)).toBeLessThan(rotTol);
  expect(vecDeviation(round.t, IDENTITY.t)).toBeLessThan(transTol);
  expect(orthoDeviation(T.R)).toBeLessThan(rotTol);
  expect(Math.abs(det(T.R) - 1)).toBeLessThan(rotTol);
}

// Measured over 512 random transforms with |t| up to 500 m: rotation part
// 1.33e-15, translation part 5.68e-13 (that is ~500 m x 1.1e-15, the expected
// cancellation of two same-size Float64 terms).
const R1_ROT_TOL = 1e-14;
const R1_TRANS_TOL = 1e-11;

describe('relation 1: a transform composed with its inverse is identity', () => {
  it('holds in both orders over randomised rotations and translations', () => {
    const r = rng(SEED);
    let worstRot = 0, worstTrans = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const T = randomTransform(r);
      expectComposesToIdentity(T, R1_ROT_TOL, R1_TRANS_TOL);
      for (const round of [compose(T, inverse(T)), compose(inverse(T), T)]) {
        worstRot = Math.max(worstRot, matDeviation(round.R, IDENTITY.R));
        worstTrans = Math.max(worstTrans, vecDeviation(round.t, IDENTITY.t));
      }
    }
    expect(worstRot).toBeLessThan(R1_ROT_TOL);
    expect(worstTrans).toBeLessThan(R1_TRANS_TOL);
  });
});

// Measured over 512 random triples: rotation part 3.33e-16, translation part
// 4.55e-13.
const R2_ROT_TOL = 1e-14;
const R2_TRANS_TOL = 1e-11;

describe('relation 2: compose is associative', () => {
  it('agrees to tolerance over randomised triples', () => {
    const r = rng(SEED ^ 0x1);
    let worstRot = 0, worstTrans = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const a = randomTransform(r), b = randomTransform(r), c = randomTransform(r);
      const left = compose(compose(a, b), c);
      const right = compose(a, compose(b, c));
      worstRot = Math.max(worstRot, matDeviation(left.R, right.R));
      worstTrans = Math.max(worstTrans, vecDeviation(left.t, right.t));
    }
    expect(worstRot).toBeLessThan(R2_ROT_TOL);
    expect(worstTrans).toBeLessThan(R2_TRANS_TOL);
  });
});

/**
 * Drift measured on this seed, composing one random rotation onto itself:
 *
 *   compositions | max |R^T R - I| | |det(R) - 1|
 *   -------------|-----------------|-------------
 *             10 |        7.77e-16 |     8.88e-16
 *            100 |        5.88e-15 |     5.88e-15
 *           1000 |        5.44e-14 |     5.21e-14
 *          10000 |        5.41e-13 |     5.35e-13
 *
 * Growth is linear in the number of compositions and stays five orders below
 * the ~1e-7 that a Float32 multiply would produce. Tolerances are the measured
 * value with one order of headroom.
 */
const R3_MARKS: ReadonlyArray<readonly [number, number]> = [
  [10, 5e-15],
  [100, 5e-14],
  [1000, 5e-13],
  [10000, 5e-12],
];

describe('relation 3: repeated composition stays orthonormal', () => {
  it('does not accumulate Float32-scale drift over 10000 compositions', () => {
    const r = rng(SEED ^ 0x2);
    const step: RigidTransform = { R: randomRotation(r), t: [1.5, -2.25, 0.75] };
    let acc = IDENTITY;
    let n = 0;
    for (const [mark, tol] of R3_MARKS) {
      while (n < mark) { acc = compose(step, acc); n++; }
      expect(orthoDeviation(acc.R)).toBeLessThan(tol);
      expect(Math.abs(det(acc.R) - 1)).toBeLessThan(tol);
    }
    expect(n).toBe(10000);
  });
});

describe('relation 4: undo and reset contract', () => {
  /**
   * The store keeps a stack of composed snapshots and undo pops it, so a
   * restored placement is the SAME OBJECT that was current before, not a
   * recomputation. The contract pinned here is therefore bitwise exactness
   * (Object.is on every component), which is stronger than a tolerance.
   */
  it('undo restores the previous placement bitwise', () => {
    const r = rng(SEED ^ 0x3);
    const s = new TransformStore();
    const seen: RigidTransform[] = [s.current()];
    expect(s.current()).toBe(IDENTITY);
    for (let i = 0; i < 8; i++) {
      s.apply(randomTransform(r));
      seen.push(s.current());
    }
    expect(s.depth).toBe(8);
    for (let i = 8; i > 0; i--) {
      s.undo();
      const restored = s.current();
      const previous = seen[i - 1];
      expect(restored).toBe(previous);
      for (let a = 0; a < 3; a++) {
        expect(Object.is(restored.t[a], previous.t[a])).toBe(true);
        for (let b = 0; b < 3; b++) expect(Object.is(restored.R[a][b], previous.R[a][b])).toBe(true);
      }
    }
    expect(s.depth).toBe(0);
    expect(s.current()).toBe(IDENTITY);
  });

  it('undo past the original is a no-op that leaves identity in place', () => {
    const s = new TransformStore();
    for (let i = 0; i < 4; i++) s.undo();
    expect(s.depth).toBe(0);
    expect(s.current()).toBe(IDENTITY);
  });

  it('reset returns to IDENTITY and UTM-magnitude coordinates come back exactly', () => {
    const r = rng(SEED ^ 0x4);
    const s = new TransformStore();
    const pts: Vec3[] = [];
    for (let i = 0; i < 64; i++) pts.push([500000 + r() * 1000, 4600000 + r() * 1000, 1200 + r() * 50]);
    for (let i = 0; i < 5; i++) s.apply(randomTransform(r));
    s.reset();
    expect(s.depth).toBe(0);
    expect(s.current()).toBe(IDENTITY);
    for (const p of pts) {
      const back = s.place(p);
      for (let a = 0; a < 3; a++) expect(Object.is(back[a], p[a])).toBe(true);
    }
  });

  /**
   * The stack base is the exported IDENTITY object itself, so a mutation of it
   * anywhere would silently redefine "the original" for every store. This pins
   * that the constant still holds the identity values after the suite has
   * driven apply, undo, reset and bake.
   */
  it('leaves the exported IDENTITY constant unmodified', () => {
    const s = new TransformStore();
    s.apply(randomTransform(rng(SEED ^ 0x7)));
    s.bake();
    s.reset();
    expect(IDENTITY.R).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(IDENTITY.t).toEqual([0, 0, 0]);
  });
});

/**
 * Round-trip error measured over 32 transforms x 256 points, both through
 * compose/applyTo directly and through TransformStore.place:
 *
 *   points within 50 m of the origin : 8.53e-14 m
 *   points at UTM magnitude          : 4.66e-09 m
 *
 * The error grows with distance from the origin (ratio 5.5e4, tracking the
 * ~9.2e4 ratio of the coordinate magnitudes), which is the expected behaviour
 * of a fixed relative precision: 4.66e-9 / 4.6e6 is about 1.0e-15, a few ulp of
 * Float64. The same round trip evaluated in Float32 lands at 7.4e-1 m for the
 * same UTM points; relation 6 measures that witness.
 */
const R5_LOCAL_TOL = 1e-12;
const R5_UTM_TOL = 5e-8;

describe('relation 5: point round trip', () => {
  it('returns coordinates near the origin and at UTM magnitude', () => {
    const r = rng(SEED ^ 0x5);
    const local: Vec3[] = [];
    const utm: Vec3[] = [];
    for (let i = 0; i < 256; i++) {
      const x = (r() - 0.5) * 100, y = (r() - 0.5) * 100, z = (r() - 0.5) * 20;
      local.push([x, y, z]);
      utm.push([500000 + x, 4600000 + y, 1200 + z]);
    }
    let worstLocal = 0, worstUtm = 0;
    for (let i = 0; i < 32; i++) {
      const T = randomTransform(r, 500);
      const inv = inverse(T);
      // The store path composes T then its inverse into one placement; the
      // direct path applies them in sequence. Both must return the input.
      const store = new TransformStore();
      store.apply(T);
      store.apply(inv);
      for (const p of local) {
        const direct = applyTo(inv, applyTo(T, p));
        const placed = store.place(p);
        worstLocal = Math.max(worstLocal, vecDeviation(direct, p), vecDeviation(placed, p));
      }
      for (const p of utm) {
        const direct = applyTo(inv, applyTo(T, p));
        const placed = store.place(p);
        worstUtm = Math.max(worstUtm, vecDeviation(direct, p), vecDeviation(placed, p));
      }
    }
    expect(worstLocal).toBeLessThan(R5_LOCAL_TOL);
    expect(worstUtm).toBeLessThan(R5_UTM_TOL);
  });
});

describe('relation 6: negative control', () => {
  /**
   * Scaling one row by 1.001 gives, on this seed: max |R^T R - I| = 1.40e-3,
   * |det - 1| = 1.00e-3, and a transpose round trip that misses identity by
   * 6.00e-3. All exceed the relation 1 tolerances by nine orders.
   */
  it('the relation 1 assertions reject a matrix that is not a rotation', () => {
    const r = rng(SEED ^ 0x6);
    const R = randomRotation(r);
    const scaled: Mat3 = [[R[0][0] * 1.001, R[0][1] * 1.001, R[0][2] * 1.001], R[1], R[2]];
    const bad: RigidTransform = { R: scaled, t: [3, -4, 5] };
    expect(() => expectComposesToIdentity(bad, R1_ROT_TOL, R1_TRANS_TOL)).toThrow();
    expect(orthoDeviation(scaled)).toBeGreaterThan(1e-3);
    expect(Math.abs(det(scaled) - 1)).toBeGreaterThan(9e-4);
    expect(identityDeviation(compose(bad, inverse(bad)))).toBeGreaterThan(1e-3);
    // A genuine rotation from the same generator passes the same assertions.
    expectComposesToIdentity({ R, t: [3, -4, 5] }, R1_ROT_TOL, R1_TRANS_TOL);
  });

  /**
   * The relation 5 UTM bound is what would catch a Float32 path, so it has to
   * be shown failing against one. Running the identical round trip with every
   * product and sum rounded through Math.fround puts the error far above
   * R5_UTM_TOL: 7.38e-1 m against 9.31e-10 m on the Float64 path, a ratio of
   * 7.9e8 on this seed.
   */
  it('the relation 5 UTM bound rejects the same round trip evaluated in Float32', () => {
    const r = rng(SEED ^ 0x8);
    const T = randomTransform(r, 500);
    const inv = inverse(T);
    let worst32 = 0, worst64 = 0;
    for (let i = 0; i < 64; i++) {
      const p: Vec3 = [500000 + (r() - 0.5) * 100, 4600000 + (r() - 0.5) * 100, 1200 + (r() - 0.5) * 20];
      worst32 = Math.max(worst32, vecDeviation(applyTo32(inv, applyTo32(T, p)), p));
      worst64 = Math.max(worst64, vecDeviation(applyTo(inv, applyTo(T, p)), p));
    }
    expect(worst32).toBeGreaterThan(R5_UTM_TOL);
    expect(worst64).toBeLessThan(R5_UTM_TOL);
    expect(worst32 / worst64).toBeGreaterThan(1e5);
  });
});

/**
 * place() does not read R and t off the current placement on every call; it
 * reads a flattened copy refreshed when the top of the stack becomes a different
 * object. That copy is Float64, so the two evaluations must agree bitwise and
 * not merely to a tolerance. This drives them apart over randomised placements,
 * at UTM magnitude as well as near the origin, and requires Object.is on every
 * component.
 */
describe('relation 7: place() agrees bitwise with the current placement', () => {
  it('matches a direct evaluation of current() over randomised placements', () => {
    const r = rng(SEED ^ 0x9);
    const s = new TransformStore();
    const pts: Vec3[] = [];
    for (let i = 0; i < 64; i++) {
      pts.push([(r() - 0.5) * 100, (r() - 0.5) * 100, (r() - 0.5) * 20]);
      pts.push([500000 + r() * 1000, 4600000 + r() * 1000, 1200 + r() * 50]);
    }
    const check = (): void => {
      for (const p of pts) {
        const placed = s.place(p);
        const direct = applyTo(s.current(), p);
        for (let a = 0; a < 3; a++) expect(Object.is(placed[a], direct[a])).toBe(true);
      }
    };
    check(); // depth 0, where the placement is IDENTITY
    for (let i = 0; i < 8; i++) { s.apply(randomTransform(r)); check(); }
    for (let i = 0; i < 8; i++) { s.undo(); check(); }
    s.apply(randomTransform(r));
    s.reset();
    check();
    expect(s.depth).toBe(0);
  });
});
