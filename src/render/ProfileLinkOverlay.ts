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
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';

/** Scene membership and redraw, and nothing more. The shared overlay host. */
export type ProfileLinkOverlayHost = SceneOverlayHost;

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

export class ProfileLinkOverlay extends SceneLineOverlay {
  private readonly _positions = new Float32Array(18);

  constructor(host: ProfileLinkOverlayHost) {
    super(
      host,
      {
        color: HOVER_COLOUR,
        transparent: true,
        opacity: HOVER_OPACITY,
        // Drawn through the scan rather than behind it: the marked return is
        // usually inside the cloud, and a mark occluded by the points it names
        // would only be visible when the section happened to face the camera.
        depthTest: false,
      },
      { name: 'olv-profile-link-mark', renderOrder: 10 },
    );
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
  }

  /** Place the mark, or clear it with `null`. */
  show(mark: ProfileLinkMark | null): void {
    if (this.isDisposed) return;
    if (!mark) {
      this.clear();
      return;
    }
    profileMarkerSegments(mark.position, mark.size, this._positions);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    const locked = mark.mode === 'locked';
    this.material.color.setHex(locked ? LOCKED_COLOUR : HOVER_COLOUR);
    this.material.opacity = locked ? LOCKED_OPACITY : HOVER_OPACITY;
    this.present();
  }
}
