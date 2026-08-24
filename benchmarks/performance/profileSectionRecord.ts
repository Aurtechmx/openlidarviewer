/**
 * profileSectionRecord.ts
 *
 * The record a profile-section measurement writes, and the rules that keep it
 * from flattering itself. Sibling to `streamingNavRecord.ts`, and it inherits
 * that file's two load-bearing rules: a measurement that was not taken is
 * `unavailable` with a reason rather than a `0`, and a record names the
 * environment it was taken in so nobody pools two machines into one figure.
 *
 * It adds a third rule, because this harness exists to check STATED TARGETS
 * rather than to publish a curve. The targets are constants in this file
 * ({@link MAIN_THREAD_SLICE_TARGET_MS}, {@link FRAME_BUDGET_MS}), every
 * verdict is derived from a measurement by {@link recomputeVerdicts}, and
 * {@link validateProfileSectionRecord} REFUSES a record whose stored verdicts
 * disagree with that recomputation or whose thresholds are not the constants
 * above. The failure this guards against is not a typo. It is the ordinary
 * temptation, when a number comes in over the line, to move the line: a record
 * carrying a 240 ms measurement and a "met" verdict against a 250 ms threshold
 * is exactly what an honest harness has to make impossible to write down.
 *
 * Timings are summarised by {@link summariseSeries}, the project's one
 * implementation of every benchmark statistic, so an IQR here means what an
 * IQR means in the scaling ladder and `benchmark:verify`'s recomputation rule
 * applies unchanged. A second percentile function living here would have made
 * the two incomparable.
 *
 * Deliberately no timing and no I/O. The driver in
 * `tests/benchmark/profileSection.test.ts` owns the clock, the memory sampler
 * and the filesystem, and feeds this module plain numbers.
 *
 * Pure — no DOM, no `node:` builtin, no wall clock, no random source.
 */

import { QUANTILE_CONVENTION, summariseSeries, type SeriesSummary } from '../runner/stats';
import { measured, unavailable, type BenchmarkEnvironment, type Metric } from '../framework';

/**
 * The longest uninterrupted main-thread task an extraction may occupy.
 *
 * The stated target, unchanged: "no unbroken main-thread extraction task above
 * 100 ms on a typical dataset". 100 ms is the point past which a click stops
 * feeling connected to what follows it, so the number is a usability bound
 * rather than a rendering one.
 */
export const MAIN_THREAD_SLICE_TARGET_MS = 100;

/** Frames per second the frame budget is stated at. */
export const FRAME_BUDGET_HZ = 60;

/**
 * One frame's worth of main thread, ms.
 *
 * The stated target for hit-testing is "latency that stays inside a frame".
 * A hover is serviced inside the frame that observes the pointer, so the whole
 * of a frame is the ceiling and anything approaching it has already spent the
 * budget the rest of the frame needs.
 */
export const FRAME_BUDGET_MS = 1000 / FRAME_BUDGET_HZ;

/**
 * A timing series: a summarised sample, or unavailable with a reason.
 *
 * The raw values ride inside `summary.values` in run order, so every published
 * statistic can be recomputed from the record. A one-sample series is
 * representable and is not a lie — `summary.stdDev` is then null and
 * `summary.unavailable.stdDev` says why — but it is not a measurement either,
 * which is what {@link MIN_RECORDED_RUNS} is for.
 */
