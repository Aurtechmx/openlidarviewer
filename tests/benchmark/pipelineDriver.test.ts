/**
 * pipelineDriver.test.ts — the driver that runs OLV's real science pipeline.
 *
 * The point of the driver is that a benchmark measures the APPLICATION. So the
 * load-bearing test here is the drift guard: the raster grid, surface, contours
 * and complexity the driver produces must be identical to what
 * `analyseContours` — the entry point the AnalysePanel and the contour worker
 * call — produces from the same points. If someone ever reimplements a stage
 * inside the benchmark, or drifts one of its parameters, that equality is what
 * breaks, and it breaks loudly instead of drifting quietly for a release.
 *
 * The rest pin the reporting contract the three suites key off: one result per
 * named stage, a failing stage recorded rather than fatal (including a failure
 * while converting an artifact), browser-only stages present and honestly
 * unmeasurable, a total that cannot double-count, and artifacts that hash.
 *
 * Clock/random/runtime-neutrality guards for this module live in
 * `sourceGuards.test.ts`, which walks all of `benchmarks/`.
 */
import { describe, test, expect } from 'vitest';
import {
  runOlvPipeline,
  pipelineDurationMs,
  scienceScopedArtifacts,
  ARTIFACT_SCOPE,
  BENCHMARK_AGGREGATION,
  BROWSER_ONLY_STAGES,
  NODE_STAGES,
  PIPELINE_ARTIFACTS,
  PIPELINE_STAGES,
  STAGE_ROLE,
  type PipelineArtifactName,
} from '../../benchmarks/pipeline/runPipeline';
import { generateSyntheticCloud } from '../../benchmarks/fixtures/syntheticCloud';
import { isMeasured, isUnavailable, toHashable, type StageResult } from '../../benchmarks/framework';
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
const artifactEntries = (r: typeof run): Array<[PipelineArtifactName, unknown]> =>
  Object.entries(r.artifacts) as Array<[PipelineArtifactName, unknown]>;

