/**
 * photorealLook.ts
 *
 * The v0.3.7 "Photoreal RGB" one-click bundle. Ties together every
 * data-layer leaf the Inspector touches when an analyst picks the
 * Photoreal preset — the documented release-default look without
 * forcing the UI to know each individual ID.
 *
 * Pure data — the bundle is a deterministic shape the Inspector reads
 * and pushes through the existing public APIs (`applyPreset`,
 * `setRgbAppearance`, sky lookup). No new pipeline coupling.
 */

import type { RgbAppearancePresetId } from './rgbAppearance';
import type { EdlPresetId } from './edlPresets';
import type { SkyPreset } from './inspectionPresets';

/** The Photoreal-RGB documented release-default look. */
export interface PhotorealLook {
  /** RGB appearance preset id — feeds `getRgbAppearancePreset`. */
  readonly rgbAppearance: RgbAppearancePresetId;
  /** EDL preset id — feeds `getEdlPreset`. */
  readonly edl: EdlPresetId;
  /** Sky preset id — feeds `getSkyDefinition`. */
  readonly sky: SkyPreset;
  /** Short human label the Inspector uses on the picker chip. */
  readonly label: string;
  /** Description shown in the chip tooltip / activation feedback. */
  readonly description: string;
}

/**
 * The documented release-default Photoreal-RGB look. Stable, readonly,
 * shaped so the Inspector can call:
 *
 *   viewer.setRgbAppearance(getRgbAppearancePreset(look.rgbAppearance).settings);
 *   // …and so on through edl / sky.
 */
export const PHOTOREAL_RGB_LOOK: Readonly<PhotorealLook> = Object.freeze({
  rgbAppearance: 'photoreal-rgb',
  edl: 'subtle',
  sky: 'studio-dark',
  label: 'Photoreal RGB',
  description: 'Documented v0.3.7 release-default look — Photoreal RGB appearance, Subtle EDL, Studio Dark backdrop.',
});

/**
 * Resolve a look by id. The current catalogue ships a single look
 * (`photoreal-rgb`); the signature is shaped so the catalogue can grow
 * without an API break.
 */
export function getPhotorealLook(id: 'photoreal-rgb'): PhotorealLook {
  // Discriminated id keeps the lookup type-safe; the call site can't
  // ask for a look that doesn't exist yet.
  if (id === 'photoreal-rgb') return PHOTOREAL_RGB_LOOK;
  return PHOTOREAL_RGB_LOOK;
}
