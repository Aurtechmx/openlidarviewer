/**
 * inspectorCardRefreshers.test.ts — the Dataset Intelligence density tier must
 * read the RESOLVED active CRS unit frame, not the file's declared one, so a user
 * CRS/unit override changes the per-m³ bucketing. The refresher takes a
 * `resolvedCrs` accessor; these cases pin that it wins over `cloud.metadata.crs`
 * (static) and `cloud.crs()` (streaming), falls closed on an unknown unit, and
 * falls back to the declared CRS only when no accessor is wired (pure tests).
 * The last block pins that a CRS change on the same scan re-runs the builder,
 * so the density follows the frame both ways.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';
import { summariseDataset } from '../src/terrain/datasetIntelligence';

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

describe('Dataset Intelligence density follows a CRS change on the same scan', () => {
  // A phone scan declares no CRS, so its density reads "Needs units". Picking a
  // metre CRS in the Inspector must give it a density, and "Use detected" must
  // take it away again, without reopening the file.
  /** The resolved frame, switched by the test the way an override switches it. */
  function switchableFrame(initial: typeof METRE | typeof UNKNOWN) {
    const frame = { crs: initial as typeof METRE | typeof UNKNOWN | typeof FOOT };
    return { frame, resolved: () => frame.crs };
  }
  const phoneCloud = { ...staticCloud, metadata: { crs: null } };
  const stream = {
    sourcePointCount: 1000,
    metadata: { header: { min: [0, 0, 0], max: [100, 100, 10] } },
    crs: () => null,
  };

  it('static: the volume appears under a metre CRS and goes again under the unknown one', () => {
    const { inspector, last } = makeInspector();
    const { frame, resolved } = switchableFrame(UNKNOWN);
    const cards = createInspectorCardRefreshers(inspector, resolved);
    cards.refreshDatasetIntelligenceFromStaticCloud(phoneCloud);
    expect(summariseDataset(last() as never)?.density.bucket).toBe('unknown');

    frame.crs = METRE;
    cards.refreshDatasetIntelligenceForFrame(phoneCloud);
    expect(last().bboxVolume).toBeCloseTo(100000, 0);
    expect((last() as { bboxSpansM?: number[] }).bboxSpansM).toEqual([100, 100, 10]);
    expect(summariseDataset(last() as never)?.density.bucket).not.toBe('unknown');

    frame.crs = UNKNOWN;
    cards.refreshDatasetIntelligenceForFrame(phoneCloud);
    expect(last().bboxVolume).toBeUndefined();
    expect((last() as { bboxSpansM?: number[] }).bboxSpansM).toBeUndefined();
    expect(summariseDataset(last() as never)?.density.bucket).toBe('unknown');
  });

  it('streaming: the volume follows the frame both ways', () => {
    const { inspector, last } = makeInspector();
    const { frame, resolved } = switchableFrame(UNKNOWN);
    const cards = createInspectorCardRefreshers(inspector, resolved);
    cards.refreshDatasetIntelligenceFromStreamingCloud(stream);
    expect(last().bboxVolume).toBeUndefined();
    frame.crs = FOOT;
    cards.refreshDatasetIntelligenceForFrame(stream);
    expect(last().bboxVolume).toBeCloseTo(2831.69, 1);
    frame.crs = UNKNOWN;
    cards.refreshDatasetIntelligenceForFrame(stream);
    expect(last().bboxVolume).toBeUndefined();
  });

  it('keeps what a finished terrain run folded in', () => {
    const { inspector, last } = makeInspector();
    const { frame, resolved } = switchableFrame(UNKNOWN);
    const cards = createInspectorCardRefreshers(inspector, resolved);
    cards.refreshDatasetIntelligenceFromStaticCloud(phoneCloud);
    cards.noteTerrainRun({
      dtm: { analyzedPointCount: 640, coverageMode: 'full' },
      quality: { meanCellConfidence: 70, groundPointRatio: 0.3 },
    });
    frame.crs = METRE;
    cards.refreshDatasetIntelligenceForFrame(phoneCloud);
    const s = last() as { engineRan?: boolean; groundPointRatio?: number; coverageMeta?: { analyzedPointCount?: number } };
    expect(last().bboxVolume).toBeCloseTo(100000, 0);
    expect(s.engineRan).toBe(true);
    expect(s.groundPointRatio).toBe(0.3);
    expect(s.coverageMeta?.analyzedPointCount).toBe(640);
  });

  it('leaves the card alone when the frame change belongs to another scan', () => {
    const calls: unknown[] = [];
    const inspector = {
      setDatasetIntelligence: (s: unknown) => calls.push(s),
      clearDatasetIntelligence: vi.fn(),
      setProvenance: vi.fn(),
    } as never;
    const { frame, resolved } = switchableFrame(UNKNOWN);
    const cards = createInspectorCardRefreshers(inspector, resolved);
    cards.refreshDatasetIntelligenceFromStaticCloud(phoneCloud);
    frame.crs = METRE;
    cards.refreshDatasetIntelligenceForFrame({ ...phoneCloud });
    expect(calls).toHaveLength(1);
  });

  it('does nothing before any summary was built', () => {
    const calls: unknown[] = [];
    const inspector = {
      setDatasetIntelligence: (s: unknown) => calls.push(s),
      clearDatasetIntelligence: vi.fn(),
      setProvenance: vi.fn(),
    } as never;
    const cards = createInspectorCardRefreshers(inspector, () => METRE);
    cards.refreshDatasetIntelligenceForFrame(phoneCloud);
    expect(calls).toHaveLength(0);
  });
});
