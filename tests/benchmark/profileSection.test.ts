/**
 * profileSection.test.ts — the profile-section measurement harness.
 *
 * WHAT THIS IS. A measurement, not a change. It drives the real
 * `extractProfileSection` / `extractProfileSectionChunks`,
 * `selectProfileSectionLod` and `profileHitTest` over a deterministic scene
 * shaped the way the section seam hands one over, and puts the numbers against
 * the two targets the profile section was written to: no unbroken main-thread
 * extraction task above 100 ms, and hit-test latency inside a frame. Nothing
 * under `src/` is touched. Every seam used here is one the viewer already
 * calls.
 *
 * WHY THE CHUNKED PATH IS MEASURED SLICE BY SLICE. The extractor is a
 * generator that yields every `chunkSize` points, and the target is about the
 * longest UNINTERRUPTED task, not the total. Total wall time says nothing
 * about whether the thread was ever handed back. So the harness times each
 * `next()` call on its own: one slice is exactly one uninterrupted task, and
 * the largest of them is the number the target speaks about. The final
 * `next()` is timed with the rest because it carries `finish()`, the copy-out
 * that sizes the section arrays — the single largest allocation the
 * extraction makes, and a stall like any other.
 *
 * WHY `extractProfileSection` IS REPORTED SEPARATELY. That helper drives the
 * generator to completion without returning to its caller, so the whole of it
 * is one uninterrupted task. Reporting only the chunked slices would hide the
 * fact that the convenience wrapper cannot satisfy the target at any size
 * where the work takes longer than the target allows.
 *
 * WHAT THIS RUNTIME CANNOT SEE. Wall-clock numbers here are this machine's.
 * They are a property of the CPU, the Node build and the load at the time, not
 * of the software, and they will differ elsewhere; the environment block
 * travels with the record so nobody pools two machines into one figure.
 *
 * Peak memory is sampled at the generator's own yield points, so a spike that
 * begins and ends inside one slice is not observed and the derived footprint
 * alongside it is what covers that case. Two counters are read, not one:
 * process RSS is the process-level truth and reads zero wherever the transient
 * fitted in pages the process had not returned, while live ArrayBuffer bytes
 * follow the section arrays themselves. Both are deltas above a
 * post-collection baseline, and `benchmark:profile-section:gc` is the run that
 * can actually take one.
 *
 * DRIFT GUARD. The always-on test runs a small scene through the same code,
 * asserts the harness actually extracted something, and proves the record
 * validator refuses a verdict that does not follow from its own measurement.
 * Set `PROFILE_SECTION_WRITE=1` to run the full size ladder and write
 * `docs/validation/profile-section-baseline.json`.
 */

import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateProfileSectionCloud,
  profileSectionLine,
  r4,
  PROFILE_CLOUD_GENERATOR,
  type ProfileSectionCloud,
} from '../../benchmarks/fixtures/profileSectionCloud';
import { captureEnvironment } from '../../benchmarks/framework/env';
import { forcedGcRequested } from '../../benchmarks/runner/gcMode';
import {
  elapsedMs,
  isMeasured,
  readMonotonicNs,
  readProcessRss,
  startMemorySampler,
  measured,
  unavailable,
  type Metric,
} from '../../benchmarks/framework';
import {
  measuredTiming,
  recomputeVerdicts,
  sectionArrayBytes,
  sectionTransientBytes,
  validateProfileSectionRecord,
  FRAME_BUDGET_MS,
  MAIN_THREAD_SLICE_TARGET_MS,
  type ProfileSectionDisplayResult,
  type ProfileSectionRecord,
  type ProfileSectionSizeResult,
} from '../../benchmarks/performance/profileSectionRecord';

