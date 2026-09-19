import { describe, it, expect } from 'vitest';
import {
  normalsAgree,
  normalsAllowFill,
  isUsableNormal,
  MAX_NORMAL_ANGLE_DEG,
  type Normal,
} from '../src/render/continuity/normalAgreement';

const UP: Normal = { x: 0, y: 0, z: 1 };
const DOWN: Normal = { x: 0, y: 0, z: -1 };
const SIDE: Normal = { x: 1, y: 0, z: 0 };
const at = (deg: number): Normal => ({
  x: Math.sin((deg * Math.PI) / 180),
  y: 0,
  z: Math.cos((deg * Math.PI) / 180),
});

describe('normalsAgree', () => {
  it('accepts the same direction', () => {
    expect(normalsAgree(UP, UP)).toBe(true);
    expect(normalsAgree(UP, { x: 0, y: 0, z: 5 })).toBe(true);
  });

  it('holds a gently curved surface together', () => {
    expect(normalsAgree(UP, at(MAX_NORMAL_ANGLE_DEG - 1))).toBe(true);
  });

  it('separates a wall from a floor', () => {
    expect(normalsAgree(UP, at(MAX_NORMAL_ANGLE_DEG + 1))).toBe(false);
    expect(normalsAgree(UP, SIDE)).toBe(false);
  });

  // A flipped normal describes the surface seen from the other side, which is
  // the fold this exists to catch.
  it('does not treat opposite directions as agreement', () => {
    expect(normalsAgree(UP, DOWN)).toBe(false);
  });

  it('refuses a zero-length direction', () => {
    expect(normalsAgree(UP, { x: 0, y: 0, z: 0 })).toBe(false);
  });
});

describe('isUsableNormal', () => {
  it('rejects absent, zero and non-finite directions', () => {
    expect(isUsableNormal(null)).toBe(false);
    expect(isUsableNormal(undefined)).toBe(false);
    expect(isUsableNormal({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(isUsableNormal({ x: Number.NaN, y: 0, z: 1 })).toBe(false);
    expect(isUsableNormal(UP)).toBe(true);
  });
});

describe('normalsAllowFill', () => {
  // Most survey formats carry no normals, and the field has to work without
  // them, so their absence is silence rather than objection.
  it('says nothing when a cloud has no normals', () => {
    expect(normalsAllowFill([])).toBe(true);
    expect(normalsAllowFill([null, null, null, null])).toBe(true);
    expect(normalsAllowFill([undefined, undefined])).toBe(true);
  });

  it('allows a fill where the known normals agree', () => {
    expect(normalsAllowFill([UP, UP, at(10)])).toBe(true);
  });

  it('refuses a fill across a fold', () => {
    expect(normalsAllowFill([UP, SIDE])).toBe(false);
    expect(normalsAllowFill([UP, UP, DOWN])).toBe(false);
  });

  it('checks every pair, not just neighbours in order', () => {
    // First and last disagree while each agrees with the middle.
    expect(normalsAllowFill([at(0), at(20), at(40)])).toBe(false);
  });

  it('ignores the gaps and judges only what is known', () => {
    expect(normalsAllowFill([UP, null, at(5), undefined])).toBe(true);
    expect(normalsAllowFill([UP, null, SIDE])).toBe(false);
  });

  // The channel claimed to know and did not, which is different from silence.
  it('refuses a normal that is present but unusable', () => {
    expect(normalsAllowFill([UP, { x: 0, y: 0, z: 0 }])).toBe(false);
    expect(normalsAllowFill([UP, { x: Number.NaN, y: 0, z: 1 }])).toBe(false);
  });

  // The safety property: adding normals to a dataset can only make the renderer
  // more careful with it. There is no input for which they permit a fill that
  // an absence of normals would have refused, because they never permit at all.
  it('can only ever refuse, never permit', () => {
    const cases: (Normal | null)[][] = [
      [],
      [UP],
      [UP, UP],
      [UP, SIDE],
      [UP, null],
      [DOWN, UP, SIDE],
      [at(0), at(29), at(58)],
    ];
    for (const c of cases) {
      const withNormals = normalsAllowFill(c);
      const withoutNormals = normalsAllowFill(c.map(() => null));
      expect(withoutNormals).toBe(true);
      expect(withNormals === true || withoutNormals === true).toBe(true);
      if (!withNormals) expect(withoutNormals).toBe(true);
    }
  });

  it('honours a caller-supplied angle', () => {
    expect(normalsAllowFill([UP, at(45)])).toBe(false);
    expect(normalsAllowFill([UP, at(45)], 60)).toBe(true);
  });
});
