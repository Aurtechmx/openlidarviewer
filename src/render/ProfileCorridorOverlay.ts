/**
 * ProfileCorridorOverlay.ts
 *
 * The 3D outline of the corridor a profile section actually sampled — the
 * capsule (or disc / line) of space whose returns the transect drew from. It is
 * the SAMPLING SUPPORT of the section, NOT an uncertainty band: it says where the
 * points came from, not how wrong the surface is.
 *
 * A SCENE OBJECT, NOT A PROJECTED OVERLAY, and the exact sibling of
 * {@link ProfileLinkOverlay}: the outline is placed once, in project-frame world
 * coordinates, and left to the camera, so it holds through an orbit or resize
 * without the workbench touching the render loop. It owns its own object and
 * nothing else's; a null clears it.
 *
 * Scene membership arrives as {@link ProfileLinkOverlayHost} — `derivedLayerHost()`
 * satisfies it — so nothing here names the Viewer.
 */

import * as THREE from 'three/webgpu';

import type { ProfileCorridorOutline } from './measure/profileCorridorOutline';
import { SceneLineOverlay, type SceneOverlayHost } from './sceneLineOverlay';

/** A muted cyan — a boundary the eye reads as context, not as measured geometry. */
const CORRIDOR_COLOUR = 0x4dd0e1;
const CORRIDOR_OPACITY = 0.55;

type Vec3 = readonly [number, number, number];

/** Append each consecutive pair of a polyline as a LineSegments pair into `out`. */
function pushPolyline(poly: readonly Vec3[], out: number[]): void {
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

/**
 * The polylines to draw for an outline: the transect down the middle, plus the
 * boundary. A capsule carries the whole boundary in `loop`; a disc has no loop,
 * so its two cap rings are drawn instead. A `line` or `none` outline draws only
 * the transect (or nothing).
 */
function outlineSegments(outline: ProfileCorridorOutline): Float32Array {
  const out: number[] = [];
  if (outline.centre.length >= 2) pushPolyline(outline.centre, out);
  if (outline.loop.length >= 2) {
    pushPolyline(outline.loop, out);
  } else {
    if (outline.startCap.length >= 2) pushPolyline(outline.startCap, out);
    if (outline.endCap.length >= 2) pushPolyline(outline.endCap, out);
  }
  return new Float32Array(out);
}

export class ProfileCorridorOverlay extends SceneLineOverlay {
  constructor(host: SceneOverlayHost) {
    super(
      host,
      {
        color: CORRIDOR_COLOUR,
        transparent: true,
        opacity: CORRIDOR_OPACITY,
        // Drawn through the scan like the link mark: the corridor encloses the
        // points it describes, so an occluded outline would only show edge-on.
        depthTest: false,
      },
      { name: 'olv-profile-corridor', renderOrder: 9 },
    );
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  }

  /** Draw the outline, or clear it with `null` (or a degenerate `none` outline). */
  show(outline: ProfileCorridorOutline | null): void {
    if (this.isDisposed) return;
    const positions = outline ? outlineSegments(outline) : new Float32Array(0);
    if (positions.length === 0) {
      this.clear();
      return;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.computeBoundingSphere();
    this.present();
  }
}
