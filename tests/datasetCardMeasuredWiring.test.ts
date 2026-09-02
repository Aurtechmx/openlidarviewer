/**
 * datasetCardMeasuredWiring.test.ts — the Dataset Intelligence card must show
 * MEASURED run values, not header constants, on a static (strided) load:
 * analysed points = the resident sample, coverage never claims "Full Dataset"
 * for a display sample, and a finished terrain run feeds ground visibility,
 * metric stability and the engine status.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';
import {
  summariseDataset,
  signalTier,
  coverageLabel,
  type DatasetIntelligenceInput,
} from '../src/terrain/datasetIntelligence';

function makeInspector() {
  const calls: DatasetIntelligenceInput[] = [];
  const inspector = {
    setDatasetIntelligence: (s: DatasetIntelligenceInput) => calls.push(s),
    clearDatasetIntelligence: vi.fn(),
    setProvenance: vi.fn(),
  } as never;
  return { inspector, last: () => calls[calls.length - 1] };
}

const METRE = { linearUnit: 'metre', linearUnitToMetres: 1 };
/** A 53.7 M-point file loaded with a display stride — 2.88 M resident. */
const stridedCloud = {
  pointCount: 2_880_000,
  declaredPointCount: 53_670_848,
  metadata: { crs: METRE },
  bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [100, 100, 10] as [number, number, number] }),
};
const fullCloud = { ...stridedCloud, pointCount: 53_670_848 };

const run = {
  dtm: { analyzedPointCount: 2_700_000, coverageMode: 'full' as const },
  quality: { meanCellConfidence: 81, groundPointRatio: 0.42 },
};

describe('static strided load — header constants are not measurements', () => {
  it('analysed points is the resident sample, source points the declared total', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector).refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    expect(last().coverageMeta?.sourcePointCount).toBe(53_670_848);
    expect(last().coverageMeta?.analyzedPointCount).toBe(2_880_000);
  });

  it('coverage is a neutral display-sample reading, not "Full Dataset"', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector).refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    const out = summariseDataset(last());
    expect(out?.coverage.bucket).toBe('display-sample');
    expect(out?.coverage.label).toBe('Full extent · display sample');
    expect(signalTier('coverage', 'display-sample')).toBe('neutral');
    expect(coverageLabel('display-sample')).not.toContain('Full Dataset');
  });

  it('an unstrided static load still reads full coverage', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector).refreshDatasetIntelligenceFromStaticCloud(fullCloud);
    expect(last().coverageMeta?.coverage).toBe('full');
    expect(last().coverageMeta?.analyzedPointCount).toBe(53_670_848);
  });

  it('the engine reads idle before any run even though coverageMeta is attached', () => {
    const { inspector, last } = makeInspector();
    createInspectorCardRefreshers(inspector).refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    expect(last().coverageMeta).toBeDefined();
    expect(summariseDataset(last())?.details.engineStatus).toBe('idle');
    expect(summariseDataset(last())?.groundVisibility.label).toBe('—');
    expect(summariseDataset(last())?.confidence.label).toBe('—');
  });
});

describe('a finished terrain run feeds the static card', () => {
  it('noteAnalyzedPointCount folds onto a static summary (not only streaming)', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector);
    cards.refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    cards.noteAnalyzedPointCount(2_700_000);
    expect(last().coverageMeta?.analyzedPointCount).toBe(2_700_000);
    cards.noteAnalyzedPointCount(Number.NaN);
    cards.noteAnalyzedPointCount(0);
    expect(last().coverageMeta?.analyzedPointCount).toBe(2_700_000);
  });

  it('noteTerrainRun feeds count, confidence, ground ratio and engine status', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector);
    cards.refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    cards.noteTerrainRun(run);
    const out = summariseDataset(last());
    expect(out?.details.analyzedPointCount).toBe(2_700_000);
    expect(out?.details.engineStatus).toBe('active');
    expect(out?.confidence.label).toBe('81%');
    expect(out?.confidence.band).toBe('green');
    expect(out?.groundVisibility.bucket).toBe('good');
    // A 'full' engine mode does not re-promote a display sample to "Full Dataset".
    expect(out?.coverage.bucket).toBe('display-sample');
  });

  it('a non-full engine coverage mode replaces the load-time reading', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector);
    cards.refreshDatasetIntelligenceFromStaticCloud(fullCloud);
    cards.noteTerrainRun({ ...run, dtm: { ...run.dtm, coverageMode: 'sampled' } });
    expect(summariseDataset(last())?.coverage.bucket).toBe('sampled');
  });

  it('non-finite quality fields leave the rows honest ("—") but the engine active', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector);
    cards.refreshDatasetIntelligenceFromStaticCloud(stridedCloud);
    cards.noteTerrainRun({ ...run, quality: { meanCellConfidence: Number.NaN, groundPointRatio: Number.NaN } });
    const out = summariseDataset(last());
    expect(out?.confidence.label).toBe('—');
    expect(out?.groundVisibility.label).toBe('—');
    expect(out?.details.engineStatus).toBe('active');
  });

  it('the run fold keeps the derived complexity and the streaming path still works', () => {
    const { inspector, last } = makeInspector();
    const cards = createInspectorCardRefreshers(inspector);
    cards.refreshDatasetIntelligenceFromStreamingCloud({
      sourcePointCount: 1000,
      metadata: { header: { min: [0, 0, 0], max: [100, 100, 10] } },
      crs: () => METRE,
    });
    cards.noteTerrainComplexity({ bucket: 'high', label: 'High', detail: 'VRM 0.1' });
    cards.noteTerrainRun({ ...run, dtm: { ...run.dtm, coverageMode: 'resident-only' } });
    expect(last().complexityDerived?.bucket).toBe('high');
    expect(last().coverageMeta?.coverage).toBe('resident-only');
    expect(last().coverageMeta?.analyzedPointCount).toBe(2_700_000);
  });
});
