/**
 * LocalOutOfCoreSource.ts — pick the out-of-core read strategy for a local file.
 *
 * The heavy readers exist independently: `openSlicedLas` reads an uncompressed
 * LAS as bounded record slices, and `readLazChunkTable` exposes a chunked LAZ's
 * independently-decodable chunks. What was missing is one entry that inspects a
 * file and routes it to the right one, or to the safe whole-file fallback when
 * neither out-of-core path applies. This is that planner: it reads only the LAS
 * public header (and, for a compressed file, the chunk table) — never the point
 * records — so choosing a strategy for a multi-gigabyte file costs a few small
 * range reads. Executing the plan (the sliced/chunked read loops, an OPFS index)
 * builds on this; it decides the mode, it does not move the points.
 */

import type { RangeSource } from '../range/RangeSource';
import { parseLasHeader } from '../lasHeader';
import { readLazChunkTable } from './lazChunkTable';

/** LAS public-header offset of the point-data-record-format byte (high bit = LAZ). */
const OFFSET_POINT_FORMAT = 104;
/** Enough to cover the largest LAS public header before any VLR. */
const HEADER_PROBE_BYTES = 375;

export type OutOfCoreMode = 'sliced-las' | 'chunked-laz' | 'whole-file';

export interface OutOfCorePlan {
  readonly mode: OutOfCoreMode;
  readonly compressed: boolean;
  readonly pointCount: number;
  /** Uncompressed LAS only: fixed record length for slicing. */
  readonly recordLength: number | null;
  /** Chunked LAZ only: number of independently-decodable chunks. */
  readonly chunkCount: number | null;
  readonly reason: string;
}

/**
 * Decide how to read `range` out of core. Reads only the header (and the chunk
 * table for a compressed file); never the point records.
 */
export async function planOutOfCore(
  range: RangeSource,
  signal?: AbortSignal,
): Promise<OutOfCorePlan> {
  const size = await range.size();
  const head = await range.readRange(0, Math.min(size, HEADER_PROBE_BYTES), signal);
  const header = parseLasHeader(head);
  // parseLasHeader masks the compression bit off `pointFormat`, so read the raw
  // format byte to tell an uncompressed LAS from a LAZ.
  const headBytes = new Uint8Array(head);
  const compressed =
    headBytes.length > OFFSET_POINT_FORMAT && (headBytes[OFFSET_POINT_FORMAT] & 0x80) !== 0;

  if (!compressed) {
    return {
      mode: 'sliced-las',
      compressed: false,
      pointCount: header.pointCount,
      recordLength: header.pointDataRecordLength,
      chunkCount: null,
      reason: 'Uncompressed LAS — bounded, randomly-addressable record slices.',
    };
  }

  const table = await readLazChunkTable(range, signal);
  if (table.supported) {
    return {
      mode: 'chunked-laz',
      compressed: true,
      pointCount: header.pointCount,
      recordLength: null,
      chunkCount: table.chunks.length,
      reason: `Chunked LAZ (compressor ${table.compressor}) — ${table.chunks.length} independently-decodable chunks.`,
    };
  }

  return {
    mode: 'whole-file',
    compressed: true,
    pointCount: header.pointCount,
    recordLength: null,
    chunkCount: null,
    reason: `LAZ without a usable chunk table (${table.reason}) — safe whole-file fallback.`,
  };
}
