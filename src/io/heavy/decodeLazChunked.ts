/**
 * decodeLazChunked.ts — decode a whole in-memory LAZ by its chunk table.
 *
 * The legacy path (`src/io/lazDecode.ts`) runs one laz-perf `LASZip` reader
 * across the entire stream: correct, but strictly sequential on one core. A
 * chunked LAZ carries a table of independent per-chunk byte ranges, and each
 * chunk is a self-contained decode unit. This module walks that table and
 * decodes each chunk through the same per-chunk laz-perf path COPC nodes use
 * (`decompressChunk`), then extracts the raw records with the SAME shared
 * `decodeRecord` the legacy and uncompressed paths use — so the output is
 * byte-for-byte identical to `decodeLaz`, only produced chunk by chunk.
 *
 * This variant decodes the chunks sequentially: it is the correctness floor and
 * the reassembly contract that `decodeLazParallel` (worker pool) builds on. It
 * returns `null` — fail-closed to the legacy whole-file path — for any file the
 * chunk table cannot describe (pointwise-compressed LAZ, an interrupted writer,
 * an unsupported record format), never a partial or a guess.
 */
import { readLazChunkTable } from './lazChunkTable';
import { ArrayBufferRangeSource } from '../range/ArrayBufferRangeSource';
import { decompressChunk } from '../copc/copcChunkDecompress';
import { getLazPerf } from '../lazDecode';
import {
  decodeContext,
  decodeRecord,
  allocRawPoints,
  finalizeRawColors,
  type RawPoints,
} from '../lasDecodeShared';
import type { LasHeader } from '../lasHeader';

/** Record formats the per-chunk laz-perf decoder is exercised for (COPC's set). */
const CHUNK_DECODE_FORMATS = new Set([6, 7, 8]);

/**
 * Decode a whole LAZ buffer chunk by chunk, sequentially. Returns `null` when
 * the file is not a chunked LAZ this path supports; the caller then falls back
 * to `decodeLaz`.
 */
export async function decodeLazChunkedSequential(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  signal?: AbortSignal,
): Promise<RawPoints | null> {
  const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), signal);
  if (!table.supported) return null;
  if (!CHUNK_DECODE_FORMATS.has(header.pointFormat)) return null;

  // Sum the chunk table's own counts rather than trusting the header: a table
  // whose counts do not reach the declared total is a mismatch, and decoding a
  // short table into a full-size buffer would leave the tail as fabricated zero
  // points. Fail closed to the legacy path instead.
  const tableTotal = table.chunks.reduce((a, c) => a + c.pointCount, 0);
  if (tableTotal !== header.pointCount) return null;

  const ctx = decodeContext(header, origin);
  const out = allocRawPoints(header.pointCount, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
  const lazPerf = await getLazPerf();
  const recordLength = header.pointDataRecordLength;

  for (const chunk of table.chunks) {
    signal?.throwIfAborted();
    const chunkBytes = buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const records = decompressChunk(lazPerf, chunkBytes, {
      pointDataRecordFormat: header.pointFormat,
      pointRecordLength: recordLength,
      pointCount: chunk.pointCount,
      scale: header.scale,
      offset: header.offset,
      renderOrigin: origin,
    });
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    for (let j = 0; j < chunk.pointCount; j++) {
      decodeRecord(view, j * recordLength, chunk.firstPointIndex + j, ctx, out);
    }
  }

  finalizeRawColors(out);
  return out;
}
