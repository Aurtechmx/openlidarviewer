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
import { deriveScanFacts } from '../src/process/scanFacts';

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
  it('review when the linear unit is unknown (physical thresholds cannot be normalized)', () => {
    const v = verdict([scan({ crs: crs({ linearUnit: 'unknown' }) })], 'classify-gaps');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('review when the CRS is missing entirely (fail closed, not assumed metre)', () => {
    const v = verdict([scan({ crs: null })], 'classify-gaps');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
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
  it('review (exploratory) on resident-only streaming — a surface for inspection, whole-dataset export withheld', () => {
    const v = verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'dtm');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('RESIDENT_ONLY');
  });
});

describe('contours — a metric product blocks on unknown unit', () => {
  it('ready over a trusted DTM with a known unit', () => {
    expect(verdict([scan({ groundClassified: true })], 'contours').readiness).toBe('ready');
  });
  it('review (exploratory) when the unit is unknown — inspection contours, validated deliverable withheld', () => {
    const v = verdict([scan({ groundClassified: true, crs: crs({ linearUnit: 'unknown' }) })], 'contours');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
  it('review when the DTM itself is only for review', () => {
    expect(verdict([scan({ groundClassified: false })], 'contours').readiness).toBe('review');
  });
  it('review over a resident-only DTM (exploratory contours), not blocked', () => {
    const v = verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'contours');
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('DTM_REVIEW');
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

// ─────────────────────────────────────────────────────────────────────────────
// A source that states no point total
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 3D Tiles tileset states no point total: `tileset.json` carries no count and
 * the per-tile figures are decode-admission estimates, so summing them would
 * report a measurement nobody made. `deriveScanFacts` carries that absence
 * through as a null `pointCount`.
 *
 * ZERO and UNSTATED are different facts. Zero is a stated measurement and
 * "the scan has no points" is true of it. An unstated total says nothing about
 * whether the scan has points, and the tileset that produces one is drawn,
 * pickable and gridded from the points the source actually delivers — the count
 * is a readiness signal, never an input to the raster. Refusing it with
 * NO_POINTS trades a true generic refusal for a false specific one.
 */
describe('a scan that states no point total', () => {
  /** Signals from a mounted tileset: streaming, no total stated. */
  const unstated = deriveScanFacts({ kind: 'streaming', coverage: 'full', crs: crs() });

  it('carries the absence through instead of collapsing it to zero', () => {
    expect(unstated.pointCount).toBeNull();
  });

  for (const product of ['classify-gaps', 'dtm', 'dsm'] as ProductId[]) {
    it(`does not tell ${product} the scan has no points`, () => {
      const v = verdict([unstated], product);
      expect(v.reasonCode).not.toBe('NO_POINTS');
      expect(v.reason).not.toMatch(/no points/i);
    });

    it(`does not refuse ${product} outright over an absent count`, () => {
      expect(verdict([unstated], product).readiness).not.toBe('blocked');
    });

    it(`names the absent total as the condition on ${product}`, () => {
      const v = verdict([unstated], product);
      expect(v.readiness).toBe('review');
      expect(v.reasonCode).toBe('POINT_TOTAL_UNSTATED');
    });
  }

  it('leaves contours reachable rather than blocked behind a missing DTM', () => {
    const v = verdict([unstated], 'contours');
    expect(v.readiness).not.toBe('blocked');
    expect(v.reasonCode).not.toBe('NO_DTM');
  });

  it('keeps the metric gates ahead of it: an unknown unit still blocks footprints', () => {
    const noUnit = deriveScanFacts({ kind: 'streaming', coverage: 'full', crs: crs({ linearUnit: 'unknown' }) });
    const v = verdict([noUnit], 'building-footprints');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('UNIT_UNKNOWN');
  });
});

describe('a scan that states ZERO points', () => {
  it('keeps the original refusal on classify-gaps', () => {
    const v = verdict([scan({ pointCount: 0 })], 'classify-gaps');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('NO_POINTS');
    expect(v.reason).toBe('The scan has no points to classify.');
  });

  for (const product of ['dtm', 'dsm'] as ProductId[]) {
    it(`keeps the original refusal on ${product}`, () => {
      const v = verdict([scan({ pointCount: 0 })], product);
      expect(v.readiness).toBe('blocked');
      expect(v.reasonCode).toBe('NO_POINTS');
      expect(v.reason).toBe('The scan has no points to grid.');
    });
  }

  it('still blocks contours behind the missing DTM', () => {
    const v = verdict([scan({ pointCount: 0 })], 'contours');
    expect(v.readiness).toBe('blocked');
    expect(v.reasonCode).toBe('NO_DTM');
  });

  it('reaches the same refusal through deriveScanFacts', () => {
    const facts = deriveScanFacts({ kind: 'static', coverage: 'full', crs: crs(), pointCount: 0 });
    expect(facts.pointCount).toBe(0);
    expect(verdict([facts], 'dtm').reasonCode).toBe('NO_POINTS');
  });
});

describe('a scan that states a real point total', () => {
  it('is unaffected: every verdict matches the pre-existing plan', () => {
    const healthy = scan({ groundClassified: true, classificationProvenance: 'producer', classification: 'partial', hasBuildingClass: true });
    const plan = evaluateCapabilities({ scans: [healthy] });
    expect(capabilityFor(plan, 'classify-gaps')).toMatchObject({ readiness: 'ready', reasonCode: 'GAPS_CLASSIFIABLE' });
    expect(capabilityFor(plan, 'dtm')).toMatchObject({ readiness: 'ready', reasonCode: 'GROUND_TRUSTED' });
    expect(capabilityFor(plan, 'dsm')).toMatchObject({ readiness: 'ready', reasonCode: 'SURFACE_READY' });
    expect(capabilityFor(plan, 'contours')).toMatchObject({ readiness: 'ready', reasonCode: 'DTM_READY' });
    expect(capabilityFor(plan, 'building-footprints')).toMatchObject({ readiness: 'ready', reasonCode: 'BUILDING_CLASS_PRESENT' });
  });

  it('keeps every other single-scan verdict it had before', () => {
    expect(verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'dtm').reasonCode).toBe('RESIDENT_ONLY');
    expect(verdict([scan({ crs: null })], 'dsm').reasonCode).toBe('UNIT_UNKNOWN');
    expect(verdict([scan()], 'dtm').reasonCode).toBe('GROUND_DERIVED');
  });
});
