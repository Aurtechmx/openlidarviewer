/**
 * lazChunkTable.ts — native random access into a plain LAZ file.
 *
 * A LAZ file's points are compressed in independent chunks, and the file
 * carries a table of chunk byte ranges — arithmetic-coded, which is why
 * whole-file decoders skip it and run one sequential coder over the entire
 * stream. This module reads the table through a {@link RangeSource} with
 * three partial reads (header, table head, table body), so a multi-gigabyte
 * file yields its chunk map without a whole-file buffer ever existing. Each
 * resulting {@link LazChunkRange} is an independent decode unit: the worker
 * pool decompresses them concurrently through the same per-chunk laz-perf
 * path the COPC reader uses.
 *
 * Fail-closed contract: a file whose table is absent (pointwise compressor,
 * `-1` offset sentinel), unreadable, or inconsistent with the header reports
 * `supported: false` with a reason — the caller falls back to the legacy
 * whole-file path, and the fast path never guesses at a suspect index. The
 * invariants enforced before any chunk is trusted:
 *
 *   • chunk offsets strictly increase and stay inside the file;
 *   • the last chunk ends exactly where the table begins;
 *   • point counts sum to the header's count (fixed-size derives them,
 *     variable-size decodes them).
 *
 * Pure, RangeSource-only — unit-tested in Node over ArrayBufferRangeSource.
 */
import type { RangeSource } from '../range/RangeSource';
import { parseLasHeader, type LasHeader } from '../lasHeader';
import { ArithmeticDecoder, IntegerDecompressor } from './arithmeticCoder';

/** One independently decodable compressed chunk. */
export interface LazChunkRange {
  /** Absolute byte offset of the chunk's compressed bytes. */
  readonly byteOffset: number;
  /** Compressed byte length. */
  readonly byteLength: number;
  /** Number of points the chunk decodes to. */
  readonly pointCount: number;
  /** Index of the chunk's first point in file order. */
  readonly firstPointIndex: number;
}

export interface LazChunkTable {
  readonly supported: true;
  readonly header: LasHeader;
  /** 2 = chunked (PDRF 0–5), 3 = layered chunked (PDRF 6–10). */
  readonly compressor: 2 | 3;
  /** Fixed points-per-chunk, or 'variable' for layered files. */
  readonly chunkSize: number | 'variable';
  readonly chunks: readonly LazChunkRange[];
}

export interface LazChunkTableUnsupported {
  readonly supported: false;
  /** Why the fast path declined — recorded in load telemetry. */
  readonly reason: string;
}

export type LazChunkTableResult = LazChunkTable | LazChunkTableUnsupported;

// LAS public-header fields the VLR walk needs beyond what LasHeader carries.
const OFFSET_HEADER_SIZE = 94;
const OFFSET_VLR_COUNT = 100;

// VLR framing (LAS 1.x): 2 reserved + 16 user id + 2 record id + 2 payload
// length + 32 description.
const VLR_HEADER_BYTES = 54;
const VLR_USER_ID_OFFSET = 2;
const VLR_USER_ID_LENGTH = 16;
const VLR_RECORD_ID_OFFSET = 18;
const VLR_RECORD_LENGTH_OFFSET = 20;

const LASZIP_USER_ID = 'laszip encoded';
const LASZIP_RECORD_ID = 22204;

/** Head read: the full VLR region, capped so a hostile header stays bounded. */
const MAX_HEAD_BYTES = 4 * 1024 * 1024;
/** Absurdity guard on the declared chunk count before any allocation. */
const MAX_CHUNKS = 16_777_216;

const VARIABLE_CHUNK_SIZE = 0xffffffff;

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

interface LaszipVlr {
  compressor: number;
  chunkSize: number;
}

