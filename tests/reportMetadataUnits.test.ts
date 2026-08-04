/**
 * reportMetadataUnits.test.ts
 *
 * The report's dataset summary and inspection findings FAIL CLOSED on an
 * unconfirmed linear unit. When the CRS declares no real linear unit the PDF
 * must NOT present source-unit spans as metres or grade a source-unit² area /
 * density: the extents read "(source units)", the density row is omitted, a
 * "units unconfirmed" warning appears, and the coverage finding reads "unknown
 * extent". A confirmed unit is byte-identical to the pre-feature output.
 */

import { describe, it, expect } from 'vitest';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { buildInspectionSummary } from '../src/report/ReportFindings';

const CONFIRMED: MetadataInputs = {
  fileName: 'survey.las',
  format: 'LAS',
  sourcePointCount: 5000,
  width: 30,
  depth: 20,
  height: 5,
  density: 8.33,
  hasRgb: true,
  hasIntensity: false,
  hasClassification: true,
  crsName: 'NAD83 / UTM zone 15N',
  crsUnit: 'metre',
};

// The same physical scan whose CRS carries no real linear unit: the spans are
// raw source units, the density is NaN, and the discriminant is set.
const UNCONFIRMED: MetadataInputs = {
  ...CONFIRMED,
  width: 100,
  depth: 60,
  height: 15,
  density: Number.NaN,
  extentUnitStatus: 'unknown',
  crsUnit: 'unknown',
};

const rowMap = (inputs: MetadataInputs): Map<string, string> => {
  const rows = buildDatasetSummary(inputs);
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.label, r.value); // last wins; labels here are unique
  return m;
};

describe('buildDatasetSummary — confirmed unit (unchanged)', () => {
  it('prints metre extents, a pts/m² density, and the CRS unit', () => {
    const m = rowMap(CONFIRMED);
    expect(m.get('Width')).toBe('30.0 m');
    expect(m.get('Density')).toBe('8.3 pts/m²');
    expect(m.get('Units')).toBe('metre');
  });
});

describe('buildDatasetSummary — fail closed on an unconfirmed unit', () => {
  it('labels the extents as source units, never metres', () => {
    const m = rowMap(UNCONFIRMED);
    expect(m.get('Width')).toBe('100.0 (source units)');
    expect(m.get('Depth')).toBe('60.0 (source units)');
    expect(m.get('Height')).toBe('15.0 (source units)');
    for (const label of ['Width', 'Depth', 'Height']) {
      expect(m.get(label)).not.toMatch(/\bm\b|km|cm/);
    }
  });

  it('omits the density row (no pts/m² on an unknown unit)', () => {
    const rows = buildDatasetSummary(UNCONFIRMED);
    expect(rows.some((r) => r.label === 'Density')).toBe(false);
  });

  it('adds a visible units-unconfirmed warning and no redundant crsUnit row', () => {
    const rows = buildDatasetSummary(UNCONFIRMED);
    const units = rows.filter((r) => r.label === 'Units');
    expect(units).toHaveLength(1); // the warning replaces the crsUnit row
    expect(units[0]!.value).toMatch(/unconfirmed/i);
    expect(units[0]!.value).toMatch(/source units/i);
  });

  it('still reports the CRS name (georeference is not the unit)', () => {
    expect(rowMap(UNCONFIRMED).get('CRS')).toBe('NAD83 / UTM zone 15N');
  });
});

describe('buildInspectionSummary — fail closed on an unconfirmed unit', () => {
  it('reports unknown extent rather than a source-unit² area as m²', () => {
    const s = buildInspectionSummary(UNCONFIRMED);
    const coverage = s.findings.find((f) => f.label === 'Coverage');
    expect(coverage?.value).toBe('unknown extent');
    expect(s.headline).toMatch(/unknown extent/);
  });

  it('reports density as unknown and draws no density bar', () => {
    const s = buildInspectionSummary(UNCONFIRMED);
    const d = s.findings.find((f) => f.label === 'Point density (all returns)');
    expect(d?.value).toBe('—');
    expect(s.densityBar).toBeUndefined();
  });
});
