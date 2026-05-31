/**
 * skyPresets.ts
 *
 * Tone-mapped radial-gradient background presets. Replaces the flat
 * `#070b16` dark background with a subtle gradient tuned per inspection
 * preset — cinematic without competing with the point cloud.
 *
 * Pure data — the values are CSS `radial-gradient(...)` strings the
 * Stage / Viewer wires into the canvas container's `background` style.
 * Switching presets is a single CSS variable update; no GPU work, no
 * extra draw call.
 */

import type { SkyPreset } from './inspectionPresets';

/** A sky preset's CSS background declaration. */
export interface SkyDefinition {
  /** CSS background-image value — paste straight into a style attr. */
  background: string;
  /** Solid fallback colour for environments that don't render gradients well. */
  fallbackColor: string;
}

const SKIES: Readonly<Record<SkyPreset, SkyDefinition>> = {
  deep: {
    background: 'radial-gradient(circle at 50% 35%, #0d1424 0%, #060912 70%, #04060c 100%)',
    fallbackColor: '#070b16',
  },
  'survey-blue': {
    background: 'radial-gradient(circle at 50% 30%, #14223a 0%, #0a1224 60%, #060a14 100%)',
    fallbackColor: '#0a1224',
  },
  'terrain-sand': {
    background: 'radial-gradient(circle at 50% 30%, #20251f 0%, #11140f 60%, #080a07 100%)',
    fallbackColor: '#11140f',
  },
  'foliage-teal': {
    background: 'radial-gradient(circle at 50% 30%, #0d2229 0%, #06141a 60%, #03090c 100%)',
    fallbackColor: '#06141a',
  },
  'qa-cool': {
    background: 'radial-gradient(circle at 50% 30%, #161e2e 0%, #0a0f1a 60%, #06090f 100%)',
    fallbackColor: '#0a0f1a',
  },
  // v0.3.7 polish presets — extend the inspection-mode set with skies tuned
  // for different presentation contexts (studio shots, blueprint look,
  // daylight survey, elevation work).
  'studio-dark': {
    // Flat #0B0F14 — the "studio backdrop" for hero shots and screenshots.
    // No gradient hue shift so points read cleanly against a constant tone.
    background:
      'radial-gradient(circle at 50% 50%, #0d1117 0%, #0b0f14 60%, #090c11 100%)',
    fallbackColor: '#0B0F14',
  },
  blueprint: {
    // Deep navy evocative of an engineering blueprint — cooler than
    // survey-blue, with a brighter highlight at the top to read like a
    // drafting-table lamp.
    background:
      'radial-gradient(circle at 50% 25%, #1a2b4d 0%, #0e1a35 55%, #060c1e 100%)',
    fallbackColor: '#0e1a35',
  },
  'survey-light': {
    // Warm off-white for daylight survey inspection — a near-white sky
    // tinted just enough that points carry contrast without harshness.
    // Light theme — the only preset that inverts the standard palette.
    background:
      'radial-gradient(circle at 50% 30%, #f6efe4 0%, #ebe2d2 65%, #e0d6c1 100%)',
    fallbackColor: '#ebe2d2',
  },
  terrain: {
    // Subtle atmospheric gradient for elevation-heavy work — warm
    // earthy underglow into cooler distance, reading like haze across
    // a wide landscape.
    background:
      'radial-gradient(circle at 50% 35%, #1c2025 0%, #131820 55%, #0a0e16 100%)',
    fallbackColor: '#131820',
  },
} as const;

/** Look up the CSS background + fallback for a sky preset. */
export function getSkyDefinition(preset: SkyPreset): SkyDefinition {
  return SKIES[preset];
}

/** Every sky preset id in display order. */
export const SKY_PRESET_ORDER: readonly SkyPreset[] = [
  'deep',
  'survey-blue',
  'terrain-sand',
  'foliage-teal',
  'qa-cool',
  // v0.3.7 polish presets follow the inspection-mode set so the user
  // sees the named inspection presets first, then the presentation /
  // context presets after.
  'studio-dark',
  'blueprint',
  'survey-light',
  'terrain',
];
