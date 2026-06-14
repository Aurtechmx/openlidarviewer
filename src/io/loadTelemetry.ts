/**
 * loadTelemetry.ts
 *
 * Per-stage timing for a file load — collected across the main thread and the
 * parse worker, surfaced only in debug mode (`?debug=1`). Every field is
 * optional: a stage that did not run (or was not timed) is simply absent.
 *
 * This module has no DOM or three.js dependency, so it is unit-tested in Node.
 */

/** Millisecond timings for the stages of one file load. */
export interface LoadTelemetry {
  /** Head-slice read + format sniff + load plan (main thread). */
  sniffMs?: number;
  /** Reading the whole file into memory (main thread). */
  fileReadMs?: number;
  /** `postMessage` to the worker's first reply — buffer transfer + spin-up. */
  transferMs?: number;
  /** Header parse and decoder setup (worker). */
  parseMs?: number;
  /** Decoding the point records (worker). */
  decodeMs?: number;
  /** Voxel downsampling, when one ran (worker). */
  downsampleMs?: number;
  /** GPU buffer upload — `addCloud` (main thread). */
  gpuUploadMs?: number;
  /** Framing and the first render pass (main thread). */
  firstRenderMs?: number;
  /** The whole load, from drop to resolved (main thread). */
  totalLoadMs?: number;
}

/** Ordered (label, key) rows for a telemetry report. */
const TELEMETRY_ROWS: [string, keyof LoadTelemetry][] = [
  ['sniff + plan', 'sniffMs'],
  ['file read', 'fileReadMs'],
  ['transfer', 'transferMs'],
  ['parse', 'parseMs'],
  ['decode', 'decodeMs'],
  ['downsample', 'downsampleMs'],
  ['gpu upload', 'gpuUploadMs'],
  ['first render', 'firstRenderMs'],
  // Wall-clock end-to-end (drop → resolved). It is LESS than the sum of the
  // stages above because the worker stages (decode / downsample) overlap the
  // main-thread stages — so the "(wall)" tag flags it as elapsed time, not an
  // accounting total, and the rows never look like they fail to add up.
  ['total (wall)', 'totalLoadMs'],
];

/**
 * Format telemetry as an aligned, multi-line block for the debug console.
 * Stages with no recorded time are omitted. Returns `'(no telemetry)'` when
 * nothing was measured.
 */
export function formatTelemetry(t: LoadTelemetry): string {
  const lines: string[] = [];
  for (const [label, key] of TELEMETRY_ROWS) {
    const value = t[key];
    if (value === undefined) continue;
    lines.push(`  ${label.padEnd(14)}${value.toFixed(1).padStart(9)} ms`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no telemetry)';
}