describe('the OLV pipeline driver', () => {
  test('records one StageResult per named stage, in the declared order', () => {
    expect(run.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);
    // The Node stages are the ones a report can put a number against, and the
    // suites hard-code these names; the browser ones come last so the measured
    // rows read as a sequence.
    expect(NODE_STAGES).toEqual([
      'generate',
      'rasterize',
      'dtm',
      'descriptors',
      'contours',
      'scientificRecord',
      'manifest',
    ]);
    expect(BROWSER_ONLY_STAGES).toEqual(['gpuUpload', 'renderReady', 'fps', 'timeToInteraction']);
    expect(new Set(PIPELINE_STAGES).size).toBe(PIPELINE_STAGES.length);
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
      expect(STAGE_ROLE[name]).toBe('declared');
    }
  });

  test('the run total sums the disjoint stages only, never the whole column', () => {
    // `rasterize` and `descriptors` are leaves `dtm` runs again internally, so
    // adding the column overstates the run. The correct answer has to be a
    // function, because a comment does not survive a reporter author.
    expect(Object.keys(STAGE_ROLE).sort()).toEqual([...PIPELINE_STAGES].sort());
    expect(STAGE_ROLE.rasterize).toBe('isolated');
    expect(STAGE_ROLE.descriptors).toBe('isolated');

    const total = pipelineDurationMs(run.stages);
    expect(total).not.toBeNull();
    const wholeColumn = run.stages.reduce(
      (n, s) => n + (s.duration.status === 'measured' ? s.duration.value : 0),
      0,
    );
    const isolated = (['rasterize', 'descriptors'] as const).reduce((n, name) => {
      const d = stageNamed(run.stages, name).duration;
      return n + (d.status === 'measured' ? d.value : 0);
    }, 0);
    expect(isolated).toBeGreaterThan(0);
    expect(total).toBeCloseTo(wholeColumn - isolated, 6);
    expect(run.metrics.runDurationMs).toMatchObject({ status: 'measured', value: total });
  });

  test('a run can opt out of the isolated leaves without losing their rows', () => {
    const lean = runOlvPipeline({ seed: SEED, pointCount: POINTS, isolateLeaves: false });
    // The rows survive — a silently shorter stage list is exactly what the
    // browser-stage rule exists to forbid — but they carry no number and say
    // why, and the leaf artifacts are simply absent.
    expect(lean.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);
    for (const name of ['rasterize', 'descriptors'] as const) {
      const stage = stageNamed(lean.stages, name);
      expect(stage.status, name).toBe('ok');
      expect(isUnavailable(stage.duration), name).toBe(true);
      if (isUnavailable(stage.duration)) {
        expect(stage.duration.reason).toMatch(/isolateLeaves/);
      }
    }
    expect(lean.artifacts.rasterSummary).toBeUndefined();
    expect(lean.artifacts.descriptors).toBeUndefined();
    // The pipeline half is untouched, so the surface is still produced.
    expect(lean.artifacts.dtmSummary).toBeDefined();
    expect(pipelineDurationMs(lean.stages)).not.toBeNull();
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

  test('a failure while converting an artifact costs that stage only', () => {
    // The conversion runs INSIDE the stage body, and the stage's product is
    // captured before it. Built the other way round — convert after the stage
    // returns — one unconvertible application field (a Date, a Map) would throw
    // outside every try/catch and take the whole run down, which is precisely
    // what a per-stage failure contract exists to prevent.
    const faulted = runOlvPipeline({
      seed: SEED,
      pointCount: POINTS,
      artifactFaults: { contours: 'injected conversion explosion' },
    });
    expect(faulted.stages.map((s) => s.name)).toEqual([...PIPELINE_STAGES]);

    const contours = stageNamed(faulted.stages, 'contours');
    expect(contours.status).toBe('failed');
    if (contours.status === 'failed') {
      expect(contours.error).toContain('injected conversion explosion');
    }
    expect(faulted.artifacts.contours).toBeUndefined();
    expect(faulted.artifacts.contourFeatures).toBeUndefined();
    // …and the stages that consume the PRODUCT, not the artifact, are fine.
    for (const later of ['scientificRecord', 'manifest'] as const) {
      expect(stageNamed(faulted.stages, later).status, later).toBe('ok');
    }
    expect(faulted.artifacts.processingManifest).toBeDefined();
    expect(faulted.result).not.toBeNull();
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
    // …and the run has no total, rather than a total missing a term.
    expect(pipelineDurationMs(faulted.stages)).toBeNull();
  });

  test('every artifact is declared, scoped, hashes without throwing, and re-hashes the same', () => {
    const produced = artifactEntries(run).map(([name]) => name);
    // A complete run produces every declared artifact — so the name list is a
    // contract a suite can compile against, not a hopeful superset.
    expect([...produced].sort()).toEqual([...PIPELINE_ARTIFACTS].sort());

    for (const [name, value] of artifactEntries(run)) {
      expect(ARTIFACT_SCOPE[name], name).toBeDefined();
      const first = hashArtifactNode(name, value);
      const second = hashArtifactNode(name, value);
      expect(first.hash, name).toBe(second.hash);
      expect(first.hash, name).toMatch(/^[0-9a-f]{64}$/);
    }
    // The grids travel as bytes: converting them cost three full copies each,
    // and the top of the size ladder would have been gigabytes of transient.
    for (const name of ['pointBytes', 'dtmZBytes', 'dtmCoverageBytes'] as const) {
      expect(hashArtifactNode(name, run.artifacts[name]).kind, name).toBe('bytes');
    }
  });

  test('the build-scoped artifacts are the only ones a cross-machine run must skip', () => {
    // The record embeds the build identity and the manifest chains from it, so
    // both track the git commit and the runner's Node version. Marking them is
    // what stops a cross-machine reproducibility check going red on a green
    // pipeline; the science inside the record stays comparable through
    // `scientificRecordContent`, which drops build and timestamp.
    const buildScoped = PIPELINE_ARTIFACTS.filter((n) => ARTIFACT_SCOPE[n] === 'build');
    expect([...buildScoped]).toEqual(['scientificRecord', 'processingManifest']);
    expect(scienceScopedArtifacts()).not.toContain('scientificRecord');
    expect(scienceScopedArtifacts()).toContain('scientificRecordContent');

    const content = run.artifacts.scientificRecordContent as Record<string, unknown>;
    expect(content.build).toBeUndefined();
    expect(content.generatedAt).toBeUndefined();
    // The app's own science-only fingerprint survives, which is what makes the
    // record's identity checkable at all across machines.
    expect(typeof content.contentHash).toBe('string');
    expect(content.summary).toBeDefined();
    expect(content.methods).toBeDefined();
  });

  test('two runs of the same seed produce the same artifact hashes', () => {
    const again = runOlvPipeline({ seed: SEED, pointCount: POINTS });
    for (const [name, value] of artifactEntries(run)) {
      expect(hashArtifactNode(name, again.artifacts[name]).hash, name).toBe(
        hashArtifactNode(name, value).hash,
      );
    }
  });

  test('drives the real application cores — raster, surface and contours match analyseContours', () => {
    // The drift guard. The driver stages the app's own two halves
    // (computeTerrainCore → contoursFromCore); `analyseContours` is defined as
    // the composition of exactly those two. If a future edit reimplements any
    // of it inside the benchmark, these stop matching.
    const cloud = generateSyntheticCloud({ seed: SEED, pointCount: POINTS });
    const expected = analyseContours(cloud.positions, run.analysisParams);

    expect(run.result).not.toBeNull();
    const actual = run.result!;

    // The isolated rasterize stage runs the same two leaves with the same
    // resolved parameters, so its grid must be the grid the core built. Without
    // this the stage was free to drift its origin, its aggregation or its input
    // and nothing would have noticed.
    const rs = run.artifacts.rasterSummary as Record<string, number>;
    expect(rs.cols).toBe(expected.dtm.cols);
    expect(rs.rows).toBe(expected.dtm.rows);
    expect(rs.originH1).toBe(expected.dtm.originH1);
    expect(rs.originH2).toBe(expected.dtm.originH2);
    expect(rs.cellSizeM).toBe(expected.dtm.cellSizeM);
    expect(rs.sourcePointCount).toBe(expected.dtm.sourcePointCount);
    expect(rs.analyzedPointCount).toBe(expected.dtm.analyzedPointCount);

    // Geometry alone cannot catch a leaf that aggregated its cells differently
    // from the core — every field above is identical under 'mean'. The values
    // can: `buildDtmGrid` keeps a measured cell's height verbatim, so on this
    // fixture, where the despike pass removes nothing (asserted, so a future
    // fixture that does trip it says why rather than failing mysteriously),
    // every filled cell must carry the identical height in the delivered DTM.
    expect(expected.warnings.filter((w) => /outlier ground cell/.test(w))).toEqual([]);
    // Reinterpret the bytes, not copy them element-wise: `new Float32Array(u8)`
    // would read each BYTE as a float and compare nonsense that happens to be
    // stable across runs.
    const rzb = run.artifacts.rasterZBytes as Uint8Array;
    const rasterZ = new Float32Array(rzb.buffer, rzb.byteOffset, rzb.byteLength / 4);
    const mismatched: number[] = [];
    let filled = 0;
    for (let i = 0; i < expected.dtm.counts.length; i++) {
      if (expected.dtm.counts[i] === 0) continue;
      filled++;
      if (rasterZ[i] !== expected.dtm.z[i]) mismatched.push(i);
    }
    expect(filled).toBeGreaterThan(100);
    expect(mismatched).toEqual([]);

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
    for (const name of ['analysisDurationMs', 'runDurationMs', 'pointsPerSecond'] as const) {
      expect(faulted.metrics[name].status, name).toBe('unavailable');
      expect(faulted.metrics[name].value, name).toBeNull();
    }
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
