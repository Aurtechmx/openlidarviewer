/**
 * scanReportWithheld.test.ts
 *
 * The scan report's Density and Spacing leave points with the LAS Withheld
 * flag out of the count, keep Overlap points, and state points counted,
 * Withheld excluded and points analysed in a "Density basis" row. A cloud
 * with no flags channel, or a count taken from the file header, records the
 * exclusion as 'unknown', never 0.
 */
import { describe, it, expect } from 'vitest';
import { scanReport, SCAN_DENSITY_METHOD_TAG } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import { methodRef, methodTag } from '../src/science/methodRegistry';
import { scopeFrom } from '../src/render/class/classScope';

const W = encodeExtendedClassificationFlags({ withheld: true });
const O = encodeExtendedClassificationFlags({ overlap: true });

/** Eight points on a 2 × 2 metre footprint (area 4). */
const POS = [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 2, 0];
const METRE = { crs: { source: 'wkt' as const, name: 'm', linearUnit: 'metre' as const, linearUnitToMetres: 1, isGeographic: false } };

function cloud(over: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  return new PointCloud({
    positions: new Float32Array(POS),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'withheld-fixture',
    metadata: METRE,
    ...over,
  });
}

const row = (c: PointCloud, label: string, scope?: Parameters<typeof scanReport.run>[2]) =>
  scanReport.run(c, undefined, scope).rows.find((r) => r.label === label)!.value;

describe('scan report density — Withheld excluded, Overlap kept', () => {
  it('counts 6 of 8 points when two are Withheld and two are Overlap', () => {
    const c = cloud({ classificationFlags: new Uint8Array([0, W, 0, O, W, O, 0, 0]) });
    expect(row(c, 'Point Count')).toBe('8');
    expect(row(c, 'Density')).toBe('1.5 pts/m²');
    expect(row(c, 'Spacing')).toBe(`${(Math.sqrt(4 / 6) * 100).toFixed(1)} cm`);
    expect(row(c, 'Density basis')).toBe(
      `6 of 8 analysed; Withheld excluded: 2 (${SCAN_DENSITY_METHOD_TAG})`,
    );
  });

  it('is unchanged when no point is Withheld', () => {
    const c = cloud({ classificationFlags: new Uint8Array([0, O, 0, O, 0, O, 0, 0]) });
    expect(row(c, 'Density')).toBe('2.0 pts/m²');
    expect(row(c, 'Density basis')).toContain('8 of 8 analysed; Withheld excluded: 0');
  });

  it("records 'unknown' and counts every point when the cloud carries no flags", () => {
    const c = cloud();
    expect(row(c, 'Density')).toBe('2.0 pts/m²');
    expect(row(c, 'Density basis')).toContain('Withheld excluded: unknown');
  });

  it("records 'unknown' for a header total it cannot inspect", () => {
    const c = cloud({
      classificationFlags: new Uint8Array([0, W, 0, 0, 0, 0, 0, 0]),
      declaredPointCount: 80,
    });
    expect(row(c, 'Density basis')).toContain('80 of 80 analysed; Withheld excluded: unknown');
  });

  it('counts Withheld over the visible classes only under a class scope', () => {
    const c = cloud({
      classification: new Uint8Array([2, 2, 2, 2, 5, 5, 5, 5]),
      classificationFlags: new Uint8Array([W, 0, 0, 0, W, W, 0, 0]),
    });
    const scope = { scope: scopeFrom([2], [2, 5], (n) => String(n)) };
    expect(row(c, 'Density basis', scope)).toContain('3 of 4 analysed; Withheld excluded: 1');
  });

  it('stamps the registered method version', () => {
    expect(SCAN_DENSITY_METHOD_TAG).toBe(methodTag(methodRef('olv.density.scan-report')));
  });
});
