/**
 * pipelineDriver.test.ts — the driver that runs OLV's real science pipeline.
 *
 * The point of the driver is that a benchmark measures the APPLICATION. So the
 * load-bearing test here is the last one: the surface and contours the driver
 * produces must be identical to what `analyseContours` — the entry point the
 * AnalysePanel and the contour worker call — produces from the same points. If
 * someone ever reimplements a stage inside the benchmark, that equality is what
 * breaks, and it breaks loudly instead of drifting quietly for a release.
 *
 * The rest pin the reporting contract the three suites key off: one result per
 * named stage, a failing stage recorded rather than fatal, browser-only stages
 * present and honestly unmeasurable, and artifacts that hash.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runOlvPipeline,
  toHashable,
  BENCHMARK_AGGREGATION,
  NODE_STAGES,
  BROWSER_ONLY_STAGES,
  PIPELINE_STAGES,
} from '../../benchmarks/pipeline/runPipeline';
import { generateSyntheticCloud } from '../../benchmarks/fixtures/syntheticCloud';
import { isMeasured, isUnavailable, type StageResult } from '../../benchmarks/framework';
import { hashArtifactNode } from '../../benchmarks/framework/node';
import { analyseContours, computeTerrainCore } from '../../src/terrain/contour/analyseContours';

/** Small enough that the whole file stays inside the unit-suite budget. */
const SEED = 11;
const POINTS = 4_000;

const run = runOlvPipeline({ seed: SEED, pointCount: POINTS });

const stageNamed = (stages: readonly StageResult[], name: string): StageResult => {
  const found = stages.find((s) => s.name === name);
  if (!found) throw new Error(`no stage named ${name}`);
  return found;
};

