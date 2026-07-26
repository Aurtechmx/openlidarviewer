/**
 * observe.ts
 *
 * Turn one `runOlvPipeline` result into the flat, JSON-shaped record both
 * suites write into `raw.json`.
 *
 * WHY BOTH SUITES SHARE ONE OBSERVER. The reproducibility suite and the scaling
 * suite ask different questions of the same pipeline, and the tempting shape is
 * two extractors each pulling the handful of fields its own summary needs. That
 * is how the two suites end up disagreeing about what "the total" is — one
 * summing the stage column, one not — and how a field the scaling suite records
 * quietly stops being the field the reproducibility suite compares. One
 * observer, one definition of every number, both suites downstream of it.
 *
 * WHAT THE TOTAL IS. `pipelineDurationMs()` from the driver, never a sum of the
 * stage column: `rasterize` and `descriptors` are isolated re-runs of work `dtm`
 * already does, so adding them double-counts by roughly a quarter on a large
 * tier. They are recorded, separately and clearly labelled, because a per-core
 * scaling curve is exactly what they are for.
 *
 * WHAT "PEAK MEMORY" MEANS HERE, precisely, because the honest answer is
 * narrower than the phrase suggests. Every pipeline stage is synchronous and
 * blocks the event loop, so the framework's background RSS sampler cannot fire
 * mid-stage: the peak reported is the largest reading taken at a STAGE
 * BOUNDARY, not a true high-water mark. Peak heap is not reported at all —
 * there is no reading between stage boundaries to take a maximum over, and a
 * start/end maximum labelled "peak" would be a smaller number wearing a bigger
 * name. It is recorded as unavailable with that reason.
 */

import { isMeasured, type ArtifactRecord, type Metric, type StageResult } from '../framework';
import { hashArtifactNode } from '../framework/node';
import {
  ARTIFACT_SCOPE,
  PIPELINE_ARTIFACTS,
  PIPELINE_STAGES,
  STAGE_ROLE,
  pipelineDurationMs,
  type PipelineArtifactName,
  type PipelineRun,
  type PipelineStageName,
  type StageRole,
} from '../pipeline/runPipeline';

/** Stated on every run so the caveat travels with the number, not with the doc. */
export const PEAK_HEAP_UNAVAILABLE_REASON =
  'peak heap is not observable here: every pipeline stage is synchronous and blocks the event loop, ' +
  'so no sampler runs between stage boundaries and a start/end maximum would understate the true peak';

/** One stage, flattened for JSON. Every absent number carries its reason. */
export interface StageRecord {
  readonly name: PipelineStageName;
  readonly role: StageRole;
  readonly status: 'ok' | 'failed';
  readonly durationMs: number | null;
  readonly durationUnavailableReason: string | null;
  readonly peakRssBytes: number | null;
  readonly peakRssUnavailableReason: string | null;
  readonly error: string | null;
}

/** The durations a report may quote, each kept strictly separate. */
export interface RunDurations {
  /** Fixture generation. NOT application time — reported on its own. */
  readonly generateMs: number | null;
  /** The isolated rasterize leaf. Overlaps `dtmMs`; never add the two. */
  readonly rasterizeIsolatedMs: number | null;
  readonly dtmMs: number | null;
  /** The isolated descriptor leaf. Overlaps `dtmMs`; never add the two. */
  readonly descriptorsIsolatedMs: number | null;
  readonly contoursMs: number | null;
  readonly scientificRecordMs: number | null;
  readonly manifestMs: number | null;
  /** The application's analysis proper: dtm + contours. */
  readonly analysisMs: number | null;
  /** The non-overlapping pipeline total, from `pipelineDurationMs()`. */
  readonly pipelineTotalMs: number | null;
  /** Points divided by `analysisMs`. Null when the analysis did not complete. */
  readonly pointsPerSecond: number | null;
}

