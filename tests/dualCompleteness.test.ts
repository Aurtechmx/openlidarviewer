/**
 * dualCompleteness.test.ts — the derived dual-completeness view must agree with
 * the existing capability gate, not diverge from it. Subject = coverage;
 * support = trusted ground + confirmed unit. The strongest claim needs both.
 */
import { describe, it, expect } from 'vitest';
import { dualCompletenessOf, permitsStrongestClaim } from '../src/process/dualCompleteness';
import { ProcessService } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, Coverage } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};
const noUnit = crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number });

describe('dual completeness', () => {
  it('full coverage + trusted ground + known unit → both complete → strongest permitted', () => {
    expect(dualCompletenessOf(BASE)).toEqual({ subjectComplete: true, supportComplete: true });
    expect(permitsStrongestClaim(dualCompletenessOf(BASE))).toBe(true);
  });

  it('resident-only → subject incomplete → strongest withheld (support can still hold)', () => {
    const dc = dualCompletenessOf({ ...BASE, coverage: 'resident-only' });
    expect(dc).toEqual({ subjectComplete: false, supportComplete: true });
    expect(permitsStrongestClaim(dc)).toBe(false);
  });

  it('unknown unit → support incomplete → strongest withheld (subject can still hold)', () => {
    const dc = dualCompletenessOf({ ...BASE, crs: noUnit });
    expect(dc).toEqual({ subjectComplete: true, supportComplete: false });
    expect(permitsStrongestClaim(dc)).toBe(false);
  });

  it('is DERIVED, not a second source of truth: dtm READY ⟺ both completeness dims (scan has points)', () => {
    const coverages: Coverage[] = ['full', 'resident-only'];
    for (const coverage of coverages) {
      for (const c of [crs(), noUnit]) {
        for (const groundClassified of [true, false]) {
          const scan: ScanFacts = { ...BASE, kind: coverage === 'full' ? 'static' : 'streaming', coverage, crs: c, groundClassified };
          const ready = ProcessService.fromFacts([scan]).readiness('dtm') === 'ready';
          expect(ready).toBe(permitsStrongestClaim(dualCompletenessOf(scan)));
        }
      }
    }
  });
});
