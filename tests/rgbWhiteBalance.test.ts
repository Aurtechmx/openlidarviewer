/**
 * tests/rgbWhiteBalance.test.ts
 *
 * Coverage for the v0.3.7 white-balance extension to `applyRgbAppearance`:
 *   - temperature 0 + tint 0 is identity (no shift)
 *   - positive temperature warms the image (R up, B down)
 *   - negative temperature cools the image (R down, B up)
 *   - positive tint shifts toward magenta (G down, R/B up)
 *   - negative tint shifts toward green (G up, R/B down)
 *   - extreme inputs are clamped
 */

import { describe, it, expect } from 'vitest';
import { applyRgbAppearance } from '../src/render/rgbAppearance';

function packMidGrey(): Float32Array {
  return new Float32Array([0.5, 0.5, 0.5]);
}

describe('applyRgbAppearance — white balance', () => {
  it('temperature 0 + tint 0 leaves the input unchanged', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 0,
      tint: 0,
    });
    expect(rgb[0]).toBeCloseTo(0.5, 5);
    expect(rgb[1]).toBeCloseTo(0.5, 5);
    expect(rgb[2]).toBeCloseTo(0.5, 5);
  });

  it('positive temperature warms — R goes up, B goes down', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 0.5,
      tint: 0,
    });
    expect(rgb[0]).toBeGreaterThan(0.5);
    expect(rgb[2]).toBeLessThan(0.5);
  });

  it('negative temperature cools — R goes down, B goes up', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: -0.5,
      tint: 0,
    });
    expect(rgb[0]).toBeLessThan(0.5);
    expect(rgb[2]).toBeGreaterThan(0.5);
  });

  it('positive tint shifts toward magenta — G goes down, R+B go up', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 0,
      tint: 0.5,
    });
    expect(rgb[1]).toBeLessThan(0.5);
    expect(rgb[0]).toBeGreaterThan(0.5);
    expect(rgb[2]).toBeGreaterThan(0.5);
  });

  it('negative tint shifts toward green — G goes up, R+B go down', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 0,
      tint: -0.5,
    });
    expect(rgb[1]).toBeGreaterThan(0.5);
    expect(rgb[0]).toBeLessThan(0.5);
    expect(rgb[2]).toBeLessThan(0.5);
  });

  it('clamps every channel to [0, 1] at full-swing inputs', () => {
    const rgb = new Float32Array([0.2, 0.2, 0.8]);
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 1,
      tint: 1,
    });
    for (const v of rgb) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('clamps inputs outside [-1, +1]', () => {
    const rgb = packMidGrey();
    applyRgbAppearance(rgb, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 5, // out of range; gets clamped
      tint: -5,
    });
    // Should be the same result as temperature=1, tint=-1.
    const reference = packMidGrey();
    applyRgbAppearance(reference, {
      exposure: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      temperature: 1,
      tint: -1,
    });
    for (let i = 0; i < 3; i++) {
      expect(rgb[i]).toBeCloseTo(reference[i], 5);
    }
  });
});