import { buildProfileFrame, type ProfileFrame } from '../../src/render/measure/profileGeometry';
import { resolveCorridorHalfWidth } from '../../src/render/measure/profileCorridor';
import { AUTO_CORRIDOR_FRACTION } from '../../src/render/measure/profileSampler';
import {
  extractProfileSection,
  extractProfileSectionChunks,
  type ProfileSectionExtractResult,
  type ProfileSectionSourceView,
} from '../../src/render/measure/profileSectionExtract';
import type { ProfileSectionPoints } from '../../src/render/measure/profileSectionBuilder';
import { selectProfileSectionLod } from '../../src/render/measure/profileSectionLod';
import {
  buildProfileHitTestIndex,
  queryProfileHitTest,
  type ProfileAffineProjection,
  type ProfileHitTestIndex,
} from '../../src/render/measure/profileHitTest';
import type { Vec3 } from '../../src/render/navMath';

/** The scene's up axis. A Z-up survey tile, so a section cuts along Z. */
const WORLD_UP: Vec3 = [0, 0, 1];

/** Sources the returns are dealt across, as a scene with a few layers has. */
const SOURCE_COUNT = 4;

/** Runs discarded before recording, so a series is not a JIT transcript. */
const WARMUP_RUNS = 1;
/** Runs recorded per series. Enough for a spread; a single sample is not one. */
const RECORDED_RUNS = 5;

/** The size ladder, in source points. */
const LADDER: ReadonlyArray<{ readonly id: string; readonly pointCount: number }> = [
  { id: '1m', pointCount: 1_000_000 },
  { id: '5m', pointCount: 5_000_000 },
  { id: '10m', pointCount: 10_000_000 },
  { id: '25m', pointCount: 25_000_000 },
];

/**
 * The display cap the selection is measured at.
 *
 * No module on this revision states one: `selectProfileSectionLod` takes the
 * cap from its caller and nothing in `src/` calls it yet. 200,000 is the
 * figure the hit-test suite already treats as a full display, and the LOD
 * module's own header calls a quarter of a million "already past what the
 * section view draws" — so this sits just inside the largest display the
 * module anticipates, which is where a selection is slowest.
 */
const DISPLAY_CAP = 200_000;
const CAP_BASIS =
  'no shipped constant states a display cap on this revision; 200,000 is the displayed count ' +
  'tests/profileHitTest.test.ts measures its query cost at, and sits just under the quarter of a ' +
  'million profileSectionLod.ts names as past what the section view draws';

/** The chart the hit-test index is built over. Matches the shipped cost test. */
const CANVAS_W = 960;
const CANVAS_H = 420;
const CANVAS_MARGIN = 30;
/** Hover radius in pixels, and hovers per timed batch. */
const HOVER_RADIUS_PX = 8;
const QUERIES_PER_BATCH = 4_000;

/**
 * A duration from two monotonic readings, or a thrown failure.
 *
 * Quantised to nanoseconds, which is the clock's own resolution: the readings
 * are whole nanosecond counts and the millisecond conversion is what grows the
 * trailing digits. Rounding them back off loses nothing a reading contained,
 * and it happens BEFORE the values are summarised, so every published
 * statistic is still recomputable from the raw values the record carries.
 * Untouched, a hover latency serialises at twenty digits, none of which the
 * clock measured.
 */
function msBetween(startNs: bigint | null, endNs: bigint | null): number {
  const metric = elapsedMs(startNs, endNs);
  if (!isMeasured(metric)) throw new Error(metric.reason);
  return Number(metric.value.toFixed(6));
}

/**
 * Source views over the fixture, built the way the seam builds them: the
 * placement is resolved once as a float64 offset and added per read, and the
 * source buffer is never copied.
 */
function viewsOf(cloud: ProfileSectionCloud): ProfileSectionSourceView[] {
  return cloud.sources.map((source) => {
    const positions = source.positions;
    const [dx, dy, dz] = source.offset;
    return {
      slot: source.slot,
      pointCount: source.pointCount,
      channels: { classification: source.classification, intensity: source.intensity },
      bounds: source.bounds,
      readProjectXYZ(index: number, out: Float64Array): void {
        const base = index * 3;
        out[0] = positions[base]! + dx;
        out[1] = positions[base + 1]! + dy;
        out[2] = positions[base + 2]! + dz;
      },
    };
  });
}

