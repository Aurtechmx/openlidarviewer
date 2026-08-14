/**
 * authorizationMonotonicity.test.ts — cross-layer authorization monotonicity.
 *
 * Several independent layers contribute to output eligibility (coverage, units,
 * classification provenance, vertical reference, points). The invariant is that
 * a downstream authorization decision may PRESERVE or REDUCE authority but never
 * INCREASE it beyond the upstream capability:
 *
 *   BLOCKED upstream → no authorization
 *   REVIEW  upstream → no authorization (exploratory only; never validated)
 *   READY   upstream → authorization permitted
 *
 * The authorization boundary is {@link ProcessService.authorize} +
 * {@link isAuthenticAuthorization}. We drive a combination matrix and assert the
 * ONE property that ties every layer together: an authentic authorization exists
 * IFF the capability is `ready`. No combination may authorize a non-ready state.
 */
import { describe, it, expect } from 'vitest';
import { ProcessService, isAuthenticAuthorization } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ProductId, ScanFacts, Coverage } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};

const COVERAGES: Coverage[] = ['full', 'sampled', 'resident-only'];
const UNITS: Array<CrsInfo | null> = [crs(), crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }), null];
const GROUND: boolean[] = [true, false];
const PRODUCTS: ProductId[] = ['classify-gaps', 'dtm', 'dsm', 'contours', 'building-footprints'];

describe('authorization monotonicity — no combination promotes a weaker state', () => {
  it('an authentic authorization exists IFF the capability is ready (single-scan matrix)', () => {
    const offenders: string[] = [];
    for (const coverage of COVERAGES) {
      for (const cinfo of UNITS) {
        for (const groundClassified of GROUND) {
          const scan: ScanFacts = { ...BASE, kind: coverage === 'full' ? 'static' : 'streaming', coverage, crs: cinfo, groundClassified };
          const svc = ProcessService.fromFacts([scan]);
          for (const product of PRODUCTS) {
            const ready = svc.readiness(product) === 'ready';
            const auth = svc.authorize(product);
            const authentic = isAuthenticAuthorization(auth, product);
            // The boundary property: authorized ⟺ ready. Any drift is a promotion or a bogus refusal.
            if ((auth != null) !== ready || authentic !== ready) {
              offenders.push(`${product} coverage=${coverage} unit=${cinfo?.linearUnit ?? 'none'} ground=${groundClassified}: ready=${ready} auth=${auth != null} authentic=${authentic}`);
            }
          }
        }
      }
    }
    expect(offenders, `authorization drifted from readiness:\n${offenders.join('\n')}`).toHaveLength(0);
  });

  it('resident-only coverage never authorizes a full-dataset product', () => {
    const svc = ProcessService.fromFacts([{ ...BASE, kind: 'streaming', coverage: 'resident-only' }]);
    for (const product of ['dtm', 'dsm'] as ProductId[]) {
      expect(svc.authorize(product)).toBeNull();
    }
  });

  it('unknown scientific units never authorize a validated metric product', () => {
    const svc = ProcessService.fromFacts([{ ...BASE, crs: crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }) }]);
    for (const product of ['contours', 'building-footprints'] as ProductId[]) {
      expect(svc.authorize(product)).toBeNull();
    }
  });

  it('unknown/incompatible vertical authority never authorizes a validated cross-epoch Z product', () => {
    const compatible = ProcessService.fromFacts([BASE, BASE], true);
    const incompatible = ProcessService.fromFacts([BASE, { ...BASE, crs: crs({ verticalDatum: undefined }) }], true);
    // The healthy pair may authorize; the mismatched pair must not.
    expect(incompatible.authorize('cross-epoch-change')).toBeNull();
    expect(incompatible.authorize('volume-cut-fill')).toBeNull();
    // sanity: the property held for the compatible control too (authorized ⟺ ready)
    expect((compatible.authorize('cross-epoch-change') != null)).toBe(compatible.isReady('cross-epoch-change'));
  });

  it('derived/unknown classification provenance never authorizes a trusted DTM', () => {
    const svc = ProcessService.fromFacts([{ ...BASE, groundClassified: false, classificationProvenance: 'derived' }]);
    expect(svc.readiness('dtm')).not.toBe('ready');
    expect(svc.authorize('dtm')).toBeNull();
  });
});
