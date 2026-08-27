/**
 * exportModeAvailability.ts
 *
 * Which Visual-Export image modes the current scene can produce, and why not when
 * it can't. Pure: it decides from a handful of scene facts (does an AABB exist,
 * is the Z extent measurable, which per-point channels are present) rather than
 * touching the Viewer, so the reasons the panel shows are unit-testable without a
 * WebGL context. Lifted out of Viewer.availableImageExportModes to keep the
 * render monolith shrinking; the Viewer supplies the facts from its export
 * adapter and this builds the map.
 */

import type { ExportMode } from '../export/types';

/** The scene facts each mode's availability is decided from. */
export interface ExportModeFacts {
  /** A finite bounding box exists (a cloud is loaded). */
  readonly hasAabb: boolean;
  /** Vertical extent of that box, in render units (0 when no box). */
  readonly zRange: number;
  readonly hasIntensity: boolean;
  readonly hasClassification: boolean;
  readonly hasNormals: boolean;
}

export type ExportModeAvailability = { readonly available: boolean; readonly reason?: string };

/** Build the per-mode availability map (with human reasons) from the scene facts. */
export function imageExportModeAvailability(
  facts: ExportModeFacts,
): ReadonlyMap<ExportMode, ExportModeAvailability> {
  const { hasAabb, zRange, hasIntensity, hasClassification, hasNormals } = facts;
  const out = new Map<ExportMode, ExportModeAvailability>();

  // orthographic-rgb — always available (current-mode passthrough).
  out.set('orthographic-rgb', { available: true });

  // height-map — needs an AABB with a non-degenerate Z extent.
  if (!hasAabb) {
    out.set('height-map', { available: false, reason: 'No cloud is loaded.' });
  } else if (zRange <= 1e-4) {
    out.set('height-map', { available: false, reason: 'Cloud has no measurable height range.' });
  } else {
    out.set('height-map', { available: true });
  }

  // intensity — needs an AABB + the channel.
  if (!hasAabb) {
    out.set('intensity', { available: false, reason: 'No cloud is loaded.' });
  } else if (!hasIntensity) {
    out.set('intensity', { available: false, reason: 'This cloud has no per-point intensity channel.' });
  } else {
    out.set('intensity', { available: true });
  }

  // classification — needs an AABB + the channel.
  if (!hasAabb) {
    out.set('classification', { available: false, reason: 'No cloud is loaded.' });
  } else if (!hasClassification) {
    out.set('classification', { available: false, reason: 'This cloud has no per-point classification channel.' });
  } else {
    out.set('classification', { available: true });
  }

  // normal — needs the channel. LiDAR captures rarely include normals.
  if (!hasNormals) {
    out.set('normal', {
      available: false,
      reason:
        'This cloud has no per-point normals. LiDAR captures rarely include them; PCD, PTX and GLTF scans and 3D Tiles point tiles that carry normals are supported.',
    });
  } else {
    out.set('normal', { available: true });
  }

  return out;
}
