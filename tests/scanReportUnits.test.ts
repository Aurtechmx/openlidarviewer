/**
 * scanReportUnits.test.ts
 *
 * Coordinate-integrity guard for the static Scan Report's extent block.
 *
 * The report derives Width/Depth/Height/Density/Spacing from the cloud's
 * source-coordinate bounds and a per-CRS metre factor. An unknown-unit CRS
 * carries the inert placeholder `linearUnitToMetres: 1`; consuming it WITHOUT
 * gating on `linearUnit !== 'unknown'` stamps "m" / "pts/m²" onto non-metre
 * data — feet, or even degrees for a geographic CRS. `scanReportUnitBasis`
 * fails closed: it only claims metres when the CRS declares a real linear unit,
 * matching the streaming report (`streamingExtentRows`) and the measure tool.
 */
import { describe, it, expect, test } from 'vitest';
import { scanReport, scanReportUnitBasis } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';

function rowByLabel(result: ReturnType<typeof scanReport.run>, label: string) {
  const row = result.rows.find((r) => r.label === label);
  if (!row) throw new Error(`Row "${label}" not found. Rows: ${result.rows.map((r) => r.label).join(', ')}`);
  return row;
}

describe('scanReportUnitBasis — fail-closed unit gate', () => {
  test('metre CRS: confirmed, factor 1, "m" / "pts/m²"', () => {
    const b = scanReportUnitBasis({ linearUnit: 'metre', linearUnitToMetres: 1 });
    expect(b.unitKnown).toBe(true);
    expect(b.mpu).toBe(1);
    expect(b.vmpu).toBe(1);
    expect(b.lengthUnit).toBe(' m');
    expect(b.densityUnit).toBe(' pts/m²');
  });

  test('foot CRS: confirmed, applies the 0.3048 factor', () => {
    const b = scanReportUnitBasis({ linearUnit: 'foot', linearUnitToMetres: 0.3048 });
    expect(b.unitKnown).toBe(true);
    expect(b.mpu).toBeCloseTo(0.3048, 6);
    expect(b.vmpu).toBeCloseTo(0.3048, 6); // vertical falls back to the horizontal factor
    expect(b.lengthUnit).toBe(' m');
  });

  test('unknown-unit CRS: fails closed to source units despite the placeholder factor', () => {
    const b = scanReportUnitBasis({ linearUnit: 'unknown', linearUnitToMetres: 1 });
    expect(b.unitKnown).toBe(false);
    expect(b.mpu).toBe(1);
    expect(b.vmpu).toBe(1);
    expect(b.lengthUnit).toBe(' (source units)');
    expect(b.densityUnit).toBe(' pts/unit²');
  });

  test('CRS-less (null / undefined): fails closed exactly like unknown', () => {
    for (const crs of [null, undefined]) {
      const b = scanReportUnitBasis(crs);
      expect(b.unitKnown).toBe(false);
      expect(b.mpu).toBe(1);
      expect(b.lengthUnit).toBe(' (source units)');
    }
  });
});

describe('scanReport — unknown-unit CRS never claims metres', () => {
  // 4 points spanning 2×2×1 in the SOURCE unit. With a resolved metre CRS these
  // read as metres; with an unknown-unit CRS the same spans must NOT be labelled
  // metres — the placeholder factor 1 is not a confirmed scale.
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]);
  const make = (crs: CrsInfo): PointCloud =>
    new PointCloud({
      positions,
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'unit-fixture',
      metadata: { crs },
    });

  const EXTENT_LABELS = ['Width', 'Depth', 'Height', 'Density', 'Spacing'] as const;

  it('unknown projected unit: no bare "m" / "pts/m²" on any extent row', () => {
    const r = scanReport.run(
      // The leak shape: a CRS was recovered, but its unit could not be resolved
      // (e.g. a projected CRS with an unmapped unit code), so the factor is 1.
      make({ source: 'wkt', name: 'Unknown-unit CRS', linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: false }),
    );
    for (const label of EXTENT_LABELS) {
      const v = rowByLabel(r, label).value;
      expect(v).not.toMatch(/\bm\b/);
      expect(v).not.toMatch(/pts\/m²/);
    }
    expect(rowByLabel(r, 'Width').value).toBe('2.0 (source units)');
    expect(rowByLabel(r, 'Density').value).toBe('1.0 pts/unit²');
    expect(rowByLabel(r, 'Spacing').value).toBe('1.00 (source units)');
  });

  it('geographic CRS (degrees): the severe case is not stamped as metres', () => {
    // A lat/lon cloud resolves to linearUnit "unknown" with factor 1. The spans
    // are DEGREES; labelling them "m" would be grossly wrong (~111 km / deg).
    const r = scanReport.run(
      make({ source: 'wkt', name: 'WGS 84', linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: true }),
    );
    expect(rowByLabel(r, 'Width').value).not.toMatch(/\bm\b/);
    expect(rowByLabel(r, 'Height').value).not.toMatch(/\bm\b/);
  });

  it('a resolved metre CRS still reports "m" / "pts/m²" (byte-identical to before)', () => {
    const r = scanReport.run(
      make({ source: 'wkt', name: 'WGS 84 / UTM zone 12N', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
    );
    expect(rowByLabel(r, 'Width').value).toBe('2.0 m');
    expect(rowByLabel(r, 'Density').value).toBe('1.0 pts/m²');
    expect(rowByLabel(r, 'Spacing').value).toBe('1.00 m');
  });
});
