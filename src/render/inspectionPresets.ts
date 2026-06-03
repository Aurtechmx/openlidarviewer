/**
 * inspectionPresets.ts
 *
 * One-tap "looks right out of the box" presets — Survey · Terrain ·
 * Foliage · Classification · QA Inspection. Each preset is a bundle of
 * the seven tunables that drive the readability of a LiDAR scan:
 *
 *   - EDL strength (depth-edge shading)
 *   - AO strength (cavity / crevice shading, when supported)
 *   - elevation palette (for the height colour mode)
 *   - point size + point-size mode (fixed vs adaptive)
 *   - sky preset (background gradient style)
 *   - hillshade enabled (terrain-only relief shading)
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

/** A complete preset bundle. */
export interface InspectionPreset {
  /** Identifier — used for persistence and the chip label. */
  readonly id: PresetId;
  /** Human label shown in the chip / picker. */
  readonly label: string;
  /** One-line description for the hover tooltip. */
  readonly description: string;
  /** EDL strength 0..1.5. */
  readonly edlStrength: number;
  /** Whether EDL is on in this preset. */
  readonly edlEnabled: boolean;
  /**
   * SSAO strength 0..1. Renderer ignores this on backends that don't
   * yet have the SSAO pass plumbed; the field is shipped so when SSAO
   * lands the presets pick up the right look without further edits.
   */
  readonly aoStrength: number;
  /** Elevation palette for height colouring. */
  readonly elevationPalette: ElevationPalette;
  /** Base point size in pixels. */
  readonly pointSize: number;
  /** Fixed or adaptive size by distance. */
  readonly pointSizeMode: 'fixed' | 'adaptive';
  /** Sky / background preset. */
  readonly sky: SkyPreset;
  /** Whether the hillshade colour-mode overlay is on (terrain only). */
  readonly hillshade: boolean;
  /** Default colour-mode to switch into when the preset applies. */
  readonly defaultColorMode: 'rgb' | 'elevation' | 'classification' | 'density' | 'intensity';
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
    description: 'Balanced default — colour + EDL + light AO for general drone / mobile scans',
    edlEnabled: true,
    edlStrength: 0.7,
    aoStrength: 0.35,
    elevationPalette: 'cividis',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'survey-blue',
    hillshade: false,
    defaultColorMode: 'rgb',
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    description: 'Bare-earth + DTM workflows — hillshade + cividis ramp + warm sky',
    edlEnabled: true,
    edlStrength: 0.55,
    aoStrength: 0.25,
    elevationPalette: 'cividis',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'terrain-sand',
    hillshade: true,
    defaultColorMode: 'elevation',
  },
  foliage: {
    id: 'foliage',
    label: 'Foliage',
    description: 'Forestry + canopy work — soft EDL, deep teal sky, viridis ramp',
    edlEnabled: true,
    edlStrength: 0.5,
    aoStrength: 0.2,
    elevationPalette: 'viridis',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'foliage-teal',
    hillshade: false,
    defaultColorMode: 'elevation',
  },
  classification: {
    id: 'classification',
    label: 'Classification',
    description: 'ASPRS class review — class palette, modest EDL so colours dominate',
    edlEnabled: true,
    edlStrength: 0.45,
    aoStrength: 0.15,
    elevationPalette: 'cividis',
    pointSize: 2.25,
    pointSizeMode: 'adaptive',
    sky: 'deep',
    hillshade: false,
    defaultColorMode: 'classification',
  },
  qa: {
    id: 'qa',
    label: 'QA Inspection',
    description: 'Acceptance review — high EDL + AO, cool sky, density colouring',
    edlEnabled: true,
    edlStrength: 0.85,
    aoStrength: 0.5,
    elevationPalette: 'inferno',
    pointSize: 2.5,
    pointSizeMode: 'fixed',
    sky: 'qa-cool',
    hillshade: false,
    defaultColorMode: 'density',
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