describe('the OLV pipeline driver', () => {
  test('records one StageResult per named stage, in the declared order', () => {
    expect(run.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);
    expect(PIPELINE_STAGES).toEqual([...NODE_STAGES, ...BROWSER_ONLY_STAGES]);
    expect(NODE_STAGES).toEqual([
      'generate',
      'rasterize',
      'dtm',
      'descriptors',
      'contours',
      'scientificRecord',
      'manifest',
    ]);
  });

  test('every Node stage completes and carries a measured duration and peak memory', () => {
    for (const name of NODE_STAGES) {
      const stage = stageNamed(run.stages, name);
      expect(stage.status, `${name}: ${stage.status === 'failed' ? stage.error : ''}`).toBe('ok');
      expect(isMeasured(stage.duration), name).toBe(true);
      if (isMeasured(stage.duration)) {
        expect(stage.duration.unit).toBe('ms');
        expect(stage.duration.runtime).toBe('node');
        expect(stage.duration.value).toBeGreaterThanOrEqual(0);
      }
      expect(stage.peakMemory.runtime, name).toBe('node');
    }
  });

  test('browser-only stages are present and unavailable with a reason, never zero', () => {
    // Omitting them would make a workflow report read as a complete pipeline
    // when a third of it was never attempted; emitting 0 or an estimate would
    // be worse still. Both failure modes are what this asserts against.
    expect(BROWSER_ONLY_STAGES.length).toBeGreaterThan(0);
    for (const name of BROWSER_ONLY_STAGES) {
      const stage = stageNamed(run.stages, name);
      expect(isUnavailable(stage.duration), name).toBe(true);
      expect(isUnavailable(stage.peakMemory), name).toBe(true);
      if (isUnavailable(stage.duration)) {
        expect(stage.duration.value).toBeNull();
        expect(stage.duration.runtime).toBe('browser');
        // The reason must name the runtime limitation, not just say "n/a".
        expect(stage.duration.reason.length).toBeGreaterThan(20);
        expect(stage.duration.reason).toMatch(/node|browser|gpu|renderer|frame|paint/i);
      }
    }
  });

  test('an injected stage failure is recorded and the later stages still run', () => {
    const faulted = runOlvPipeline({
      seed: SEED,
      pointCount: POINTS,
      faults: { descriptors: 'injected descriptor explosion' },
    });
    // Every stage still has a row — a partial list would hide which stages
    // were fine, which is the whole reason a failed stage must not abort.
    expect(faulted.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);

    const descriptors = stageNamed(faulted.stages, 'descriptors');
    expect(descriptors.status).toBe('failed');
    if (descriptors.status === 'failed') {
      expect(descriptors.error).toContain('injected descriptor explosion');
    }
    // It still carries measurements: a stage that died after doing work tells
    // a reader something, and the framework records them either way.
    expect(descriptors.duration.status).toBe('measured');

    for (const later of ['contours', 'scientificRecord', 'manifest'] as const) {
      expect(stageNamed(faulted.stages, later).status, later).toBe('ok');
    }
    // The descriptor artifact is simply absent — never a fabricated stand-in.
    expect(faulted.artifacts.descriptors).toBeUndefined();
    expect(faulted.artifacts.contours).toBeDefined();
  });

  test('a failure upstream leaves the dependent stages failed, not missing', () => {
    const faulted = runOlvPipeline({
      seed: SEED,
      pointCount: POINTS,
      faults: { dtm: 'injected core explosion' },
    });
    expect(faulted.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);
    expect(stageNamed(faulted.stages, 'dtm').status).toBe('failed');
    for (const dependent of ['descriptors', 'contours', 'scientificRecord', 'manifest'] as const) {
      const stage = stageNamed(faulted.stages, dependent);
      expect(stage.status, dependent).toBe('failed');
      // Each one names the prerequisite it was missing, so a reader can walk
      // the chain back to the stage that actually broke.
      if (stage.status === 'failed') expect(stage.error, dependent).toMatch(/did not produce/);
    }
    for (const direct of ['descriptors', 'contours'] as const) {
      const stage = stageNamed(faulted.stages, direct);
      if (stage.status === 'failed') expect(stage.error, direct).toMatch(/dtm/);
    }
    // The stages that DID complete are still reported as such.
    expect(stageNamed(faulted.stages, 'rasterize').status).toBe('ok');
  });

  test('every artifact hashes without throwing, and re-hashing the same run agrees', () => {
    const names = Object.keys(run.artifacts);
    // The pipeline produced real science, so the artifact set is not empty.
    expect(names).toEqual(
      expect.arrayContaining([
        'fixture',
        'rasterSummary',
        'dtmSummary',
        'dtmSurface',
        'descriptors',
        'contours',
        'contourFeatures',
        'scientificRecord',
        'processingManifest',
      ]),
    );
    for (const name of names) {
      const first = hashArtifactNode(name, run.artifacts[name]);
      const second = hashArtifactNode(name, run.artifacts[name]);
      expect(first.hash, name).toBe(second.hash);
      expect(first.hash, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('two runs of the same seed produce the same artifact hashes', () => {
    const again = runOlvPipeline({ seed: SEED, pointCount: POINTS });
    for (const name of Object.keys(run.artifacts)) {
      expect(hashArtifactNode(name, again.artifacts[name]).hash, name).toBe(
        hashArtifactNode(name, run.artifacts[name]).hash,
      );
    }
  });

  test('drives the real application cores — the surface matches analyseContours', () => {
    // The drift guard. The driver stages the app's own two halves
    // (computeTerrainCore → contoursFromCore); `analyseContours` is defined as
    // the composition of exactly those two. If a future edit reimplements any
    // of it inside the benchmark, these arrays stop matching.
    const cloud = generateSyntheticCloud({ seed: SEED, pointCount: POINTS });
    const expected = analyseContours(cloud.positions, run.analysisParams);

    expect(run.result).not.toBeNull();
    const actual = run.result!;
    expect(Array.from(actual.dtm.z)).toEqual(Array.from(expected.dtm.z));
    expect(Array.from(actual.dtm.confidence)).toEqual(Array.from(expected.dtm.confidence));
    expect(Array.from(actual.dtm.coverage)).toEqual(Array.from(expected.dtm.coverage));
    expect(actual.validation.rmse).toBe(expected.validation.rmse);
    expect(actual.intervalM).toBe(expected.intervalM);
    expect(actual.tally).toEqual(expected.tally);
    expect(actual.model.features.length).toBe(expected.model.features.length);
    // And the descriptor stage re-runs the app's own complexity summary over
    // the core's cached Horn grids, so it must agree with the core's own.
    expect(run.artifacts.descriptors).toEqual(toHashable(expected.complexity));
  });

  test('headline metrics are stated only when the stages behind them ran', () => {
    expect(run.metrics.pointCount).toMatchObject({ status: 'measured', value: POINTS });
    expect(run.metrics.analysisDurationMs.status).toBe('measured');
    expect(run.metrics.pointsPerSecond.status).toBe('measured');

    // With the core broken there is no analysis time, so throughput must be
    // withheld with a reason — never a 0 that reads as "infinitely slow".
    const faulted = runOlvPipeline({
      seed: SEED,
      pointCount: POINTS,
      faults: { dtm: 'injected core explosion' },
    });
    expect(faulted.metrics.analysisDurationMs.status).toBe('unavailable');
    expect(faulted.metrics.pointsPerSecond.status).toBe('unavailable');
    expect(faulted.metrics.pointsPerSecond.value).toBeNull();
  });

  test('the driver never reaches for Math.random or the wall clock', () => {
    // Both would poison an artifact hash, and neither would fail loudly: the
    // run would look fine and the reproducibility check would simply never
    // match again. Same guard the framework holds itself to.
    const file = fileURLToPath(
      new URL('../../benchmarks/pipeline/runPipeline.ts', import.meta.url),
    );
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/Math\.random\s*\(/);
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(/);
    // …and it stays runtime-neutral, so a browser suite can reuse it to fill
    // in the four stages Node cannot measure.
    expect(code).not.toMatch(/['"]node:/);
  });

  test('the declared aggregation is still the one the live pipeline picks', () => {
    // The driver names the per-cell aggregation explicitly, because the
    // isolated `rasterize` stage has to match the core and the live default is
    // private to analyseContours. This is the guard on that duplication: if the
    // application changes what it ships, the benchmark stops silently measuring
    // a surface the application no longer produces.
    const cloud = generateSyntheticCloud({ seed: 2, pointCount: 1_000 });
    const { aggregation: _declared, ...withoutAggregation } = run.analysisParams;
    const core = computeTerrainCore(cloud.positions, withoutAggregation);
    expect(core.aggregation).toBe(BENCHMARK_AGGREGATION);
  });

  test('the analysed cloud produced a real surface with contours on it', () => {
    // Guards against a green suite over a degenerate fixture: a pipeline that
    // classified nothing as ground, or found no contourable relief, would
    // still report seven happy stages.
    const summary = run.artifacts.dtmSummary as Record<string, unknown>;
    expect(summary.cols as number).toBeGreaterThan(4);
    expect(summary.rows as number).toBeGreaterThan(4);
    const result = run.result!;
    expect(result.dtm.sourcePointCount).toBeGreaterThan(0);
    expect(result.intervalM).not.toBeNull();
    expect(result.contours.levels.length).toBeGreaterThan(0);
    expect(result.model.features.length).toBeGreaterThan(0);
  });
});
