/**
 * lazRecord0.ts — world coordinates of a LAZ file's first point record.
 *
 * Feeds {@link lasOriginFor}: the origin rule needs record 0 before any decode
 * starts. In a chunked LAZ (laszip compressor 2 or 3) the point data opens with
 * the 8-byte chunk-table offset, and chunk 0 follows. LASzip stores each chunk's
 * first record uncompressed at the chunk's start, so a short prefix of chunk 0
 * holds record 0; it is decoded through laz-perf's chunk decoder all the same.
 * A pointwise LAZ (compressor 1) or a file without a laszip VLR yields null,
 * which keeps the header origin.
 */
import type { RangeSource } from '../range/RangeSource';
import type { LasHeader } from '../lasHeader';
import { getLazPerf } from '../lazDecode';
import { recordWorld, type Vec3 } from '../lasDataOrigin';
import { findLaszipVlr } from './lazChunkTable';

/** Bytes read past record 0's length, for the chunk's leading fields. */
const PREFIX_SLACK_BYTES = 256;
/** Zero padding after the prefix, so decoder read-ahead stays in bounds. */
const PADDING_BYTES = 4096;
/** The chunk-table offset that opens a chunked LAZ's point data. */
const CHUNK_TABLE_OFFSET_BYTES = 8;

/**
 * Record 0 of the LAZ behind `range`, or null when it cannot be read cheaply.
 * `head` is a prefix of the file the caller already holds (header and VLRs at
 * least); bytes it covers are not read again. Never throws: any read or decode
 * fault is a null.
 */
export async function lazRecord0(
  range: RangeSource,
  header: LasHeader,
  head?: ArrayBuffer,
  signal?: AbortSignal,
): Promise<Vec3 | null> {
  if (!(header.pointCount > 0)) return null;
  try {
    const vlrHead =
      head && head.byteLength >= header.offsetToPointData
        ? head
        : await range.readRange(0, header.offsetToPointData, signal);
    const vlr = findLaszipVlr(vlrHead);
    if (!vlr || (vlr.compressor !== 2 && vlr.compressor !== 3)) return null;

    const recordLength = header.pointDataRecordLength;
    const start = header.offsetToPointData + CHUNK_TABLE_OFFSET_BYTES;
    const size = await range.size();
    const length = Math.min(recordLength + PREFIX_SLACK_BYTES, size - start);
    if (length < recordLength) return null;
    const prefix =
      head && head.byteLength >= start + length
        ? new Uint8Array(head, start, length)
        : new Uint8Array(await range.readRange(start, length, signal));
    const compressed = new Uint8Array(prefix.byteLength + PADDING_BYTES);
    compressed.set(prefix);

    const lazPerf = await getLazPerf();
    const chunkPtr = lazPerf._malloc(compressed.byteLength);
    const pointPtr = lazPerf._malloc(recordLength);
    const decoder = new lazPerf.ChunkDecoder();
    try {
      lazPerf.HEAPU8.set(compressed, chunkPtr);
      decoder.open(header.pointFormat, recordLength, chunkPtr);
      decoder.getPoint(pointPtr);
      // Re-read the heap after the decode: laz-perf may have grown it.
      return recordWorld(new DataView(lazPerf.HEAPU8.buffer), pointPtr, header);
    } finally {
      decoder.delete();
      lazPerf._free(pointPtr);
      lazPerf._free(chunkPtr);
    }
  } catch {
    return null;
  }
}
