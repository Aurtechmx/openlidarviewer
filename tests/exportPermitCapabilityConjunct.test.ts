/**
 * exportPermitCapabilityConjunct.test.ts
 *
 * The production export permit consumes the capability verdict. With the
 * registry stubbed `validated`, a fully supported launch, metric units and no
 * precision refusal, the verdict alone decides: `ready` keeps `validated`;
 * every `review` code caps to `exploratory` naming its reason; `blocked`
 * blocks with its reason; and no verdict at all is a shortfall, never a pass.
 * This is the property v0.6.8 lacked: the registry was the only thing between
 * a sampled read and "validated".
 */

import { describe, it, expect } from 'vitest';
import {
  resolveContourExportPermit,
  capabilityForProduct,
  type ContourPermitProduct,
  type ContourPermitContext,
} from '../src/export/contourExportPermit';
import type { ExportCapabilityVerdict } from '../src/export/exportManifest';

const PRODUCTS: ContourPermitProduct[] = ['pdf', 'geojson', 'geojson-native', 'dxf', 'svg', 'dem', 'complete-package', 'report'];

const supported = (over: Partial<ContourPermitContext> = {}): ContourPermitContext => ({
  launchStatus: 'available',
  verticalUnitsKnown: true,
  crsProjected: true,
  analyticalGeometry: false,
  precision: null,
  evidenceStatusOf: () => 'validated',
  ...over,
});

const ready: ExportCapabilityVerdict = { readiness: 'ready', reasonCode: 'GROUND_TRUSTED', reason: 'Trusted ground.' };
const REVIEW: readonly ExportCapabilityVerdict[] = [
  { readiness: 'review', reasonCode: 'SAMPLED', reason: 'Only a sample of the scan was read, so a surface can be built for inspection but a whole-dataset product is withheld until the full cloud is analysed.' },
  { readiness: 'review', reasonCode: 'RESIDENT_ONLY', reason: 'Only the resident streaming set is loaded, so a surface can be built for inspection but a whole-dataset product is withheld until the full cloud is graded.' },
  { readiness: 'review', reasonCode: 'GROUND_DERIVED', reason: 'No trusted ground class is present, so ground is derived by the filter; the surface carries lower confidence than one built from classified ground.' },
  { readiness: 'review', reasonCode: 'UNIT_UNKNOWN', reason: 'The linear unit is unconfirmed, so the surface can be built for inspection but its georeferenced export is withheld.' },
  { readiness: 'review', reasonCode: 'POINT_TOTAL_UNSTATED', reason: 'The source states no point total.' },
];
const blocked: ExportCapabilityVerdict = { readiness: 'blocked', reasonCode: 'NO_DTM', reason: 'Contours derive from a DTM, which is not available for this scan.' };

describe('the permit consumes the capability verdict', () => {
  it('ready keeps validated under a validated registry', () => {
    for (const product of PRODUCTS) {
      const p = resolveContourExportPermit(product, supported({ capability: ready }));
      expect(p.ok, product).toBe(true);
      if (p.ok) expect(p.decision.status, product).toBe('validated');
    }
  });

  it('every review code caps to exploratory and names its reason', () => {
    for (const product of PRODUCTS) {
      for (const cap of REVIEW) {
        const p = resolveContourExportPermit(product, supported({ capability: cap }));
        expect(p.ok, `${product}/${cap.reasonCode}`).toBe(true);
        if (p.ok) {
          expect(p.decision.status).toBe('exploratory');
          expect(p.decision.caveats).toContain(cap.reason);
        }
      }
    }
  });

  it('blocked blocks with the capability reason', () => {
    for (const product of PRODUCTS) {
      const p = resolveContourExportPermit(product, supported({ capability: blocked }));
      expect(p.ok, product).toBe(false);
      if (!p.ok) expect(p.reasons).toContain(blocked.reason);
    }
  });

  it('no verdict is a shortfall, never a pass', () => {
    for (const product of PRODUCTS) {
      const p = resolveContourExportPermit(product, supported());
      expect(p.ok).toBe(true);
      if (p.ok) {
        expect(p.decision.status).toBe('exploratory');
        expect(p.decision.caveats.some((c) => /No capability verdict/.test(c))).toBe(true);
      }
    }
  });

  it('states the registry shortfall before the capability fact', () => {
    const p = resolveContourExportPermit('dem', supported({ evidenceStatusOf: () => 'exploratory', capability: REVIEW[0] }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      const registry = p.decision.caveats.findIndex((c) => /evidence level/.test(c));
      const fact = p.decision.caveats.indexOf(REVIEW[0].reason);
      expect(registry).toBeGreaterThan(-1);
      expect(fact).toBeGreaterThan(registry);
    }
  });
});

describe('the governing product picks the verdict', () => {
  const caps = { contours: REVIEW[0], dtm: ready };
  it('vector and map products export under contours', () => {
    for (const product of ['pdf', 'geojson', 'geojson-native', 'dxf', 'svg'] as const) {
      expect(capabilityForProduct(product, caps)).toBe(REVIEW[0]);
    }
  });
  it('the DEM and the report export under dtm', () => {
    expect(capabilityForProduct('dem', caps)).toBe(ready);
    expect(capabilityForProduct('report', caps)).toBe(ready);
  });
  it('the complete package takes the weaker of the two, and none when either is missing', () => {
    expect(capabilityForProduct('complete-package', caps)).toBe(REVIEW[0]);
    expect(capabilityForProduct('complete-package', { contours: ready, dtm: blocked })).toBe(blocked);
    expect(capabilityForProduct('complete-package', { contours: ready })).toBeUndefined();
    expect(capabilityForProduct('complete-package', undefined)).toBeUndefined();
  });
});

describe('no exporter outranks the capability model', () => {
  const rank = { validated: 0, exploratory: 1, blocked: 2 } as const;
  const ceiling = { ready: 'validated', review: 'exploratory', blocked: 'blocked' } as const;
  it('rank(permit) ≥ rank(ceiling(readiness)) for every product × verdict × unit × launch', () => {
    const verdicts = [ready, ...REVIEW, blocked];
    for (const product of PRODUCTS) {
      for (const cap of verdicts) {
        for (const verticalUnitsKnown of [true, false]) {
          for (const launchStatus of ['available', 'exploratory'] as const) {
            const p = resolveContourExportPermit(product, supported({ capability: cap, verticalUnitsKnown, launchStatus }));
            const status = p.ok ? p.decision.status : 'blocked';
            expect(rank[status], `${product}/${cap.reasonCode}/${verticalUnitsKnown}/${launchStatus}`)
              .toBeGreaterThanOrEqual(rank[ceiling[cap.readiness]]);
            // Idempotent: the same facts mint the same permit.
            const again = resolveContourExportPermit(product, supported({ capability: cap, verticalUnitsKnown, launchStatus }));
            expect(again).toEqual(p);
          }
        }
      }
    }
  });
});
