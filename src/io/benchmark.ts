/**
 * benchmark.ts
 *
 * Turns the per-stage timings a file load records ({@link LoadTelemetry}) into
 * a stable, comparable benchmark report — the `?benchmark=1` result.
 *
 * It adds no measurement of its own: every number here is already collected by
 * the load. Benchmark mode simply formalises those numbers into one structured
 * result, so optimisation work across versions has a fixed baseline to compare.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

import type { LoadTelemetry } from './loadTelemetry';
import { formatTelemetry } from './loadTelemetry';

/** A structured, comparable result for one benchmarked file load. */
export interface BenchmarkResult {
  /** The loaded file's name. */
  file: string;
  /** The detected source format (e.g. `las`, `e57`, `pcd`). */
  format: string;
  /** Points rendered after the device-aware load budget was applied. */
  pointCount: number;
  /**
   * Total points the source file declared in its header — independent of
   * what the load budget retained. The denominator the reader needs to
   * tell "5M @ 200 ms is great" from "5M of 500M @ 200 ms is incomplete".
   * Undefined for formats whose header doesn't declare a count up front.
   */
  sourcePointCount?: number;
  /**
   * Milliseconds from the file arriving to its first rendered frame — the
   * headline benchmark number. In the single-shot load path this is
   * also the time to a fully ready scene; a v0.3 streaming source would let
   * first-render land earlier than full-ready.
   */
  timeToFirstRenderMs: number;
  /** The per-stage timing breakdown the load recorded. */
  stages: LoadTelemetry;
}

/**
 * Assemble a {@link BenchmarkResult} from a finished load's telemetry.
 *
 * `telemetry` is the merged record — the worker-side stages plus the
 * main-thread `gpuUploadMs` / `firstRenderMs` — exactly what the debug console
 * block is given. `timeToFirstRenderMs` sums the whole-load span
 * (`totalLoadMs`) with the GPU upload and first-render costs that follow it.
 */
export function buildBenchmarkResult(
  file: string,
  format: string,
  pointCount: number,
  telemetry: LoadTelemetry,
  sourcePointCount?: number,
): BenchmarkResult {
  const timeToFirstRenderMs =
    (telemetry.totalLoadMs ?? 0) +
    (telemetry.gpuUploadMs ?? 0) +
    (telemetry.firstRenderMs ?? 0);
  return {
    file,
    format,
    pointCount,
    sourcePointCount,
    timeToFirstRenderMs,
    stages: { ...telemetry },
  };
}

/** Format a benchmark result as an aligned, multi-line console/overlay block. */
export function formatBenchmarkResult(result: BenchmarkResult): string {
  const pointsLine = formatPointsLine(result);
  return [
    `file                  ${result.file}`,
    `format                ${result.format}`,
    pointsLine,
    `time to first render  ${result.timeToFirstRenderMs.toFixed(1)} ms`,
    'stages',
    formatTelemetry(result.stages),
  ].join('\n');
}

/**
 * Compose the points line so the reader can tell a budget-capped load
 * apart from a full one. When the source declared a point count and the
 * rendered count is smaller, we surface "X of Y (Z%)" so the benchmark
 * never reads as faster than it actually was on the underlying file.
 */
function formatPointsLine(result: BenchmarkResult): string {
  const rendered = result.pointCount.toLocaleString('en-US');
  const source = result.sourcePointCount;
  if (source === undefined || source <= result.pointCount) {
    return `points rendered       ${rendered}`;
  }
  const pct = (result.pointCount / source) * 100;
  const sourceFmt = source.toLocaleString('en-US');
  return `points rendered       ${rendered} of ${sourceFmt} (${pct.toFixed(1)}%)`;
}
