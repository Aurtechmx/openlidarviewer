/**
 * streamingSpacingLabel.test.ts
 *
 * Label-vs-value regression for the streaming-scan summary's resolution row.
 *
 * COPC metadata `spacing` is a METRIC root-node point spacing in the dataset's
 * CRS units, so the panel must render it as a distance — but only when the CRS
 * confirms the unit. A metre CRS reads "1.20 m"; a foot CRS is converted to
 * metres; a geographic CRS has no linear spacing; and an unknown / absent unit
 * FAILS CLOSED to source units rather than being stamped "m" (a state-plane-FEET
 * COPC otherwise read ~3.28× too large mislabelled as metres). EPT metadata
 * `span` is a DIMENSIONLESS points-per-tile budget — labelled "Node budget" in
 * pts/node so the number is never mistaken for a distance.
 */
import { spacingRowFor } from '../src/ui/StreamingPanel';

const METRE = { linearUnit: 'metre' as const, linearUnitToMetres: 1, isGeographic: false };
const FOOT = { linearUnit: 'foot' as const, linearUnitToMetres: 0.3048, isGeographic: false };
const US_FOOT = { linearUnit: 'us-survey-foot' as const, linearUnitToMetres: 1200 / 3937, isGeographic: false };
const GEOGRAPHIC = { linearUnit: 'unknown' as const, isGeographic: true };
const UNKNOWN = { linearUnit: 'unknown' as const, linearUnitToMetres: 1, isGeographic: false };

test('COPC + metre CRS: spacing renders as a metric distance under "Spacing"', () => {
  const r = spacingRowFor('copc', 1.2, METRE);
  expect(r.label).toBe('Spacing');
  expect(r.value).toBe('1.20 m');
});

test('COPC + foot CRS: spacing is converted from feet to metres', () => {
  // 4 ft root spacing ≈ 1.22 m — not "4.00 m".
  const r = spacingRowFor('copc', 4, FOOT);
  expect(r.label).toBe('Spacing');
  expect(r.value).toBe(`${(4 * 0.3048).toFixed(2)} m`);
  expect(r.value).toBe('1.22 m');
});

test('COPC + US-survey-foot CRS: also converted to metres', () => {
  const r = spacingRowFor('copc', 4, US_FOOT);
  expect(r.value).toBe(`${(4 * (1200 / 3937)).toFixed(2)} m`);
});

test('COPC + geographic CRS: no linear spacing (degrees are not a distance)', () => {
  const r = spacingRowFor('copc', 0.00001, GEOGRAPHIC);
  expect(r.label).toBe('Spacing');
  expect(r.value).not.toMatch(/\bm\b/);
  expect(r.value).toMatch(/geographic/i);
});

test('COPC + unknown unit: FAILS CLOSED to source units, never "m"', () => {
  const r = spacingRowFor('copc', 1.2, UNKNOWN);
  expect(r.value).toBe('1.20 (source units)');
  expect(r.value).not.toMatch(/\bm\b/);
  expect(r.title).toMatch(/unconfirmed/i);
});

test('COPC + no CRS at all: FAILS CLOSED to source units', () => {
  const r = spacingRowFor('copc', 1.2);
  expect(r.value).toBe('1.20 (source units)');
  expect(r.value).not.toMatch(/\bm\b/);
});

test('EPT: span renders as a points-per-node budget, NOT a metric spacing', () => {
  const r = spacingRowFor('ept', 128, METRE);
  // Crucially NOT labelled "Spacing" and NOT suffixed " m".
  expect(r.label).toBe('Node budget');
  expect(r.value).toBe('~128 pts/node');
  expect(r.value).not.toMatch(/\bm\b/);
  expect(r.title).toMatch(/not a metric spacing/i);
});

test('EPT: a large span never reads as a huge metre distance', () => {
  const r = spacingRowFor('ept', 65536);
  expect(r.value).toBe('~65,536 pts/node');
  expect(r.label).not.toBe('Spacing');
});

test('undefined format is treated as COPC and still gates on the unit', () => {
  expect(spacingRowFor(undefined, 0.5, METRE).value).toBe('0.50 m');
  expect(spacingRowFor(undefined, 0.5, UNKNOWN).value).toBe('0.50 (source units)');
});

test('COPC + foot CRS with no usable metre factor: FAILS CLOSED, never "m"', () => {
  // The conversion cannot run, and the unconverted number is feet: labelling it
  // metres would overstate the spacing ~3.28x, the very drift this row gates.
  for (const factor of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const r = spacingRowFor('copc', 4, { linearUnit: 'foot', linearUnitToMetres: factor, isGeographic: false });
    expect(r.value).toBe('4.00 (source units)');
    expect(r.value).not.toMatch(/\bm\b/);
  }
});
