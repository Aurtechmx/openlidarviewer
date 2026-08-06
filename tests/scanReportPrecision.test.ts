/**
 * tests/scanReportPrecision.test.ts
 *
 * The Scan Report discloses the in-memory Float32 quantization next to the
 * extent it is derived from. Two non-negotiables carry over from the rest of
 * the report: the figure reads as a real quantity with its unit, and it fails
 * closed when the linear unit is not established (no fabricated metres).
 */

import { describe, it, expect } from 'vitest';
import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import { fullScope } from '../src/render/class/classScope';
import type { CrsInfo } from '../src/io/crs';

const METRE_CRS: CrsInfo = {
  source: 'wkt',
  epsg: 32633,
  name: 'WGS 84 / UTM zone 33N',
  isGeographic: false,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
};

const UNKNOWN_UNIT_CRS: CrsInfo = {
  source: 'wkt',
  name: 'Some projected CRS',
  isGeographic: false,
  linearUnit: 'unknown',
  linearUnitToMetres: 1,
};

/**
 * A cloud whose LOCAL positions span `span` on each axis — the residuals that
 * actually sit in the Float32 buffer, which is what the row reports on.
 */
function cloudSpanning(span: number, crs?: CrsInfo): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, span, span, span / 10]),
    origin: [500_000, 4_500_000, 0],
    sourceFormat: 'las',
    name: 'precision-fixture',
    metadata: crs ? { crs } : undefined,
  });
}

function rowByLabel(result: ReturnType<typeof scanReport.run>, label: string) {
  const row = result.rows.find((r) => r.label === label);
  if (!row) {
    throw new Error(`Row "${label}" not found. Rows: ${result.rows.map((r) => r.label).join(', ')}`);
  }
  return row;
}

describe('Scan Report — in-memory resolution row', () => {
  it('reports a real length with its unit and a grade', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(1_000, METRE_CRS)), 'In-memory resolution');
    // A 1 km residual sits in the 2^9 binade: 2^-14 m ≈ 0.061 mm.
    expect(row.value).toContain('0.061 mm');
    expect(row.value).toContain('fine');
    expect(row.status).toBe('info');
  });

  it('reports both the worst case and the typical step', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(1_000, METRE_CRS)), 'In-memory resolution');
    expect(row.value).toContain('worst case');
    expect(row.value).toContain('typical');
  });

  it('warns and grades coarse once the step passes a millimetre', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(20_000, METRE_CRS)), 'In-memory resolution');
    expect(row.value).toContain('1.95 mm');
    expect(row.value).toContain('coarse');
    expect(row.status).toBe('warn');
  });

  it('grades a continental extent as unusable for precision work', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(400_000, METRE_CRS)), 'In-memory resolution');
    expect(row.value).toContain('unusable for precision work');
    expect(row.status).toBe('warn');
  });

  it('withholds metres when the CRS declares no linear unit', () => {
    const row = rowByLabel(
      scanReport.run(cloudSpanning(400_000, UNKNOWN_UNIT_CRS)),
      'In-memory resolution',
    );
    expect(row.value).toContain('source units');
    expect(row.value).not.toMatch(/\bmm\b/);
    expect(row.status).toBe('warn');
  });

  it('withholds metres for a cloud with no CRS at all', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(400_000)), 'In-memory resolution');
    expect(row.value).toContain('source units');
    expect(row.value).not.toMatch(/\bmm\b/);
  });

  it('converts a foot CRS through its own factor', () => {
    const feet: CrsInfo = {
      source: 'wkt',
      name: 'NAD83 / State Plane (ft)',
      isGeographic: false,
      linearUnit: 'us-survey-foot',
      linearUnitToMetres: 1200 / 3937,
    };
    const row = rowByLabel(scanReport.run(cloudSpanning(20_000, feet)), 'In-memory resolution');
    // The same 20,000-unit reach: 2^-9 ft = 0.595 mm (fine), where 2^-9 m is 1.95 mm (coarse).
    expect(row.value).toContain('0.595 mm');
    expect(row.value).toContain('fine');
  });

  it('names the governing axis and its reach under the Advanced report', () => {
    const row = rowByLabel(scanReport.run(cloudSpanning(20_000, METRE_CRS)), 'Quantization basis');
    expect(row.advanced).toBe(true);
    expect(row.value).toContain('x');
    expect(row.value).toContain('20000');
  });

  it('is a whole-buffer fact, so it carries no class-scope stamp', () => {
    const result = scanReport.run(cloudSpanning(20_000, METRE_CRS), undefined, {
      scope: fullScope(),
    });
    expect(rowByLabel(result, 'In-memory resolution').scope).toBeUndefined();
    expect(rowByLabel(result, 'Quantization basis').scope).toBeUndefined();
  });

  it('makes no quality assertion the geometry has not been measured against', () => {
    const banned = /\b(accurate|precise|certified|survey-grade|professional)\b/i;
    for (const span of [100, 20_000, 400_000]) {
      for (const crs of [METRE_CRS, UNKNOWN_UNIT_CRS, undefined]) {
        for (const label of ['In-memory resolution', 'Quantization basis']) {
          expect(rowByLabel(scanReport.run(cloudSpanning(span, crs)), label).value).not.toMatch(
            banned,
          );
        }
      }
    }
  });
});
