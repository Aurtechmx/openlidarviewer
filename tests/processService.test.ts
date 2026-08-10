/**
 * processService.test.ts — the single eligibility surface over the evaluator.
 */

import { describe, it, expect } from 'vitest';
import { ProcessService } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
const healthy: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2,
};

describe('ProcessService', () => {
  it('agrees with the underlying evaluator and gates exporters through isReady', () => {
    const svc = ProcessService.fromFacts([healthy]);
    expect(svc.isReady('dtm')).toBe(true);
    expect(svc.readiness('contours')).toBe('ready');
  });

  it('authorize issues a token only for a ready product', () => {
    const svc = ProcessService.fromFacts([healthy]);
    const auth = svc.authorize('dtm');
    expect(auth).not.toBeNull();
    expect(auth?.product).toBe('dtm');
    expect(auth?.grantedFrom.length).toBeGreaterThan(0);
    // A two-scan product with a single scan is blocked → no token.
    expect(svc.authorize('cross-epoch-change')).toBeNull();
  });

  it('runIfAuthorized invokes the executor only when the product is ready', () => {
    const svc = ProcessService.fromFacts([healthy]);
    let ran = 0;
    const ok = svc.runIfAuthorized('dtm', (auth) => {
      ran++;
      expect(auth.product).toBe('dtm');
      return 42;
    });
    expect(ran).toBe(1);
    expect(ok.authorized).toBe(true);
    if (ok.authorized) expect(ok.value).toBe(42);
  });

  it('runIfAuthorized refuses a blocked product without invoking the executor', () => {
    const svc = ProcessService.fromFacts([healthy]);
    let ran = 0;
    const res = svc.runIfAuthorized('cross-epoch-change', () => {
      ran++;
      return 'produced';
    });
    expect(ran).toBe(0); // executor never reached — the gate held
    expect(res.authorized).toBe(false);
    if (!res.authorized) {
      expect(res.readiness).not.toBe('ready');
      expect(res.reasonCode.length).toBeGreaterThan(0);
    }
  });

  it('an unknown product reads blocked, never accidentally ready', () => {
    const svc = ProcessService.fromFacts([healthy]);
    // A product id the model does not carry defaults to blocked.
    expect(svc.readiness('not-a-real-product' as never)).toBe('blocked');
    expect(svc.isReady('not-a-real-product' as never)).toBe(false);
  });

  it('fromSignals normalises fail-closed, so a missing CRS blocks metric products', () => {
    // No crs supplied → deriveScanFacts nulls it → building-footprints (metric
    // area, no inspection path) blocked. Contours instead cap to exploratory.
    const svc = ProcessService.fromSignals([{ pointCount: 1000, classification: 'full', groundClassified: true }]);
    expect(svc.readiness('building-footprints')).toBe('blocked');
  });

  it('summary counts products by readiness', () => {
    const s = ProcessService.fromFacts([healthy]).summary();
    expect(s.ready + s.review + s.blocked).toBeGreaterThan(0);
    expect(s.anyReady).toBe(true);
  });
});
