/**
 * exportAuthorizationFreshness.test.ts
 *
 * `validated` is state-bound. With the registry stubbed validated, a
 * supported launch, metric units and a `ready` verdict, the decision still
 * needs an authorization token that is authentic, for this product and minted
 * on the current scientific state; absent, forged, wrong-product or stale
 * tokens cap to exploratory and say why. Exploratory and blocked need no
 * token. Uses the real `ProcessService` so the token semantics are the
 * shipped ones.
 */

import { describe, it, expect } from 'vitest';
import { resolveExportDecision, type ExportAuthorization, type ExportDecisionContext } from '../src/export/exportManifest';
import { ProcessService } from '../src/process/ProcessService';
import type { ProductId, ScanFacts } from '../src/process/ProcessPlan';

const STALE = 'Authorization is stale or absent for the current scientific state.';

function facts(over: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full',
    crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as ScanFacts['crs'],
    pointCount: 1_000_000, hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
    classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
    ...over,
  };
}

const supported = (over: Partial<ExportDecisionContext> = {}): ExportDecisionContext => ({
  launchStatus: 'available', unitClaim: 'metric-supported', precision: null,
  evidenceStatusOf: () => 'validated',
  capability: { readiness: 'ready', reasonCode: 'GROUND_TRUSTED', reason: 'Trusted ground.' },
  ...over,
});

const bind = (issuer: ProcessService, verifier: ProcessService, product: ProductId = 'contours'): ExportAuthorization => ({
  product, token: issuer.authorize(product), verify: (t, p) => verifier.verifyAuthorization(t, p),
});

describe('validated requires a fresh authorization', () => {
  it('a token minted on the current state keeps validated', () => {
    const svc = ProcessService.fromFacts([facts()]);
    expect(svc.capability('contours')?.readiness).toBe('ready');
    const d = resolveExportDecision('contour.geojson.analytical', supported({ authorization: bind(svc, svc) }));
    expect(d.status).toBe('validated');
  });

  it('no token caps to exploratory and names it', () => {
    const d = resolveExportDecision('contour.geojson.analytical', supported());
    expect(d.status).toBe('exploratory');
    if (d.status === 'exploratory') expect(d.caveats).toContain(STALE);
  });

  it('a token minted on an earlier state is stale once the facts change', () => {
    const before = ProcessService.fromFacts([facts()]);
    const after = ProcessService.fromFacts([facts({ groundClassified: false, classification: 'partial' })]);
    const d = resolveExportDecision('contour.geojson.analytical', supported({ authorization: bind(before, after) }));
    expect(d.status).toBe('exploratory');
    if (d.status === 'exploratory') expect(d.caveats).toContain(STALE);
  });

  it('a forged token and a token for another product are refused', () => {
    const svc = ProcessService.fromFacts([facts()]);
    const forged = { product: 'contours', grantedFrom: 'GROUND_TRUSTED', stateSignature: 'x', __brand: 'process-authorization' };
    const f = resolveExportDecision('contour.geojson.analytical', supported({
      authorization: { product: 'contours', token: forged, verify: (t, p) => svc.verifyAuthorization(t, p) },
    }));
    expect(f.status).toBe('exploratory');
    const wrong = resolveExportDecision('contour.geojson.analytical', supported({
      authorization: { product: 'contours', token: svc.authorize('dtm'), verify: (t, p) => svc.verifyAuthorization(t, p) },
    }));
    expect(wrong.status).toBe('exploratory');
    if (wrong.status === 'exploratory') expect(wrong.caveats).toContain(STALE);
  });

  it('exploratory and blocked never mention authorization', () => {
    const e = resolveExportDecision('contour.geojson.analytical', supported({ launchStatus: 'exploratory' }));
    expect(e.status).toBe('exploratory');
    if (e.status === 'exploratory') expect(e.caveats).not.toContain(STALE);
    const b = resolveExportDecision('contour.geojson.analytical', supported({ launchStatus: 'unavailable', blockedReasons: ['No surface.'] }));
    expect(b.status).toBe('blocked');
  });
});