/** The frame and corridor half-width a default section over this cloud walks. */
function corridorOf(cloud: ProfileSectionCloud): { frame: ProfileFrame; band: number } {
  const line = profileSectionLine(cloud);
  const frame = buildProfileFrame(line.a as Vec3, line.b as Vec3, WORLD_UP);
  // The width a caller gets by passing no width at all: the sampler's own
  // automatic fraction of the section length, so the corridor measured here
  // is the corridor a user opens by default.
  const band = resolveCorridorHalfWidth(frame.horizontalLength, null, AUTO_CORRIDOR_FRACTION);
  return { frame, band };
}

/**
 * Live ArrayBuffer bytes, or null where the runtime does not report them.
 *
 * The section is typed arrays throughout, so this counter is the one that
 * moves with the extraction. It is fed to the framework's peak sampler through
 * the reader seam that module already exposes, rather than by growing a second
 * high-water tracker beside it.
 */
function readArrayBufferBytes(): number | null {
  const usage = (globalThis as { process?: { memoryUsage?: () => { arrayBuffers: number } } })
    .process?.memoryUsage;
  if (typeof usage !== 'function') return null;
  try {
    const value = usage().arrayBuffers;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** A peak reading above a baseline, or unavailable with the reason. */
function peakAbove(peak: Metric, baseline: number | null, counter: string): Metric {
  if (!isMeasured(peak) || baseline === null) {
    return unavailable(
      `${counter} is not readable in this runtime, so no high-water mark could be taken`,
      { runtime: 'node', deterministic: false },
    );
  }
  // Clamped at zero: a counter can fall across a run when the collector
  // returns memory, and a negative "peak above baseline" is not a quantity.
  return measured(Math.max(0, peak.value - baseline), 'bytes', {
    runtime: 'node',
    deterministic: false,
  });
}

/**
 * Ask the runtime to collect, and report whether it could.
 *
 * `global.gc` exists only under `--expose-gc`, which the ordinary vitest
 * invocation does not pass; `benchmark:profile-section:gc` asks for it. The
 * attempt is made either way and the outcome is recorded, because a run
 * without a collection is still a valid run whose memory baseline carries the
 * previous repeat's garbage. That is a caveat a reader can weigh. A harness
 * that refused to start is not.
 */
function releaseMemory(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') return false;
  try {
    gc();
    return true;
  } catch {
    return false;
  }
}

/** One chunked run, sliced. */
interface ChunkedRun {
  readonly result: ProfileSectionExtractResult;
  readonly totalMs: number;
  /** One entry per `next()` call, including the final one that carries finish(). */
  readonly sliceMs: readonly number[];
  /** Peak RSS above the pre-run baseline, or unavailable with the reason. */
  readonly peakRssDeltaBytes: Metric;
  /** Peak live ArrayBuffer bytes above the pre-run baseline. */
  readonly peakArrayBufferDeltaBytes: Metric;
  /** Whether a collection was actually possible before the baseline was read. */
  readonly forcedGcAvailable: boolean;
}

/**
 * Drive the generator by hand, timing every `next()`.
 *
 * The clock is read immediately before and after each call and the readings
 * are stored raw, so the arithmetic and the array growth both land in the gap
 * between two slices rather than inside a measured one.
 */
function runChunked(
  frame: ProfileFrame,
  band: number,
  sources: readonly ProfileSectionSourceView[],
): ChunkedRun {
  // Collect first, so the baseline is a post-collection floor rather than the
  // previous repeat's high-water mark. Without this the delta at the large
  // sizes reads near zero: the baseline already contains what the run is about
  // to allocate again.
  const forcedGcAvailable = releaseMemory();
  const rssBaseline = readProcessRss();
  const bufferBaseline = readArrayBufferBytes();
  // Both samplers have their background timer switched off. A synchronous
  // stage blocks the event loop, so an interval could not fire inside one;
  // the generator's own yields are the only points a reading can be taken.
  const rss = startMemorySampler({ intervalMs: 0 });
  const buffers = startMemorySampler({ intervalMs: 0, readRss: readArrayBufferBytes });
  const iterator = extractProfileSectionChunks({ frame, band, sources });

  const starts: (bigint | null)[] = [];
  const ends: (bigint | null)[] = [];
  let result: ProfileSectionExtractResult | null = null;
  for (;;) {
    const from = readMonotonicNs();
    const step = iterator.next();
    const to = readMonotonicNs();
    starts.push(from);
    ends.push(to);
    if (step.done) {
      result = step.value;
      break;
    }
    rss.sample();
    buffers.sample();
  }
  // Stopped immediately after the final next() returned, so the reading is
  // taken while the builder's grown lanes and the arrays finish() copied out
  // of them are both still live — the moment the extraction is largest.
  const rssPeak = rss.stop();
  const bufferPeak = buffers.stop();

  const sliceMs = starts.map((from, i) => msBetween(from, ends[i]!));
  const totalMs = msBetween(starts[0]!, ends[ends.length - 1]!);

  return {
    result: result!,
    totalMs,
    sliceMs,
    peakRssDeltaBytes: peakAbove(rssPeak, rssBaseline, 'process RSS'),
    peakArrayBufferDeltaBytes: peakAbove(bufferPeak, bufferBaseline, 'live ArrayBuffer bytes'),
    forcedGcAvailable,
  };
}

/** Measure one rung of the ladder. */
function measureSize(
  sizeId: string,
  pointCount: number,
): { size: ProfileSectionSizeResult; section: ProfileSectionPoints } {
  const cloud = generateProfileSectionCloud({ pointCount, sourceCount: SOURCE_COUNT });
  const sources = viewsOf(cloud);
  const { frame, band } = corridorOf(cloud);

  for (let w = 0; w < WARMUP_RUNS; w++) {
    extractProfileSection({ frame, band, sources });
    runChunked(frame, band, sources);
  }

  const wholeRunMs: number[] = [];
  let wholeRunResult: ProfileSectionExtractResult | null = null;
  for (let r = 0; r < RECORDED_RUNS; r++) {
    const from = readMonotonicNs();
    const out = extractProfileSection({ frame, band, sources });
    const to = readMonotonicNs();
    wholeRunMs.push(msBetween(from, to));
    wholeRunResult = out;
  }

  const chunkedTotalMs: number[] = [];
  const longestSliceMs: number[] = [];
  let lastRun: ChunkedRun | null = null;
  for (let r = 0; r < RECORDED_RUNS; r++) {
    const run = runChunked(frame, band, sources);
    chunkedTotalMs.push(run.totalMs);
    longestSliceMs.push(Math.max(...run.sliceMs));
    lastRun = run;
  }

  const run = lastRun!;
  const accepted = run.result.points.count;
  const size: ProfileSectionSizeResult = {
    sizeId,
    sourcePoints: pointCount,
    sourceCount: cloud.sources.length,
    extentM: cloud.extentM,
    corridor: {
      halfWidthM: band,
      basis: `resolveCorridorHalfWidth with no supplied width: AUTO_CORRIDOR_FRACTION (${AUTO_CORRIDOR_FRACTION}) of the section length`,
      lengthM: frame.horizontalLength,
    },
    acceptedPoints: accepted,
    examinedPoints: run.result.examined,
    skippedSlots: run.result.skippedSlots.length,
    // The default the extractor applies when a caller states none, which is
    // what the seam does.
    chunkSize: 65_536,
    chunkYields: run.sliceMs.length - 1,
    wholeRunMs: measuredTiming(wholeRunMs),
    chunkedTotalMs: measuredTiming(chunkedTotalMs),
    longestSliceMs: measuredTiming(longestSliceMs),
    sliceMs: measuredTiming(run.sliceMs),
    sliceSampleRun: RECORDED_RUNS,
    peakRssDeltaBytes: run.peakRssDeltaBytes,
    peakArrayBufferDeltaBytes: run.peakArrayBufferDeltaBytes,
    forcedGcAvailable: run.forcedGcAvailable,
    memoryBasis:
      'both counters sampled at every generator yield (one reading per chunk) plus one immediately ' +
      'after the final next(), minus the reading taken just before the run; a spike that begins and ' +
      'ends inside a single chunk is not observed. RSS can read 0 here and often does: a process ' +
      'already holding the source buffers satisfies the extraction out of pages it has not returned, ' +
      'so the ArrayBuffer counter is the one that follows the section. A collection is requested ' +
      'before the baseline; whether it was possible is recorded as forcedGcAvailable, and a false ' +
      'there means the baseline still held the previous repeat\u2019s garbage',
    sectionArrayBytes: sectionArrayBytes(accepted),
    sectionTransientBytes: sectionTransientBytes(accepted),
    footprintBasis:
      'derived from the accepted count and the builder array widths, not sampled: the finished ' +
      'section arrays, and the builder storage plus the copy-out that are both live during finish()',
  };
  // The whole-run helper and the chunked walk read the sources in the same
  // order, so they must accept the same returns. A disagreement would mean
  // the two columns describe different work.
  if (wholeRunResult!.points.count !== accepted) {
    throw new Error(
      `the two extraction paths disagreed at ${sizeId}: ${wholeRunResult!.points.count} vs ${accepted}`,
    );
  }
  return { size, section: run.result.points };
}

/** An affine chart transform that fits a section's selected returns to the canvas. */
function projectionFor(
  section: ProfileSectionPoints,
  displayed: Uint32Array,
): ProfileAffineProjection {
  let minChain = Infinity;
  let maxChain = -Infinity;
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let k = 0; k < displayed.length; k++) {
    const i = displayed[k]!;
    const c = section.chainage[i]!;
    const h = section.height[i]!;
    if (c < minChain) minChain = c;
    if (c > maxChain) maxChain = c;
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  const chainSpan = maxChain > minChain ? maxChain - minChain : 1;
  const heightSpan = maxHeight > minHeight ? maxHeight - minHeight : 1;
  return {
    chainageAtOrigin: minChain,
    heightAtOrigin: minHeight,
    originXPx: CANVAS_MARGIN,
    originYPx: CANVAS_H - CANVAS_MARGIN,
    pxPerChainage: (CANVAS_W - 2 * CANVAS_MARGIN) / chainSpan,
    pxPerHeight: (CANVAS_H - 2 * CANVAS_MARGIN) / heightSpan,
  };
}

/** One batch of hovers, timed individually. */
function queryBatch(
  index: ProfileHitTestIndex,
): { batchMs: number; queryMs: number[]; hits: number } {
  const starts: (bigint | null)[] = [];
  const ends: (bigint | null)[] = [];
  let hits = 0;
  const batchFrom = readMonotonicNs();
  for (let k = 1; k <= QUERIES_PER_BATCH; k++) {
    // Hover positions from the same low-discrepancy generator the scene came
    // from, so the pointer sweeps the canvas evenly instead of clustering.
    const x = r4(0, k) * CANVAS_W;
    const y = r4(1, k) * CANVAS_H;
    const from = readMonotonicNs();
    const found = queryProfileHitTest(index, x, y, HOVER_RADIUS_PX);
    const to = readMonotonicNs();
    starts.push(from);
    ends.push(to);
    if (found !== null) hits++;
  }
  const batchTo = readMonotonicNs();
  return {
    batchMs: msBetween(batchFrom, batchTo),
    queryMs: starts.map((from, i) => msBetween(from, ends[i]!)),
    hits,
  };
}

/** Measure selection, index build and hover query over one section. */
function measureDisplay(
  sizeId: string,
  section: ProfileSectionPoints,
): ProfileSectionDisplayResult {
  for (let w = 0; w < WARMUP_RUNS; w++) {
    const warm = selectProfileSectionLod(section, { cap: DISPLAY_CAP });
    const index = buildProfileHitTestIndex({
      section,
      displayed: warm,
      projection: projectionFor(section, warm),
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    queryBatch(index);
  }

  const lodSelectMs: number[] = [];
  let displayed: Uint32Array | null = null;
  for (let r = 0; r < RECORDED_RUNS; r++) {
    const from = readMonotonicNs();
    const selected = selectProfileSectionLod(section, { cap: DISPLAY_CAP });
    const to = readMonotonicNs();
    lodSelectMs.push(msBetween(from, to));
    displayed = selected;
  }

  const selection = displayed!;
  const projection = projectionFor(section, selection);
  const buildMs: number[] = [];
  let index: ProfileHitTestIndex | null = null;
  for (let r = 0; r < RECORDED_RUNS; r++) {
    const from = readMonotonicNs();
    const built = buildProfileHitTestIndex({
      section,
      displayed: selection,
      projection,
      widthPx: CANVAS_W,
      heightPx: CANVAS_H,
    });
    const to = readMonotonicNs();
    buildMs.push(msBetween(from, to));
    index = built;
  }

  const batchMs: number[] = [];
  let sampleQueryMs: readonly number[] = [];
  let hits = 0;
  for (let r = 0; r < RECORDED_RUNS; r++) {
    const batch = queryBatch(index!);
    batchMs.push(batch.batchMs);
    // The last recorded batch's individual latencies. See the record's field
    // doc for why one batch and not all of them.
    sampleQueryMs = batch.queryMs;
    hits += batch.hits;
  }

  return {
    sectionPoints: section.count,
    sizeId,
    cap: DISPLAY_CAP,
    selectedPoints: selection.length,
    capBasis: CAP_BASIS,
    lodSelectMs: measuredTiming(lodSelectMs),
    hitTestBuildMs: measuredTiming(buildMs),
    hitTestQueryBatchMs: measuredTiming(batchMs),
    hitTestQueryMs: measuredTiming(sampleQueryMs),
    queryBatchSampleRun: RECORDED_RUNS,
    canvasWidthPx: CANVAS_W,
    canvasHeightPx: CANVAS_H,
    hoverRadiusPx: HOVER_RADIUS_PX,
    cellSizePx: index!.cellSizePx,
    queriesPerBatch: QUERIES_PER_BATCH,
    liveCount: index!.liveCount,
    skippedCount: index!.skippedCount,
    hits,
  };
}

/** The short git revision, or a clearly-marked fallback. */
function gitRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown-revision';
  }
}

const NOTES: readonly string[] = [
  'Wall-clock on the machine named in `environment`, under the Node build named there. These durations are a property of that host and will differ elsewhere; the counts, the accepted totals and the derived footprints are not.',
  'extractProfileSection drives the generator to completion without returning to its caller, so its whole duration is one uninterrupted main-thread task. It is judged against the same 100 ms target as a single chunk.',
  'The chunked slices include the final next(), which carries builder.finish() — the copy-out that sizes the section arrays, and the largest single allocation an extraction makes.',
  'The corridor half-width is the one a caller gets by supplying no width: AUTO_CORRIDOR_FRACTION of the section length. The accepted count therefore grows with the tile, and is not a fixed fraction of the source.',
  'Every source spans the whole tile, so the bounds pre-test skips nothing and every source point is examined. A spatially tiled scene would let the pre-test reject most of the scan.',
  'No module on this revision states a display cap; selectProfileSectionLod takes it from its caller and src/ does not yet call it. The cap measured here is stated in `display.capBasis`.',
  'The stated 100 ms target names extraction. The `lod-select` verdict applies that same number, unchanged, to selectProfileSectionLod: the stage next to extraction on the same thread, and the one stage in the section path with no yield seam at all. The threshold was not moved, only the stage it is read against.',
  'The environment block reports a dirty working tree at capture. What differed from the named revision was this harness, its fixture and this record; nothing under src/ did, so the modules measured are the ones that revision ships.',
  'Peak memory is reported twice. RSS is the process-level figure and reads 0 wherever the transient fitted in pages the process already held; live ArrayBuffer bytes track the section arrays themselves. The derived footprints are arithmetic over the accepted count, not a sample.',
];

/** Run the whole ladder and assemble the record. */
export function runProfileSectionMeasurement(
  label: string,
  ladder: ReadonlyArray<{ readonly id: string; readonly pointCount: number }>,
): ProfileSectionRecord {
  const sizes: ProfileSectionSizeResult[] = [];
  const notRun: { sizeId: string; reason: string }[] = [];
  const displaySections: { sizeId: string; section: ProfileSectionPoints }[] = [];

  for (const rung of ladder) {
    try {
      const { size, section } = measureSize(rung.id, rung.pointCount);
      sizes.push(size);
      // Only a section that overruns the cap is worth timing a selection over:
      // below the cap `selectProfileSectionLod` returns every index from its
      // first branch, and the number would be the cost of that branch.
      if (section.count > DISPLAY_CAP) displaySections.push({ sizeId: rung.id, section });
      else {
        notRun.push({
          sizeId: `display-${rung.id}`,
          reason: `the ${rung.id} section holds ${section.count} returns, below the ${DISPLAY_CAP} display cap, so a selection over it would return every index rather than choose between them`,
        });
      }
    } catch (err) {
      // A size this machine cannot run is a finding, not a missing row.
      const detail = err instanceof Error ? err.message : String(err);
      notRun.push({
        sizeId: rung.id,
        reason: `the ${rung.id} rung could not be run on this host: ${detail.replace(/\s*[\r\n]+\s*/g, '; ').slice(0, 500)}`,
      });
    }
  }

  const displays = displaySections.map((entry) => measureDisplay(entry.sizeId, entry.section));

  return {
    schemaVersion: 1,
    label,
    revision: gitRevision(),
    generatedAt: new Date().toISOString(),
    environment: captureEnvironment(),
    generator: PROFILE_CLOUD_GENERATOR,
    warmupRuns: WARMUP_RUNS,
    recordedRuns: RECORDED_RUNS,
    forcedGcRequested: forcedGcRequested(),
    sizes,
    displays,
    notRun,
    verdicts: recomputeVerdicts(sizes, displays),
    notes: NOTES,
  };
}

/** A compact table for the run log, so the headline is readable without the JSON. */
function renderTable(record: ProfileSectionRecord): string {
  const num = (v: number, digits = 3): string => v.toFixed(digits);
  const lines: string[] = [];
  const mib = (metric: Metric): string =>
    isMeasured(metric) ? num(metric.value / (1024 * 1024), 1) : 'unavailable';
  lines.push(
    '| size | accepted | whole-run median ms | whole-run IQR | chunked total median ms | longest slice median ms | longest slice max ms | peak RSS delta MiB | peak buffers delta MiB | derived transient MiB |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of record.sizes) {
    const whole = s.wholeRunMs.status === 'measured' ? s.wholeRunMs.summary : null;
    const chunked = s.chunkedTotalMs.status === 'measured' ? s.chunkedTotalMs.summary : null;
    const slice = s.longestSliceMs.status === 'measured' ? s.longestSliceMs.summary : null;
    lines.push(
      `| ${s.sizeId} | ${s.acceptedPoints} | ${whole ? num(whole.median) : 'n/a'} | ${whole ? num(whole.iqr) : 'n/a'} | ${chunked ? num(chunked.median) : 'n/a'} | ${slice ? num(slice.median) : 'n/a'} | ${slice ? num(slice.max) : 'n/a'} | ${mib(s.peakRssDeltaBytes)} | ${mib(s.peakArrayBufferDeltaBytes)} | ${mib(s.sectionTransientBytes)} |`,
    );
  }
  if (record.displays.length > 0) {
    lines.push('');
    lines.push('| size | section returns | display stage | median ms | IQR ms | max ms |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const d of record.displays) {
      const row = (name: string, series: ProfileSectionDisplayResult['lodSelectMs']): void => {
        if (series.status !== 'measured') return;
        lines.push(
          `| ${d.sizeId} | ${d.sectionPoints} | ${name} | ${num(series.summary.median)} | ${num(series.summary.iqr)} | ${num(series.summary.max)} |`,
        );
      };
      row(`LOD selection at cap ${d.cap}`, d.lodSelectMs);
      row(`hit-test build over ${d.selectedPoints}`, d.hitTestBuildMs);
      row(`hover batch of ${d.queriesPerBatch}`, d.hitTestQueryBatchMs);
      row('one hover', d.hitTestQueryMs);
    }
  }
  lines.push('');
  lines.push('| verdict | threshold ms | observed ms | met |');
  lines.push('| --- | --- | --- | --- |');
  for (const v of record.verdicts) {
    lines.push(
      `| ${v.id} | ${num(v.thresholdMs)} | ${num(v.observedMs)} | ${v.met ? 'yes' : 'NO'} |`,
    );
  }
  return lines.join('\n');
}

const WRITE = process.env.PROFILE_SECTION_WRITE === '1';

describe('profile section measurement harness', () => {
  test('extracts through the real modules and produces a validated record', () => {
    const record = runProfileSectionMeasurement('profile-section-contract', [
      { id: 'contract', pointCount: 200_000 },
    ]);

    expect(record.sizes).toHaveLength(1);
    const size = record.sizes[0]!;
    // It really walked the scene: nothing was skipped, and the corridor kept a
    // proper subset rather than everything or nothing.
    expect(size.examinedPoints).toBe(200_000);
    expect(size.skippedSlots).toBe(0);
    expect(size.acceptedPoints).toBeGreaterThan(0);
    expect(size.acceptedPoints).toBeLessThan(size.examinedPoints);
    expect(size.chunkYields).toBeGreaterThan(0);

    // The timings are distributions, not single samples.
    expect(size.longestSliceMs.status).toBe('measured');
    if (size.longestSliceMs.status === 'measured') {
      expect(size.longestSliceMs.summary.count).toBe(RECORDED_RUNS);
      expect(size.longestSliceMs.summary.stdDev).not.toBeNull();
    }

    // A 200k scene cannot reach the display cap, and the record says so rather
    // than carrying an empty display block.
    expect(record.displays).toEqual([]);
    expect(record.notRun.map((n) => n.sizeId)).toContain('display-contract');

    expect(validateProfileSectionRecord(record)).toEqual([]);
  }, 120_000);

  test('the validator rejects a verdict that does not follow from the measurement', () => {
    // A guard on the guard. The failure it exists to catch is a target widened
    // until a measurement fits, so both halves are checked: a flipped verdict,
    // and a moved threshold.
    const record = runProfileSectionMeasurement('profile-section-tamper', [
      { id: 'contract', pointCount: 20_000 },
    ]);
    expect(record.verdicts.length).toBeGreaterThan(0);

    const flipped: ProfileSectionRecord = {
      ...record,
      verdicts: record.verdicts.map((v) => ({ ...v, met: !v.met })),
    };
    expect(validateProfileSectionRecord(flipped)).toContain('verdicts-disagree-with-measurements');

    const widened: ProfileSectionRecord = {
      ...record,
      verdicts: record.verdicts.map((v) => ({ ...v, thresholdMs: v.thresholdMs * 10, met: true })),
    };
    const problems = validateProfileSectionRecord(widened);
    expect(problems).toContain('threshold-is-not-the-stated-target');
    expect(problems).toContain('verdicts-disagree-with-measurements');
  }, 120_000);

  test('the stated targets are the constants the verdicts are drawn against', () => {
    // Pinned so a later edit to either number is a deliberate, visible change
    // rather than a quiet re-baselining.
    expect(MAIN_THREAD_SLICE_TARGET_MS).toBe(100);
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.6667, 3);
  });

  test.runIf(WRITE)('runs the size ladder and writes the baseline', () => {
    const record = runProfileSectionMeasurement('profile-section-baseline', LADDER);
    expect(validateProfileSectionRecord(record)).toEqual([]);

    const here = dirname(fileURLToPath(import.meta.url));
    const out = resolve(here, '../../docs/validation/profile-section-baseline.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    /* eslint-disable no-console */
    console.log(renderTable(record));
    for (const missing of record.notRun) console.log(`not run — ${missing.sizeId}: ${missing.reason}`);
    console.log(`profile-section baseline written to ${out}`);
    /* eslint-enable no-console */
  }, 3_600_000);
});
