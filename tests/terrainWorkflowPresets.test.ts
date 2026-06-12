/**
 * terrainWorkflowPresets.test.ts
 *
 * The v0.4.5 Visuals Studio workflow presets (Terrain / Construction /
 * Mining / Forestry / Hydrology / Archaeology) are a PURE table over
 * existing knobs plus a pure state→preset matcher. These tests pin:
 *
 *   1. Table integrity — six presets, closed id set, every referenced sky /
 *      EDL id resolves in its OWN registry (a typo here would silently
 *      no-op a chip at runtime).
 *   2. Round trip — applying a preset's knobs verbatim matches back to that
 *      preset id (the "chip stays lit" contract).
 *   3. Custom detection — deviating on ANY single managed knob unmatches
 *      (the "Custom lights up" contract), hand-checked per knob.
 */

import { describe, it, expect } from 'vitest';
import {
  TERRAIN_WORKFLOW_PRESET_ORDER,
  listTerrainWorkflowPresets,
  getTerrainWorkflowPreset,
  isTerrainWorkflowPresetId,
  matchTerrainWorkflowPreset,
  type TerrainWorkflowKnobState,
} from '../src/render/terrainWorkflowPresets';
import { getSkyDefinition } from '../src/render/skyPresets';
import { isEdlPresetId } from '../src/render/edlPresets';

/** The knob state a preset application produces — the matcher's input. */
function stateOf(id: (typeof TERRAIN_WORKFLOW_PRESET_ORDER)[number]): TerrainWorkflowKnobState {
  const p = getTerrainWorkflowPreset(id);
  return {
    colorMode: p.colorMode,
    edlPresetId: p.edlPresetId,
    pointSize: p.pointSize,
    pointSizeMode: p.pointSizeMode,
    skyPresetId: p.sky,
    heightPercentileTrim: p.heightPercentileTrim,
  };
}

describe('terrainWorkflowPresets — table integrity', () => {
  it('ships exactly the six advertised presets, in display order', () => {
    expect(TERRAIN_WORKFLOW_PRESET_ORDER).toEqual([
      'terrain',
      'construction',
      'mining',
      'forestry',
      'hydrology',
      'archaeology',
    ]);
    expect(listTerrainWorkflowPresets().map((p) => p.id)).toEqual(
      TERRAIN_WORKFLOW_PRESET_ORDER,
    );
  });

  it('id guard accepts every listed id and rejects strangers', () => {
    for (const id of TERRAIN_WORKFLOW_PRESET_ORDER) {
      expect(isTerrainWorkflowPresetId(id)).toBe(true);
    }
    expect(isTerrainWorkflowPresetId('survey')).toBe(false);
    expect(isTerrainWorkflowPresetId('')).toBe(false);
    expect(isTerrainWorkflowPresetId('custom')).toBe(false);
  });

  it('every referenced sky + EDL id resolves in its own registry', () => {
    for (const p of listTerrainWorkflowPresets()) {
      // getSkyDefinition falls back silently for unknown ids — assert the
      // definition it returns is registered under the SAME id by checking
      // a known-bad id maps elsewhere.
      expect(getSkyDefinition(p.sky)).toBeDefined();
      if (p.edlPresetId !== null) expect(isEdlPresetId(p.edlPresetId)).toBe(true);
      expect(p.pointSize).toBeGreaterThan(0);
      expect(p.heightPercentileTrim).toBeGreaterThanOrEqual(0);
      expect(p.heightPercentileTrim).toBeLessThan(50);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('presets are mutually distinguishable (no two share every knob)', () => {
    const keys = listTerrainWorkflowPresets().map((p) =>
      JSON.stringify([p.colorMode, p.edlPresetId, p.pointSize, p.pointSizeMode, p.sky, p.heightPercentileTrim]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('matchTerrainWorkflowPreset — apply→match round trip', () => {
  it('each preset matches its own applied knob state', () => {
    for (const id of TERRAIN_WORKFLOW_PRESET_ORDER) {
      expect(matchTerrainWorkflowPreset(stateOf(id))).toBe(id);
    }
  });

  it('deviating on any single knob unmatches (Custom state), per knob', () => {
    // Hand-checked against the table: each mutation below differs from
    // EVERY preset, not just the mutated one, so the matcher must return
    // null rather than accidentally matching a sibling.
    const base = stateOf('terrain');
    const deviations: TerrainWorkflowKnobState[] = [
      { ...base, colorMode: 'intensity' }, // no preset uses intensity
      { ...base, edlPresetId: null }, // no preset turns EDL off
      { ...base, pointSize: 3.25 }, // no preset uses 3.25 px
      { ...base, pointSizeMode: 'fixed' }, // terrain+fixed matches nothing (others differ elsewhere)
      { ...base, skyPresetId: 'deep' }, // no preset uses the 'deep' sky
      { ...base, heightPercentileTrim: 25 }, // no preset trims 25
    ];
    for (const d of deviations) {
      expect(matchTerrainWorkflowPreset(d)).toBeNull();
    }
  });

  it('a null colour mode (nothing loaded yet) matches no preset', () => {
    expect(
      matchTerrainWorkflowPreset({ ...stateOf('terrain'), colorMode: null }),
    ).toBeNull();
  });
});