export type TimingSeries =
  | {
      readonly status: 'measured';
      readonly unit: 'ms';
      readonly runtime: 'node';
      readonly quantileConvention: string;
      readonly summary: SeriesSummary;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Below this many recorded runs a series states a number, not a measurement. */
export const MIN_RECORDED_RUNS = 3;

/** A reason shorter than this reads as a placeholder rather than an explanation. */
export const MIN_REASON_LENGTH = 20;

export function measuredTiming(values: readonly number[]): TimingSeries {
  return {
    status: 'measured',
    unit: 'ms',
    runtime: 'node',
    quantileConvention: QUANTILE_CONVENTION,
    summary: summariseSeries(values),
  };
}

export function unavailableTiming(reason: string): TimingSeries {
  return { status: 'unavailable', reason };
}

/** The corridor and the line one size was measured with. */
export interface ProfileSectionCorridor {
  /** Half-width actually walked, metres. */
  readonly halfWidthM: number;
  /** How that half-width was chosen, e.g. the module's own auto fraction. */
  readonly basis: string;
  /** Horizontal length of the section line, metres. */
  readonly lengthM: number;
}

/** One rung of the source-size ladder. */
export interface ProfileSectionSizeResult {
  /** Short id a table keys off, e.g. `10m`. */
  readonly sizeId: string;
  readonly sourcePoints: number;
  readonly sourceCount: number;
  /** Side of the square tile, metres. */
  readonly extentM: number;
  readonly corridor: ProfileSectionCorridor;

  /** Returns the corridor kept. */
  readonly acceptedPoints: number;
  /** Returns the scan looked at; below `sourcePoints` only if a slot was skipped. */
  readonly examinedPoints: number;
  /** Slots the bounds pre-test rejected without reading. */
  readonly skippedSlots: number;

  /** Points examined between generator yields. */
  readonly chunkSize: number;
  /** Yields the chunked run produced. */
  readonly chunkYields: number;

  /**
   * `extractProfileSection` wall time.
   *
   * This helper drives the generator to completion without returning to the
   * caller, so the whole of it is ONE uninterrupted main-thread task. The
   * number below is therefore both a throughput figure and a stall.
   */
  readonly wholeRunMs: TimingSeries;
  /** `extractProfileSectionChunks` driven to completion, end to end. */
  readonly chunkedTotalMs: TimingSeries;
  /** The longest single slice of the chunked run, one value per repeat. */
  readonly longestSliceMs: TimingSeries;
  /** Every slice of one recorded repeat, so the tail is visible. */
  readonly sliceMs: TimingSeries;
  /** Which repeat `sliceMs` came from, 1-based. */
  readonly sliceSampleRun: number;

  /** Peak process RSS above the pre-run baseline, bytes. */
  readonly peakRssDeltaBytes: Metric;
  /**
   * Peak live ArrayBuffer bytes above the pre-run baseline.
   *
   * The section is typed arrays, so its whole footprint is ArrayBuffer bytes
   * and this counter tracks it directly. RSS does not: a process already
   * holding the source buffers can satisfy the extraction out of pages it has
   * not returned, and then reports no growth at all for a transient that
   * genuinely occurred.
   */
  readonly peakArrayBufferDeltaBytes: Metric;
  /** How the two peaks were sampled, and what they can therefore miss. */
  readonly memoryBasis: string;
  /**
   * Whether a collection could actually be requested before the baseline.
   *
   * Kept apart from the record's `forcedGcRequested` for the reason
   * `gcMode.ts` sets out: a flag nobody honoured must not be publishable as a
   * controlled measurement. Without a collection the baseline still holds the
   * previous repeat's garbage, and the delta above it understates the
   * transient — sometimes to zero.
   */
  readonly forcedGcAvailable: boolean;
  /** Bytes the finished section arrays occupy, derived from the accepted count. */
  readonly sectionArrayBytes: Metric;
  /** Bytes the builder holds at its high-water mark, derived. See the driver. */
  readonly sectionTransientBytes: Metric;
  /** How the two derived figures above were arrived at. */
  readonly footprintBasis: string;
}

/** The display-side measurement: selection, index build, hover query. */
export interface ProfileSectionDisplayResult {
  /** Returns in the section the display path was measured over. */
  readonly sectionPoints: number;
  /** Which size the section came from. */
  readonly sizeId: string;
  /** Display cap the selection ran at. */
  readonly cap: number;
  /** Returns selected. Equals the cap unless the keep set overran it. */
  readonly selectedPoints: number;
  /** Where the cap came from, since no shipped constant states one. */
  readonly capBasis: string;

  /**
   * `selectProfileSectionLod` run to completion.
   *
   * That helper drives the selection generator without returning to its
   * caller, so the whole of it is ONE uninterrupted main-thread task, exactly
   * as `wholeRunMs` is for extraction.
   */
  readonly lodSelectMs: TimingSeries;
  /** Steps the selection takes between yields. */
  readonly lodChunkSize: number;
  /** Yields the chunked selection produced. */
  readonly lodChunkYields: number;
  /** `selectProfileSectionLodChunks` driven to completion, end to end. */
  readonly lodChunkedTotalMs: TimingSeries;
  /** The longest single slice of the chunked selection, one value per repeat. */
  readonly lodLongestSliceMs: TimingSeries;
  /** Every slice of one recorded repeat, so the tail is visible. */
  readonly lodSliceMs: TimingSeries;
  /** Which repeat `lodSliceMs` came from, 1-based. */
  readonly lodSliceSampleRun: number;

  readonly hitTestBuildMs: TimingSeries;
  /** One batch of `queriesPerBatch` hovers, per repeat. */
  readonly hitTestQueryBatchMs: TimingSeries;
  /**
   * Individual hover latencies from ONE recorded batch.
   *
   * One batch rather than all of them, for the same reason `sliceMs` publishes
   * one repeat: the raw values ride along so every statistic here can be
   * recomputed, and five batches of four thousand hovers would make the raw
   * values the artifact rather than its evidence. The repeat-to-repeat spread
   * lives in `hitTestQueryBatchMs`, which carries every batch total.
   */
  readonly hitTestQueryMs: TimingSeries;
  /** Which recorded batch `hitTestQueryMs` came from, 1-based. */
  readonly queryBatchSampleRun: number;

  readonly canvasWidthPx: number;
  readonly canvasHeightPx: number;
  readonly hoverRadiusPx: number;
  readonly cellSizePx: number;
  readonly queriesPerBatch: number;
  /** Displayed points the index could place on the canvas. */
  readonly liveCount: number;
  /** Displayed points left out: off-canvas or non-finite projection. */
  readonly skippedCount: number;
  /** Hovers that found a point. A run of misses would make the timing hollow. */
  readonly hits: number;
}

/** One stated target, the measurement put against it, and the verdict. */
export interface TargetVerdict {
  /** Stable id, so a reader can follow one verdict across records. */
  readonly id: string;
  /** The target as stated, in words. */
  readonly target: string;
  readonly thresholdMs: number;
  /** What was measured, and where. */
  readonly observedMs: number;
  readonly observedAt: string;
  readonly met: boolean;
}

/** A whole profile-section measurement. */
export interface ProfileSectionRecord {
  readonly schemaVersion: 1;
  readonly label: string;
  /** Git revision the modules under measurement were read at. */
  readonly revision: string;
  /** ISO timestamp — provenance only, never hashed. */
  readonly generatedAt: string;
  readonly environment: BenchmarkEnvironment;
  /** The point generator, named in full. */
  readonly generator: string;
  /** Warm-up runs discarded before recording began. */
  readonly warmupRuns: number;
  /** Runs recorded per series. */
  readonly recordedRuns: number;
  /** Whether the run ASKED for `--expose-gc`. What it got is per size. */
  readonly forcedGcRequested: boolean;

  readonly sizes: readonly ProfileSectionSizeResult[];
  /**
   * One entry per size whose section overran the display cap.
   *
   * A list rather than a single block because selection cost follows the
   * SECTION size, not the cap: measured at one section it is a number, and
   * measured across the ladder it says where the cost crosses a target.
   * Empty when no section reached the cap.
   */
  readonly displays: readonly ProfileSectionDisplayResult[];
  /** Sizes asked for that this machine could not run, with the reason. */
  readonly notRun: readonly { readonly sizeId: string; readonly reason: string }[];
  readonly verdicts: readonly TargetVerdict[];
  /** Caveats that travel with the numbers. */
  readonly notes: readonly string[];
}

/** Why a record was refused. */
export type ProfileRecordProblem =
  | 'missing-revision'
  | 'unavailable-without-reason'
  | 'measured-without-samples'
  | 'too-few-recorded-runs'
  | 'negative-sample'
  | 'accepted-exceeds-examined'
  | 'verdicts-disagree-with-measurements'
  | 'threshold-is-not-the-stated-target'
  | 'no-sizes-measured';

function checkTiming(series: TimingSeries, problems: ProfileRecordProblem[]): void {
  if (series.status === 'unavailable') {
    if (series.reason.length < MIN_REASON_LENGTH) problems.push('unavailable-without-reason');
    return;
  }
  const values = series.summary.values;
  if (values.length === 0) problems.push('measured-without-samples');
  if (values.some((v) => v < 0)) problems.push('negative-sample');
}

/**
 * Derive every verdict from the measurements.
 *
 * The only place a target is compared with a number. The driver calls it to
 * fill the record and the validator calls it again to check the record, so a
 * verdict written by hand — or a threshold quietly widened until a
 * measurement fits — cannot survive.
 */
export function recomputeVerdicts(
  sizes: readonly ProfileSectionSizeResult[],
  displays: readonly ProfileSectionDisplayResult[],
): TargetVerdict[] {
  const out: TargetVerdict[] = [];
  const sliceTarget =
    'no unbroken main-thread extraction task above 100 ms on a typical dataset';
  const frameTarget = 'hit-test latency that stays inside a frame';

  for (const size of sizes) {
    if (size.longestSliceMs.status === 'measured') {
      const worst = size.longestSliceMs.summary.max;
      out.push({
        id: `chunked-slice-${size.sizeId}`,
        target: sliceTarget,
        thresholdMs: MAIN_THREAD_SLICE_TARGET_MS,
        observedMs: worst,
        observedAt: `longest generator slice at ${size.sizeId}, chunk ${size.chunkSize}`,
        met: worst <= MAIN_THREAD_SLICE_TARGET_MS,
      });
    }
    if (size.wholeRunMs.status === 'measured') {
      // `extractProfileSection` never yields, so its whole duration is one
      // task. Judged against the same target as a chunk, because the target
      // is about the thread and not about which helper was called.
      const worst = size.wholeRunMs.summary.max;
      out.push({
        id: `whole-run-${size.sizeId}`,
        target: sliceTarget,
        thresholdMs: MAIN_THREAD_SLICE_TARGET_MS,
        observedMs: worst,
        observedAt: `extractProfileSection run to completion at ${size.sizeId}`,
        met: worst <= MAIN_THREAD_SLICE_TARGET_MS,
      });
    }
  }

  for (const display of displays) {
    if (display.lodSelectMs.status === 'measured') {
      // The stated target names EXTRACTION. Selection is the stage next to it
      // on the same thread, so the same 100 ms is applied to it here — the
      // bound is unchanged, only the stage it is read against is stated
      // openly. See the record's notes.
      const worst = display.lodSelectMs.summary.max;
      out.push({
        id: `lod-select-${display.sizeId}`,
        target: `${sliceTarget} (applied to selection, which the target does not name)`,
        thresholdMs: MAIN_THREAD_SLICE_TARGET_MS,
        observedMs: worst,
        observedAt: `selectProfileSectionLod at cap ${display.cap} over ${display.sectionPoints} returns`,
        met: worst <= MAIN_THREAD_SLICE_TARGET_MS,
      });
    }
    if (display.lodLongestSliceMs.status === 'measured') {
      const worst = display.lodLongestSliceMs.summary.max;
      out.push({
        id: `lod-select-slice-${display.sizeId}`,
        target: `${sliceTarget} (applied to selection, which the target does not name)`,
        thresholdMs: MAIN_THREAD_SLICE_TARGET_MS,
        observedMs: worst,
        observedAt: `longest selection slice at cap ${display.cap} over ${display.sectionPoints} returns, chunk ${display.lodChunkSize}`,
        met: worst <= MAIN_THREAD_SLICE_TARGET_MS,
      });
    }
    if (display.hitTestQueryMs.status === 'measured') {
      const worst = display.hitTestQueryMs.summary.max;
      out.push({
        id: `hit-test-query-${display.sizeId}`,
        target: frameTarget,
        thresholdMs: FRAME_BUDGET_MS,
        observedMs: worst,
        observedAt: `slowest of ${display.hitTestQueryMs.summary.count} hovers at ${display.selectedPoints} displayed points`,
        met: worst <= FRAME_BUDGET_MS,
      });
    }
    if (display.hitTestBuildMs.status === 'measured') {
      // The build is not per-hover, but it runs on the same thread and a
      // build over the frame budget is a dropped frame wherever it lands.
      const worst = display.hitTestBuildMs.summary.max;
      out.push({
        id: `hit-test-build-${display.sizeId}`,
        target: frameTarget,
        thresholdMs: FRAME_BUDGET_MS,
        observedMs: worst,
        observedAt: `index build over ${display.selectedPoints} displayed points`,
        met: worst <= FRAME_BUDGET_MS,
      });
    }
  }
  return out;
}

/** Whether two verdict lists are the same claim, field for field. */
function verdictsMatch(a: readonly TargetVerdict[], b: readonly TargetVerdict[]): boolean {
  if (a.length !== b.length) return false;
  for (const [i, x] of a.entries()) {
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.target !== y.target ||
      x.thresholdMs !== y.thresholdMs ||
      x.observedMs !== y.observedMs ||
      x.observedAt !== y.observedAt ||
      x.met !== y.met
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Refuse a record that cannot support the reading it invites.
 *
 * The last two problems are the teeth. A record whose verdicts do not follow
 * from its own numbers, or whose thresholds are not the stated targets, is
 * rejected outright rather than published with a footnote.
 */
export function validateProfileSectionRecord(rec: ProfileSectionRecord): ProfileRecordProblem[] {
  const problems: ProfileRecordProblem[] = [];
  if (!rec.revision) problems.push('missing-revision');
  if (rec.sizes.length === 0) problems.push('no-sizes-measured');

  for (const size of rec.sizes) {
    for (const series of [
      size.wholeRunMs,
      size.chunkedTotalMs,
      size.longestSliceMs,
      size.sliceMs,
    ] as const) {
      checkTiming(series, problems);
    }
    if (size.longestSliceMs.status === 'measured') {
      if (size.longestSliceMs.summary.count < MIN_RECORDED_RUNS) {
        problems.push('too-few-recorded-runs');
      }
    }
    if (size.acceptedPoints > size.examinedPoints) problems.push('accepted-exceeds-examined');
  }

  for (const display of rec.displays) {
    for (const series of [
      display.lodSelectMs,
      display.lodChunkedTotalMs,
      display.lodLongestSliceMs,
      display.lodSliceMs,
      display.hitTestBuildMs,
      display.hitTestQueryBatchMs,
      display.hitTestQueryMs,
    ] as const) {
      checkTiming(series, problems);
    }
    if (display.lodLongestSliceMs.status === 'measured') {
      if (display.lodLongestSliceMs.summary.count < MIN_RECORDED_RUNS) {
        problems.push('too-few-recorded-runs');
      }
    }
  }

  for (const v of rec.verdicts) {
    const expected =
      v.thresholdMs === MAIN_THREAD_SLICE_TARGET_MS || v.thresholdMs === FRAME_BUDGET_MS;
    if (!expected) problems.push('threshold-is-not-the-stated-target');
  }
  if (!verdictsMatch(rec.verdicts, recomputeVerdicts(rec.sizes, rec.displays))) {
    problems.push('verdicts-disagree-with-measurements');
  }
  return problems;
}

/**
 * Bytes the finished section arrays hold per accepted return.
 *
 * chainage 4 + height 8 + lateral offset 4 + source slot 2 + point index 4 +
 * channel presence 1, plus the two channels the fixture carries: intensity 2
 * and classification 1. The optional channels no source carries are absent
 * from the finished section rather than present and zero, so they contribute
 * nothing here.
 */
export const SECTION_BYTES_PER_POINT = 4 + 8 + 4 + 2 + 4 + 1 + 2 + 1;

/**
 * The builder's per-point storage, including the lanes `finish()` may drop.
 *
 * The builder carries every attribute lane whether or not a source supplied
 * it, rgb and normals at three entries per point, and the finished section
 * then drops the ones nobody carried. So its per-point cost is well above
 * {@link SECTION_BYTES_PER_POINT}.
 */
export const BUILDER_BYTES_PER_POINT =
  4 + 8 + 4 + 2 + 4 + 1 + 3 * 1 + 2 + 1 + 1 + 1 + 2 + 8 + 3 * 4;

/** Derived section footprint, as a measured metric with its basis stated. */
export function sectionArrayBytes(acceptedPoints: number): Metric {
  if (!Number.isFinite(acceptedPoints) || acceptedPoints < 0) {
    return unavailable('the accepted count was not a finite non-negative number', {
      runtime: 'node',
      deterministic: true,
    });
  }
  return measured(acceptedPoints * SECTION_BYTES_PER_POINT, 'bytes', {
    runtime: 'node',
    // Derived from the accepted count and the array widths, so it repeats
    // exactly wherever the same section is extracted.
    deterministic: true,
  });
}

/**
 * Derived builder high-water mark, as a measured metric.
 *
 * Storage grows by doubling, so the grown lanes hold the next power of two at
 * or above the accepted count, and `finish()` copies out arrays sized to the
 * accepted count while the grown lanes are still live. The sum of the two is
 * the moment the extraction is at its largest.
 */
export function sectionTransientBytes(acceptedPoints: number): Metric {
  if (!Number.isFinite(acceptedPoints) || acceptedPoints < 0) {
    return unavailable('the accepted count was not a finite non-negative number', {
      runtime: 'node',
      deterministic: true,
    });
  }
  const grown = 2 ** Math.ceil(Math.log2(Math.max(1024, acceptedPoints)));
  return measured(grown * BUILDER_BYTES_PER_POINT + acceptedPoints * SECTION_BYTES_PER_POINT, 'bytes', {
    runtime: 'node',
    deterministic: true,
  });
}