export interface RunMemory {
  readonly startRssBytes: number | null;
  readonly endRssBytes: number | null;
  readonly startHeapUsedBytes: number | null;
  readonly endHeapUsedBytes: number | null;
  /** Largest stage-boundary RSS reading of the run. See the header. */
  readonly peakRssBytes: number | null;
  readonly peakRssUnavailableReason: string | null;
  /** Always null. See {@link PEAK_HEAP_UNAVAILABLE_REASON}. */
  readonly peakHeapBytes: null;
  readonly peakHeapUnavailableReason: string;
  /** Whether `global.gc` existed for the pre-run release. Never a pass condition. */
  readonly forcedGcAvailable: boolean;
}

/** Scalar science outputs, compared field by field between runs. */
export interface RunScalars {
  readonly gridCols: number | null;
  readonly gridRows: number | null;
  readonly gridCellCount: number | null;
  readonly cellSizeM: number | null;
  readonly elevationMinM: number | null;
  readonly elevationMaxM: number | null;
  readonly elevationRangeM: number | null;
  readonly meanConfidence: number | null;
  readonly qualityScore: number | null;
  readonly qualityBand: string | null;
  readonly contourIntervalM: number | null;
  readonly contourLevelCount: number | null;
  readonly contourPolylineCount: number | null;
  readonly contourFeatureCount: number | null;
  readonly contourLabelCount: number | null;
  readonly sourcePointCount: number | null;
  readonly analyzedPointCount: number | null;
  /** The application's OWN content hash, taken over the science alone. */
  readonly applicationContentHash: string | null;
}

export interface RunObservation {
  readonly index: number;
  readonly datasetId: string;
  readonly seed: number;
  readonly requestedPointCount: number;
  readonly generatedPointCount: number | null;
  readonly generationMs: number | null;
  readonly stages: readonly StageRecord[];
  /** Full hash records, so a reader sees what each hash excluded. */
  readonly artifacts: readonly ArtifactRecord[];
  /** Cross-run scientific identity: hash by artifact name, science scope only. */
  readonly scienceHashes: Readonly<Record<string, string>>;
  /** Build-scoped hashes, reported SEPARATELY — they track commit and Node. */
  readonly buildScopedHashes: Readonly<Record<string, string>>;
  /** Artifacts the run was expected to produce and did not. */
  readonly missingArtifacts: readonly string[];
  readonly durations: RunDurations;
  readonly memory: RunMemory;
  readonly scalars: RunScalars;
  /** The terrain-complexity summary verbatim, or null when nothing was measurable. */
  readonly complexitySummary: unknown;
  /** The scientific record with build identity and timestamps removed. */
  readonly scientificRecordContent: unknown;
  readonly manifestVerified: boolean;
  readonly failedStages: readonly { readonly name: string; readonly error: string }[];
  readonly warnings: readonly string[];
}

export interface ObserveOptions {
  readonly index: number;
  readonly startRssBytes: number | null;
  readonly endRssBytes: number | null;
  readonly startHeapUsedBytes: number | null;
  readonly endHeapUsedBytes: number | null;
  readonly forcedGcAvailable: boolean;
}

function metricValue(m: Metric): number | null {
  return isMeasured(m) ? m.value : null;
}

function metricReason(m: Metric): string | null {
  return isMeasured(m) ? null : m.reason;
}

function stageOf(stages: readonly StageResult[], name: string): StageResult | undefined {
  return stages.find((s) => s.name === name);
}

/** A stage's duration, or null when it failed or carried no measurement. */
function durationOf(stages: readonly StageResult[], name: string): number | null {
  const stage = stageOf(stages, name);
  if (!stage || stage.status !== 'ok') return null;
  return metricValue(stage.duration);
}

function sumOrNull(parts: readonly (number | null)[]): number | null {
  let total = 0;
  for (const p of parts) {
    if (p === null) return null;
    total += p;
  }
  return total;
}

