/**
 * processCapabilities.test.ts
 *
 * The Phase 1 capability evaluator is the single source of product eligibility,
 * so these tests pin every ready / review / blocked path and, above all, the
 * fail-closed rules: an unconfirmed linear unit blocks metric products, a
 * differing vertical reference blocks cross-epoch height math, and resident-only
 * streaming coverage cannot back a full-dataset product.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, ProductId } from '../src/process/ProcessPlan';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';

function crs(overrides: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: 'epsg',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    ...overrides,
  } as CrsInfo;
}

function scan(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static',
    coverage: 'full',
    crs: crs(),
    pointCount: 1_000_000,
    hasRgb: true,
    hasIntensity: true,
    hasGpsTime: true,
    hasReturnNumber: true,
    hasPointSourceId: false,
    classification: 'none',
    groundClassified: false,
    hasBuildingClass: false,
    medianSpacing: 0.2,
    ...overrides,
  };
}

function verdict(scans: ScanFacts[], product: ProductId, projectFrameCompatible?: boolean) {
  const plan = evaluateCapabilities({ scans, projectFrameCompatible });
  return capabilityFor(plan, product)!;
}

describe('classify-gaps', () => {
  it('ready on an unclassified full scan', () => {
    expect(verdict([scan()], 'classify-gaps').readiness).toBe('ready');
  });
  it('review when already fully classified (preserve producer classes)', () => {
    const v = verdict([scan({ classification: 'full' })], 'classify-gaps');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('ALREADY_CLASSIFIED');
  });
  it('review on resident-only streaming coverage', () => {
    const v = verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'classify-gaps');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('PARTIAL_COVERAGE');
  });
  it('blocked with no points', () => {
    expect(verdict([scan({ pointCount: 0 })], 'classify-gaps').readiness).toBe('blocked');
  });
});

describe('dtm — fail closed on unit and coverage', () => {
  it('ready with trusted ground and a known unit', () => {
    expect(verdict([scan({ groundClassified: true })], 'dtm').readiness).toBe('ready');
  });
  it('review when ground must be derived', () => {
    const v = verdict([scan({ groundClassified: false })], 'dtm');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('GROUND_DERIVED');
  });
  it('review when the linear unit is unknown', () => {
    const v = verdict([scan({ groundClassified: true, crs: crs({ linearUnit: 'unknown' }) })], 'dtm');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('review when the CRS is missing entirely (fail closed, not assumed metre)', () => {
    const v = verdict([scan({ groundClassified: true, crs: null })], 'dtm');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('blocked on resident-only streaming', () => {
    const v = verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'dtm');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('RESIDENT_ONLY');
  });
});

describe('contours — a metric product blocks on unknown unit', () => {
  it('ready over a trusted DTM with a known unit', () => {
    expect(verdict([scan({ groundClassified: true })], 'contours').readiness).toBe('ready');
  });
  it('blocked when the unit is unknown, even though a surface could be drawn', () => {
    const v = verdict([scan({ groundClassified: true, crs: crs({ linearUnit: 'unknown' }) })], 'contours');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('review when the DTM itself is only for review', () => {
    expect(verdict([scan({ groundClassified: false })], 'contours').readiness).toBe('review');
  });
  it('blocked when no DTM is possible (resident-only)', () => {
    const v = verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'contours');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('NO_DTM');
  });
});

describe('building-footprints', () => {
  it('ready with building-class points and a known unit', () => {
    expect(verdict([scan({ hasBuildingClass: true, classification: 'full' })], 'building-footprints').readiness).toBe('ready');
  });
  it('blocked when the unit is unknown (area is metric)', () => {
    const v = verdict([scan({ hasBuildingClass: true, crs: crs({ linearUnit: 'unknown' }) })], 'building-footprints');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('review when unclassified (classify first)', () => {
    const v = verdict([scan({ classification: 'none' })], 'building-footprints');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('NEEDS_CLASSIFICATION');
  });
});

describe('cross-epoch change & volume — two-scan fail-closed rules', () => {
  const epochA = scan({ crs: crs({ verticalDatum: 'NAVD88' }), groundClassified: true });
  const epochB = scan({ crs: crs({ verticalDatum: 'NAVD88' }), groundClassified: true });

  it('blocked with a single scan', () => {
    expect(verdict([epochA], 'cross-epoch-change').readiness).toBe('blocked');
    expect(verdict([epochA], 'volume-cut-fill').reasonCode).toBe('NEED_TWO_SCANS');
  });

  it('blocked when vertical references differ', () => {
    const other = scan({ crs: crs({ verticalDatum: 'EGM2008' }), groundClassified: true });
    const v = verdict([epochA, other], 'volume-cut-fill', true);
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('VERTICAL_REF_DIFFERS');
  });

  it('blocked when either vertical reference is missing (fail closed)', () => {
    const noVert = scan({ crs: crs(), groundClassified: true }); // no verticalDatum
    const v = verdict([epochA, noVert], 'cross-epoch-change', true);
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('VERTICAL_REF_DIFFERS');
  });

  it('blocked when the same datum carries different vertical units (ft vs m)', () => {
    const feet = scan({ crs: crs({ verticalDatum: 'NAVD88', verticalUnitToMetres: 0.3048 }), groundClassified: true });
    const metres = scan({ crs: crs({ verticalDatum: 'NAVD88', verticalUnitToMetres: 1 }), groundClassified: true });
    const v = verdict([feet, metres], 'volume-cut-fill', true);
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('VERTICAL_UNIT_CONFLICT');
  });

  it('ready when the same datum shares a known vertical unit', () => {
    const a = scan({ crs: crs({ verticalDatum: 'NAVD88', verticalUnitToMetres: 1 }), groundClassified: true });
    const b = scan({ crs: crs({ verticalDatum: 'NAVD88', verticalUnitToMetres: 1 }), groundClassified: true });
    expect(verdict([a, b], 'cross-epoch-change', true).readiness).toBe('ready');
  });

  it('does not read two placeholder datums as a shared reference (fail closed)', () => {
    const p1 = scan({ crs: crs({ verticalDatum: 'unknown' }), groundClassified: true });
    const p2 = scan({ crs: crs({ verticalDatum: 'unknown' }), groundClassified: true });
    const v = verdict([p1, p2], 'volume-cut-fill', true);
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('VERTICAL_REF_DIFFERS');
  });

  it('review when the frame compatibility is not yet proven', () => {
    const v = verdict([epochA, epochB], 'cross-epoch-change', undefined);
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('FRAME_UNPROVEN');
  });

  it('ready with two compatible scans sharing a vertical reference', () => {
    expect(verdict([epochA, epochB], 'volume-cut-fill', true).readiness).toBe('ready');
  });

  it('blocked when a unit is unknown on either scan', () => {
    const noUnit = scan({ crs: crs({ linearUnit: 'unknown', verticalDatum: 'NAVD88' }), groundClassified: true });
    const v = verdict([epochA, noUnit], 'volume-cut-fill', true);
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
});

describe('plan shape', () => {
  it('is empty of single-scan products when no scans are loaded, and blocks two-scan ones', () => {
    const plan = evaluateCapabilities({ scans: [] });
    expect(capabilityFor(plan, 'dtm')).toBeUndefined();
    expect(capabilityFor(plan, 'cross-epoch-change')!.readiness).toBe('blocked');
  });
  it('every reason code is UPPER_SNAKE and every product carries a reason sentence', () => {
    const plan = evaluateCapabilities({ scans: [scan()], projectFrameCompatible: false });
    for (const c of plan.products) {
      expect(c.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });
});
