/**
 * terrainWorkflowPresets.ts
 *
 * Workflow presets for the Visuals Studio (v0.4.5) — Terrain · Construction
 * · Mining · Forestry · Hydrology · Archaeology. One chip click answers the
 * domain question "how should this scan LOOK for my job?" by bundling the
 * knobs that already exist, and ONLY those knobs:
 *
 *   - colour mode            (Viewer.setColorMode / streaming equivalent)
 *   - EDL preset             (Viewer.setEdlPreset — strength rides along)
 *   - point size + size mode (Viewer.setPointSize / setPointSizeMode)
 *   - sky / background       (Viewer.setSky)
 *   - height percentile trim (Viewer.setHeightPercentileTrim — how much of
 *                             the elevation band the height ramp spans)
 *
 * NO new rendering engines, by contract. Live hillshade / ramp selection are
 * not runtime knobs today (hillshade lives in the Analyse panel's relief
 * tile), so relief-heavy presets (Mining, Archaeology) reach for the closest
 * existing instrument: the `inspection` EDL preset, whose strong depth-edge
 * shading is the live-view counterpart of a high-relief hillshade.
 *
 * "Custom" semantics: {@link matchTerrainWorkflowPreset} maps the CURRENT
 * knob state back to a preset id, or null when the user has deviated on any
 * preset-managed knob — the UI then lights a "Custom" chip instead of a
 * preset. Matching uses only discrete ids + the two numeric knobs the
 * presets set exactly, so it can never false-positive from float drift.
 *
 * Pure data + pure functions — no DOM, no three.js — mirroring
 * `inspectionPresets.ts`, so the table is trivially unit-testable.
 */

import type { ColorMode } from './colorModes';
import type { SkyPreset } from './inspectionPresets';
import type { EdlPresetId } from './edlPresets';
import type { PointSizeMode } from './pointStyle';

/** The closed set of workflow preset ids. */
export type TerrainWorkflowPresetId =
  | 'terrain'
  | 'construction'
  | 'mining'
  | 'forestry'
  | 'hydrology'
  | 'archaeology';

/** One workflow preset — a named bundle over EXISTING knobs only. */
export interface TerrainWorkflowPreset {
  readonly id: TerrainWorkflowPresetId;
  /** Chip label. */
  readonly label: string;
  /** One-line hover description: what the bundle is tuned for. */
  readonly description: string;
  /** Colour mode to switch into (falls back per-cloud when channel-less). */
  readonly colorMode: ColorMode;
  /** EDL preset id, or null for "EDL off". Strength rides on the preset. */
  readonly edlPresetId: EdlPresetId | null;
  readonly pointSize: number;
  readonly pointSizeMode: PointSizeMode;
  /** Background sky preset. */
  readonly sky: SkyPreset;
  /**
   * Symmetric height-ramp percentile trim (0 = true min/max band,
   * 5 = the 5/95 default). Relief-reading presets widen the band so pit
   * floors / channel bottoms keep colour resolution.
   */
  readonly heightPercentileTrim: number;
}

/**
 * The six workflow presets. Values reuse the vocabulary the inspection
 * presets and Visuals Studio rails already ship — every sky id is a
 * registered {@link SkyPreset}, every EDL id a registered EDL preset.
 */
const PRESETS: Readonly<Record<TerrainWorkflowPresetId, TerrainWorkflowPreset>> = {
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    description:
      'General bare-earth reading — height colours over the full site, balanced depth shading',
    colorMode: 'elevation',
    edlPresetId: 'balanced',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'terrain',
    heightPercentileTrim: 5,
  },
  construction: {
    id: 'construction',
    label: 'Construction',
    description:
      'Site / progress review — true RGB with crisp structural edges on a neutral light sky',
    colorMode: 'rgb',
    edlPresetId: 'inspection',
    pointSize: 2.5,
    pointSizeMode: 'fixed',
    sky: 'survey-light',
    heightPercentileTrim: 5,
  },
  mining: {
    id: 'mining',
    label: 'Mining',
    description:
      'Pits, benches and stockpiles — untrimmed height band so floors and crests keep contrast',
    colorMode: 'elevation',
    edlPresetId: 'inspection',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'studio-dark',
    heightPercentileTrim: 0,
  },
  forestry: {
    id: 'forestry',
    label: 'Forestry',
    description:
      'Canopy structure — soft depth shading so height colours dominate, deep teal backdrop',
    colorMode: 'elevation',
    edlPresetId: 'subtle',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'foliage-teal',
    heightPercentileTrim: 5,
  },
  hydrology: {
    id: 'hydrology',
    label: 'Hydrology',
    description:
      'Drainage and low relief — untrimmed height band resolves subtle channels, blueprint sky',
    colorMode: 'elevation',
    edlPresetId: 'balanced',
    pointSize: 2,
    pointSizeMode: 'adaptive',
    sky: 'blueprint',
    heightPercentileTrim: 0,
  },
  archaeology: {
    id: 'archaeology',
    label: 'Archaeology',
    description:
      'Micro-relief hunting — strongest depth-edge shading (the live stand-in for hillshade), fine fixed points',
    colorMode: 'elevation',
    edlPresetId: 'inspection',
    pointSize: 1.5,
    pointSizeMode: 'fixed',
    sky: 'studio-dark',
    heightPercentileTrim: 2,
  },
} as const;

/** Display order for the chip rail. */
export const TERRAIN_WORKFLOW_PRESET_ORDER: readonly TerrainWorkflowPresetId[] = [
  'terrain',
  'construction',
  'mining',
  'forestry',
  'hydrology',
  'archaeology',
] as const;

/** All presets in display order — the chip rail reads this directly. */
export function listTerrainWorkflowPresets(): readonly TerrainWorkflowPreset[] {
  return TERRAIN_WORKFLOW_PRESET_ORDER.map((id) => PRESETS[id]);
}

/** True when the string is a known workflow preset id. */
export function isTerrainWorkflowPresetId(v: string): v is TerrainWorkflowPresetId {
  return Object.hasOwn(PRESETS, v);
}

/** Look up a preset by id (undefined for unknown ids — callers gate first). */
export function getTerrainWorkflowPreset(
  id: TerrainWorkflowPresetId,
): TerrainWorkflowPreset {
  return PRESETS[id];
}

/** The knob state the matcher compares against (all read off the Viewer). */
export interface TerrainWorkflowKnobState {
  readonly colorMode: ColorMode | null;
  readonly edlPresetId: EdlPresetId | null;
  readonly pointSize: number;
  readonly pointSizeMode: PointSizeMode;
  readonly skyPresetId: string;
  readonly heightPercentileTrim: number;
}

/**
 * Map the current knob state back to the preset it equals, or null when the
 * user has deviated on any preset-managed knob ("Custom"). Exact equality on
 * every field: the presets only write exact values, so any difference IS a
 * user deviation — there is no tolerance to tune or drift through.
 */
export function matchTerrainWorkflowPreset(
  state: TerrainWorkflowKnobState,
): TerrainWorkflowPresetId | null {
  for (const id of TERRAIN_WORKFLOW_PRESET_ORDER) {
    const p = PRESETS[id];
    if (
      state.colorMode === p.colorMode &&
      state.edlPresetId === p.edlPresetId &&
      state.pointSize === p.pointSize &&
      state.pointSizeMode === p.pointSizeMode &&
      state.skyPresetId === p.sky &&
      state.heightPercentileTrim === p.heightPercentileTrim
    ) {
      return id;
    }
  }
  return null;
}
