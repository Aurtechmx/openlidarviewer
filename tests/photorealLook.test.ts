/**
 * tests/photorealLook.test.ts
 *
 * Coverage for the v0.3.7 Photoreal-RGB look bundle.
 */

import { describe, it, expect } from 'vitest';
import {
  PHOTOREAL_RGB_LOOK,
  getPhotorealLook,
} from '../src/render/photorealLook';
import { getRgbAppearancePreset } from '../src/render/rgbAppearance';
import { getEdlPreset } from '../src/render/edlPresets';
import { getSkyDefinition } from '../src/render/skyPresets';

describe('Photoreal RGB look', () => {
  it('points at Photoreal RGB + Subtle EDL + Studio Dark sky', () => {
    expect(PHOTOREAL_RGB_LOOK.rgbAppearance).toBe('photoreal-rgb');
    expect(PHOTOREAL_RGB_LOOK.edl).toBe('subtle');
    expect(PHOTOREAL_RGB_LOOK.sky).toBe('studio-dark');
  });

  it('every referenced id resolves through its own catalogue', () => {
    const rgb = getRgbAppearancePreset(PHOTOREAL_RGB_LOOK.rgbAppearance);
    expect(rgb.id).toBe('photoreal-rgb');
    const edl = getEdlPreset(PHOTOREAL_RGB_LOOK.edl);
    expect(edl.id).toBe('subtle');
    const sky = getSkyDefinition(PHOTOREAL_RGB_LOOK.sky);
    expect(sky.fallbackColor).toBe('#0B0F14');
  });

  it('Photoreal RGB preset carries the documented values', () => {
    const rgb = getRgbAppearancePreset('photoreal-rgb');
    expect(rgb.settings.exposure).toBeCloseTo(1.15, 3);
    expect(rgb.settings.gamma).toBeCloseTo(1.10, 3);
    expect(rgb.settings.contrast).toBeCloseTo(1.12, 3);
    expect(rgb.settings.saturation).toBeCloseTo(1.08, 3);
  });

  it('getPhotorealLook(id) returns the bundle', () => {
    expect(getPhotorealLook('photoreal-rgb')).toBe(PHOTOREAL_RGB_LOOK);
  });
});
