/**
 * georefStatus.test.ts — the plain-language "anchored to the real world?"
 * status. Pins ALL FOUR states (both / position-only / height-only / neither),
 * the muted (never-error) tone, the plain copy, and the schematic glyph's
 * state-specific marks.
 */

import { describe, it, expect } from 'vitest';
import { georefStatus, georefGlyphSvg, type GeorefTone } from '../src/geo/georefStatus';

describe('georefStatus — four states', () => {
  it('both known → anchored, real-world position and elevation', () => {
    const s = georefStatus(true, true, { crsName: 'WGS 84 / UTM zone 12N', datumName: 'NAVD88' });
    expect(s.tone).toBe<GeorefTone>('anchored');
    expect(s.headline).toBe('Placed in the real world');
    expect(s.positionLabel).toBe('On the map');
    expect(s.heightLabel).toBe('Real-world elevation');
    expect(s.tooltip).toContain('UTM zone 12N');
    expect(s.tooltip).toContain('NAVD88');
  });

  it('neither known → floating, plain "not placed on Earth"', () => {
    const s = georefStatus(false, false);
    expect(s.tone).toBe<GeorefTone>('floating');
    expect(s.headline).toMatch(/floating/i);
    expect(s.positionLabel).toBe('Not on a map');
    expect(s.heightLabel).toBe('Relative heights');
    expect(s.tooltip).toMatch(/no CRS/i);
    expect(s.tooltip).toMatch(/no vertical datum/i);
  });

  it('position only → partial, heights relative', () => {
    const s = georefStatus(true, false, { crsName: 'EPSG:32612' });
    expect(s.tone).toBe<GeorefTone>('partial');
    expect(s.headline).toMatch(/heights are relative/i);
    expect(s.positionLabel).toBe('On the map');
    expect(s.heightLabel).toBe('Relative heights');
  });

  it('height only → partial, not placed on a map', () => {
    const s = georefStatus(false, true, { datumName: 'NAVD88' });
    expect(s.tone).toBe<GeorefTone>('partial');
    expect(s.headline).toMatch(/not placed on a map/i);
    expect(s.positionLabel).toBe('Not on a map');
    expect(s.heightLabel).toBe('Real-world elevation');
  });

  it('never uses an error tone (a missing CRS is a neutral fact, not a fault)', () => {
    for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(['anchored', 'partial', 'floating']).toContain(georefStatus(a, b).tone);
    }
  });

  it('falls back to a generic word when a name is absent but the axis is known', () => {
    const s = georefStatus(true, true);
    expect(s.tooltip).toContain('Position: defined');
    expect(s.tooltip).toContain('Height: defined');
  });
});

describe('georefGlyphSvg — schematic marks per state', () => {
  const dashedTether = /stroke-dasharray="1\.6 1\.8"/; // the floating-height tether
  const slash = (svg: string): boolean => /<line[^>]*stroke-linecap="round"\/>/.test(svg) && /<circle[^>]*fill="none"/.test(svg);

  it('renders valid SVG using currentColor', () => {
    const svg = georefGlyphSvg(true, true);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('currentColor');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('positioned + real height → a planted pin, solid ground, no tether', () => {
    const svg = georefGlyphSvg(true, true);
    expect(svg).toContain('<path'); // the pin teardrop
    expect(svg).not.toMatch(dashedTether); // height is real → no floating tether
    expect(svg).not.toMatch(/stroke-dasharray="2\.2 2\.2"/); // ground is solid
  });

  it('relative height → a dashed tether + a dashed/faint ground line', () => {
    const svg = georefGlyphSvg(true, false);
    expect(svg).toMatch(dashedTether);
    expect(svg).toMatch(/stroke-dasharray="2\.2 2\.2"/);
  });

  it('no position → a slashed detached dot, not a pin', () => {
    const svg = georefGlyphSvg(false, true);
    expect(svg).not.toContain('<path'); // no pin
    expect(slash(svg)).toBe(true); // slashed circle
  });
});
