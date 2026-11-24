/**
 * elevationShade.ts: the seam between elevation colouring and sun shading.
 *
 * `colorForMode('elevation')` passes its bytes through {@link shadeElevation},
 * so the first upload, a mode switch and every recolour shade alike without
 * the Viewer knowing. With nothing registered (the default, and whenever the
 * strength is zero) the bytes come back untouched.
 */

import type { PointCloud } from '../../model/PointCloud';

export interface ElevationShade {
  /** Shade `cloud`'s interleaved RGB in place; does nothing while it is not ready. */
  shade(cloud: PointCloud, rgb: Uint8Array): void;
  /** The legend sentence for `cloud`, or null when it is not shaded. */
  note(cloud: PointCloud): string | null;
}

let active: ElevationShade | null = null;

/** Register the shading, or clear it with null. */
export function setElevationShade(next: ElevationShade | null): void {
  active = next;
}

export function shadeElevation(cloud: PointCloud, rgb: Uint8Array): Uint8Array {
  active?.shade(cloud, rgb);
  return rgb;
}

export function elevationShadeNote(cloud: PointCloud): string | null {
  return active?.note(cloud) ?? null;
}
