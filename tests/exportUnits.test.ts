/**
 * exportUnits.test.ts
 *
 * Pins the export linear-unit helpers: a foot-CRS scan must label its
 * dimensions / Z-range / contour interval in "ft", a metre or unknown unit in
 * "m". Coordinates are stored native, so this is what keeps the Studio raster
 * exports (height/depth/contour) from labelling feet as metres.
 */

import { describe, it, expect } from 'vitest';
import {
  linearUnitOf,
  linearUnitLabel,
  formatLinear,
} from '../src/export/ScanReportRenderer';

describe('linearUnitOf', () => {
  it('recognises foot units in any common spelling', () => {
    for (const s of ['foot', 'US survey foot', 'us-survey-foot', 'feet', 'ft', 'International Foot']) {
      expect(linearUnitOf(s)).toBe('foot');
    }
  });

  it('recognises metre units', () => {
    for (const s of ['metre', 'meter', 'm', 'Metre']) {
      expect(linearUnitOf(s)).toBe('metre');
    }
  });

  it('absent or unrecognised unit collapses to unknown', () => {
    expect(linearUnitOf(null)).toBe('unknown');
    expect(linearUnitOf(undefined)).toBe('unknown');
    expect(linearUnitOf('')).toBe('unknown');
    expect(linearUnitOf('degree')).toBe('unknown');
  });
});

describe('linearUnitLabel', () => {
  it('ft for foot, m for metre and unknown (the standing default)', () => {
    expect(linearUnitLabel('foot')).toBe('ft');
    expect(linearUnitLabel('metre')).toBe('m');
    expect(linearUnitLabel('unknown')).toBe('m');
  });
});

describe('formatLinear', () => {
  it('labels a foot value in ft, never m', () => {
    expect(formatLinear(123.4, 'foot')).toBe('123.4 ft');
    expect(formatLinear(5, 'foot')).toBe('5.00 ft');
    expect(formatLinear(123.4, 'foot')).not.toMatch(/ m$/);
  });

  it('does NOT regroup large foot values into km', () => {
    // 2000 ft must stay feet, not become "0.61 km".
    expect(formatLinear(2000, 'foot')).toBe('2000.0 ft');
  });

  it('metre and unknown use the metre formatter (km/m/cm grouping)', () => {
    expect(formatLinear(2000, 'metre')).toBe('2.00 km');
    expect(formatLinear(42, 'metre')).toBe('42.0 m');
    expect(formatLinear(42, 'unknown')).toBe('42.0 m');
  });
});
