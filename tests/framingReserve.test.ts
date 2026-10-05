import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { clampReserve, reservedFrustum, openingFit, MAX_FRAMING_RESERVE } from '../src/render/camera/cameraPresets';
import { setLensShift, withoutLensShift } from '../src/render/camera/orthoCamera';

const tanHalf = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360);

const BOX = { boxMin: { x: -500, y: -480, z: 190 }, boxMax: { x: 500, y: 520, z: 210 } };
const DIR = { x: 0, y: -Math.cos(0.61), z: Math.sin(0.61) };
const UP = { x: 0, y: 0, z: 1 };

function cameraAt(fit: ReturnType<typeof openingFit>, fov: number, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.01, 1e6);
  cam.up.set(0, 0, 1);
  cam.position.set(fit.position.x, fit.position.y, fit.position.z);
  cam.lookAt(fit.target.x, fit.target.y, fit.target.z);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('reservedFrustum', () => {
  it('leaves the frustum alone with no reserve', () => {
    expect(reservedFrustum(50, 1.6, 0)).toEqual({ fovDeg: 50, aspect: 1.6, reserve: 0 });
  });

  it('narrows the vertical field to the free share and keeps the horizontal field', () => {
    const f = reservedFrustum(50, 1.6, 0.25);
    expect(tanHalf(f.fovDeg)).toBeCloseTo(tanHalf(50) * 0.75, 12);
    expect(tanHalf(f.fovDeg) * f.aspect).toBeCloseTo(tanHalf(50) * 1.6, 12);
  });

  it('clamps nonsense and oversize reserves', () => {
    expect(clampReserve(Number.NaN)).toBe(0);
    expect(clampReserve(-1)).toBe(0);
    expect(clampReserve(0.9)).toBe(MAX_FRAMING_RESERVE);
  });
});

describe('openingFit', () => {
  it('keeps the target on the box centre whatever the reserve', () => {
    for (const reserve of [0, 0.24, 0.4]) {
      const fit = openingFit({ ...BOX, dir: DIR, worldUp: UP, fovDeg: 50, aspect: 1.6, reserve });
      expect(fit.target).toEqual({ x: 0, y: 20, z: 200 });
      expect(fit.lensShift).toBe(reserve);
    }
  });

  it('with the lens shift applied, the whole box projects into the free band', () => {
    const r = 0.24;
    const fit = openingFit({ ...BOX, dir: DIR, worldUp: UP, fovDeg: 50, aspect: 1.6, reserve: r });
    const cam = cameraAt(fit, 50, 1.6);
    const ortho = new THREE.OrthographicCamera();
    setLensShift(cam, ortho, fit.lensShift);
    expect(cam.aspect).toBe(1.6);
    const centre = new THREE.Vector3(fit.target.x, fit.target.y, fit.target.z).project(cam);
    expect(centre.x).toBeCloseTo(0, 9);
    expect(centre.y).toBeCloseTo(r, 9);
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? BOX.boxMax.x : BOX.boxMin.x,
        i & 2 ? BOX.boxMax.y : BOX.boxMin.y,
        i & 4 ? BOX.boxMax.z : BOX.boxMin.z,
      ).project(cam);
      expect(p.y).toBeGreaterThanOrEqual(-1 + 2 * r - 1e-9);
      expect(p.y).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('moves the orthographic follower by the same NDC amount', () => {
    const ortho = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
    ortho.position.set(0, 0, 10);
    ortho.updateMatrixWorld(true);
    setLensShift(new THREE.PerspectiveCamera(50, 2, 0.1, 100), ortho, 0.3);
    expect(new THREE.Vector3(0, 0, 0).project(ortho).y).toBeCloseTo(0.3, 9);
  });

  it('clears the shift for a capture and restores it after', async () => {
    const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
    const ortho = new THREE.OrthographicCamera();
    setLensShift(cam, ortho, 0.2);
    const during = await withoutLensShift(cam, ortho, 0.2, async () => cam.view?.enabled === true);
    expect(during).toBe(false);
    expect(cam.view?.enabled).toBe(true);
    expect(cam.view?.offsetY).toBeCloseTo(0.1, 12);
    expect(cam.aspect).toBe(1.6);
  });
});
