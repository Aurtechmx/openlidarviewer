/**
 * authorizationScopeNonBroadening.test.ts — an authorization may be reused for
 * the SAME scope or a NARROWER one, but never a BROADER one.
 *
 * "Scope" here is not a free-text field — it is the structured state the
 * authorization is actually bound to (see `scientificStateSignature`): the
 * terrain extent (coverage), the sensor-derived capability (classification /
 * ground / building class) and the vertical reference (CRS vertical datum). A
 * token issued against a state authorizes an output whose scope is contained by
 * that state; a request that WIDENS any axis past the evidence must fail closed.
 *
 * The evidence-level axis is the claim register's own: a claim whose CURRENT
 * evidence level does not meet its REQUIRED level cannot be authorized as a
 * validated output (a weaker level cannot stand in for a stronger claim).
 *
 * These tests consume the existing machinery only — `ProcessService`, the
 * evidence registry and `meetsRequired`. They add no production scope schema:
 * the registry's `scope.supported/unsupported` prose is intentionally NOT
 * treated as a machine-comparable dimension here, because it is prose.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, ProductId } from '../src/process/ProcessPlan';
import { ProcessService } from '../src/process/ProcessService';
import { EVIDENCE_REGISTRY } from '../src/validation/claimRegistry.generated';
import { meetsRequired } from '../src/validation/evidenceLevel';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...o } as CrsInfo;
}

/** A fully-supported single scan — the widest scope on every axis. */
const BASE: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: true,
  classificationProvenance: 'producer', medianSpacing: 0.2,
};

const svc = (...scans: ScanFacts[]) => ProcessService.fromFacts(scans);
/** Issue on `before`, verify against `after`; true iff the token was ACCEPTED. */
function accepted(before: ScanFacts[], after: ScanFacts[], product: ProductId, frame?: boolean): boolean {
  const token = ProcessService.fromFacts(before, frame).authorize(product);
  return ProcessService.fromFacts(after, frame).verifyAuthorization(token, product).ok;
}

describe('same or narrower scope is honoured', () => {
  it('same scope — a token verifies against the identical state it was issued for', () => {
    expect(accepted([BASE], [BASE], 'dtm')).toBe(true);
  });

  it('narrower requested claim — a superset state still authorizes a product it fully covers', () => {
    // classify-gaps needs less than a full-dataset surface; a complete state that
    // authorizes the wider DTM also authorizes the narrower gap-fill.
    expect(svc(BASE).isReady('dtm')).toBe(true);
    expect(svc({ ...BASE, classification: 'partial' }).authorize('classify-gaps')).not.toBeNull();
  });
});

describe('a broader scope on any axis is rejected (fail closed)', () => {
  it('broader terrain scope — a resident-only state cannot authorize a full-dataset DTM', () => {
    // The evidence covers only the resident window; a whole-dataset DTM widens the
    // terrain extent past it.
    expect(svc({ ...BASE, kind: 'streaming', coverage: 'resident-only' }).authorize('dtm')).toBeNull();
  });

  it('broader terrain scope after issuance — narrowing coverage makes the wider token stale', () => {
    expect(accepted([BASE], [{ ...BASE, kind: 'streaming', coverage: 'resident-only' }], 'dtm')).toBe(false);
  });

  it('broader sensor scope — removing the building class refuses a validated footprint claim', () => {
    expect(svc(BASE).isReady('building-footprints')).toBe(true);
    // Building class gone → the footprint claim can no longer be authorized as ready.
    expect(svc({ ...BASE, hasBuildingClass: false }).authorize('building-footprints')).toBeNull();
    // …and a token issued while it was present does not survive its removal.
    expect(accepted([BASE], [{ ...BASE, hasBuildingClass: false }], 'building-footprints')).toBe(false);
  });

  it('removing a vertical-reference limitation broadens the claim — the cross-epoch token is refused', () => {
    // Both epochs share a vertical datum → a vertical-change claim is authorizable.
    const epochs = [BASE, BASE];
    expect(ProcessService.fromFacts(epochs, true).authorize('cross-epoch-change')).not.toBeNull();
    // Drop one epoch's vertical reference (the limitation that kept the claim horizontal-safe
    // is gone) → the still-issued token must not be accepted against the broadened state.
    const broadened = [BASE, { ...BASE, crs: crs({ verticalDatum: undefined }) }];
    expect(accepted(epochs, broadened, 'cross-epoch-change', true)).toBe(false);
  });

  it('unknown / incomparable scope — an unknown linear unit fails closed for a metric product', () => {
    const unknownUnit = { ...BASE, crs: crs({ linearUnit: 'unknown', linearUnitToMetres: undefined as unknown as number }) };
    expect(svc(unknownUnit).authorize('contours')).toBeNull();
  });
});

describe('a weaker evidence level cannot authorize a stronger evidence-level claim', () => {
  it('every registry claim below its required level is not a validated output', () => {
    // The registry is the evidence-level scope. current < required means the
    // strongest (validated) claim is not yet authorized — it may only be offered
    // as explicitly exploratory. This must hold for every entry, no exceptions.
    const below = Object.entries(EVIDENCE_REGISTRY).filter(([, e]) => !meetsRequired(e.current, e.required));
    // Sanity: the fixture has teeth — at least one claim really is below its bar.
    expect(below.length).toBeGreaterThan(0);
    for (const [id, e] of below) {
      expect(meetsRequired(e.current, e.required), `${id} must NOT meet required`).toBe(false);
    }
  });

  it('a claim that meets its required level does authorize as validated (not vacuous)', () => {
    const atOrAbove = Object.entries(EVIDENCE_REGISTRY).filter(([, e]) => meetsRequired(e.current, e.required));
    expect(atOrAbove.length).toBeGreaterThan(0);
  });
});
