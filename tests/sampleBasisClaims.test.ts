/**
 * sampleBasisClaims.test.ts
 *
 * Figures built from a sample of the points say so: the density reference is
 * withheld, the recovery status does not claim full resolution, the Height row
 * carries the noise qualifier wherever it is printed, and timestamps name
 * their zone.
 */
import { describe, it, expect } from 'vitest';
import {
  analysedBasisOf, isSampledBasis, WITHHELD_RECOVERY_STATUS, DENSITY_REF_SAMPLE_NOTE,
} from '../src/terrain/export/analysedBasis';
import { buildExportProvenance, provenanceLines } from '../src/terrain/export/exportProvenance';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { extentRows } from '../src/report/ReportMetadataSection';
import { hasNoiseClassPoints, HEIGHT_INCLUDES_NOISE_SUFFIX } from '../src/geo/height';
import { formatTimestamp } from '../src/export';

function result(coverageMode: string): AnalyseContoursResult {
  return {
    dtm: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode, meanConfidence: 82 },
    intervalM: 1,
    model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: { readiness: 'ready', exportReadiness: 'available', crsKnown: true, datumKnown: true, coverageMode, reasons: [], exportReasons: [] },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}
const OPTS = { basename: 'site', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1', verticalUnitToMetres: 1 } as const;

describe('density reference on a sampled basis', () => {
  it('classifies sampled and full bases', () => {
    expect(isSampledBasis(analysedBasisOf({ coverage: 'sampled', pointCount: 6_983_766 }, 289_790))).toBe(true);
    expect(isSampledBasis(analysedBasisOf({ coverage: 'full', pointCount: 1000 }, 1000))).toBe(false);
    expect(isSampledBasis(analysedBasisOf({ coverage: 'full', pointCount: 1000 }, 900, 1000))).toBe(true);
    expect(isSampledBasis(null)).toBe(false);
  });

  it('provenance withholds the floor for a sampled basis and a sampled grid', () => {
    const basis = analysedBasisOf({ coverage: 'sampled', pointCount: 6_983_766 }, 289_790);
    const p = buildExportProvenance(result('full'), { ...OPTS, analysedBasis: basis });
    expect(p.accuracy?.usgsDensityReferenceFloor).toBe('none');
    expect(p.accuracy?.accuracyOnSample).toBe(true);
    expect(p.accuracy?.rmseZM).toBeCloseTo(0.14);
    expect(provenanceLines(p).join('\n')).toContain(DENSITY_REF_SAMPLE_NOTE);
    const g = buildExportProvenance(result('sampled'), OPTS);
    expect(g.accuracy?.usgsDensityReferenceFloor).toBe('none');
  });

  it('provenance keeps the floor on a full-cloud basis', () => {
    const basis = analysedBasisOf({ coverage: 'full', pointCount: 1000 }, 1000);
    const p = buildExportProvenance(result('full'), { ...OPTS, analysedBasis: basis });
    expect(p.accuracy?.usgsDensityReferenceFloor).toBe('QL2');
    expect(p.accuracy?.accuracyOnSample).toBeUndefined();
  });
});

describe('terrain recovery status', () => {
  it('does not claim full resolution', () => {
    expect(WITHHELD_RECOVERY_STATUS).not.toMatch(/full[- ]resolution/i);
    expect(WITHHELD_RECOVERY_STATUS).toMatch(/still a sample/);
  });
});

describe('Height row noise qualifier', () => {
  it('appends the shared qualifier when noise classes are present', () => {
    const rows = extentRows({ width: 100, depth: 100, height: 43.8, unitKnown: true, includesNoise: true });
    expect(rows.find((r) => r.label === 'Height')!.value).toBe(`43.8 m${HEIGHT_INCLUDES_NOISE_SUFFIX}`);
    const plain = extentRows({ width: 100, depth: 100, height: 43.8, unitKnown: true });
    expect(plain.find((r) => r.label === 'Height')!.value).toBe('43.8 m');
  });

  it('detects noise classes 7 and 18 and honours the skip predicate', () => {
    expect(hasNoiseClassPoints(new Uint8Array([2, 7, 2]), 3)).toBe(true);
    expect(hasNoiseClassPoints(new Uint8Array([2, 18, 2]), 3)).toBe(true);
    expect(hasNoiseClassPoints(new Uint8Array([2, 2, 6]), 3)).toBe(false);
    expect(hasNoiseClassPoints(new Uint8Array([2, 7, 2]), 3, (i) => i === 1)).toBe(false);
  });
});

describe('timestamps name their zone', () => {
  it('prints UTC', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 9, 9, 20, 52)))).toBe('2026-10-09 20:52 UTC');
  });
});
