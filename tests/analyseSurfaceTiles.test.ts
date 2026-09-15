/**
 * analyseSurfaceTiles.test.ts
 *
 * The Node-testable decisions of the Analyse panel's raster previews: the
 * sample readout wording and the vertical-unit token the legends print. The
 * tiles themselves need a canvas, so they stay under the panel's own suites
 * and the e2e spec. A readout never dresses an unknown unit as metres. The
 * sample objects are the minimum shape the formatter reads. Nothing here
 * touches a canvas.
 */
import { describe, it, expect } from 'vitest';
import { sampleReadoutText, verticalUnitTokenFor } from '../src/ui/analyseSurfaceTiles';

describe('analyse surface tiles', () => {
  it('formats a covered sample with the vertical suffix on both heights', () => {
    const text = sampleReadoutText({ covered: true, elevationM: 412.345, slopeDeg: 12.34, canopyM: 3.21 } as never, ' m');
    expect(text).toBe('Sample · 412.35 m · slope 12.3° · canopy 3.2 m');
  });

  it('names an uncovered cell and falls back to the hint with no sample', () => {
    expect(sampleReadoutText({ covered: false } as never, ' m')).toBe('Sample · outside coverage');
    expect(sampleReadoutText(null as never, ' m')).toMatch(/Click the map/);
  });

  it('keeps a non-finite figure as a dash instead of a number', () => {
    const text = sampleReadoutText({ covered: true, elevationM: Number.NaN, slopeDeg: 1, canopyM: 2 } as never, ' ft');
    expect(text).toMatch(/^Sample · — ft/);
  });

  it('prints units for an unknown vertical scale, never metres', () => {
    expect(verticalUnitTokenFor(undefined)).toBe('units');
    expect(verticalUnitTokenFor(0)).toBe('units');
    expect(verticalUnitTokenFor(1)).toBe('m');
    expect(verticalUnitTokenFor(0.3048)).toMatch(/ft/);
  });
});
