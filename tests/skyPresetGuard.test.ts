/**
 * skyPresetGuard.test.ts — the canonical sky-preset id guard.
 *
 * main.ts used to carry a hand-kept copy of the valid ids; `isSkyPreset` now
 * derives from the one ordered inventory (SKY_PRESET_ORDER), so a preset is
 * recognised the moment it is listed and no second list can drift. These pin
 * that the guard accepts exactly the inventory and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { isSkyPreset, SKY_PRESET_ORDER } from '../src/render/skyPresets';

describe('isSkyPreset', () => {
  it('accepts every id in the canonical inventory', () => {
    for (const id of SKY_PRESET_ORDER) expect(isSkyPreset(id)).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isSkyPreset('not-a-sky')).toBe(false);
    expect(isSkyPreset('')).toBe(false);
    expect(isSkyPreset(undefined)).toBe(false);
    expect(isSkyPreset(42)).toBe(false);
  });

  it('accepts EXACTLY the inventory — the same 10 ids the old inline guard listed', () => {
    // The former main.ts copy: deep / survey-blue / terrain-sand / foliage-teal /
    // qa-cool / studio-dark / blueprint / survey-light / terrain / black.
    const legacy = [
      'deep', 'survey-blue', 'terrain-sand', 'foliage-teal', 'qa-cool',
      'studio-dark', 'blueprint', 'survey-light', 'terrain', 'black',
    ];
    expect([...SKY_PRESET_ORDER].sort()).toEqual([...legacy].sort());
    for (const id of legacy) expect(isSkyPreset(id)).toBe(true);
  });
});
