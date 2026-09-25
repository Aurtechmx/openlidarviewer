/**
 * ObservatoryOverlay.ts — the three.js binding for the Observatory's
 * shadow-voxel wireframe, drawn through `Viewer.derivedLayerHost()` exactly
 * as contours and Flow Pulse are (SPEC's own O9 requirement: visible in the
 * scene, not only inside the panel's modal).
 *
 * Reuses `SceneLineOverlay`, the same shared attach/detach/dispose base
 * `ProfileLinkOverlay.ts` and `FlowOverlay.ts`'s path overlay stand on, so
 * this file is only the buffer upload and lifecycle — the actual voxel
 * geometry comes from the pure `observatoryOverlayGeometry.ts`.
 */
import * as THREE from 'three/webgpu';
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';
import { buildShadowWireframeBuffer } from './observatoryOverlayGeometry';

export type ObservatoryOverlayHost = SceneOverlayHost;

const SHADOW_COLOR = 0x7a5cff;
const SHADOW_OPACITY = 0.55;

export class ObservatoryOverlay extends SceneLineOverlay {
  constructor(host: ObservatoryOverlayHost) {
    super(
      host,
      { color: SHADOW_COLOR, transparent: true, opacity: SHADOW_OPACITY, depthTest: true },
      { name: 'olv-observatory-shadow', renderOrder: 5 },
    );
  }

  /** Draw a wireframe box per shadowed voxel key, or clear with an empty list. */
  show(
    shadowedKeys: readonly number[],
    grid: { readonly nx: number; readonly ny: number },
    voxelEdge: number,
    domainMin: readonly [number, number, number],
  ): void {
    if (this.isDisposed) return;
    if (shadowedKeys.length === 0) {
      this.clear();
      return;
    }
    const verts = buildShadowWireframeBuffer(shadowedKeys, grid, voxelEdge, domainMin);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.present();
  }
}
