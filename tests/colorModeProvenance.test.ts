import { describe, it, expect } from 'vitest';
import { isDerivedColorMode } from '../src/render/colorModeProvenance';
import type { ColorMode } from '../src/render/colorModes';

describe('isDerivedColorMode', () => {
  it('reports rgb as measured colour', () => {
    expect(isDerivedColorMode('rgb')).toBe(false);
  });

  it('reports every ramped or categorical mode as derived', () => {
    const applied: ColorMode[] = [
      'elevation',
      'intensity',
      'classification',
      'gpsTime',
      'returnNumber',
      'density',
      'coverage',
      'confidence',
      'normal',
    ];
    for (const mode of applied) expect(isDerivedColorMode(mode)).toBe(true);
  });

  it('treats a mode it has not been taught about as derived', () => {
    // Over-qualifying a rendering is a smaller error than presenting one as
    // measurement, so an unknown mode must not read as measured colour.
    expect(isDerivedColorMode('some-future-overlay' as ColorMode)).toBe(true);
  });
});
