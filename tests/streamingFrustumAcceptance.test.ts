/**
 * Draw-frustum acceptance for streamed nodes.
 *
 * The release blocker for this feature is one-directional: a node the viewer
 * can see must never be culled. A node kept when it could have been dropped
 * costs a draw; a node dropped when it was visible is a hole in the picture.
 * So the cases below lean on inclusion, and the boundary cases assert that a
 * node touching the frustum at all is drawn.
 *
 * Two traps are pinned specifically. The plane derivation is shared with the
 * scheduler rather than rewritten, because two extractions could disagree
 * about where the camera is looking. And the record comment warns that bounds
 * shifted twice by the render origin cull to nothing, so an origin case is
 * here with a real offset.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cullResidentNodes,
  boundsInRenderFrame,
  boxIntersectsFrustum,
  planesFromTuples,
  type Box6,
} from '../src/render/streaming/nodeFrustumCulling';
import { frustumPlanesFromViewProjection } from '../src/render/streaming/streamingScore';

/** Planes for a camera looking down -Z from +Z, as the renderer would build them. */
function planesFor(camera: THREE.Camera): ReturnType<typeof planesFromTuples> {
  camera.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  return planesFromTuples(frustumPlanesFromViewProjection(vp.elements));
}

function perspective(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  c.position.set(0, 0, 50);
  c.lookAt(0, 0, 0);
  return c;
}

function orthographic(): THREE.OrthographicCamera {
  const c = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.1, 1000);
  c.position.set(0, 0, 50);
  c.lookAt(0, 0, 0);
  return c;
}

const box = (cx: number, cy: number, cz: number, h = 2): Box6 =>
  [cx - h, cy - h, cz - h, cx + h, cy + h, cz + h];

const ORIGIN: readonly [number, number, number] = [0, 0, 0];

describe('perspective camera', () => {
  const planes = planesFor(perspective());

  it('draws a node in front of the camera', () => {
    expect(boxIntersectsFrustum(box(0, 0, 0), planes)).toBe(true);
  });

  it('culls a node far off to the side', () => {
    expect(boxIntersectsFrustum(box(500, 0, 0), planes)).toBe(false);
  });

  it('culls a node behind the camera', () => {
    expect(boxIntersectsFrustum(box(0, 0, 400), planes)).toBe(false);
  });

  it('draws a node that only intersects the frustum', () => {
    // Straddling the left plane: partially visible, so it must be drawn.
    expect(boxIntersectsFrustum(box(-28, 0, 0, 6), planes)).toBe(true);
  });
});

describe('orthographic camera', () => {
  const planes = planesFor(orthographic());

  it('draws a node inside the box', () => {
    expect(boxIntersectsFrustum(box(0, 0, 0), planes)).toBe(true);
  });

  it('culls a node outside it', () => {
    expect(boxIntersectsFrustum(box(200, 0, 0), planes)).toBe(false);
  });

  it('draws a node straddling the edge', () => {
    expect(boxIntersectsFrustum(box(21, 0, 0, 3), planes)).toBe(true);
  });
});

describe('render origin', () => {
  it('shifts world bounds into the drawn frame exactly once', () => {
    const world: Box6 = [1000, 2000, 10, 1004, 2004, 14];
    const shifted = boundsInRenderFrame(world, [1000, 2000, 10]);
    expect(shifted).toEqual([0, 0, 0, 4, 4, 4]);
  });

  it('draws a node at a large survey coordinate once the origin is applied', () => {
    const planes = planesFor(perspective());
    const origin: readonly [number, number, number] = [2600000, 1200000, 400];
    // A node sitting exactly at the render origin is at the scene centre.
    const world: Box6 = [
      origin[0] - 2, origin[1] - 2, origin[2] - 2,
      origin[0] + 2, origin[1] + 2, origin[2] + 2,
    ];
    const { drawn, residentNotDrawn } = cullResidentNodes(
      [{ key: 'n', bounds: world }], planes, origin,
    );
    expect(drawn).toEqual(['n']);
    expect(residentNotDrawn).toEqual([]);
  });

  it('culls everything when the origin is applied twice, which is the trap', () => {
    // Recorded so the failure has a named shape: the same node, shifted by an
    // origin it was already expressed relative to, lands far from the camera.
    const planes = planesFor(perspective());
    const origin: readonly [number, number, number] = [2600000, 1200000, 400];
    const alreadyLocal: Box6 = [-2, -2, -2, 2, 2, 2];
    const { drawn } = cullResidentNodes([{ key: 'n', bounds: alreadyLocal }], planes, origin);
    expect(drawn).toEqual([]);
  });
});

describe('residency is not visibility', () => {
  it('reports a culled node as resident-not-drawn rather than dropping it', () => {
    const planes = planesFor(perspective());
    const nodes = [
      { key: 'near', bounds: box(0, 0, 0) },
      { key: 'far-side', bounds: box(9000, 0, 0) },
    ];
    const { drawn, residentNotDrawn } = cullResidentNodes(nodes, planes, ORIGIN);
    expect(drawn).toEqual(['near']);
    expect(residentNotDrawn).toEqual(['far-side']);
    // Every node is accounted for: culling removes nothing from residency.
    expect(drawn.length + residentNotDrawn.length).toBe(nodes.length);
  });

  it('returns a node to drawn when the camera turns back, with no reload step', () => {
    const looking = planesFor(perspective());
    const away = (() => {
      const c = perspective();
      c.position.set(0, 0, 50);
      c.lookAt(0, 0, 1000); // turn around
      return planesFor(c);
    })();
    const nodes = [{ key: 'n', bounds: box(0, 0, 0) }];
    expect(cullResidentNodes(nodes, away, ORIGIN).drawn).toEqual([]);
    expect(cullResidentNodes(nodes, looking, ORIGIN).drawn).toEqual(['n']);
  });
});

describe('the plane derivation is shared, not duplicated', () => {
  it('accepts exactly the six the scheduler produces', () => {
    const vp = new THREE.Matrix4().multiplyMatrices(
      perspective().projectionMatrix,
      perspective().matrixWorldInverse,
    );
    const tuples = frustumPlanesFromViewProjection(vp.elements);
    expect(tuples).toHaveLength(6);
    expect(() => planesFromTuples(tuples)).not.toThrow();
  });

  it('refuses a plane set that is not six, rather than culling on a partial frustum', () => {
    expect(() => planesFromTuples([[1, 0, 0, 0]])).toThrow(/expected 6/);
  });
});
