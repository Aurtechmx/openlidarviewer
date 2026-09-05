/**
 * The PDF report may not print an unverified scale as metres.
 *
 * The measurement engine deliberately holds two separate facts: `unitToMetres`,
 * which is an inert 1 when the frame states no linear unit, and `crsKnown`,
 * which says whether that 1 means anything. The CSV and GeoJSON exports carry
 * the second one through as `unitsVerified`. The PDF carried only the first, so
 * `buildMeasurementRows` formatted every value with "m" / "m²" / "m³" against a
 * factor it had no reason to trust.
 *
 * The result was a document that contradicted itself: the dataset summary read
 * "Units: Unconfirmed — extents in source units" while the measurement table on
 * another page read "15.20 m". A local scan whose coordinates are feet printed
 * numbers wrong by 3.28x under a metre label.
 */
import { describe, it, expect } from 'vitest';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import type { Measurement } from '../src/render/measure/types';

/** A 15-unit horizontal distance along +X. */
const distance = {
  id: 'd1', name: 'Wall run', kind: 'distance',
  points: [[0, 0, 0], [15.2, 0, 0]],
} as unknown as Measurement;

/** A closed 4 x 4 square in the XY plane. */
const area = {
  id: 'a1', name: 'Pad', kind: 'area', closed: true,
  points: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]],
} as unknown as Measurement;

/** A 4 x 4 x 2 box, so the m3 claim is covered too. */
const box = {
  id: 'b1', name: 'Stock', kind: 'box',
  points: [[0, 0, 0], [4, 4, 2]],
} as unknown as Measurement;

const rows = (unitsVerified: boolean, system: 'metric' | 'imperial' = 'metric'): string[] =>
  buildMeasurementRows([distance, area, box], system, 1, [0, 0, 1], 1, unitsVerified)
    .map((r) => r.value);

describe('measurement rows with an UNVERIFIED scale', () => {
  it('never claims metres, square metres or cubic metres', () => {
    for (const v of rows(false)) {
      expect(v, v).not.toMatch(/\bm\b/);
      expect(v, v).not.toMatch(/m²/);
      expect(v, v).not.toMatch(/m³/);
      expect(v, v).not.toMatch(/\bkm\b|\bcm\b/);
    }
  });

  it('names the unit it actually is', () => {
    const [len, ar, vol] = rows(false);
    expect(len).toBe('15.200 source units');
    expect(ar).toBe('16.000 source units²');
    expect(vol).toBe('32.000 source units³');
  });

  it('does not convert to feet either — an unknown scale converts to nothing', () => {
    // Imperial is a DISPLAY preference; it cannot rescue an unknown source unit.
    // Reporting 49.9 ft would assert the same thing "m" did, in another costume.
    for (const v of rows(false, 'imperial')) {
      expect(v, v).not.toMatch(/\bft\b|\bmi\b|yd³/);
      expect(v, v).toContain('source units');
    }
    // And the metric run agrees with it: an unknown scale is system-independent.
    expect(rows(false, 'imperial')).toEqual(rows(false, 'metric'));
  });

  it('still reports the magnitude, so the measurement is not lost', () => {
    expect(rows(false)[0]).toMatch(/15\.200/);
  });
});

describe('measurement rows with a VERIFIED scale are unchanged', () => {
  it('reports metres as before', () => {
    const [len, ar, vol] = rows(true);
    expect(len).toBe('15.200 m');
    expect(ar).toMatch(/m²/);
    expect(vol).toMatch(/m³/);
  });

  it('defaults to verified, so every existing caller is byte-identical', () => {
    const explicit = buildMeasurementRows([distance], 'metric', 1, [0, 0, 1], 1, true);
    const defaulted = buildMeasurementRows([distance], 'metric', 1, [0, 0, 1], 1);
    expect(defaulted.map((r) => r.value)).toEqual(explicit.map((r) => r.value));
  });

  it('still converts for imperial', () => {
    expect(rows(true, 'imperial')[0]).toMatch(/ft/);
  });
});
