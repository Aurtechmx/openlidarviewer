/**
 * processAuthorizationAuthenticity.test.ts — a ProductAuthorization must be
 * RUNTIME-authentic, not merely structurally shaped.
 *
 * The compile-time `__brand` is forgeable at runtime: a plain object carrying
 * the right brand satisfies the `ProductAuthorization` type, and so does a
 * spread/clone of a genuine token. `isAuthenticAuthorization` closes that with a
 * module-private WeakSet — only a token `authorize()` actually issued is a
 * member, held by reference, so a forgery (never added) and a clone (a new
 * object) are both non-members. No hashing, no crypto, no point-data traversal.
 */
import { describe, it, expect } from 'vitest';
import { ProcessService, isAuthenticAuthorization } from '../src/process/ProcessService';
import type { ProductAuthorization } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
/** A full-coverage, known-unit, ground-classified scan — `dtm` is `ready`. */
const healthy: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2,
};

describe('ProductAuthorization runtime authenticity', () => {
  it('an authorization issued by the service is accepted', () => {
    const auth = ProcessService.fromFacts([healthy]).authorize('dtm');
    expect(auth).not.toBeNull();
    expect(isAuthenticAuthorization(auth!)).toBe(true);
    expect(isAuthenticAuthorization(auth!, 'dtm')).toBe(true);
    expect(auth!.grantedFrom).toBe('GROUND_TRUSTED'); // provenance preserved
  });

  it('a plain object with identical fields is rejected (structural forgery)', () => {
    const auth = ProcessService.fromFacts([healthy]).authorize('dtm')!;
    const forged = {
      product: auth.product,
      grantedFrom: auth.grantedFrom,
      __brand: 'process-authorization',
    } as ProductAuthorization;
    expect(isAuthenticAuthorization(forged)).toBe(false);
  });

  it('a spread/cloned valid authorization is rejected (a new object is not a member)', () => {
    const auth = ProcessService.fromFacts([healthy]).authorize('dtm')!;
    expect(isAuthenticAuthorization({ ...auth })).toBe(false);
    expect(isAuthenticAuthorization(Object.assign({}, auth))).toBe(false);
    expect(isAuthenticAuthorization(structuredClone(auth))).toBe(false);
  });

  it('a valid authorization used for the WRONG product is rejected', () => {
    const auth = ProcessService.fromFacts([healthy]).authorize('dtm')!;
    expect(isAuthenticAuthorization(auth, 'dtm')).toBe(true);
    expect(isAuthenticAuthorization(auth, 'dsm')).toBe(false);
  });

  it('a blocked or review capability cannot yield a valid ready authorization', () => {
    // resident-only streaming: dtm is never `ready` (review or blocked by policy).
    const streaming = ProcessService.fromFacts([{ ...healthy, kind: 'streaming', coverage: 'resident-only' }]);
    expect(streaming.readiness('dtm')).not.toBe('ready');
    expect(streaming.authorize('dtm')).toBeNull();
    // a no-points scan blocks classify-gaps outright.
    const empty = ProcessService.fromFacts([{ ...healthy, pointCount: 0 }]);
    expect(empty.authorize('classify-gaps')).toBeNull();
  });

  it('non-object / null inputs are rejected without throwing', () => {
    expect(isAuthenticAuthorization(null)).toBe(false);
    expect(isAuthenticAuthorization(undefined)).toBe(false);
    expect(isAuthenticAuthorization('process-authorization')).toBe(false);
    expect(isAuthenticAuthorization(42)).toBe(false);
    expect(isAuthenticAuthorization({})).toBe(false);
  });

  it('runIfAuthorized hands the executor a genuine, authentic token', () => {
    const svc = ProcessService.fromFacts([healthy]);
    const run = svc.runIfAuthorized('dtm', (auth) => isAuthenticAuthorization(auth, 'dtm'));
    expect(run.authorized).toBe(true);
    if (run.authorized) expect(run.value).toBe(true);
    // and it refuses a non-ready product without invoking the executor.
    let ran = false;
    const refused = ProcessService.fromFacts([{ ...healthy, pointCount: 0 }])
      .runIfAuthorized('classify-gaps', () => { ran = true; return 1; });
    expect(refused.authorized).toBe(false);
    expect(ran).toBe(false);
  });
});