/** Find and parse the laszip VLR in the head slice, or null when absent. */
function findLaszipVlr(head: ArrayBuffer): LaszipVlr | null {
  const view = new DataView(head);
  if (head.byteLength < OFFSET_VLR_COUNT + 4) return null;
  const headerSize = view.getUint16(OFFSET_HEADER_SIZE, true);
  const vlrCount = view.getUint32(OFFSET_VLR_COUNT, true);
  let cursor = headerSize;
  for (let i = 0; i < vlrCount; i++) {
    if (cursor + VLR_HEADER_BYTES > head.byteLength) break;
    const userId = readAscii(view, cursor + VLR_USER_ID_OFFSET, VLR_USER_ID_LENGTH);
    const recordId = view.getUint16(cursor + VLR_RECORD_ID_OFFSET, true);
    const payloadLength = view.getUint16(cursor + VLR_RECORD_LENGTH_OFFSET, true);
    const payloadStart = cursor + VLR_HEADER_BYTES;
    if (payloadStart + payloadLength > head.byteLength) break;
    if (userId === LASZIP_USER_ID && recordId === LASZIP_RECORD_ID) {
      // Payload: u16 compressor, u16 coder, version (4), u32 options,
      // u32 chunk_size, …
      if (payloadLength < 16) return null;
      return {
        compressor: view.getUint16(payloadStart, true),
        chunkSize: view.getUint32(payloadStart + 12, true),
      };
    }
    cursor = payloadStart + payloadLength;
  }
  return null;
}

function unsupported(reason: string): LazChunkTableUnsupported {
  return { supported: false, reason };
}

/**
 * Read a plain LAZ file's chunk table over partial reads.
 *
 * Throws only what {@link parseLasHeader} throws (a file that is not LAS at
 * all); every table-level defect reports `supported: false` instead, so the
 * caller's fallback decision is one branch.
 *
 * `maxHeadBytes` caps the single prefix read that covers the public header and
 * the VLR region; it defaults to {@link MAX_HEAD_BYTES} and is clamped to that
 * cap. A caller that already knows `offsetToPointData` (every VLR precedes the
 * point data) passes it here so the prefix read stays a few hundred bytes on a
 * file whose header is small, instead of reading up to the 4 MiB default — which
 * on a file smaller than the default would be the whole file. All the VLRs must
 * still fall inside the prefix, so too small a cap simply reports `supported:
 * false` (no laszip VLR found), it never mis-reads the table.
 */
