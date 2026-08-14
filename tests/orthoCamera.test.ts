import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeOrthoCamera, syncCameraPose, fitOrthoFrustum, followPerspective } from '../src/render/camera/orthoCamera';

describe('makeOrthoCamera', () => {
  it('is a real orthographic camera with the given depth range', () => {
    const c = makeOrthoCamera(0.5, 1234);
    expect(c.isOrthographicCamera).toBe(true);
    expect(c.near).toBe(0.5);
    expect(c.far).toBe(1234);
  });
});

describe('syncCameraPose', () => {
  it('copies position and orientation so the inactive camera shadows the master', () => {
    const persp = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    persp.position.set(10, -5, 30);
    persp.lookAt(0, 0, 0);
    persp.updateMatrixWorld(true);

    const ortho = makeOrthoCamera(0.1, 100);
    syncCameraPose(ortho, persp);

    expect(ortho.position.toArray()).toEqual(persp.position.toArray());
    expect(ortho.quaternion.toArray()).toEqual(persp.quaternion.toArray());
    // World matrices agree, so a switch keeps the exact view direction.
    expect(ortho.matrixWorld.elements).toEqual(persp.matrixWorld.elements);
  });
});

describe('fitOrthoFrustum', () => {
  it('sets a symmetric frustum that fits the sphere, wider than tall in landscape', () => {
    const c = makeOrthoCamera(0.1, 1000);
    fitOrthoFrustum(c, 10, 2, 0.1, 1000, 1); // aspect 2, no pad
    expect(c.top).toBeCloseTo(10);
    expect(c.bottom).toBeCloseTo(-10);
    expect(c.right).toBeCloseTo(20);
    expect(c.left).toBeCloseTo(-20);
    expect(c.near).toBe(0.1);
    expect(c.far).toBe(1000);
  });

  it('applies edge padding', () => {
    const c = makeOrthoCamera(0.1, 1000);
    fitOrthoFrustum(c, 10, 1, 0.1, 1000, 1.1);
    expect(c.top).toBeCloseTo(11);
  });

  it('leaves zoom untouched (OrbitControls owns dolly under ortho)', () => {
    const c = makeOrthoCamera(0.1, 1000);
    c.zoom = 2.5;
    fitOrthoFrustum(c, 10, 1, 0.1, 1000);
    expect(c.zoom).toBe(2.5);
  });

  it('produces a finite projection matrix', () => {
    const c = makeOrthoCamera(0.1, 1000);
    fitOrthoFrustum(c, 10, 1.5, 0.1, 1000);
    expect(c.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
  });
});

describe('followPerspective', () => {
  const target = new THREE.Vector3(0, 0, 0);

  function persp(dist: number, fov = 60): THREE.PerspectiveCamera {
    const p = new THREE.PerspectiveCamera(fov, 1, 0.1, 1000);
    p.position.set(0, 0, dist);
    p.lookAt(target);
    p.updateMatrixWorld(true);
    return p;
  }

  it('sets a half-height of distance × tan(fov/2), matching what perspective spans at the target', () => {
    const p = persp(100, 60);
    const o = makeOrthoCamera(0.1, 1000);
    followPerspective(o, p, target, 60, 1, 0.1, 1000);
    // tan(30°) ≈ 0.57735 → halfH ≈ 57.735
    expect(o.top).toBeCloseTo(100 * Math.tan(Math.PI / 6), 3);
  });

  it('shrinks the frustum as the perspective camera dollies in (drives ortho zoom)', () => {
    const o = makeOrthoCamera(0.1, 1000);
    followPerspective(o, persp(100), target, 60, 1, 0.1, 1000);
    const far = o.top;
    followPerspective(o, persp(50), target, 60, 1, 0.1, 1000);
    const near = o.top;
    expect(near).toBeCloseTo(far / 2, 3); // half the distance → half the extent
  });

  it('stretches the horizontal extent by aspect', () => {
    const o = makeOrthoCamera(0.1, 1000);
    followPerspective(o, persp(100), target, 60, 2, 0.1, 1000);
    expect(o.right).toBeCloseTo(o.top * 2, 3);
  });

  it('copies the pose so the two cameras share a view direction', () => {
    const p = persp(80);
    const o = makeOrthoCamera(0.1, 1000);
    followPerspective(o, p, target, 60, 1, 0.1, 1000);
    expect(o.position.toArray()).toEqual(p.position.toArray());
    expect(o.quaternion.toArray()).toEqual(p.quaternion.toArray());
  });
});
