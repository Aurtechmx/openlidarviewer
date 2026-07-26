/**
 * series.ts
 *
 * The named numeric series a suite summarises, extracted from an observation.
 *
 * WHY THE SERIES ARE NAMED DATA RATHER THAN CODE PATHS. `benchmark:verify` has
 * to recompute every published median and IQR from `raw.json` and get bit-equal
 * answers. If the verifier reached into the run records with its own accessors
 * — "the median analysis duration is `runs[i].durations.analysisMs`" — then the
 * verifier and the suites would each hold half of the definition, and a suite
 * that started summarising a different field would still verify green. Instead
 * each run carries a flat `series` map, the summary keys off exactly those
 * names, and the verifier needs to know nothing about the pipeline at all.
 *
 * WHY THE KEYS ARE SPELLED OUT. `stage.dtm.durationMs`, `analysisMs`,
 * `pipelineTotalMs` and `stage.rasterize.durationMs` are FOUR different numbers
 * with three different meanings, and the last one overlaps the first. Naming
 * them apart, in the data, is what stops a downstream table adding two of them.
 */

import { NODE_STAGES, STAGE_ROLE } from '../pipeline/runPipeline';
import type { RunObservation } from './observe';

/** The suite-level series every run contributes to, beyond the per-stage ones. */
export const SERIES_ANALYSIS_MS = 'analysisMs';
export const SERIES_PIPELINE_TOTAL_MS = 'pipelineTotalMs';
export const SERIES_POINTS_PER_SECOND = 'pointsPerSecond';
export const SERIES_PEAK_RSS_BYTES = 'peakRssBytes';

/** The series key for one stage's duration. */
export function stageSeriesKey(stage: string): string {
  return `stage.${stage}.durationMs`;
}

/**
 * Human-readable meaning of a series key, written into every summary.
 *
 * Carried in the output rather than only here, because the one mistake this
 * whole module exists to prevent — treating an isolated leaf as part of the
 * total — is made by a reader looking at a table, not by a function.
 */
export function describeSeries(key: string): string {
  switch (key) {
    case SERIES_ANALYSIS_MS:
      return 'the application analysis proper: the dtm and contours stages, nothing else';
    case SERIES_PIPELINE_TOTAL_MS:
      return 'the non-overlapping pipeline total; the isolated leaves are deliberately excluded';
    case SERIES_POINTS_PER_SECOND:
      return 'points divided by the analysis duration';
    case SERIES_PEAK_RSS_BYTES:
      return 'largest stage-boundary RSS reading of the run; not a true mid-stage high-water mark';
    default:
      break;
  }
  for (const stage of NODE_STAGES) {
    if (key !== stageSeriesKey(stage)) continue;
    const role = STAGE_ROLE[stage];
    return role === 'isolated'
      ? `the ${stage} leaf timed on its own; it re-runs work the dtm stage also does, so it must never be added to a total`
      : `the ${stage} stage, a disjoint part of the pipeline total`;
  }
  return `series ${key}`;
}

/**
 * Every series a run can contribute, with the reason for any it could not.
 *
 * A key is present in `values` only when a real, finite measurement exists. A
 * key that could not be measured appears in `unavailable` with its reason and
 * in NEITHER map as a number — the whole point being that a summary computed
 * over nine of ten runs must be visibly a summary over nine.
 */
export interface RunSeries {
  readonly values: Readonly<Record<string, number>>;
  readonly unavailable: Readonly<Record<string, string>>;
}

export function seriesOf(observation: RunObservation): RunSeries {
  const values: Record<string, number> = {};
  const unavailable: Record<string, string> = {};

  const put = (key: string, value: number | null, reason: string): void => {
    if (value === null || !Number.isFinite(value)) unavailable[key] = reason;
    else values[key] = value;
  };

  for (const stage of observation.stages) {
    if (STAGE_ROLE[stage.name] === 'declared') continue;
    // A FAILED stage's duration is deliberately excluded from the series even
    // though the framework measured one. The number is real and it stays in the
    // run record — "it died after 40 s" is worth knowing — but it is the time a
    // failure took, not the time the stage takes, and a median mixing the two
    // would understate the stage while looking like a complete sample.
    put(
      stageSeriesKey(stage.name),
      stage.status === 'ok' ? stage.durationMs : null,
      stage.error ?? stage.durationUnavailableReason ?? 'no duration was recorded for this stage',
    );
  }

  const d = observation.durations;
  put(SERIES_ANALYSIS_MS, d.analysisMs, 'the dtm or contours stage did not complete');
  put(
    SERIES_PIPELINE_TOTAL_MS,
    d.pipelineTotalMs,
    'a pipeline-role stage did not complete, so the run has no total',
  );
  put(
    SERIES_POINTS_PER_SECOND,
    d.pointsPerSecond,
    'throughput needs a completed analysis with a non-zero duration',
  );
  put(
    SERIES_PEAK_RSS_BYTES,
    observation.memory.peakRssBytes,
    observation.memory.peakRssUnavailableReason ?? 'no RSS reading was taken',
  );

  return { values, unavailable };
}
