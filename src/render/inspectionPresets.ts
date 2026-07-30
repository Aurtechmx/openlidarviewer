/**
 * inspectionPresets.ts
 *
 * One-tap "looks right out of the box" presets — Survey · Terrain ·
 * Foliage · Classification · QA Inspection. Each preset is a bundle of
 * the seven tunables that drive the readability of a LiDAR scan:
 *
 *   - EDL strength (depth-edge shading)
 *   - point size + point-size mode (fixed vs adaptive)
 *   - sky preset (background gradient style)
 *   - the colour mode the preset moves into
 *
 * Three further settings the presets used to declare (AO strength,
 * elevation palette, hillshade) have no runtime setter behind them. They
 * live under `reserved` so the applied set and the aspirational set are
 * not read as one thing.
 *
 * The `description` of each preset names ONLY the four applied fields. It used
 * to advertise the reserved ones as well ("light AO", "hillshade + cividis
 * ramp", "viridis ramp"), which put a promise in the tooltip that the renderer
 * could not keep: a user reading "hillshade" and seeing none reasonably
 * concludes the feature is broken rather than absent. Anything under `reserved`
 * is documented in this file for developers and stays out of the descriptions.
 *
 * Pure data — no DOM, no three.js — so it ships through the same seam
 * every other v0.3.7 module reads. The Viewer applies a preset by
 * reading these fields and calling its existing setters; persistence
 * uses the preset *name* not its payload, so future preset tweaks
 * propagate to saved sessions automatically.
 */

import type { ElevationPalette } from './colorModes';

/**
 * Background sky preset keyed by inspection mode.
 *
 * v0.3.7 polish adds four release-polish presets alongside the original
 * five inspection-mode skies:
 *   - `studio-dark` — flat #0B0F14, the "studio" backdrop for hero
 *     screenshots and presentations.
 *   - `blueprint` — deep navy gradient evocative of engineering drawings.
 *   - `survey-light` — warm off-white for daylight survey inspection.
 *   - `terrain` — subtle atmospheric gradient for elevation-heavy work.
 */
export type SkyPreset =
  | 'deep'
  | 'survey-blue'
  | 'terrain-sand'
  | 'foliage-teal'
  | 'qa-cool'
  | 'studio-dark'
  | 'blueprint'
  | 'survey-light'
  | 'terrain'
  | 'black';

/**
 * Fields a preset declares but the live renderer does not apply.
 *
 * These sat in `InspectionPreset` and read as operational: a preset naming a
 * palette, or switching hillshade on, appeared to change the scene and did
 * not. `Viewer.applyPreset()` never touched any of them, and no runtime
 * setter exists for them to call.
 *
 * They are kept rather than deleted, because the values were tuned against
 * real survey data and are the right starting point once each capability
 * lands. Holding them behind `reserved` makes the separation explicit:
 * nothing in here is claimed to affect the live view.
 */
export interface ReservedPresetCapabilities {
  /**
   * SSAO strength 0..1. `ssaoApproximation.ts` computes an AO factor, but no
   * pass consumes it, so there is nothing for a preset to set.
   */
  readonly aoStrength: number;
  /**
   * Elevation palette for height colouring. The Viewer exposes no palette
   * setter; the ramp is selected inside `colorForMode`.
   */
  readonly elevationPalette: ElevationPalette;
  /**
   * Terrain relief shading. Hillshade is an analysis product derived from a
   * DEM, not a live point-cloud render control, so a preset field cannot
   * switch it on: there is no live hillshade renderer to switch.
   */
  readonly hillshade: boolean;
}

/** A complete preset bundle. */
export interface InspectionPreset {
  /** Identifier — used for persistence and the chip label. */
  readonly id: PresetId;
  /** Human label shown in the chip / picker. */
  readonly label: string;
  /**
   * One-line description for the hover tooltip.
   *
   * User-facing, so it may name only effects the applier actually performs:
   * colour mode, EDL strength, point size and mode, background. The EDL and
   * point-size figures are repeated here in words, and
   * `tests/inspectionPresets.test.ts` reads them back out of the sentence and
   * compares them with the fields, so a retuned preset with a stale sentence
   * fails rather than shipping.
   */
  readonly description: string;
  /** EDL strength 0..1.5. */
  readonly edlStrength: number;
  /** Whether EDL is on in this preset. */
  readonly edlEnabled: boolean;
  /** Base point size in pixels. */
  readonly pointSize: number;
  /** Fixed or adaptive size by distance. */
  readonly pointSizeMode: 'fixed' | 'adaptive';
  /** Sky / background preset. */
  readonly sky: SkyPreset;
  /**
   * Colour mode the preset moves into. Applied per cloud, and only where the
   * cloud carries what that mode needs; a cloud with no classification keeps
   * the mode it has rather than rendering a uniform default.
   */
  readonly defaultColorMode: 'rgb' | 'elevation' | 'classification' | 'density' | 'intensity';
  /** Declared, not applied to the live view. See `ReservedPresetCapabilities`. */
  readonly reserved: ReservedPresetCapabilities;
}

