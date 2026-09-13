/**
 * permitProvenanceAgreement.test.ts
 *
 * The permit and the provenance stamp resolve over one claim set. The permit
 * governs over the exporter's registered ids plus the ids the artifact carries
 * (`contourArtifactClaims` / `dtmArtifactClaims`), and hands that union back
 * as `permit.claimIds`; so nothing the artifact carries can escape the gate,
 * and the governing claim can only be weaker than either set alone. Every id
 * either function can emit is in the register.
 */

import { describe, it, expect } from 'vitest';
import { permitContextFor, resolveContourExportPermit, type ContourExportFrameFacts, type ContourPermitProduct } from '../src/export/contourExportPermit';
import { exporterRegistration, unionClaimIds } from '../src/export/exportManifest';
import { contourArtifactClaims, dtmArtifactClaims } from '../src/terrain/export/exportProvenance';
import { governingClaim } from '../src/validation/evidenceComposition';
import { EVIDENCE_REGISTRY } from '../src/validation/claimRegistry.generated';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const EXPORTER: Record<ContourPermitProduct, string> = {
  pdf: 'contour.pdf', geojson: 'contour.geojson.cartographic', 'geojson-native': 'contour.geojson.analytical',
  dxf: 'contour.dxf.cartographic', svg: 'contour.svg.cartographic', dem: 'contour.dem',
  'complete-package': 'contour.package', report: 'contour.report',
};

const withRmse = { accuracyStandards: { rmseZM: 0.08 }, generationParams: { contourStyle: 'crisp' } } as unknown as AnalyseContoursResult;
const generalized = { generationParams: { contourStyle: 'smooth' } } as unknown as AnalyseContoursResult;

function frame(result: AnalyseContoursResult): ContourExportFrameFacts {
  return {
    launchStatus: 'available', verticalUnitsKnown: true, crsProjected: true, precision: null,
    capabilities: {
      contours: { readiness: 'ready', reasonCode: 'GROUND_TRUSTED', reason: 'Trusted ground.' },
      dtm: { readiness: 'ready', reasonCode: 'GROUND_TRUSTED', reason: 'Trusted ground.' },
    },
    artifactClaimIds: { contours: contourArtifactClaims(result), dtm: dtmArtifactClaims(result) },
  };
}

describe('permit and provenance resolve over one claim set', () => {
  it('every id the artifact functions emit is registered', () => {
    for (const r of [withRmse, generalized]) {
      for (const id of [...contourArtifactClaims(r), ...dtmArtifactClaims(r)]) {
        expect(EVIDENCE_REGISTRY[id], id).toBeDefined();
      }
    }
    expect(contourArtifactClaims(withRmse)).toContain('HOLDOUT-RMSE');
  });

  it.each(Object.keys(EXPORTER) as ContourPermitProduct[])('%s: the permit set contains the registry and the artifact', (product) => {
    for (const result of [withRmse, generalized]) {
      const f = frame(result);
      const ctx = permitContextFor(product, f, product === 'geojson-native');
      const permit = resolveContourExportPermit(product, ctx);
      expect(permit.ok).toBe(true);
      if (!permit.ok) return;
      const registered = exporterRegistration(EXPORTER[product])!.claimIds;
      for (const id of registered) expect(permit.claimIds).toContain(id);
      for (const id of ctx.claimIds ?? []) expect(permit.claimIds).toContain(id);
      expect(permit.claimIds).toEqual(unionClaimIds(registered, ctx.claimIds));
      // The decision governed over that set, so the stamp cannot say more.
      expect(governingClaim(permit.claimIds)).toBe(governingClaim([...registered, ...(ctx.claimIds ?? [])]));
    }
  });

  it('a hold-out figure on the artifact reaches the package permit', () => {
    const ctx = permitContextFor('complete-package', frame(withRmse), false);
    expect(ctx.claimIds).toContain('HOLDOUT-RMSE');
    expect(ctx.claimIds).toContain('CONTOURS');
    expect(ctx.claimIds).toContain('DTM');
  });
});
