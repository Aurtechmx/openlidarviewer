/**
 * tests/inspectionPresets.test.ts
 *
 * Pin the v0.3.7 inspection-preset catalogue: the five built-in presets
 * exist in the documented display order, each carries the full set of
 * fields the Viewer needs, the lookup falls back to the default on an
 * unknown id, and `isPresetId` matches the exported `PresetId` union.
 */

import { describe, it, expect } from 'vitest';
import {
  listPresets,
  getPreset,
  isPresetId,
  PRESET_ORDER,
  DEFAULT_PRESET_ID,
} from '../src/render/inspectionPresets';

describe('listPresets — the catalogue', () => {
  it('exposes exactly five presets in display order', () => {
    const ids = listPresets().map((p) => p.id);
    expect(ids).toEqual(['survey', 'terrain', 'foliage', 'classification', 'qa']);
    expect(ids).toEqual([...PRESET_ORDER]);
  });

  it('each preset has every required field with a sensible value', () => {
    for (const p of listPresets()) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.edlStrength).toBeGreaterThanOrEqual(0);
      expect(p.edlStrength).toBeLessThanOrEqual(1.5);
      expect(p.aoStrength).toBeGreaterThanOrEqual(0);
      expect(p.aoStrength).toBeLessThanOrEqual(1);
      expect(p.pointSize).toBeGreaterThan(0);
      expect(['fixed', 'adaptive']).toContain(p.pointSizeMode);
      expect(typeof p.hillshade).toBe('boolean');
      expect(typeof p.edlEnabled).toBe('boolean');
    }
  });

  it('hillshade is only on in the Terrain preset', () => {
    const hillshadeOn = listPresets().filter((p) => p.hillshade);
    expect(hillshadeOn).toHaveLength(1);
    expect(hillshadeOn[0].id).toBe('terrain');
  });

  it('Classification preset opens in the classification colour mode', () => {
    expect(getPreset('classification').defaultColorMode).toBe('classification');
  });

  it('QA preset opens in the density heatmap', () => {
    expect(getPreset('qa').defaultColorMode).toBe('density');
  });
});

describe('getPreset', () => {
  it('returns the named preset', () => {
    expect(getPreset('foliage').id).toBe('foliage');
  });

  it('falls back to the default preset when the id is unknown', () => {
    expect(getPreset('nope-not-a-preset').id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('isPresetId', () => {
  it('recognises every catalogue id', () => {
    for (const id of PRESET_ORDER) {
      expect(isPresetId(id)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isPresetId('random')).toBe(false);
    expect(isPresetId('')).toBe(false);
  });
});
