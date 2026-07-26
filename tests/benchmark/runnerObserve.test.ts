/**
 * runnerObserve.test.ts — what one run's record says, especially when the run
 * went wrong.
 *
 * Sizes here are deliberately tiny (a few thousand points). The ladder is for
 * the suite; a unit test that took a real 250k measurement would be a slow test
 * that still proved nothing about the measurement.
 *
 * The failure cases use the driver's own fault-injection seam, because "a failed
 * stage is reported with its reason and the total becomes unavailable rather
 * than smaller" is the one behaviour a healthy run can never exercise.
 */
import { describe, test, expect } from 'vitest';
import { runOlvPipeline } from '../../benchmarks/pipeline/runPipeline';
import { observeRun, PEAK_HEAP_UNAVAILABLE_REASON } from '../../benchmarks/runner/observe';
import {
  SERIES_ANALYSIS_MS,
  SERIES_PIPELINE_TOTAL_MS,
  seriesOf,
  stageSeriesKey,
} from '../../benchmarks/runner/series';
import { summariseRuns } from '../../benchmarks/runner/summarise';

const POINTS = 3_000;
const TERRAIN = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', holdoutSeed: 1 };

const OBSERVE_OPTIONS = {
  index: 1,
  startRssBytes: 1_000,
  endRssBytes: 2_000,
  startHeapUsedBytes: 500,
  endHeapUsedBytes: 600,
  forcedGcAvailable: false,
};

function observe(overrides: Parameters<typeof runOlvPipeline>[0]): ReturnType<typeof observeRun> {
  return observeRun(runOlvPipeline(overrides), OBSERVE_OPTIONS);
}

describe('a healthy run', () => {
  const o = observe({ seed: 7, pointCount: POINTS, ...TERRAIN });

  test('records every science artifact and no missing ones', () => {
    expect(o.missingArtifacts).toEqual([]);
    expect(Object.keys(o.scienceHashes)).toContain('dtmZBytes');
    expect(Object.keys(o.scienceHashes)).toContain('contourFeatures');
    // Build-scoped hashes are kept in their own map so a cross-machine
    // comparison cannot pick them up by accident.
    expect(Object.keys(o.buildScopedHashes).sort()).toEqual(['processingManifest', 'scientificRecord']);
    expect(Object.keys(o.scienceHashes)).not.toContain('scientificRecord');
  });

  test('the pipeline total is smaller than the sum of the whole stage column', () => {
    const columnSum = o.stages
      .map((s) => s.durationMs ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(o.durations.pipelineTotalMs).not.toBeNull();
    // The isolated leaves re-run work the dtm stage does; adding them is the
    // exact mistake `pipelineDurationMs` exists to prevent.
    expect(o.durations.pipelineTotalMs as number).toBeLessThan(columnSum);
    expect(o.durations.rasterizeIsolatedMs).not.toBeNull();
    expect(o.durations.descriptorsIsolatedMs).not.toBeNull();
  });

  test('generation time is kept separate from analysis time', () => {
    expect(o.durations.analysisMs).toBeCloseTo(
      (o.durations.dtmMs ?? 0) + (o.durations.contoursMs ?? 0),
      9,
    );
    expect(o.generationMs).toBe(o.durations.generateMs);
  });

  test('verifies its processing manifest and produces the app content hash', () => {
    expect(o.manifestVerified).toBe(true);
    expect(o.scalars.applicationContentHash).toMatch(/^[0-9a-f]+$/);
  });

  test('reports peak heap as unavailable with a reason rather than as a number', () => {
    expect(o.memory.peakHeapBytes).toBeNull();
    expect(o.memory.peakHeapUnavailableReason).toBe(PEAK_HEAP_UNAVAILABLE_REASON);
    expect(o.memory.forcedGcAvailable).toBe(false);
  });

  test('every scalar is finite or explicitly null, never NaN', () => {
    for (const [key, value] of Object.entries(o.scalars)) {
      if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
    }
  });

  test('declared browser stages contribute no series', () => {
    const series = seriesOf(o);
    expect(series.values[stageSeriesKey('gpuUpload')]).toBeUndefined();
    expect(series.unavailable[stageSeriesKey('gpuUpload')]).toBeUndefined();
    expect(series.values[SERIES_ANALYSIS_MS]).toBeGreaterThan(0);
  });
});

describe('a run with a failed stage', () => {
  const o = observe({
    seed: 7,
    pointCount: POINTS,
    ...TERRAIN,
    faults: { dtm: 'injected dtm failure' },
  });

  test('names the failed stage and keeps its message', () => {
    expect(o.failedStages.map((f) => f.name)).toContain('dtm');
    expect(o.failedStages.find((f) => f.name === 'dtm')?.error).toBe('injected dtm failure');
  });

  test('reports no total rather than a smaller one', () => {
    expect(o.durations.pipelineTotalMs).toBeNull();
    expect(o.durations.analysisMs).toBeNull();
    expect(o.durations.pointsPerSecond).toBeNull();
  });

  test('records the missing artifacts instead of hashing an absence', () => {
    expect(o.missingArtifacts).toContain('dtmZBytes');
    expect(o.scienceHashes.dtmZBytes).toBeUndefined();
  });

  test('the manifest could not verify, and the record says so', () => {
    expect(o.manifestVerified).toBe(false);
  });

  test('its series carry reasons, not gaps', () => {
    const series = seriesOf(o);
    expect(series.values[SERIES_PIPELINE_TOTAL_MS]).toBeUndefined();
    expect(series.unavailable[SERIES_PIPELINE_TOTAL_MS]).toMatch(/did not complete/);
    expect(series.unavailable[stageSeriesKey('dtm')]).toBe('injected dtm failure');
  });
});

describe('summarising a mixed set of runs', () => {
  test('a series missing from one run is reported unavailable, not averaged over the rest', () => {
    const good = seriesOf(observe({ seed: 7, pointCount: POINTS, ...TERRAIN }));
    const bad = seriesOf(
      observe({ seed: 7, pointCount: POINTS, ...TERRAIN, faults: { contours: 'boom' } }),
    );

    const summarised = summariseRuns([good, good, bad], 3);
    const analysis = summarised.unavailable.find((u) => u.key === SERIES_ANALYSIS_MS);
    expect(analysis, 'analysisMs must not be summarised over two of three runs').toBeDefined();
    expect(analysis?.reason).toMatch(/only 2 of 3 runs/);
    expect(summarised.available.some((b) => b.key === SERIES_ANALYSIS_MS)).toBe(false);
  });

  test('a run count below the configured one fails the series even when every value is present', () => {
    const good = seriesOf(observe({ seed: 7, pointCount: POINTS, ...TERRAIN }));
    const summarised = summariseRuns([good, good], 3);
    expect(summarised.available).toEqual([]);
    expect(summarised.unavailable.every((u) => /expected 3 values|only 2 of 3/.test(u.reason))).toBe(true);
  });
});
