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

  it('an unknown product reads blocked, never accidentally ready', () => {
    const svc = ProcessService.fromFacts([healthy]);
    // A product id the model does not carry defaults to blocked.
    expect(svc.readiness('not-a-real-product' as never)).toBe('blocked');
    expect(svc.isReady('not-a-real-product' as never)).toBe(false);
  });

  it('fromSignals normalises fail-closed, so a missing CRS blocks metric products', () => {
    // No crs supplied → deriveScanFacts nulls it → contours (metric) blocked.
    const svc = ProcessService.fromSignals([{ pointCount: 1000, classification: 'full', groundClassified: true }]);
    expect(svc.readiness('contours')).toBe('blocked');
  });

  it('summary counts products by readiness', () => {
    const s = ProcessService.fromFacts([healthy]).summary();
    expect(s.ready + s.review + s.blocked).toBeGreaterThan(0);
    expect(s.anyReady).toBe(true);
  });
});
