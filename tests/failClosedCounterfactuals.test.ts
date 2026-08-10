/**
 * failClosedCounterfactuals.test.ts — each fail-closed guard is load-bearing.
 *
 * A guard only protects anything if (a) removing the exact missing fact would
 * have let the product through, and (b) the DEFAULT when the fact is absent is
 * the CLOSED verdict, not the open one. processCapabilities.test.ts asserts the
 * closed side; this file pairs each closed verdict with its counterfactual — the
 * one fact flipped to present — and confirms the verdict flips with it. If a
 * guard were dead code, the counterfactual would already be ready and the pair
 * would collapse.
 *
 * The subtlety these pairs pin (see the fail-OPEN null-guard class): a MISSING
 * fact must read as the closed state, never as a convenient default. A null CRS
 * is not metre; an undetermined frame is not compatible; a missing vertical
 * reference is not "same datum".
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, ProductId, Readiness } from '../src/process/ProcessPlan';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';

function crs(overrides: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...overrides } as CrsInfo;
}

function scan(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
    hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2,
    ...overrides,
  };
}

function verdict(scans: ScanFacts[], product: ProductId, frame?: boolean): Readiness {
  return capabilityFor(evaluateCapabilities({ scans, projectFrameCompatible: frame }), product)!.readiness;
}

describe('unit trust — metric products fail closed on a missing or unknown unit', () => {
  it('contours: unknown unit blocks, a known unit is ready (guard is load-bearing)', () => {
    expect(verdict([scan({ crs: crs({ linearUnit: 'unknown' }) })], 'contours')).toBe('blocked');
    expect(verdict([scan()], 'contours')).toBe('ready'); // counterfactual: only the unit changed
  });

  it('a MISSING CRS reads as unknown, not as an assumed metre (fail closed, not open)', () => {
    // The dangerous bug would be a null CRS defaulting to metre and passing the
    // metric gate. It must land on the SAME closed verdict as an explicit unknown.
    expect(verdict([scan({ crs: null })], 'contours')).toBe('blocked');
    expect(verdict([scan({ crs: null })], 'building-footprints')).toBe('blocked');
  });
});

describe('coverage — surfaces degrade to review on resident-only streaming', () => {
  it('dtm: resident-only degrades to review, full coverage is ready (guard is load-bearing)', () => {
    // A resident-only surface is exploratory (whole-dataset export withheld), not a
    // hard block — matching the module contract and the Contour Studio launcher.
    expect(verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'dtm')).toBe('review');
    expect(verdict([scan({ kind: 'streaming', coverage: 'full' })], 'dtm')).toBe('ready'); // only coverage changed
  });
  it('building-footprints still fail closed on resident-only — missing returns would drop buildings', () => {
    expect(verdict([scan({ kind: 'streaming', coverage: 'resident-only', hasBuildingClass: true })], 'building-footprints')).toBe('blocked');
  });
});

describe('two-scan height math fails closed on the frame and the vertical reference', () => {
  const epoch = (v: string | null): ScanFacts =>
    scan({ crs: crs({ verticalDatum: v ?? undefined } as Partial<CrsInfo>) });

  it('cross-epoch: an undetermined frame is not "compatible" — review until proven, ready once true', () => {
    // frame undefined → not ready (can't assume compatibility); frame true → ready.
    expect(verdict([epoch('NAVD88'), epoch('NAVD88')], 'cross-epoch-change', undefined)).not.toBe('ready');
    expect(verdict([epoch('NAVD88'), epoch('NAVD88')], 'cross-epoch-change', true)).toBe('ready');
  });

  it('a MISSING vertical reference is not "same datum" — it blocks the height comparison', () => {
    // One epoch has no vertical datum: the difference is unsafe, so it must block
    // even with a proven frame. The counterfactual (both NAVD88) is ready.
    expect(verdict([epoch('NAVD88'), epoch(null)], 'cross-epoch-change', true)).toBe('blocked');
    expect(verdict([epoch('NAVD88'), epoch('NAVD88')], 'cross-epoch-change', true)).toBe('ready');
  });
});
