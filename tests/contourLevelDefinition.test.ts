/**
 * contourLevelDefinition.test.ts
 *
 * Unit-safe contour level definitions (spec §10): source↔metre conversion,
 * unknown-unit behavior (no fabricated metres, no metric claim), the projected-
 * vs-geographic claim gate, display formatting, and export fields.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContourLevelDefinition,
  contourUnitClaim,
  formatContourInterval,
  contourLevelExportFields,
} from '../src/terrain/contourStudio/contourLevelDefinition';
import { knownUnit, unknownUnit } from '../src/units/units';

const M_PER_FT = 0.3048;

describe('buildContourLevelDefinition', () => {
  it('metre units: source == metres', () => {
    const d = buildContourLevelDefinition({
      intervalSource: 0.5,
      baseSource: 100,
      verticalUnit: knownUnit(1),
      sourceUnitLabel: 'm',
    });
    expect(d.intervalSource).toBe(0.5);
    expect(d.intervalMetres).toBeCloseTo(0.5, 9);
    expect(d.baseMetres).toBeCloseTo(100, 9);
    expect(d.verticalUnitStatus).toBe('known');
    expect(d.sourceUnitLabel).toBe('m');
  });

  it('foot units: metre equivalent is source × 0.3048', () => {
    const d = buildContourLevelDefinition({
      intervalSource: 2,
      baseSource: 50,
      verticalUnit: knownUnit(M_PER_FT),
      sourceUnitLabel: 'ft',
    });
    expect(d.intervalMetres).toBeCloseTo(2 * M_PER_FT, 9);
    expect(d.baseMetres).toBeCloseTo(50 * M_PER_FT, 9);
    expect(d.sourceUnitLabel).toBe('ft');
  });

  it('unknown units: no metre value and no unit label', () => {
    const d = buildContourLevelDefinition({
      intervalSource: 0.5,
      baseSource: 0,
      verticalUnit: unknownUnit(),
      sourceUnitLabel: 'm', // ignored — unit is unknown
    });
    expect(d.intervalMetres).toBeNull();
    expect(d.baseMetres).toBeNull();
    expect(d.verticalUnitStatus).toBe('unknown');
    expect(d.sourceUnitLabel).toBe(''); // never claims a unit it doesn't know
  });

  it('rejects a non-finite or non-positive interval', () => {
    const base = { baseSource: 0, verticalUnit: knownUnit(1), sourceUnitLabel: 'm' };
    expect(() => buildContourLevelDefinition({ ...base, intervalSource: Number.NaN })).toThrow();
    expect(() => buildContourLevelDefinition({ ...base, intervalSource: Infinity })).toThrow();
    expect(() => buildContourLevelDefinition({ ...base, intervalSource: 0 })).toThrow(/positive/i);
    expect(() => buildContourLevelDefinition({ ...base, intervalSource: -1 })).toThrow(/positive/i);
  });

  it('allows a negative base (below datum) but rejects a non-finite one', () => {
    const ok = buildContourLevelDefinition({
      intervalSource: 1,
      baseSource: -12,
      verticalUnit: knownUnit(1),
      sourceUnitLabel: 'm',
    });
    expect(ok.baseSource).toBe(-12);
    expect(() =>
      buildContourLevelDefinition({ intervalSource: 1, baseSource: Number.NaN, verticalUnit: knownUnit(1), sourceUnitLabel: 'm' }),
    ).toThrow();
  });
});

describe('contourUnitClaim — metric support gate', () => {
  const metreDef = buildContourLevelDefinition({ intervalSource: 1, baseSource: 0, verticalUnit: knownUnit(1), sourceUnitLabel: 'm' });
  const unknownDef = buildContourLevelDefinition({ intervalSource: 1, baseSource: 0, verticalUnit: unknownUnit(), sourceUnitLabel: 'm' });

  it('known unit + projected CRS → metric-supported', () => {
    expect(contourUnitClaim(metreDef, { crsProjected: true })).toBe('metric-supported');
  });

  it('known unit but geographic CRS → cartographic-only (degrees are not linear)', () => {
    expect(contourUnitClaim(metreDef, { crsProjected: false })).toBe('cartographic-only');
  });

  it('unknown unit → cartographic-only even on a projected CRS', () => {
    expect(contourUnitClaim(unknownDef, { crsProjected: true })).toBe('cartographic-only');
  });
});

describe('formatContourInterval', () => {
  it('metres show metres', () => {
    const d = buildContourLevelDefinition({ intervalSource: 0.5, baseSource: 0, verticalUnit: knownUnit(1), sourceUnitLabel: 'm' });
    expect(formatContourInterval(d)).toBe('0.5 m');
  });
  it('feet show feet with the metric equivalent', () => {
    const d = buildContourLevelDefinition({ intervalSource: 2, baseSource: 0, verticalUnit: knownUnit(M_PER_FT), sourceUnitLabel: 'ft' });
    expect(formatContourInterval(d)).toBe('2 ft (0.61 m)');
  });
  it('unknown units are labelled unverified, never metres', () => {
    const d = buildContourLevelDefinition({ intervalSource: 0.5, baseSource: 0, verticalUnit: unknownUnit(), sourceUnitLabel: 'm' });
    expect(formatContourInterval(d)).toBe('0.5 (units unverified)');
    expect(formatContourInterval(d)).not.toMatch(/\bm\b/);
  });
});

describe('contourLevelExportFields', () => {
  it('null metre fields + "unknown" unit when the vertical unit is unknown', () => {
    const d = buildContourLevelDefinition({ intervalSource: 1, baseSource: 0, verticalUnit: unknownUnit(), sourceUnitLabel: 'm' });
    const f = contourLevelExportFields(d);
    expect(f.interval_m).toBeNull();
    expect(f.base_m).toBeNull();
    expect(f.elevation_unit).toBe('unknown');
    expect(f.vertical_unit_status).toBe('unknown');
  });
  it('populated metre fields + unit label when known', () => {
    const d = buildContourLevelDefinition({ intervalSource: 2, baseSource: 10, verticalUnit: knownUnit(M_PER_FT), sourceUnitLabel: 'ft' });
    const f = contourLevelExportFields(d);
    expect(f.interval_m).toBeCloseTo(2 * M_PER_FT, 9);
    expect(f.elevation_unit).toBe('ft');
    expect(f.vertical_unit_status).toBe('known');
  });
});
