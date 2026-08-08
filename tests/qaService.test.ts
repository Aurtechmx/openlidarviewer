/**
 * qaService.test.ts — product-specific QA gating stays independent per product.
 */

import { describe, it, expect } from 'vitest';
import { QaService } from '../src/qa/QaService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
function facts(o: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
    hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2, ...o,
  };
}

describe('QaService.gateFor — products fail independently', () => {
  it('a failed terrain-readiness check does NOT block a classification export', () => {
    // No trusted ground → TERRAIN_READINESS reviews, but classification is fine.
    const svc = QaService.forFacts(facts({ groundClassified: false, classification: 'full' }));
    const dtm = svc.gateFor('dtm');
    const classify = svc.gateFor('classify-gaps');
    // Terrain readiness only reviews (not block), so dtm is allowed but flagged;
    // classification does not even consider terrain readiness.
    expect(classify.relevant.some((c) => c.id === 'TERRAIN_READINESS')).toBe(false);
    expect(classify.allowed).toBe(true);
    expect(dtm.relevant.some((c) => c.id === 'TERRAIN_READINESS')).toBe(true);
  });

  it('a missing CRS blocks metric products but not gap-classification', () => {
    const svc = QaService.forFacts(facts({ crs: null }));
    expect(svc.gateFor('contours').allowed).toBe(false); // spatial reference blocks
    expect(svc.gateFor('contours').blocking.some((c) => c.id === 'SPATIAL_REFERENCE')).toBe(true);
    // classify-gaps does not depend on the CRS.
    expect(svc.gateFor('classify-gaps').allowed).toBe(true);
  });

  it('an empty cloud blocks every product (file integrity is in every base set)', () => {
    const svc = QaService.forFacts(facts({ pointCount: 0 }));
    expect(svc.gateFor('dtm').allowed).toBe(false);
    expect(svc.gateFor('classify-gaps').allowed).toBe(false);
    expect(svc.worst()).toBe('block');
  });

  it('a healthy scan allows all products', () => {
    const svc = QaService.forFacts(facts());
    for (const p of ['dtm', 'contours', 'building-footprints', 'classify-gaps'] as const) {
      expect(svc.gateFor(p).allowed).toBe(true);
    }
    expect(svc.worst()).toBe('pass');
  });
});
