/**
 * authorizationFreshness.test.ts — state-bound authorization freshness.
 *
 * Runtime authenticity (processAuthorizationAuthenticity.test.ts) stops forged
 * and cloned tokens. This suite stops STALE authentic tokens: a token issued for
 * one scientific state must not be honoured after a scientifically-relevant
 * change. The state identity is a pure signature of the `ScanFacts` the service
 * was built from (see scientificState.ts) — no revision counter, no point data,
 * O(1) to compare.
 */
import { describe, it, expect } from 'vitest';
import { ProcessService } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ProductId, ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, epsg: 32613, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};
const svc = (...s: ScanFacts[]): ProcessService => ProcessService.fromFacts(s);

/** Issue a genuine dtm token from a healthy state, then verify against `after`. */
function verifyAfter(after: ScanFacts, product: ProductId = 'dtm') {
  const token = svc(BASE).authorize('dtm')!;
  return svc(after).verifyAuthorization(token, product);
}

describe('state-bound authorization freshness', () => {
  it('a valid authentic token verifies against the UNCHANGED state', () => {
    // Rebuilding the service from identical facts (e.g. after a UI/camera change)
    // yields the same signature — the token stays valid.
    expect(verifyAfter({ ...BASE })).toEqual({ ok: true });
  });

  it('an unrelated (non-ScanFacts) change leaves the token valid', () => {
    // Camera, theme, viewport, panel state are not ScanFacts inputs, so they
    // cannot change the signature. Identical facts ⇒ still valid.
    const token = svc(BASE).authorize('dtm')!;
    expect(svc({ ...BASE }).verifyAuthorization(token, 'dtm')).toEqual({ ok: true });
  });

  const STALE = { ok: false, reason: 'STALE_AUTHORIZATION' } as const;
  it('classification change → stale', () => expect(verifyAfter({ ...BASE, classification: 'partial' })).toEqual(STALE));
  it('classification-provenance change → stale', () => expect(verifyAfter({ ...BASE, classificationProvenance: 'derived' })).toEqual(STALE));
  it('dataset change (point count) → stale', () => expect(verifyAfter({ ...BASE, pointCount: 999_999 })).toEqual(STALE));
  it('horizontal CRS change → stale', () => expect(verifyAfter({ ...BASE, crs: crs({ epsg: 32614 }) })).toEqual(STALE));
  it('vertical-reference change → stale', () => expect(verifyAfter({ ...BASE, crs: crs({ verticalDatum: 'NGVD29' }) })).toEqual(STALE));
  it('coverage change → stale', () => expect(verifyAfter({ ...BASE, kind: 'streaming', coverage: 'resident-only' })).toEqual(STALE));
  it('ground-trust (evidence) change → stale', () => expect(verifyAfter({ ...BASE, groundClassified: false })).toEqual(STALE));

  it('building-class removal → a building-footprints token goes stale (regression: signature must include hasBuildingClass)', () => {
    const token = svc(BASE).authorize('building-footprints')!;
    expect(token).not.toBeNull();
    expect(svc({ ...BASE, hasBuildingClass: false }).verifyAuthorization(token, 'building-footprints')).toEqual(STALE);
  });

  it('a forged token WITH the correct current signature is still rejected (authenticity first)', () => {
    const s = svc(BASE);
    const forged = { product: 'dtm', grantedFrom: 'GROUND_TRUSTED', stateSignature: s.stateSignature, __brand: 'process-authorization' };
    expect(s.verifyAuthorization(forged, 'dtm')).toEqual({ ok: false, reason: 'NOT_AUTHENTIC' });
  });

  it('a clone of an authentic token (correct signature) is rejected', () => {
    const s = svc(BASE);
    const auth = s.authorize('dtm')!;
    expect(s.verifyAuthorization({ ...auth }, 'dtm')).toEqual({ ok: false, reason: 'NOT_AUTHENTIC' });
  });

  it('an authentic, current token for the WRONG product is rejected before staleness', () => {
    const s = svc(BASE);
    const auth = s.authorize('dtm')!;
    expect(s.verifyAuthorization(auth, 'dsm')).toEqual({ ok: false, reason: 'WRONG_PRODUCT' });
  });

  it('an authentic, current token for the right product is accepted', () => {
    const s = svc(BASE);
    const auth = s.authorize('dtm')!;
    expect(s.verifyAuthorization(auth, 'dtm')).toEqual({ ok: true });
  });
});