/** The set of preset ids. Closed so the type system catches unknown names. */
export type PresetId = 'survey' | 'terrain' | 'foliage' | 'classification' | 'qa';

/** The default preset every fresh session opens with. */
export const DEFAULT_PRESET_ID: PresetId = 'survey';

/**
 * The five built-in presets. Tuned for the v0.3.7 readability-first
 * release. The values are the result of A/B'ing against real drone +
 * terrestrial + airborne survey data; analysts who want tighter control
 * can still drive every parameter individually after applying a preset.
 */
const PRESETS: Readonly<Record<PresetId, InspectionPreset>> = {
  survey: {
    id: 'survey',
    label: 'Survey',
    description:
      'General drone and mobile scans. RGB colour where the scan has it, EDL 0.7, '
      + 'adaptive 2 px points, survey-blue background.',
    edlEnabled: true,
    edlStrength: 0.7,
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'survey-blue',
    defaultColorMode: 'rgb',
    reserved: { aoStrength: 0.35, elevationPalette: 'cividis', hillshade: false },
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    description:
      'Bare-earth and DTM work. Elevation colour, EDL 0.55, adaptive 2 px points, '
      + 'terrain-sand background.',
    edlEnabled: true,
    edlStrength: 0.55,
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'terrain-sand',
    defaultColorMode: 'elevation',
    reserved: { aoStrength: 0.25, elevationPalette: 'cividis', hillshade: true },
  },
  foliage: {
    id: 'foliage',
    label: 'Foliage',
    description:
      'Forestry and canopy work. Elevation colour, EDL 0.5, adaptive 2 px points, '
      + 'foliage-teal background.',
    edlEnabled: true,
    edlStrength: 0.5,
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'foliage-teal',
    defaultColorMode: 'elevation',
    reserved: { aoStrength: 0.2, elevationPalette: 'viridis', hillshade: false },
  },
  classification: {
    id: 'classification',
    label: 'Classification',
    description:
      'ASPRS class review. Classification colour where the scan carries a class field, '
      + 'EDL 0.45 so the class colours stay readable, adaptive 2.25 px points, deep background.',
    edlEnabled: true,
    edlStrength: 0.45,
    pointSize: 2.25,
    pointSizeMode: 'adaptive',
    sky: 'deep',
    defaultColorMode: 'classification',
    reserved: { aoStrength: 0.15, elevationPalette: 'cividis', hillshade: false },
  },
  qa: {
    id: 'qa',
    label: 'QA Inspection',
    description:
      'Acceptance review. Density colour, EDL 0.85, fixed 2.5 px points, qa-cool background.',
    edlEnabled: true,
    edlStrength: 0.85,
    pointSize: 2.5,
    pointSizeMode: 'fixed',
    sky: 'qa-cool',
    defaultColorMode: 'density',
    reserved: { aoStrength: 0.5, elevationPalette: 'inferno', hillshade: false },
  },
} as const;

/** All preset ids in display order. */
export const PRESET_ORDER: readonly PresetId[] = [
  'survey',
  'terrain',
  'foliage',
  'classification',
  'qa',
] as const;

/** List every preset in display order — the picker reads this directly. */
export function listPresets(): readonly InspectionPreset[] {
  return PRESET_ORDER.map((id) => PRESETS[id]);
}

/** Look up a preset by id. Returns the default when the id is unknown. */
export function getPreset(id: PresetId | string): InspectionPreset {
  const known = (PRESETS as Record<string, InspectionPreset>)[id];
  return known ?? PRESETS[DEFAULT_PRESET_ID];
}

/** True when the given string is one of the known preset ids. */
export function isPresetId(v: string): v is PresetId {
  return v in PRESETS;
}
