import { describe, it, expect } from 'vitest';
import { isDerivedColorMode, DERIVED_COLOR_NOTE } from '../src/render/colorModeProvenance';
import { buildColorChipNote } from '../src/ui/colorChipModel';
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

describe('buildColorChipNote', () => {
  it('qualifies a derived colour while one is active', () => {
    const note = buildColorChipNote('elevation', false);
    expect(note).toBe(DERIVED_COLOR_NOTE);
    expect(note).toMatch(/not recorded by the scan/);
  });

  it('says nothing about provenance while true colour is active', () => {
    expect(buildColorChipNote('rgb', false)).toBe('');
  });

  it('keeps the coverage gate reason, and leads with provenance when both apply', () => {
    const both = buildColorChipNote('elevation', true);
    expect(both.indexOf(DERIVED_COLOR_NOTE)).toBe(0);
    expect(both).toMatch(/Coverage and Confidence/);

    // rgb is measured, so only the gate reason remains.
    expect(buildColorChipNote('rgb', true)).toMatch(/^Run terrain analysis first/);
  });

  it('is empty when there is nothing to say, so the row can hide', () => {
    expect(buildColorChipNote('rgb', false)).toBe('');
  });
});
