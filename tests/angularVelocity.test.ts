/**
 * angularVelocity.test.ts
 *
 * Pins the P3 quaternion angular-distance maths: identical orientations read 0,
 * the double cover (q ≡ −q) does not fabricate a spin, a known rotation reports
 * the right geodesic angle, and a non-positive dt yields 0.
 */

import { describe, it, expect } from 'vitest';
import { quaternionAngle, angularVelocity, type Quat } from '../src/render/angularVelocity';

const IDENT: Quat = [0, 0, 0, 1];
function zRot(rad: number): Quat {
  return [0, 0, Math.sin(rad / 2), Math.cos(rad / 2)];
}
function negate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

describe('quaternionAngle', () => {
  it('is 0 for identical orientations', () => {
    expect(quaternionAngle(IDENT, IDENT)).toBe(0);
  });
  it('treats q and −q as the same rotation (double-cover safe)', () => {
    const q = zRot(Math.PI / 2);
    expect(quaternionAngle(q, negate(q))).toBeCloseTo(0, 10);
  });
  it('measures a known 90° rotation', () => {
    expect(quaternionAngle(IDENT, zRot(Math.PI / 2))).toBeCloseTo(Math.PI / 2, 10);
  });
  it('measures a 180° rotation, sign-invariant', () => {
    expect(quaternionAngle(IDENT, zRot(Math.PI))).toBeCloseTo(Math.PI, 10);
    expect(quaternionAngle(IDENT, negate(zRot(Math.PI)))).toBeCloseTo(Math.PI, 10);
  });
  it('clamps a slightly non-unit dot without NaN', () => {
    expect(Number.isNaN(quaternionAngle([0, 0, 0, 1.0000001], IDENT))).toBe(false);
  });
});

describe('angularVelocity', () => {
  it('divides the geodesic angle by dt', () => {
    expect(angularVelocity(IDENT, zRot(Math.PI / 2), 0.5)).toBeCloseTo((Math.PI / 2) / 0.5, 10);
  });
  it('reads 0 for a stationary camera', () => {
    expect(angularVelocity(IDENT, IDENT, 1 / 60)).toBe(0);
  });
  it('returns 0 for a non-positive dt', () => {
    expect(angularVelocity(IDENT, zRot(1), 0)).toBe(0);
    expect(angularVelocity(IDENT, zRot(1), -0.1)).toBe(0);
  });
});
