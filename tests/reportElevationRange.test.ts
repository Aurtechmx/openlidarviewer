/**
 * reportElevationRange.test.ts
 *
 * The technical report's dataset table states the scan's lowest and highest
 * elevation in the source frame, beside Height, in Height's unit and with
 * Height's noise-class note.
 */
import { describe, it, expect } from 'vitest';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { sourceElevationRange } from '../src/app/reportExport';
import { footprintMetres } from '../src/report/reportFootprint';
import { HEIGHT_INCLUDES_NOISE_SUFFIX } from '../src/geo/height';

const base: MetadataInputs = {
  fileName: 'tile.laz',
  format: 'LAZ',
  sourcePointCount: 1000,
  width: 1000,
  depth: 1000,
  height: 61.2,
  density: 8,
  hasRgb: false,
  hasIntensity: true,
  hasClassification: true,
};

const row = (rows: readonly { label: string; value: string }[], label: string): string | undefined =>
  rows.find((r) => r.label === label)?.value;

describe('dataset table elevation rows', () => {
  it('prints Min and Max elevation right after Height, in metres', () => {
    const rows = buildDatasetSummary({ ...base, elevationRange: { min: -3.41, max: 57.79 } });
    const labels = rows.map((r) => r.label);
    const h = labels.indexOf('Height');
    expect(labels.slice(h, h + 3)).toEqual(['Height', 'Min elevation', 'Max elevation']);
    expect(row(rows, 'Min elevation')).toBe('-3.41 m');
    expect(row(rows, 'Max elevation')).toBe('57.79 m');
  });

  it('carries the noise-class note Height carries', () => {
    const rows = buildDatasetSummary({ ...base, heightIncludesNoise: true, elevationRange: { min: -3.41, max: 57.79 } });
    expect(row(rows, 'Min elevation')).toBe(`-3.41 m${HEIGHT_INCLUDES_NOISE_SUFFIX}`);
    expect(row(rows, 'Max elevation')).toBe(`57.79 m${HEIGHT_INCLUDES_NOISE_SUFFIX}`);
  });

  it('uses source units, with the reason, when Height does', () => {
    const rows = buildDatasetSummary({
      ...base,
      heightUnitGap: 'vertical-unit-not-declared',
      elevationRange: { min: 10, max: 25.5 },
    });
    expect(row(rows, 'Min elevation')).toBe('10.00 source units (vertical unit not declared)');
    const unconfirmed = buildDatasetSummary({ ...base, extentUnitStatus: 'unknown', elevationRange: { min: 10, max: 25.5 } });
    expect(row(unconfirmed, 'Max elevation')).toBe('25.50 (source units)');
  });

  it('omits both rows when the range is not known', () => {
    const rows = buildDatasetSummary(base);
    expect(row(rows, 'Min elevation')).toBeUndefined();
    expect(row(rows, 'Max elevation')).toBeUndefined();
  });
});

describe('sourceElevationRange', () => {
  const fp = (verticalUnitToMetres: number | undefined) => footprintMetres({
    extentX: 1000, extentY: 1000, extentZ: 61.2, pointCount: 1000,
    linearUnitToMetres: 1, verticalUnitToMetres, linearUnitKnown: true, zUp: true,
  });

  it('adds the source origin back and converts to metres when Height is metres', () => {
    const r = sourceElevationRange({ min: [0, 0, -13.41], max: [1, 1, 47.79] }, [261000, 3195000, 10], true, fp(1), 1);
    expect(r!.min).toBeCloseTo(-3.41, 9);
    expect(r!.max).toBeCloseTo(57.79, 9);
    const feet = sourceElevationRange({ min: [0, 0, 0], max: [1, 1, 100] }, [0, 0, 0], true, fp(0.3048), 0.3048);
    expect(feet!.max).toBeCloseTo(30.48, 9);
  });

  it('stays in source units when the vertical unit is not declared', () => {
    const r = sourceElevationRange({ min: [0, 0, 5], max: [1, 1, 100] }, [0, 0, 0], true, fp(undefined), undefined);
    expect(r).toEqual({ min: 5, max: 100 });
  });

  it('reads Y as the elevation axis of a Y-up mesh', () => {
    const r = sourceElevationRange({ min: [0, 2, 9], max: [1, 7, 9] }, [0, 0, 0], false, fp(1), 1);
    expect(r).toEqual({ min: 2, max: 7 });
  });
});
