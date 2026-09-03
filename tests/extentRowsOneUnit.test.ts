/**
 * extentRowsOneUnit.test.ts
 *
 * Width, Depth and Height describe one bounding box, so they must render in
 * ONE unit. Formatting each independently sent a 1000 m depth over the km
 * threshold while its 922 m and 331 m siblings stayed in metres, printing
 * "922.0 m / 1.00 km / 330.6 m" in the technical report while the on-screen
 * Scan Report showed "1000.0 m" for the same value.
 */
import { describe, it, expect } from 'vitest';
import { extentRows, buildDatasetSummary } from '../src/report/ReportMetadataSection';

describe('extent rows share one unit', () => {
  it('keeps a 1000 m depth in metres beside its metre-scale siblings', () => {
    const rows = extentRows({ width: 922.0, depth: 1000.0, height: 330.6, unitKnown: true });
    const vals = rows.map((r) => r.value);
    expect(vals.every((v) => / m$/.test(v))).toBe(true);
    expect(vals).toContain('1000.0 m');
    expect(vals.some((v) => /km/.test(v))).toBe(false);
  });

  it('uses km for all three when the box is genuinely kilometre-scale', () => {
    const rows = extentRows({ width: 12000, depth: 8000, height: 2400, unitKnown: true });
    expect(rows.every((r) => /km$/.test(r.value))).toBe(true);
  });

  it('uses one sub-metre unit across a small object scan', () => {
    const rows = extentRows({ width: 0.42, depth: 0.31, height: 0.9, unitKnown: true });
    const units = new Set(rows.map((r) => r.value.replace(/^[\d.]+\s*/, '')));
    expect(units.size).toBe(1);
  });

  it('never labels a unit when the CRS declares none', () => {
    const rows = extentRows({ width: 922.0, depth: 1000.0, height: 330.6, unitKnown: false });
    expect(rows.every((r) => /\(source units\)$/.test(r.value))).toBe(true);
    expect(rows.some((r) => /\bm\b|km|cm/.test(r.value))).toBe(false);
  });
});

describe('the rendered dataset summary, not just the helper', () => {
  it('renders Width, Depth and Height in one unit on a 1 km tile', () => {
    const rows = buildDatasetSummary({
      fileName: 'tile.laz', format: 'LAZ', pointCount: 37_333_283,
      width: 922.0, depth: 1000.0, height: 330.6,
      density: 40.5, hasRgb: false, hasIntensity: true, hasClassification: true,
      crsName: 'NAD83(2011) / UTM zone 10N (EPSG:6339)',
      extentUnitStatus: 'confirmed', unitName: 'metre',
    } as never);
    const byLabel = (l: string) => rows.find((r) => r.label === l)?.value ?? '';
    const dims = ['Width', 'Depth', 'Height'].map(byLabel);
    expect(dims).toEqual(['922.0 m', '1000.0 m', '330.6 m']);
    expect(dims.some((v) => /km/.test(v))).toBe(false);
  });
});
