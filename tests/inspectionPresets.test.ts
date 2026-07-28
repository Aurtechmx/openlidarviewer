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
      expect(p.reserved.aoStrength).toBeGreaterThanOrEqual(0);
      expect(p.reserved.aoStrength).toBeLessThanOrEqual(1);
      expect(p.pointSize).toBeGreaterThan(0);
      expect(['fixed', 'adaptive']).toContain(p.pointSizeMode);
      expect(typeof p.reserved.hillshade).toBe('boolean');
      expect(typeof p.edlEnabled).toBe('boolean');
    }
  });

  it('hillshade is only on in the Terrain preset', () => {
    const hillshadeOn = listPresets().filter((p) => p.reserved.hillshade);
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


  // The v0.6.2 preset model declared aoStrength, elevationPalette and
  // hillshade alongside fields Viewer.applyPreset() actually set. None of the
  // three were ever applied and no runtime setter existed for them, so a
  // preset advertised a palette and a relief mode it could not deliver.
  // These assertions pin the split rather than the values: a field moved back
  // into the applied set without a setter behind it fails here.
  it('the applied surface carries no field the renderer cannot set', () => {
    for (const p of listPresets()) {
      expect(p).not.toHaveProperty('aoStrength');
      expect(p).not.toHaveProperty('elevationPalette');
      expect(p).not.toHaveProperty('hillshade');
    }
  });

  it('every preset declares the reserved capabilities, with the tuned values kept', () => {
    for (const p of listPresets()) {
      expect(p.reserved.elevationPalette.length).toBeGreaterThan(0);
      expect(typeof p.reserved.hillshade).toBe('boolean');
      expect(Number.isFinite(p.reserved.aoStrength)).toBe(true);
    }
    // The values survived the move rather than being reset to a default.
    expect(getPreset('qa').reserved.elevationPalette).toBe('inferno');
    expect(getPreset('foliage').reserved.elevationPalette).toBe('viridis');
    expect(getPreset('qa').reserved.aoStrength).toBe(0.5);
  });

  it('every preset names a colour mode the viewer can apply', () => {
    const applicable = ['rgb', 'elevation', 'classification', 'density', 'intensity'];
    for (const p of listPresets()) {
      expect(applicable).toContain(p.defaultColorMode);
    }
  });
});
