/**
 * tests/rgbAppearance.test.ts
 *
 * Coverage for the v0.3.7 RGB appearance modulator:
 *   - identity bundle is a no-op (fast path)
 *   - exposure scales each channel
 *   - contrast scales around 0.5
 *   - saturation interpolates toward luminance
 *   - gamma applies the power curve
 *   - every channel is clamped to [0, 1]
 *   - NaN inputs read as 0 rather than poisoning the output
 *   - preset registry exposes the four documented presets
 */

import { describe, it, expect } from 'vitest';
import {
  applyRgbAppearance,
  IDENTITY_RGB_APPEARANCE,
  listRgbAppearancePresets,
  getRgbAppearancePreset,
  isRgbAppearancePresetId,
} from '../src/render/rgbAppearance';

function pack(triples: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(triples.length * 3);
  for (let i = 0; i < triples.length; i++) {
    out[i * 3] = triples[i][0];
    out[i * 3 + 1] = triples[i][1];
    out[i * 3 + 2] = triples[i][2];
  }
  return out;
}

describe('applyRgbAppearance — identity', () => {
  it('leaves every channel unchanged when called with no settings', () => {
    const rgb = pack([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    const copy = new Float32Array(rgb);
    applyRgbAppearance(rgb);
    for (let i = 0; i < rgb.length; i++) {
      expect(rgb[i]).toBeCloseTo(copy[i], 6);
    }
  });

  it('leaves every channel unchanged with the IDENTITY constant', () => {
    const rgb = pack([[0.25, 0.5, 0.75]]);
    applyRgbAppearance(rgb, IDENTITY_RGB_APPEARANCE);
    expect(rgb[0]).toBeCloseTo(0.25, 6);
    expect(rgb[1]).toBeCloseTo(0.5, 6);
    expect(rgb[2]).toBeCloseTo(0.75, 6);
  });
});

describe('applyRgbAppearance — exposure', () => {
  it('multiplies every channel and clamps to [0, 1]', () => {
    const rgb = pack([[0.2, 0.3, 0.4]]);
    applyRgbAppearance(rgb, { exposure: 2, contrast: 1, saturation: 1, gamma: 1 });
    expect(rgb[0]).toBeCloseTo(0.4, 5);
    expect(rgb[1]).toBeCloseTo(0.6, 5);
    expect(rgb[2]).toBeCloseTo(0.8, 5);
  });

  it('clamps an over-exposed channel to 1', () => {
    const rgb = pack([[0.6, 0.7, 0.8]]);
    applyRgbAppearance(rgb, { exposure: 5, contrast: 1, saturation: 1, gamma: 1 });
    expect(rgb[0]).toBe(1);
    expect(rgb[1]).toBe(1);
    expect(rgb[2]).toBe(1);
  });
});

describe('applyRgbAppearance — contrast', () => {
  it('contrast=2 doubles the distance from mid-grey 0.5', () => {
    // 0.3 → (0.3 − 0.5) × 2 + 0.5 = 0.1
    // 0.7 → (0.7 − 0.5) × 2 + 0.5 = 0.9
    const rgb = pack([[0.3, 0.5, 0.7]]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 2, saturation: 1, gamma: 1 });
    expect(rgb[0]).toBeCloseTo(0.1, 5);
    expect(rgb[1]).toBeCloseTo(0.5, 5);
    expect(rgb[2]).toBeCloseTo(0.9, 5);
  });

  it('contrast=0 collapses every channel to mid-grey 0.5', () => {
    const rgb = pack([
      [0.0, 0.25, 1.0],
      [0.5, 0.75, 0.1],
    ]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 0, saturation: 1, gamma: 1 });
    for (const v of rgb) {
      expect(v).toBeCloseTo(0.5, 5);
    }
  });
});

describe('applyRgbAppearance — saturation', () => {
  it('saturation=0 collapses every channel to its luminance', () => {
    const rgb = pack([[0.8, 0.2, 0.4]]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 1, saturation: 0, gamma: 1 });
    // Rec.709 luminance = 0.8·0.2126 + 0.2·0.7152 + 0.4·0.0722 ≈ 0.34272
    const lum = 0.8 * 0.2126 + 0.2 * 0.7152 + 0.4 * 0.0722;
    expect(rgb[0]).toBeCloseTo(lum, 5);
    expect(rgb[1]).toBeCloseTo(lum, 5);
    expect(rgb[2]).toBeCloseTo(lum, 5);
  });

  it('saturation=1 leaves a coloured input unchanged', () => {
    const rgb = pack([[0.4, 0.6, 0.2]]);
    const copy = new Float32Array(rgb);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 1, saturation: 1, gamma: 1 });
    for (let i = 0; i < rgb.length; i++) {
      expect(rgb[i]).toBeCloseTo(copy[i], 5);
    }
  });
});

