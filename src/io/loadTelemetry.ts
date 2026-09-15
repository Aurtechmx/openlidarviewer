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
  /** Load start to the first preview chunk's arrival on the main thread, when one was sent. */
  previewMs?: number;
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
  /** Name of the file the row was measured on (local LAZ path). */
  fileName?: string;
  /** Size of that file, in bytes. */
  fileBytes?: number;
  /** Point count the LAS header declares, before any stride or budget. */
  declaredPointCount?: number;
  /** Point data record format id (PDRF) the header declares. */
  pointFormat?: number;
  /** Chunks the LAZ chunk table described, when the chunked path planned one. */
  lazChunkCount?: number;
  /** Stride the loader applied: every `n`-th record was decoded. */
  decodeStride?: number;
  /** Preview records the page asked for, when it asked for a preview. */
  previewBudget?: number;
  /** Bytes read before the first chunk decode: header, VLRs, chunk table (worker). */
  metadataBytes?: number;
  /** Ranged reads issued over the source (worker). */
  rangeRequests?: number;
  /** Sum of the requested read lengths, re-reads counted each time (worker). */
  requestedBytes?: number;
  /** Bytes of the file the requested spans cover, each counted once (worker). */
  uniqueBytesRead?: number;
  /** `requestedBytes` minus `uniqueBytesRead`: bytes fetched more than once. */
  rereadBytes?: number;
  /** Compressed bytes counted when the first preview chunk was handed on. */
  compressedBytesBeforePreview?: number;
  /** Compressed bytes read through ranged reads (worker). */
  compressedBytesRead?: number;
  /** Records handed to the preview as chunks, before any thinning on the page. */
  previewPoints?: number;
  /** Workers the chunk pool was sized to, when it engaged (worker). */
  poolWorkers?: number;
  /** Which decoder produced the cloud (worker). */
  decodePath?: 'pooled' | 'whole-file' | 'pool-fallback';
  /** Why the pool did not produce the cloud: skipped, or engaged and failed. */
  poolFallbackReason?: string;
}

/** Ordered (label, key) rows for a telemetry report. */
const TELEMETRY_ROWS: [string, keyof LoadTelemetry][] = [
  ['sniff + plan', 'sniffMs'],
  ['file read', 'fileReadMs'],
  ['transfer', 'transferMs'],
  ['preview', 'previewMs'],
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
    if (typeof value !== 'number') continue;
    lines.push(`  ${label.padEnd(14)}${value.toFixed(1).padStart(9)} ms`);
  }
  for (const [label, key, unit] of COUNT_ROWS) {
    const value = t[key];
    if (value === undefined) continue;
    const text = typeof value === 'number' ? formatCount(value, unit) : String(value);
    lines.push(`  ${label.padEnd(14)}${text.padStart(12)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no telemetry)';
}

/** Non-timing rows: which file was read, what the ranged path read, which decoder ran. */
const COUNT_ROWS: [string, keyof LoadTelemetry, 'bytes' | 'count' | 'text'][] = [
  ['file', 'fileName', 'text'],
  ['file bytes', 'fileBytes', 'bytes'],
  ['declared pts', 'declaredPointCount', 'count'],
  ['point format', 'pointFormat', 'count'],
  ['laz chunks', 'lazChunkCount', 'count'],
  ['stride', 'decodeStride', 'count'],
  ['preview cap', 'previewBudget', 'count'],
  ['metadata read', 'metadataBytes', 'bytes'],
  ['range reads', 'rangeRequests', 'count'],
  ['requested', 'requestedBytes', 'bytes'],
  ['unique read', 'uniqueBytesRead', 'bytes'],
  ['re-read', 'rereadBytes', 'bytes'],
  ['pre-preview', 'compressedBytesBeforePreview', 'bytes'],
  ['compressed', 'compressedBytesRead', 'bytes'],
  ['preview pts', 'previewPoints', 'count'],
  ['pool workers', 'poolWorkers', 'count'],
  ['decode path', 'decodePath', 'text'],
  ['pool reason', 'poolFallbackReason', 'text'],
];

function formatCount(value: number, unit: 'bytes' | 'count' | 'text'): string {
  if (unit === 'bytes') {
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${(value / 1e3).toFixed(1)} kB`;
  }
  return value.toLocaleString('en-US');
}
