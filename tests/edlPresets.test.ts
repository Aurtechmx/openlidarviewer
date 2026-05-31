/**
 * tests/edlPresets.test.ts
 *
 * Coverage for the v0.3.7 EDL preset catalogue:
 *   - exposes the three documented presets
 *   - strengths progress Subtle < Balanced < Inspection
 *   - getEdlPreset falls back to Balanced for unknown ids
 *   - isEdlPresetId narrows correctly
 *   - Inspection opts out of adaptive scaling
 */

import { describe, it, expect } from 'vitest';
import {
  listEdlPresets,
  getEdlPreset,
  isEdlPresetId,
} from '../src/render/edlPresets';

describe('EDL preset catalogue', () => {
  it('exposes Subtle, Balanced and Inspection in display order', () => {
    expect(listEdlPresets().map((p) => p.id)).toEqual([
      'subtle',
      'balanced',
      'inspection',
    ]);
  });

  it('strengths progress monotonically Subtle → Balanced → Inspection', () => {
    const subtle = getEdlPreset('subtle').strength;
    const balanced = getEdlPreset('balanced').strength;
    const inspection = getEdlPreset('inspection').strength;
    expect(subtle).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(inspection);
  });

  it('Inspection preset opts out of adaptive scaling', () => {
    expect(getEdlPreset('inspection').adaptive).toBe(false);
    expect(getEdlPreset('subtle').adaptive).toBe(true);
    expect(getEdlPreset('balanced').adaptive).toBe(true);
  });

  it('every preset carries a label, description, strength and radius', () => {
    for (const p of listEdlPresets()) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.radius).toBeGreaterThan(0);
    }
  });

  it('getEdlPreset returns Balanced for unknown ids', () => {
    // @ts-expect-error — feeding an off-catalog id
    const fallback = getEdlPreset('made-up-preset');
    expect(fallback.id).toBe('balanced');
  });

  it('isEdlPresetId narrows correctly', () => {
    expect(isEdlPresetId('subtle')).toBe(true);
    expect(isEdlPresetId('balanced')).toBe(true);
    expect(isEdlPresetId('inspection')).toBe(true);
    expect(isEdlPresetId('cinematic')).toBe(false);
    expect(isEdlPresetId(undefined)).toBe(false);
  });
});
