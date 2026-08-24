/**
 * ProfileLinkOverlay.ts
 *
 * The mark the 3D scene carries for the return selected in the Profile
 * Workbench: a small three-axis cross standing on the source point.
 *
 * A SCENE OBJECT, NOT A PROJECTED OVERLAY. The inspector draws its marker as
 * an SVG halo re-projected from the camera every frame, which is crisp but
 * needs a per-frame hook. This mark is placed once and left to the camera, so
 * it stays on the point through an orbit, a fly and a resize without the
 * workbench subscribing to the render loop at all. Its arm length comes from
 * the corridor half width (`profileMarkerSize`), so it reads at the scale of
 * the section that produced it rather than at a constant that is invisible on
 * one scan and a wall across another.
 *
 * IT DOES NOT TOUCH THE INSPECTOR. Profile selection and Inspect selection are
 * separate states: a hover over the section must not clear a point the user
 * picked with the inspector, and picking with the inspector must not clear the
 * section's mark. This overlay owns its own object and nothing else's.
 *
 * Scene membership arrives as {@link ProfileLinkOverlayHost} — `derivedLayerHost()`
 * satisfies it — so nothing here names the Viewer.
 */

import * as THREE from 'three/webgpu';

import { profileMarkerSegments } from './measure/profilePointLink';

/** Scene membership and redraw, and nothing more. */
export interface ProfileLinkOverlayHost {
  add(object: THREE.Object3D): void;
  remove(object: THREE.Object3D): void;
  requestFrame(): void;
}

/** What to mark. `null` clears the mark. */
export interface ProfileLinkMark {
  readonly position: readonly [number, number, number];
  readonly mode: 'hover' | 'locked';
  /** Arm length in scene units, from {@link profileMarkerSize}. */
  readonly size: number;
}

/** A passing hover is quieter than a selection the user committed to. */
const HOVER_COLOUR = 0xffd666;
const LOCKED_COLOUR = 0xffffff;
const HOVER_OPACITY = 0.65;
const LOCKED_OPACITY = 1;

export class ProfileLinkOverlay {
  private readonly _host: ProfileLinkOverlayHost;
  private readonly _positions = new Float32Array(18);
  private readonly _geometry: THREE.BufferGeometry;
  private readonly _material: THREE.LineBasicMaterial;
  private readonly _lines: THREE.LineSegments;
  private _attached = false;
  private _disposed = false;

  constructor(host: ProfileLinkOverlayHost) {
    this._host = host;
    this._geometry = new THREE.BufferGeometry();
    this._geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    this._material = new THREE.LineBasicMaterial({
      color: HOVER_COLOUR,
      transparent: true,
      opacity: HOVER_OPACITY,
      // Drawn through the scan rather than behind it: the marked return is
      // usually inside the cloud, and a mark occluded by the points it names
      // would only be visible when the section happened to face the camera.
      depthTest: false,
    });
    this._lines = new THREE.LineSegments(this._geometry, this._material);
    this._lines.name = 'olv-profile-link-mark';
    this._lines.frustumCulled = false;
    this._lines.renderOrder = 10;
    this._lines.visible = false;
  }

  /** Place the mark, or clear it with `null`. */
  show(mark: ProfileLinkMark | null): void {
    if (this._disposed) return;
    if (!mark) {
      if (this._attached) {
        this._host.remove(this._lines);
        this._attached = false;
      }
      this._lines.visible = false;
      this._host.requestFrame();
      return;
    }
    profileMarkerSegments(mark.position, mark.size, this._positions);
    const attribute = this._geometry.getAttribute('position');
    attribute.needsUpdate = true;
    this._geometry.computeBoundingSphere();
    const locked = mark.mode === 'locked';
    this._material.color.setHex(locked ? LOCKED_COLOUR : HOVER_COLOUR);
    this._material.opacity = locked ? LOCKED_OPACITY : HOVER_OPACITY;
    this._lines.visible = true;
    if (!this._attached) {
      this._host.add(this._lines);
      this._attached = true;
    }
    this._host.requestFrame();
  }

  /** Detach and release the GPU resources. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached) {
      this._host.remove(this._lines);
      this._attached = false;
    }
    this._geometry.dispose();
    this._material.dispose();
    this._host.requestFrame();
  }
}
