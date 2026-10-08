import { describe, it, expect } from 'vitest';
import {
  COLLINEAR_TOLERANCE,
  cross,
  dot,
  length,
  northVector,
  placeOnPlane,
  planeFromThreePoints,
  principalPlane,
  rayPlaneHit,
  sub,
  type Vec3,
  type WorkplaneBasis,
} from '../src/render/workplane/workplanePlane';

const close = (a: Vec3, b: Vec3, tol = 1e-12): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i]), `component ${i}: ${a} vs ${b}`).toBeLessThanOrEqual(tol);
};
const orthonormal = (p: WorkplaneBasis): void => {
  expect(length(p.normal)).toBeCloseTo(1, 12);
  expect(length(p.u)).toBeCloseTo(1, 12);
  expect(length(p.v)).toBeCloseTo(1, 12);
  expect(dot(p.u, p.v)).toBeCloseTo(0, 12);
  expect(dot(p.u, p.normal)).toBeCloseTo(0, 12);
  close(cross(p.u, p.v), p.normal); // right-handed
};

describe('principal planes', () => {
  it('Z-up: horizontal faces up and lies along X and Y', () => {
    const p = principalPlane('horizontal', [10, 20, 30], 'z');
    orthonormal(p);
    close(p.normal, [0, 0, 1]);
    close(p.u, [1, 0, 0]);
    close(p.v, [0, 1, 0]);
  });

  it('Z-up: the two vertical planes contain up and one horizontal axis each', () => {
    const vx = principalPlane('vertical-x', [0, 0, 0], 'z');
    const vn = principalPlane('vertical-north', [0, 0, 0], 'z');
    orthonormal(vx);
    orthonormal(vn);
    close(vx.u, [1, 0, 0]);
    close(vx.v, [0, 0, 1]);
    close(vn.u, [0, 1, 0]);
    close(vn.v, [0, 0, 1]);
  });

  it('Y-up: horizontal faces +Y and north is -Z, the rotation the contour overlay uses, not a mirror', () => {
    const p = principalPlane('horizontal', [0, 0, 0], 'y');
    orthonormal(p);
    close(p.normal, [0, 1, 0]);
    close(p.v, northVector('y'));
    close(p.v, [0, 0, -1]);
  });
});

