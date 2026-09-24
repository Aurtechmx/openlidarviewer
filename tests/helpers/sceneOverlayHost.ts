/**
 * sceneOverlayHost.ts — a fake `SceneOverlayHost` that records what an
 * overlay attaches/detaches, shared by `flowOverlayInvalidation.test.ts` and
 * `terrainAccessOverlayInvalidation.test.ts` (Sonar-flagged as a verbatim
 * duplicate).
 */
import * as THREE from 'three/webgpu';

export function fakeHost() {
  const objects: THREE.Object3D[] = [];
  return {
    add: (o: THREE.Object3D) => { objects.push(o); },
    remove: (o: THREE.Object3D) => {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    requestFrame: () => {},
    objects,
  };
}
