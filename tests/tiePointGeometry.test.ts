/**
 * tiePointGeometry.test.ts — refusing a registration that is not determined.
 *
 * Horn's method returns a rotation for a correspondence set that cannot fix
 * one. Collinear points leave rotation about the line free; coincident points
 * leave all of it free. The solver picked arbitrarily from that family and then
 * measured the residual against its own choice, so it reported:
 *
 *   collinear points          rms 4.2e-16
 *   three identical points    rms 0
 *   a NaN coordinate          rms NaN, translation NaN
 *
 * A residual of zero reads as the best fit a user will ever see, so the least
 * determined input was reported as the most trustworthy result. These cases
 * hold the refusal, and the last of them holds the other side: a set that IS
 * determined must still register.
 */

import { describe, it, expect } from 'vitest';
import {
  tiePointGeometryOf,
  describeTiePointDefect,
  MIN_PLANARITY,
  type Vec3,
} from '../src/geo/tiePointGeometry';
import { registerTiePoints, applyRigid } from '../src/geo/tiePointRegister';

const LINE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
];
const TRIANGLE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
];
const TETRA: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe('classifying the shape of a correspondence set', () => {
  it('calls a line collinear', () => {
    const g = tiePointGeometryOf(LINE);
    expect(g.defect).toBe('collinear');
    expect(g.planarity).toBeLessThan(MIN_PLANARITY);
  });

  it('calls one repeated location coincident', () => {
    expect(tiePointGeometryOf([[2, 2, 2], [2, 2, 2], [2, 2, 2]]).defect).toBe('coincident');
  });

  it('accepts a plane, because three non-collinear points fix a rigid transform', () => {
    // Rank 2 is enough. Refusing it would reject the commonest real case: tie
    // points picked off a floor, a facade or a flat site.
    expect(tiePointGeometryOf(TRIANGLE).defect).toBeNull();
  });

  it('accepts a set with volume', () => {
    expect(tiePointGeometryOf(TETRA).defect).toBeNull();
  });

  it('rejects a coordinate that is not a finite number', () => {
    expect(tiePointGeometryOf([[0, 0, 0], [1, 0, 0], [0, Number.NaN, 0]]).defect).toBe('non-finite');
    expect(tiePointGeometryOf([[0, 0, 0], [1, 0, 0], [0, Infinity, 0]]).defect).toBe('non-finite');
  });

  it('measures departure from a line without a unit', () => {
    // The same shape scaled by a million is the same shape. A threshold on an
    // absolute distance would refuse a scanner-local set and accept a survey
    // one, or the reverse, for no reason but the unit its numbers are in.
    const big = TRIANGLE.map((p) => p.map((v) => v * 1e6) as unknown as Vec3);
    expect(tiePointGeometryOf(big).planarity).toBeCloseTo(
      tiePointGeometryOf(TRIANGLE).planarity,
      9,
    );
  });

  it('sees a very slightly bent line as still a line', () => {
    // A line perturbed far below the threshold is not evidence of rotation.
    const nearly: Vec3[] = [
      [0, 0, 0],
      [1, 1e-12, 0],
      [2, 0, 0],
      [3, -1e-12, 0],
    ];
    expect(tiePointGeometryOf(nearly).defect).toBe('collinear');
  });
});

describe('the refusal a caller sees', () => {
  it('names the set and says why a low residual would not help', () => {
    const msg = describeTiePointDefect('source', 'collinear');
    expect(msg).toContain('source');
    expect(msg).toContain('line');
    // The whole point: stop a reader treating the residual as reassurance.
    expect(msg).toContain('residual');
  });

  it('names the destination when that is the degenerate side', () => {
    expect(describeTiePointDefect('destination', 'coincident')).toContain('destination');
  });
});

describe('registerTiePoints refuses rather than inventing a transform', () => {
  it('refuses collinear correspondences', () => {
    expect(() =>
      registerTiePoints(LINE, [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]]),
    ).toThrow(/line/);
  });

  it('refuses when only the destination is degenerate', () => {
    // The source alone cannot vouch for the pair.
    expect(() => registerTiePoints(TETRA, [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]])).toThrow(
      /destination/,
    );
  });

  it('refuses a non-finite coordinate instead of returning NaN', () => {
    expect(() =>
      registerTiePoints(TRIANGLE, [[0, 0, 0], [1, 0, 0], [0, Number.NaN, 0]]),
    ).toThrow(/finite/);
  });

  it('still recovers a known transform from a determined set', () => {
    // A quarter turn about z, then a translation. The refusal must not have
    // cost the case the solver exists for.
    const rot = (p: Vec3): Vec3 => [-p[1] + 10, p[0] + 20, p[2] + 30];
    const dst = TETRA.map(rot);
    const tf = registerTiePoints(TETRA, dst);
    expect(tf.rmsResidual).toBeLessThan(1e-6);
    for (let i = 0; i < TETRA.length; i++) {
      const got = applyRigid(tf, TETRA[i]!);
      for (let a = 0; a < 3; a++) expect(got[a]).toBeCloseTo(dst[i]![a]!, 6);
    }
  });
});