describe('plane through three points', () => {
  const A: Vec3 = [0, 0, 0];
  const B: Vec3 = [10, 0, 1];
  const C: Vec3 = [0, 10, 2];

  it('passes through all three points', () => {
    const r = planeFromThreePoints(A, B, C, 'z');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    orthonormal(r.basis);
    for (const p of [A, B, C]) expect(Math.abs(dot(sub(p, r.basis.origin), r.basis.normal))).toBeLessThan(1e-12);
  });

  it('the normal points up for every order of the same points', () => {
    const orders: Array<[Vec3, Vec3, Vec3]> = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]];
    const normals = orders.map(([p, q, r]) => {
      const res = planeFromThreePoints(p, q, r, 'z');
      if (!res.ok) throw new Error('refused');
      return res.basis.normal;
    });
    for (const n of normals) {
      expect(n[2]).toBeGreaterThan(0);
      close(n, normals[0], 1e-12);
    }
  });

  it('on a Y-up scan the normal points along +Y', () => {
    const r = planeFromThreePoints([0, 0, 0], [10, 1, 0], [0, 2, -10], 'y');
    expect(r.ok && r.basis.normal[1] > 0).toBe(true);
  });

  it('a vertical plane gets a deterministic sign (toward +east, then +north)', () => {
    const r1 = planeFromThreePoints([0, 0, 0], [0, 10, 0], [0, 0, 5], 'z');
    const r2 = planeFromThreePoints([0, 10, 0], [0, 0, 0], [0, 0, 5], 'z');
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    close(r1.basis.normal, [1, 0, 0]);
    close(r2.basis.normal, [1, 0, 0]);
    expect(r1.dipDeg).toBeCloseTo(90, 9);
  });

  it('reports the dip', () => {
    const r = planeFromThreePoints([0, 0, 0], [10, 0, 0], [0, 10, 10], 'z');
    expect(r.ok && r.dipDeg).toBeCloseTo(45, 9);
  });

  it('refuses exactly collinear and coincident points', () => {
    const line = planeFromThreePoints([0, 0, 0], [5, 5, 5], [10, 10, 10], 'z');
    expect(line.ok).toBe(false);
    expect(!line.ok && line.reason).toMatch(/in a line/);
    const same = planeFromThreePoints([1, 1, 1], [1, 1, 1], [1, 1, 1], 'z');
    expect(!same.ok && same.reason).toMatch(/same point/);
  });

  it('refuses nearly collinear points with a tolerance relative to their spread', () => {
    // Third point 4 cm off a 100 m line: altitude / longest edge = 4e-4 < 1e-3.
    const thin = planeFromThreePoints([0, 0, 0], [100, 0, 0], [50, 0.04, 0], 'z');
    expect(thin.ok).toBe(false);
    expect(thin.flatness).toBeLessThan(COLLINEAR_TOLERANCE);
    // 20 cm off: 2e-3, accepted.
    expect(planeFromThreePoints([0, 0, 0], [100, 0, 0], [50, 0.2, 0], 'z').ok).toBe(true);
  });

  it('the verdict does not depend on scale or on where the points are', () => {
    for (const s of [1e-3, 1, 1e3]) {
      for (const off of [[0, 0, 0], [500_000, 4_100_000, 1200]] as Vec3[]) {
        const p = (x: number, y: number, z: number): Vec3 => [off[0] + x * s, off[1] + y * s, off[2] + z * s];
        expect(planeFromThreePoints(p(0, 0, 0), p(100, 0, 0), p(50, 0.04, 0), 'z').ok).toBe(false);
        expect(planeFromThreePoints(p(0, 0, 0), p(100, 0, 0), p(50, 0.2, 0), 'z').ok).toBe(true);
      }
    }
  });

  it('keeps millimetre fidelity at UTM-sized coordinates', () => {
    const o: Vec3 = [512_345.678, 4_123_456.789, 1234.567];
    const pts: [Vec3, Vec3, Vec3] = [o, [o[0] + 30, o[1], o[2] + 3], [o[0], o[1] + 30, o[2] - 1.5]];
    const r = planeFromThreePoints(...pts, 'z');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const p of pts) expect(Math.abs(dot(sub(p, r.basis.origin), r.basis.normal))).toBeLessThan(1e-6);
  });

  it('refuses non-finite picks', () => {
    expect(planeFromThreePoints([0, 0, 0], [1, 0, 0], [0, Number.NaN, 0], 'z').ok).toBe(false);
  });
});

describe('placing on the plane', () => {
  it('keeps the typed horizontal coordinates and moves only the elevation on a tilted plane', () => {
    const r = planeFromThreePoints([0, 0, 0], [10, 0, 1], [0, 10, 2], 'z');
    if (!r.ok) throw new Error('refused');
    const p = placeOnPlane([4, 6, 999], r.basis, 'z');
    expect(p[0]).toBeCloseTo(4, 12);
    expect(p[1]).toBeCloseTo(6, 12);
    expect(p[2]).toBeCloseTo(0.4 + 1.2, 12); // z = 0.1 x + 0.2 y
  });

  it('meets the line of sight', () => {
    const plane = principalPlane('horizontal', [0, 0, 5], 'z');
    close(rayPlaneHit([1, 2, 15], [1, 2, 10], plane)!, [1, 2, 5]);
    expect(rayPlaneHit([0, 0, 10], [1, 0, 10], plane)).toBeNull(); // parallel
    expect(rayPlaneHit([0, 0, 10], [0, 0, 20], plane)).toBeNull(); // looking away
  });
});