export async function readLazChunkTable(
  range: RangeSource,
  signal?: AbortSignal,
  maxHeadBytes: number = MAX_HEAD_BYTES,
): Promise<LazChunkTableResult> {
  const size = await range.size();
  const headCap = Math.min(MAX_HEAD_BYTES, Math.max(0, Math.floor(maxHeadBytes)));
  const headLength = Math.min(size, headCap);
  const head = await range.readRange(0, headLength, signal);
  const header = parseLasHeader(head);

  const vlr = findLaszipVlr(head);
  if (!vlr) {
    return unsupported('no laszip VLR in the head slice — not a LAZ file, or oversized VLRs');
  }
  if (vlr.compressor === 1) {
    return unsupported('pointwise compressor (pre-chunking LAZ) has no chunk table');
  }
  if (vlr.compressor !== 2 && vlr.compressor !== 3) {
    return unsupported(`unknown laszip compressor ${vlr.compressor}`);
  }
  if (vlr.chunkSize === 0) {
    return unsupported('laszip VLR declares a zero chunk size');
  }
  const variable = vlr.chunkSize === VARIABLE_CHUNK_SIZE;

  // The 8 bytes at the start of the point data hold the table's absolute
  // offset; the first chunk begins right after them.
  if (header.offsetToPointData + 8 > size) {
    return unsupported('file ends before the chunk-table offset field');
  }
  const offsetBytes = await range.readRange(header.offsetToPointData, 8, signal);
  const tableOffsetBig = new DataView(offsetBytes).getBigInt64(0, true);
  if (tableOffsetBig === -1n) {
    return unsupported('chunk-table offset is the -1 sentinel (interrupted writer)');
  }
  if (tableOffsetBig < 0n || tableOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return unsupported('chunk-table offset is out of range');
  }
  const tableOffset = Number(tableOffsetBig);
  const chunksStart = header.offsetToPointData + 8;
  if (tableOffset < chunksStart || tableOffset + 8 > size) {
    return unsupported('chunk-table offset points outside the file');
  }

  // Table head: u32 version (0), u32 chunk count.
  const tableHead = new DataView(await range.readRange(tableOffset, 8, signal));
  const version = tableHead.getUint32(0, true);
  if (version !== 0) return unsupported(`chunk-table version ${version} is not 0`);
  const numChunks = tableHead.getUint32(4, true);
  if (numChunks === 0) {
    if (header.pointCount !== 0) {
      return unsupported('table declares zero chunks for a non-empty file');
    }
    return {
      supported: true,
      header,
      compressor: vlr.compressor,
      chunkSize: variable ? 'variable' : vlr.chunkSize,
      chunks: [],
    };
  }
  if (numChunks > MAX_CHUNKS) {
    return unsupported(`table declares ${numChunks} chunks — over the sanity cap`);
  }
  if (!variable) {
    const expected = Math.ceil(header.pointCount / vlr.chunkSize);
    if (numChunks !== expected) {
      return unsupported(
        `table declares ${numChunks} chunks; ${expected} follow from the header count`,
      );
    }
  }

  // Table body: the arithmetic-coded delta streams. Each value costs a
  // bounded handful of bytes; 12 per chunk plus slack is a safe over-read.
  const bodyCap = Math.min(size - tableOffset - 8, numChunks * 12 + 1024);
  const body = new Uint8Array(await range.readRange(tableOffset + 8, bodyCap, signal));

  const dec = new ArithmeticDecoder(body);
  dec.init();
  const ic = new IntegerDecompressor(dec, 2);

  // Deltas are predicted from the previous delta, then prefix-summed:
  // starts[i] is the absolute offset of chunk i, starts[n] the end of the
  // last chunk; totals mirror that for point counts on variable-size files.
  const startDeltas = new Float64Array(numChunks);
  const countDeltas = variable ? new Float64Array(numChunks) : null;
  let prevCount = 0;
  let prevStart = 0;
  for (let i = 0; i < numChunks; i++) {
    if (countDeltas) {
      const c = ic.decompress(prevCount | 0, 0) >>> 0;
      countDeltas[i] = c;
      prevCount = c;
    }
    const s = ic.decompress(prevStart | 0, 1) >>> 0;
    startDeltas[i] = s;
    prevStart = s;
  }

  const chunks: LazChunkRange[] = [];
  let start = chunksStart;
  let firstPointIndex = 0;
  for (let i = 0; i < numChunks; i++) {
    const end = start + startDeltas[i];
    let pointCount: number;
    if (countDeltas) {
      pointCount = countDeltas[i];
    } else if (i < numChunks - 1) {
      pointCount = vlr.chunkSize;
    } else {
      pointCount = header.pointCount - vlr.chunkSize * (numChunks - 1);
    }
    if (startDeltas[i] <= 0) {
      return unsupported(`chunk ${i} has a non-positive byte length`);
    }
    if (end > tableOffset) {
      return unsupported(`chunk ${i} runs past the chunk table`);
    }
    if (pointCount <= 0 || !Number.isSafeInteger(pointCount)) {
      return unsupported(`chunk ${i} has an impossible point count`);
    }
    chunks.push({ byteOffset: start, byteLength: startDeltas[i], pointCount, firstPointIndex });
    start = end;
    firstPointIndex += pointCount;
  }
  if (start !== tableOffset) {
    return unsupported('the last chunk does not end at the chunk table');
  }
  if (firstPointIndex !== header.pointCount) {
    return unsupported(
      `chunk point counts sum to ${firstPointIndex}, header declares ${header.pointCount}`,
    );
  }

  return {
    supported: true,
    header,
    compressor: vlr.compressor,
    chunkSize: variable ? 'variable' : vlr.chunkSize,
    chunks,
  };
}
