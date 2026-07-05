/**
 * captureLens.ts
 *
 * The single source of truth for "is this an airborne survey / terrain dataset,
 * or a capture (object / interior / local-frame) scan where survey and terrain
 * framing does not apply?" (v0.5.7 object/E57 capture lens).
 *
 * It composes the two verdicts the app already computes — the shape verdict
 * (`scanShape`: object | interior | terrain) and the display profile
 * (`displayProfile`: geo | terrestrial-scan | handheld-scan | mesh) — into one
 * value read by every surface (the capture-type classifier, the report entry
 * points, and the panel sections). Carrying the facets, not just the boolean,
 * is deliberate: the two facets gate different wrongness and must not be
 * collapsed, or a local terrestrial scan of a hillside (terrain-shaped, no CRS)
 * would lose either its contours or its CRS suppression.
 *
 * Pure: enums in, booleans out. No DOM, no `Viewer`. Consumed via the lazy
 * `applyDisplayProfile` chunk so it never enters the eager startup shell.
 */

import type { DisplayProfile } from './displayProfile';

/** The scan-shape verdict as the app exposes it (`null` when not yet computed). */
export type ShapeVerdict = 'terrain' | 'object' | 'interior' | null | undefined;

export interface CaptureLens {
  /** Object or interior — terrain framing (contours, coverage, slope) is wrong. */
  readonly isNonTerrain: boolean;
  /** No geodetic CRS — survey / CRS / aerial framing is wrong. */
  readonly isLocalFrame: boolean;
  /** Either facet — this is not an airborne survey/terrain dataset. */
  readonly isCaptureScan: boolean;
}

/** Profiles that carry no geodetic CRS (the local-frame facet). */
const LOCAL_FRAME_PROFILES: ReadonlySet<DisplayProfile> = new Set<DisplayProfile>([
  'terrestrial-scan',
  'handheld-scan',
  'mesh',
]);

/** Compose the shape verdict and display profile into the capture lens. */
export function captureLensFor(shape: ShapeVerdict, profile: DisplayProfile): CaptureLens {
  const isNonTerrain = shape === 'object' || shape === 'interior';
  const isLocalFrame = LOCAL_FRAME_PROFILES.has(profile);
  return { isNonTerrain, isLocalFrame, isCaptureScan: isNonTerrain || isLocalFrame };
}