/**
 * Number-or-null from an application field, refusing a non-finite value.
 *
 * A NaN elevation reaching `raw.json` serialises as `null`, which then reads as
 * "the pipeline did not produce this" — the same field standing for two
 * completely different findings. Returning null here would repeat that; instead
 * the caller records it as a run-level warning naming the field.
 */
function finiteOrNull(value: unknown, field: string, warnings: string[]): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) {
    warnings.push(`${field} is ${String(value)}, which cannot be represented in JSON as a number`);
    return null;
  }
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Read one field off an unknown JSON-shaped artifact without casting the lot. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function observeRun(run: PipelineRun, options: ObserveOptions): RunObservation {
  const warnings: string[] = [];

  const stages: StageRecord[] = PIPELINE_STAGES.map((name) => {
    const stage = stageOf(run.stages, name);
    if (!stage) {
      // A stage the driver did not emit at all. Recorded rather than skipped:
      // an absent row is the one thing a reader cannot see is absent.
      return {
        name,
        role: STAGE_ROLE[name],
        status: 'failed',
        durationMs: null,
        durationUnavailableReason: 'the driver emitted no result for this stage',
        peakRssBytes: null,
        peakRssUnavailableReason: 'the driver emitted no result for this stage',
        error: 'stage missing from the run',
      };
    }
    return {
      name,
      role: STAGE_ROLE[name],
      status: stage.status,
      durationMs: metricValue(stage.duration),
      durationUnavailableReason: metricReason(stage.duration),
      peakRssBytes: metricValue(stage.peakMemory),
      peakRssUnavailableReason: metricReason(stage.peakMemory),
      error: stage.status === 'failed' ? stage.error : null,
    };
  });

  const failedStages = stages
    .filter((s) => s.status === 'failed')
    .map((s) => ({ name: s.name, error: s.error ?? 'no message recorded' }));

  // Hash every artifact the run produced, with the fast Node digest — the
  // portable one copies the payload and runs at ~40 MiB/s, which on the 1M
  // tier's rasters is seconds of pure harness cost per run.
  const artifacts: ArtifactRecord[] = [];
  const scienceHashes: Record<string, string> = {};
  const buildScopedHashes: Record<string, string> = {};
  const missingArtifacts: string[] = [];
  for (const name of PIPELINE_ARTIFACTS) {
    const value = run.artifacts[name as PipelineArtifactName];
    if (value === undefined) {
      missingArtifacts.push(name);
      continue;
    }
    const record = hashArtifactNode(name, value);
    artifacts.push(record);
    if (ARTIFACT_SCOPE[name] === 'science') scienceHashes[name] = record.hash;
    else buildScopedHashes[name] = record.hash;
  }

  const dtmMs = durationOf(run.stages, 'dtm');
  const contoursMs = durationOf(run.stages, 'contours');
  const analysisMs = sumOrNull([dtmMs, contoursMs]);
  const durations: RunDurations = {
    generateMs: durationOf(run.stages, 'generate'),
    rasterizeIsolatedMs: durationOf(run.stages, 'rasterize'),
    dtmMs,
    descriptorsIsolatedMs: durationOf(run.stages, 'descriptors'),
    contoursMs,
    scientificRecordMs: durationOf(run.stages, 'scientificRecord'),
    manifestMs: durationOf(run.stages, 'manifest'),
    analysisMs,
    // The driver's own answer, so the "never sum overlapping stages" rule is
    // obeyed by calling the exported function rather than by remembering it.
    pipelineTotalMs: pipelineDurationMs(run.stages),
    pointsPerSecond:
      analysisMs === null || analysisMs <= 0 ? null : (run.pointCount / analysisMs) * 1000,
  };

  const measuredPeaks = stages
    .map((s) => s.peakRssBytes)
    .filter((v): v is number => v !== null);
  const memory: RunMemory = {
    startRssBytes: options.startRssBytes,
    endRssBytes: options.endRssBytes,
    startHeapUsedBytes: options.startHeapUsedBytes,
    endHeapUsedBytes: options.endHeapUsedBytes,
    peakRssBytes: measuredPeaks.length === 0 ? null : Math.max(...measuredPeaks),
    peakRssUnavailableReason:
      measuredPeaks.length === 0
        ? 'no stage reported a peak RSS reading; process.memoryUsage() is not available in this runtime'
        : null,
    peakHeapBytes: null,
    peakHeapUnavailableReason: PEAK_HEAP_UNAVAILABLE_REASON,
    forcedGcAvailable: options.forcedGcAvailable,
  };

  const result = run.result;
  const dtmSummary = run.artifacts.dtmSummary;
  const recordContent = run.artifacts.scientificRecordContent ?? null;

  const cols = finiteOrNull(field(dtmSummary, 'cols'), 'dtm.cols', warnings);
  const rows = finiteOrNull(field(dtmSummary, 'rows'), 'dtm.rows', warnings);

  const scalars: RunScalars = {
    gridCols: cols,
    gridRows: rows,
    gridCellCount: cols === null || rows === null ? null : cols * rows,
    cellSizeM: finiteOrNull(field(dtmSummary, 'cellSizeM'), 'dtm.cellSizeM', warnings),
    elevationMinM: finiteOrNull(field(dtmSummary, 'minZ'), 'dtm.minZ', warnings),
    elevationMaxM: finiteOrNull(field(dtmSummary, 'maxZ'), 'dtm.maxZ', warnings),
    elevationRangeM: finiteOrNull(
      field(dtmSummary, 'elevationRangeM'),
      'dtm.elevationRangeM',
      warnings,
    ),
    meanConfidence: finiteOrNull(field(dtmSummary, 'meanConfidence'), 'dtm.meanConfidence', warnings),
    qualityScore: result === null ? null : finiteOrNull(result.qualityScore.score, 'qualityScore', warnings),
    qualityBand: result === null ? null : result.qualityScore.band,
    contourIntervalM: result === null ? null : finiteOrNull(result.intervalM, 'intervalM', warnings),
    contourLevelCount: result === null ? null : result.contours.levels.length,
    // The count a reader means by "contour count": the stitched polylines that
    // reach an export, not the raw marching-squares segments.
    contourPolylineCount:
      result === null ? null : result.stitched.reduce((n, l) => n + l.polylines.length, 0),
    contourFeatureCount: result === null ? null : result.model.features.length,
    contourLabelCount: result === null ? null : result.labels.length,
    sourcePointCount: finiteOrNull(
      field(dtmSummary, 'sourcePointCount'),
      'dtm.sourcePointCount',
      warnings,
    ),
    analyzedPointCount: finiteOrNull(
      field(dtmSummary, 'analyzedPointCount'),
      'dtm.analyzedPointCount',
      warnings,
    ),
    applicationContentHash: readString(field(recordContent, 'contentHash')),
  };

  for (const w of run.result?.warnings ?? []) warnings.push(`pipeline: ${w}`);

  return {
    index: options.index,
    datasetId: run.datasetId,
    seed: run.seed,
    requestedPointCount: run.pointCount,
    generatedPointCount: run.cloud?.pointCount ?? null,
    generationMs: durations.generateMs,
    stages,
    artifacts,
    scienceHashes,
    buildScopedHashes,
    missingArtifacts,
    durations,
    memory,
    scalars,
    complexitySummary: run.artifacts.descriptors ?? null,
    scientificRecordContent: recordContent,
    // The driver throws inside the `manifest` stage when the chain does not
    // verify, so an ok manifest stage IS the verification result — not a
    // separate boolean somebody has to remember to set.
    manifestVerified: stages.find((s) => s.name === 'manifest')?.status === 'ok',
    failedStages,
    warnings,
  };
}
