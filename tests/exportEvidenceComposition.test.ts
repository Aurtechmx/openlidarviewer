/**
 * The composed evidence reaching a real provenance stamp.
 *
 * `evidenceComposition.test.ts` pins the rule; this pins that the export paths
 * actually apply it — that the constituent helpers name what each artifact
 * contains, and that a stamp built from them resolves the weakest member rather
 * than the silent 'DTM' every call site used to inherit.
 */
import { describe, it, expect } from 'vitest';
import {
  buildExportProvenance,
  contourArtifactClaims,
  dtmArtifactClaims,
} from '../src/terrain/export/exportProvenance';
import { governingClaim } from '../src/validation/evidenceComposition';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

function result(style: string | null, withAccuracy = false): AnalyseContoursResult {
  return {
    dtm: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode: 'full', meanConfidence: 82 },
    intervalM: 1,
    model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: style, coverageMode: 'full' },
    ...(withAccuracy
      ? {
          accuracyStandards: {
            rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
            densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
          },
        }
      : {}),
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    generationParams: {
      interpolation: 'geodesic', smoothing: true, despike: true, aggregation: 'median',
      ...(style == null ? {} : { contourStyle: style }),
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

describe('contourArtifactClaims', () => {
  it('always carries the DTM the contours were cut from', () => {
    // The register's own CONTOURS assumption is "depends on DTM validity". A
    // contour is an iso-line THROUGH the grid; it inherits the grid's standing.
    expect(contourArtifactClaims(result('crisp'))).toContain('DTM');
  });

  it('claims the analytical geometry only for the analytical style', () => {
    expect(contourArtifactClaims(result('crisp'))).toContain('CONTOURS');
    expect(contourArtifactClaims(result('crisp'))).not.toContain('CONTOURS-CARTOGRAPHIC');
  });

  it('claims the cartographic geometry for a generalized style', () => {
    for (const style of ['smooth', 'generalized', null]) {
      const claims = contourArtifactClaims(result(style));
      expect(claims, `style ${String(style)}`).toContain('CONTOURS-CARTOGRAPHIC');
      expect(claims, `style ${String(style)}`).not.toContain('CONTOURS');
    }
  });

  it('adds the hold-out accuracy claim only when a figure is actually printed', () => {
    expect(contourArtifactClaims(result('crisp', true))).toContain('HOLDOUT-RMSE');
    expect(contourArtifactClaims(result('crisp', false))).not.toContain('HOLDOUT-RMSE');
    expect(dtmArtifactClaims(result('crisp', true))).toContain('HOLDOUT-RMSE');
    expect(dtmArtifactClaims(result('crisp', false))).toEqual(['DTM']);
  });
});

describe('a stamped export resolves the composed claim', () => {
  const stampFor = (r: AnalyseContoursResult, ids: readonly string[]): string | undefined =>
    buildExportProvenance(r, {
      generatedAt: '2026-09-05T00:00:00.000Z',
      methodDigest: 'deadbeef',
      evidenceClaimIds: ids,
    }).scopedEvidence?.claimId;

  it('stamps the governing constituent, not the first one listed', () => {
    const r = result('crisp');
    const claims = contourArtifactClaims(r);
    expect(stampFor(r, claims)).toBe(governingClaim(claims));
    // For an analytical contour over a DTM, that is the DTM: E4 needing E5.
    expect(stampFor(r, claims)).toBe('DTM');
  });

  it('a generalized export stamps the cartographic claim, which is weaker still', () => {
    const r = result('smooth');
    expect(stampFor(r, contourArtifactClaims(r))).toBe('CONTOURS-CARTOGRAPHIC');
  });

  it('leaves a path that declares nothing exactly as it was', () => {
    const r = result('crisp');
    const before = buildExportProvenance(r, { generatedAt: '2026-09-05T00:00:00.000Z', methodDigest: 'deadbeef' });
    expect(before.scopedEvidence?.claimId).toBe('DTM');
  });

  it('never reports an effective level above the governing constituent', () => {
    const r = result('smooth', true);
    const p = buildExportProvenance(r, {
      generatedAt: '2026-09-05T00:00:00.000Z',
      methodDigest: 'deadbeef',
      evidenceClaimIds: contourArtifactClaims(r),
    });
    expect(p.evidenceResolution?.effectiveEvidence).toBe('E2_ANALYTICALLY_VERIFIED');
  });
});
