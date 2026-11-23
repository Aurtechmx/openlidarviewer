/**
 * lassoProjector.test.ts — the projection a lasso selection is decided by.
 *
 * The projector used to be built inline in the Viewer with three.js vectors,
 * where the only way to exercise it was a WebGL context. It now takes the
 * matrices as plain arrays, so the case that matters can be asserted directly:
 * it agrees with three.js point for point, because a selection that projected
 * differently from the render would select something other than what the user
 * drew around.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { isReversedProjection, makeLassoProjector, makeLassoUnprojector } from '../src/render/measure/lassoProjector';

const W = 1280;
const H = 720;

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(55, W / H, 0.5, 500);
  cam.position.set(12, -30, 18);
  cam.lookAt(0, 0, 2);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** The projector exactly as the Viewer built it before the extraction. */
function reference(cam: THREE.Camera): (x: number, y: number, z: number) => { x: number; y: number } | null {
  const tmp = new THREE.Vector3();
  return (x, y, z) => {
    tmp.set(x, y, z).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (tmp.z < -1 || tmp.z > 1) return null;
    return { x: (tmp.x * 0.5 + 0.5) * W, y: (1 - (tmp.y * 0.5 + 0.5)) * H };
  };
}

describe('makeLassoProjector', () => {
  const cam = camera();
  const project = makeLassoProjector(cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, W, H);
  const ref = reference(cam);

  it('agrees with the three.js projection it replaces', () => {
    for (let i = 0; i < 200; i++) {
      const x = ((i * 37) % 61) - 30;
      const y = ((i * 53) % 71) - 35;
      const z = ((i * 17) % 23) - 4;
      const got = project(x, y, z);
      const want = ref(x, y, z);
      if (want === null) {
        expect(got).toBeNull();
        continue;
      }
      expect(got).not.toBeNull();
      expect(got!.x).toBeCloseTo(want.x, 6);
      expect(got!.y).toBeCloseTo(want.y, 6);
    }
  });

  it('rejects a point behind the camera', () => {
    const behind = new THREE.Vector3(0, 0, 2).sub(cam.position).multiplyScalar(-2).add(cam.position);
    expect(project(behind.x, behind.y, behind.z)).toBeNull();
  });

  it('reports view-axis distance, which grows with distance from the camera', () => {
    const near = project(0, 0, 2)!;
    const far = project(0, 30, 2)!;
    expect(near.depth).toBeGreaterThan(0);
    // The camera sits at negative Y looking at the origin, so +Y is away.
    expect(far.depth!).toBeGreaterThan(near.depth!);
    // Distance along the view axis, not to the camera: a point on the axis has
    // both equal, so the near one pins the units as cloud units, not NDC.
    expect(near.depth!).toBeCloseTo(cam.position.distanceTo(new THREE.Vector3(0, 0, 2)), 3);
  });
});

describe('the lasso under every depth convention', () => {
  type Cam = THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const build = (kind: string, system: THREE.CoordinateSystem, reversed: boolean): Cam => {
    const cam: Cam = kind === 'perspective'
      ? new THREE.PerspectiveCamera(55, W / H, 0.01, 1000)
      : new THREE.OrthographicCamera(-32, 32, 18, -18, 0.01, 1000);
    cam.position.set(12, -30, 18);
    cam.lookAt(0, 0, 2);
    cam.coordinateSystem = system;
    (cam as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
  };
  const cases = ['perspective', 'orthographic'].flatMap((kind) => [
    { kind, name: 'WebGL', system: THREE.WebGLCoordinateSystem, reversed: false },
    { kind, name: 'WebGPU', system: THREE.WebGPUCoordinateSystem, reversed: false },
    { kind, name: 'reversed', system: THREE.WebGPUCoordinateSystem, reversed: true },
    { kind, name: 'reversed WebGL 2', system: THREE.WebGLCoordinateSystem, reversed: true },
  ]);

  it.each(cases)('$kind, $name: keeps the scene, drops what is behind or past far', ({ kind, system, reversed }) => {
    const cam = build(kind, system, reversed);
    expect(isReversedProjection(cam.projectionMatrix.elements)).toBe(reversed);
    const project = makeLassoProjector(cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, W, H);
    const along = (d: number): THREE.Vector3 => new THREE.Vector3(0, 0, -d).applyMatrix4(cam.matrixWorld);
    for (const d of [0.5, 10, 900]) {
      const p = along(d);
      expect(project(p.x, p.y, p.z)?.depth, `${d} m ahead`).toBeCloseTo(d, 6);
    }
    for (const d of [-0.5, -10, -900, 1001, 1500]) {
      const p = along(d);
      expect(project(p.x, p.y, p.z), `${d} m`).toBeNull();
    }
  });

  it.each(cases)('$kind, $name: unprojects to the plane ahead and refuses one behind', ({ kind, system, reversed }) => {
    const cam = build(kind, system, reversed);
    const unproject = makeLassoUnprojector(cam.matrixWorld.elements, cam.projectionMatrixInverse.elements, W, H);
    const at = new THREE.Vector3(3, -2, 1);
    const ndc = at.clone().project(cam);
    const hit = unproject((ndc.x * 0.5 + 0.5) * W, (1 - (ndc.y * 0.5 + 0.5)) * H, 1)!;
    expect(hit[0]).toBeCloseTo(3, 5);
    expect(hit[1]).toBeCloseTo(-2, 5);
    expect(hit[2]).toBeCloseTo(1, 8);
    // The camera looks down from 18 m: a plane at 40 m is behind it.
    expect(unproject(W / 2, H / 2, 40)).toBeNull();
  });
});
