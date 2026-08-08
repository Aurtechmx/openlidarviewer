/**
 * processPlanCounterfactualMatrix.test.ts — quick-win 6. A table-driven matrix
 * over the important ProcessPlan gates: for each condition, a healthy baseline
 * and the SAME baseline with exactly one condition degraded, asserting the exact
 * READY / REVIEW / BLOCKED transition and its reason code.
 *
 * Because only one condition changes per row, the table makes it obvious which
 * individual condition causes each refusal or downgrade. Thresholds are not
 * altered — this reads the current model.
 */

import { describe, it, expect } from 'vitest';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts, ProductId, Readiness } from '../src/process/ProcessPlan';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
function scan(o: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
    hasRgb: true, hasIntensity: true, hasGpsTime: true, hasReturnNumber: true, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: true, medianSpacing: 0.2, ...o,
  };
}
function verdict(scans: ScanFacts[], product: ProductId, frame?: boolean) {
  return capabilityFor(evaluateCapabilities({ scans, projectFrameCompatible: frame }), product)!;
}

const navd = (): ScanFacts => scan({ crs: crs({ verticalDatum: 'NAVD88' } as Partial<CrsInfo>) });

interface Row {
  condition: string;
  product: ProductId;
  normal: () => { readiness: Readiness; reasonCode: string };
  degraded: () => { readiness: Readiness; reasonCode: string };
  expectNormal: Readiness;
  expectDegraded: Readiness;
  degradedReason: string;
}

const MATRIX: Row[] = [
  {
    condition: 'linear unit: known → unknown',
    product: 'contours',
    normal: () => verdict([scan()], 'contours'),
    degraded: () => verdict([scan({ crs: crs({ linearUnit: 'unknown' }) })], 'contours'),
    expectNormal: 'ready', expectDegraded: 'blocked', degradedReason: 'UNIT_UNKNOWN',
  },
  {
    condition: 'linear unit: known → CRS missing (fail closed)',
    product: 'building-footprints',
    normal: () => verdict([scan()], 'building-footprints'),
    degraded: () => verdict([scan({ crs: null })], 'building-footprints'),
    expectNormal: 'ready', expectDegraded: 'blocked', degradedReason: 'UNIT_UNKNOWN',
  },
  {
    condition: 'coverage: full → resident-only',
    product: 'dtm',
    normal: () => verdict([scan({ kind: 'streaming', coverage: 'full' })], 'dtm'),
    degraded: () => verdict([scan({ kind: 'streaming', coverage: 'resident-only' })], 'dtm'),
    expectNormal: 'ready', expectDegraded: 'blocked', degradedReason: 'RESIDENT_ONLY',
  },
  {
    condition: 'ground: producer → derived',
    product: 'dtm',
    normal: () => verdict([scan({ groundClassified: true })], 'dtm'),
    degraded: () => verdict([scan({ groundClassified: false })], 'dtm'),
    expectNormal: 'ready', expectDegraded: 'review', degradedReason: 'GROUND_DERIVED',
  },
  {
    condition: 'frame: proven-compatible → unproven',
    product: 'cross-epoch-change',
    normal: () => verdict([navd(), navd()], 'cross-epoch-change', true),
    degraded: () => verdict([navd(), navd()], 'cross-epoch-change', undefined),
    expectNormal: 'ready', expectDegraded: 'review', degradedReason: 'FRAME_UNPROVEN',
  },
  {
    condition: 'vertical reference: shared → one missing',
    product: 'cross-epoch-change',
    normal: () => verdict([navd(), navd()], 'cross-epoch-change', true),
    degraded: () => verdict([navd(), scan({ crs: crs() })], 'cross-epoch-change', true),
    expectNormal: 'ready', expectDegraded: 'blocked', degradedReason: 'VERTICAL_REF_DIFFERS',
  },
];

describe('ProcessPlan counterfactual matrix — one degraded condition at a time', () => {
  it.each(MATRIX)('$condition → $product goes $expectNormal → $expectDegraded ($degradedReason)', (row) => {
    const n = row.normal();
    const d = row.degraded();
    // The healthy baseline is at the expected strong state.
    expect(n.readiness).toBe(row.expectNormal);
    // Degrading exactly one condition produces the expected weaker state...
    expect(d.readiness).toBe(row.expectDegraded);
    // ...for the expected, greppable reason — so the cause of the refusal is named.
    expect(d.reasonCode).toBe(row.degradedReason);
  });
});
