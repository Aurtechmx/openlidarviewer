/**
 * inspectorCardRefreshers.test.ts — the Dataset Intelligence density tier must
 * read the RESOLVED active CRS unit frame, not the file's declared one, so a user
 * CRS/unit override changes the per-m³ bucketing. The refresher takes a
 * `resolvedCrs` accessor; these cases pin that it wins over `cloud.metadata.crs`
 * (static) and `cloud.crs()` (streaming), falls closed on an unknown unit, and
 * falls back to the declared CRS only when no accessor is wired (pure tests).
 */
import { describe, it, expect, vi } from 'vitest';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';

/** Capture the last Dataset Intelligence summary pushed to the Inspector. */
function makeInspector() {
  const calls: Array<{ bboxVolume?: number }> = [];
  const inspector = {
    setDatasetIntelligence: (s: { bboxVolume?: number }) => calls.push(s),
    clearDatasetIntelligence: vi.fn(),
    setProvenance: vi.fn(),
  } as never;
  return { inspector, last: () => calls[calls.length - 1] };
}

// A 100 × 100 × 10 source box. In metres that is 100 000 m³; in US survey feet
// (0.3048006 m per foot) the same span is ~2 831.7 m³ — the factor the tier reads.
const METRE = { linearUnit: 'metre', linearUnitToMetres: 1 };
const FOOT = { linearUnit: 'us-ft', linearUnitToMetres: 0.30480060960121924 };
const UNKNOWN = { linearUnit: 'unknown', linearUnitToMetres: 1 };
const staticCloud = {
  pointCount: 1000,
  declaredPointCount: 1000,
  metadata: { crs: METRE }, // the file DECLARES metre
  bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [100, 100, 10] as [number, number, number] }),
};

describe('Dataset Intelligence density tier — resolved CRS authority', () => {
  it('static: a resolved FOOT override drives the m³ volume, not the declared metre CRS', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector, () => FOOT);
    cards.refreshDatasetIntelligenceFromStaticCloud(staticCloud);
    expect(last().bboxVolume).toBeCloseTo(2831.69, 1); // foot factor applied
    expect(last().bboxVolume).not.toBeCloseTo(100000, 0); // NOT the declared-metre volume
  });

  it('static: a resolved UNKNOWN unit fails closed — no volume, no wrong tier', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector, () => UNKNOWN);
    cards.refreshDatasetIntelligenceFromStaticCloud(staticCloud);
    expect(last().bboxVolume).toBeUndefined();
  });

  it('static: no resolver wired falls back to the declared CRS (metre)', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector); // no resolvedCrs
    cards.refreshDatasetIntelligenceFromStaticCloud(staticCloud);
    expect(last().bboxVolume).toBeCloseTo(100000, 0);
  });

  it('streaming: a resolved FOOT override drives the m³ volume, not the source crs()', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector, () => FOOT);
    cards.refreshDatasetIntelligenceFromStreamingCloud({
      sourcePointCount: 1000,
      metadata: { header: { min: [0, 0, 0], max: [100, 100, 10] } },
      crs: () => METRE, // the stream DECLARES metre
    });
    expect(last().bboxVolume).toBeCloseTo(2831.69, 1);
  });
});