describe('applyRgbAppearance — gamma', () => {
  it('gamma=2.2 brightens mid-grey 0.5 → 0.5^(1/2.2) ≈ 0.7297', () => {
    const rgb = pack([[0.5, 0.5, 0.5]]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 1, saturation: 1, gamma: 2.2 });
    const expected = Math.pow(0.5, 1 / 2.2);
    expect(rgb[0]).toBeCloseTo(expected, 5);
    expect(rgb[1]).toBeCloseTo(expected, 5);
    expect(rgb[2]).toBeCloseTo(expected, 5);
  });

  it('gamma=0 (invalid) collapses to identity (no NaN)', () => {
    const rgb = pack([[0.5, 0.5, 0.5]]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 1, saturation: 1, gamma: 0 });
    // With gamma=0 the function falls back to identity, so the value
    // stays at 0.5.
    expect(rgb[0]).toBeCloseTo(0.5, 6);
    expect(rgb[1]).toBeCloseTo(0.5, 6);
    expect(rgb[2]).toBeCloseTo(0.5, 6);
  });
});

describe('applyRgbAppearance — clamp + NaN guard', () => {
  it('clamps every channel to [0, 1] after the pipeline', () => {
    const rgb = pack([[0.0, 0.5, 1.0]]);
    applyRgbAppearance(rgb, { exposure: 3, contrast: 2, saturation: 2, gamma: 0.5 });
    for (const v of rgb) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reads NaN inputs as 0 rather than propagating', () => {
    const rgb = new Float32Array([NaN, NaN, NaN]);
    applyRgbAppearance(rgb, { exposure: 1, contrast: 1, saturation: 1, gamma: 1.5 });
    expect(Number.isFinite(rgb[0])).toBe(true);
    expect(Number.isFinite(rgb[1])).toBe(true);
    expect(Number.isFinite(rgb[2])).toBe(true);
    expect(rgb[0]).toBe(0);
    expect(rgb[1]).toBe(0);
    expect(rgb[2]).toBe(0);
  });
});

describe('RGB appearance preset registry', () => {
  it('exposes the documented preset catalogue in display order', () => {
    // v0.3.7 visual-fidelity pass added Drone RGB / Mobile LiDAR /
    // Infrastructure to the original four. The display order keeps the
    // four-bundle "generic" set first, then the scan-context bundles.
    const ids = listRgbAppearancePresets().map((p) => p.id);
    expect(ids).toEqual([
      'natural',
      'survey',
      'rgb-inspection',
      'high-contrast',
      'drone-rgb',
      'mobile-lidar',
      'infrastructure',
      'photoreal-rgb',
    ]);
  });

  it('every preset has a label + description + settings', () => {
    for (const p of listRgbAppearancePresets()) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.settings.exposure).toBeGreaterThan(0);
      expect(p.settings.contrast).toBeGreaterThan(0);
      expect(p.settings.saturation).toBeGreaterThanOrEqual(0);
      expect(p.settings.gamma).toBeGreaterThan(0);
    }
  });

  it('Natural preset is identity', () => {
    const natural = getRgbAppearancePreset('natural');
    expect(natural.settings.exposure).toBe(1);
    expect(natural.settings.contrast).toBe(1);
    expect(natural.settings.saturation).toBe(1);
    expect(natural.settings.gamma).toBe(1);
  });

  it('isRgbAppearancePresetId narrows correctly', () => {
    expect(isRgbAppearancePresetId('natural')).toBe(true);
    expect(isRgbAppearancePresetId('survey')).toBe(true);
    expect(isRgbAppearancePresetId('rgb-inspection')).toBe(true);
    expect(isRgbAppearancePresetId('high-contrast')).toBe(true);
    expect(isRgbAppearancePresetId('classic')).toBe(false);
    expect(isRgbAppearancePresetId('')).toBe(false);
    expect(isRgbAppearancePresetId(undefined)).toBe(false);
  });
});
