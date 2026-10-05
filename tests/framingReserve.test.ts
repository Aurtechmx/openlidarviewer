import { describe, it, expect } from 'vitest';
import { clampReserve, reservedFrustum, reserveShift, MAX_FRAMING_RESERVE } from '../src/render/camera/cameraPresets';

const tanHalf = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360);

describe('framingReserve', () => {
  it('leaves the frustum alone with no reserve', () => {
    expect(reservedFrustum(50, 1.6, 0)).toEqual({ fovDeg: 50, aspect: 1.6, reserve: 0 });
    expect(reserveShift({ x: 0, y: 1, z: -1 }, { x: 0, y: 0, z: 1 }, 10, 50, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('narrows the vertical field to the free share and keeps the horizontal field', () => {
    const f = reservedFrustum(50, 1.6, 0.25);
    expect(tanHalf(f.fovDeg)).toBeCloseTo(tanHalf(50) * 0.75, 12);
    expect(tanHalf(f.fovDeg) * f.aspect).toBeCloseTo(tanHalf(50) * 1.6, 12);
  });

  it('moves the camera down its own up vector by r·dist·tan(fov/2)', () => {
    // Looking straight along +y with z up: camera up is +z.
    const s = reserveShift({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 1 }, 10, 50, 0.25);
    expect(s.x).toBeCloseTo(0, 12);
    expect(s.y).toBeCloseTo(0, 12);
    expect(s.z).toBeCloseTo(-0.25 * 10 * tanHalf(50), 12);
  });

  it('puts the box centre in the middle of the free band', () => {
    // A point at the old target, seen from the shifted camera, sits at NDC y = r.
    const r = 0.3;
    const dist = 20;
    const fov = 45;
    const look = { x: 0, y: 1, z: 0 };
    const s = reserveShift(look, { x: 0, y: 0, z: 1 }, dist, fov, r);
    const ndcY = -s.z / (dist * tanHalf(fov));
    expect(ndcY).toBeCloseTo(r, 12);
  });

  it('clamps nonsense and oversize reserves', () => {
    expect(clampReserve(Number.NaN)).toBe(0);
    expect(clampReserve(-1)).toBe(0);
    expect(clampReserve(0.9)).toBe(MAX_FRAMING_RESERVE);
  });
});
