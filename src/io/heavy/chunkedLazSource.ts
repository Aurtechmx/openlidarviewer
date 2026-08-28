/**
 * chunkedLazSource.ts — feed a chunked LAZ file to the out-of-core indexer.
 *
 * The uncompressed sibling {@link openSlicedLasSource} reads a plain LAS as
 * bounded batches of packed tile records. A modern LAZ compresses its points in
 * independent chunks and carries a table of per-chunk byte ranges, so the same
 * out-of-core shape is reachable without ever holding the whole file: read the
 * header, the laszip VLR and the chunk table over three small range reads
 * ({@link readLazChunkTable}), then decode one bounded window of chunks at a
 * time, pack each decoded chunk into fixed-length tile records, yield it, and
 * discard it before the next window. Peak residency is a window of chunks, never
 * the cloud.
 *
 * Scope is deliberate and matches the two format audits. Only a LAZ whose chunk
 * table {@link readLazChunkTable} can randomly address is supported; a pointwise
 * (pre-chunking) LAZ, an interrupted writer, or any table defect throws
 * {@link ChunkedLazUnsupportedError} rather than falling back to a whole-file
 * read. Only the point formats the per-chunk laz-perf decoder is exercised for
 * (PDRF 6, 7, 8 — the set the committed multichunk fixture uses) are decoded;
 * any other format is refused by name through the same error.
 *
 * Re-iterable because `batches()` re-reads chunks from the {@link RangeSource}
 * on each call, so the indexer's optional bounds pass and its bucketing pass see
 * identical points. Pure and RangeSource-only, so the whole build is Node-
 * testable through laz-perf's WASM decoder; the browser passes an OPFS-file
 * RangeSource and an OPFS spill store.
 */
import type { RangeSource } from '../range/RangeSource';
import { parseLasHeader, type LasHeader } from '../lasHeader';
import {
  decodeContext,
  finalizeRawColors,
  type DecodeContext,
} from '../lasDecodeShared';
import { getLazPerf } from '../lazDecode';
import { readLazChunkTable, type LazChunkRange } from './lazChunkTable';
import {
  MAX_DECODED_ALLOCATION_BYTES,
  MAX_DECODE_PEAK_BYTES,
  decodedBytesFor,
  withinDecodedByteBudget,
  withinDecodePeakBudget,
} from './heavyByteBudget';
import { decodeLazChunkLocal, type LazChunkJob } from './decodeLazChunked';
import type { PointSource, PositionBatch, SourceHeader } from './oocIndexer';
import {
  packTileRecord,
  tileRecordBytes,
  tileSchemaForHeader,
  type TileSchema,
} from './tileRecord';

/** Point formats the per-chunk laz-perf decoder is exercised for (COPC's set). */
const CHUNK_DECODE_FORMATS = new Set([6, 7, 8]);

/**
 * Fixed prefix read for the LAS public header, sized so a header parse never
 * pulls more than a few kilobytes. The full VLR-region read the chunk table
 * needs is bounded separately by `offsetToPointData`.
 */
const HEADER_PROBE_BYTES = 8 * 1024;

/**
 * How many consecutive chunks to pull and decode per range read. Chunks are
 * stored back to back, so a window reads one contiguous span, decodes each chunk
 * in it, and frees the span before the next. The default keeps a real
 * multi-gigabyte cloud (thousands of ~50 000-point chunks) streaming a few chunks
 * at a time; a test lowers it to prove the largest read never approaches the file.
 */
export const DEFAULT_CHUNK_WINDOW = 4;

/**
 * Hard ceiling on the ONE contiguous span a window may range-read. Defense in
 * depth behind the per-chunk caps in {@link readLazChunkTable}: even when every
 * chunk is individually legal, a wide window of them would otherwise read an
 * unbounded contiguous span into memory at once. 128 MiB matches the build's
 * staging budget; real chunks are sub-megabyte, so a window of a few never
 * approaches it and this only bites a pathological run of large-but-legal
 * chunks, shrinking the window (never below one chunk, which the per-chunk
 * compressed cap already bounds well under this).
 */
export const MAX_LAZ_WINDOW_SPAN_BYTES = 128 * 1024 * 1024;

/**
 * Plan the next window starting at `start`: grow it while the contiguous span
 * from the first chunk's offset stays under {@link MAX_LAZ_WINDOW_SPAN_BYTES},
 * the aggregate DECODED bytes of the window stay under
 * {@link MAX_DECODED_ALLOCATION_BYTES}, the summed simultaneous peak
 * (span + decoded + packed) stays under {@link MAX_DECODE_PEAK_BYTES}, and it is
 * under `window` chunks — but always take at least one chunk. The decoded-byte
 * cap uses the real record length (`recordLength`, 0 to skip it): the
 * compressed-span cap bounds the read, but a window of highly-compressed chunks
 * can decode to far more than it reads, and every decoded chunk in the window is
 * staged before the window advances. `packedRecordBytes` (0 to skip its term) adds
 * the packed tile records to the joint peak, since those coexist with the span and
 * the raw decode. Pure, so the shrink behaviour is unit-testable without decoding.
 * `chunks` must be non-empty at `start`.
 */
export function planChunkWindow(
  chunks: readonly LazChunkRange[],
  start: number,
  window: number,
  recordLength: number = 0,
  packedRecordBytes: number = 0,
): { end: number; spanStart: number; spanLength: number } {
  const spanStart = chunks[start].byteOffset;
  const cap = recordLength > 0 ? MAX_DECODED_ALLOCATION_BYTES : Number.POSITIVE_INFINITY;
  // The joint-peak cap only bites when the decoded size is knowable.
  const peakActive = recordLength > 0;
  let end = start + 1;
  let points = chunks[start].pointCount;
  let decoded = decodedBytesFor(points, recordLength > 0 ? recordLength : 1);
  while (end < chunks.length && end - start < window) {
    const next = chunks[end];
    const nextSpan = next.byteOffset + next.byteLength - spanStart;
    if (nextSpan > MAX_LAZ_WINDOW_SPAN_BYTES) break;
    const nextPoints = points + next.pointCount;
    const nextDecoded = decoded + decodedBytesFor(next.pointCount, recordLength > 0 ? recordLength : 1);
    if (nextDecoded > cap) break;
    if (
      peakActive &&
      !withinDecodePeakBudget(nextSpan, nextPoints, recordLength, packedRecordBytes)
    ) {
      break;
    }
    points = nextPoints;
    decoded = nextDecoded;
    end++;
  }
  const last = chunks[end - 1];
  return { end, spanStart, spanLength: last.byteOffset + last.byteLength - spanStart };
}

/**
 * A LAZ the chunked out-of-core path cannot serve: no usable chunk table, a
 * point format the per-chunk decoder does not support, or a chunk/window over the
 * decoded-byte budget. Named so the open path can route on it rather than reading
 * the file whole here. Routing does NOT mean an automatic whole-file fallback: a
 * whole-file read is permitted only when an independent load plan proves that
 * path fits in memory. When this error is raised because a chunk or window
 * exceeds the byte budget, the file is by construction too large for a bounded
 * decode, so the whole-file path cannot fit and must not be tried — the file is
 * refused with convert-to-COPC/EPT guidance.
 */
export class ChunkedLazUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkedLazUnsupportedError';
  }
}

export interface ChunkedLazOptions {
  /** Recentring origin. Defaults to the floored header minimum, as the LAS path does. */
  readonly origin?: [number, number, number];
  /** Consecutive chunks decoded per range read. Default {@link DEFAULT_CHUNK_WINDOW}. */
  readonly chunkWindow?: number;
  readonly signal?: AbortSignal;
}

export interface ChunkedLazSource {
  readonly source: PointSource;
  readonly schema: TileSchema;
  readonly recordBytes: number;
  readonly pointCount: number;
  readonly origin: [number, number, number];
  readonly header: LasHeader;
}

/**
 * Open a chunked LAZ as a {@link PointSource} of packed tile records.
 *
 * Throws {@link ChunkedLazUnsupportedError} for a LAZ without a usable chunk
 * table or with an unsupported point format, and whatever {@link parseLasHeader}
 * throws for a file that is not LAS at all. Never reads the whole file: the
 * header, VLRs and chunk table come from bounded range reads, and the points
 * stream a window of chunks at a time.
 */
export async function openChunkedLazSource(
  range: RangeSource,
  options: ChunkedLazOptions = {},
): Promise<ChunkedLazSource> {
  const size = await range.size();
  const probe = await range.readRange(0, Math.min(size, HEADER_PROBE_BYTES), options.signal);
  const probeHeader = parseLasHeader(probe);

  // Cap the chunk-table's prefix read at the point-data offset: every VLR
  // precedes the point data, so this covers the laszip VLR without pulling the
  // 4 MiB default, which on a small file would be the whole file.
  const table = await readLazChunkTable(range, options.signal, probeHeader.offsetToPointData);
  if (!table.supported) {
    throw new ChunkedLazUnsupportedError(
      `chunked LAZ out-of-core needs a usable chunk table: ${table.reason}`,
    );
  }
  const header = table.header;
  if (!CHUNK_DECODE_FORMATS.has(header.pointFormat)) {
    throw new ChunkedLazUnsupportedError(
      `chunked LAZ out-of-core supports point formats 6, 7 and 8; ` +
        `this file is point format ${header.pointFormat}`,
    );
  }

  const origin: [number, number, number] =
    options.origin ?? [
      Math.floor(header.min[0]),
      Math.floor(header.min[1]),
      Math.floor(header.min[2]),
    ];
  const ctx = decodeContext(header, origin);
  const schema = tileSchemaForHeader(header.pointFormat, ctx);
  const recordBytes = tileRecordBytes(schema);
  const chunks = table.chunks;
  const window = Math.max(1, Math.floor(options.chunkWindow ?? DEFAULT_CHUNK_WINDOW));

  const sourceHeader = chunkedSourceHeader(header.min, header.max, origin, header.pointCount);

  const source: PointSource = {
    header: sourceHeader,
    async *batches(signal): AsyncGenerator<PositionBatch> {
      if (chunks.length === 0) return;
      const lazPerf = await getLazPerf();
      for (let start = 0; start < chunks.length; ) {
        signal?.throwIfAborted();
        // One contiguous range read for the whole window: chunks are packed
        // back to back, so the span runs from the first chunk's offset to the
        // last chunk's end. `planChunkWindow` caps that span so a wide window of
        // large chunks can never read an unbounded contiguous slice. Nothing
        // outside this window is resident.
        const { end, spanStart, spanLength } = planChunkWindow(
          chunks,
          start,
          window,
          header.pointDataRecordLength,
          recordBytes,
        );
        // A window is always at least one chunk. When it shrank to a single chunk
        // whose own summed peak (its span + decoded + packed) is still over the
        // total budget, no smaller window exists: refuse via the unsupported path
        // rather than stage an over-budget decode or fall to a whole-file read.
        if (end - start === 1) {
          const only = chunks[start];
          if (
            !withinDecodePeakBudget(
              only.byteLength,
              only.pointCount,
              header.pointDataRecordLength,
              recordBytes,
            )
          ) {
            throw new ChunkedLazUnsupportedError(
              `chunked LAZ chunk of ${only.pointCount} points would peak over the ` +
                `${MAX_DECODE_PEAK_BYTES}-byte simultaneous-decode budget (compressed span + ` +
                'decoded records + packed records); convert it to COPC or EPT',
            );
          }
        }
        const windowChunks = chunks.slice(start, end);
        const span = await range.readRange(spanStart, spanLength, signal);
        for (const c of windowChunks) {
          signal?.throwIfAborted();
          yield decodeChunkBatch(lazPerf, span, spanStart, header, ctx, schema, recordBytes, c);
        }
        start = end;
      }
    },
  };

  return { source, schema, recordBytes, pointCount: header.pointCount, origin, header };
}

/** Decode one chunk out of the already-read window span into a packed batch. */
function decodeChunkBatch(
  lazPerf: Awaited<ReturnType<typeof getLazPerf>>,
  span: ArrayBuffer,
  spanStart: number,
  header: LasHeader,
  ctx: DecodeContext,
  schema: TileSchema,
  recordBytes: number,
  c: LazChunkRange,
): PositionBatch {
  // Defense in depth behind the table-read cap: never decode a chunk whose
  // records exceed the decoded-byte budget. readLazChunkTable already refuses
  // such a chunk, so a supported table cannot reach here over budget; this holds
  // even if a future caller hands in a chunk that skipped that gate.
  if (!withinDecodedByteBudget(c.pointCount, header.pointDataRecordLength)) {
    throw new ChunkedLazUnsupportedError(
      `chunked LAZ chunk decodes to ${c.pointCount} points of ${header.pointDataRecordLength} ` +
        'bytes, over the safe decode budget; convert it to COPC or EPT',
    );
  }
  const rel = c.byteOffset - spanStart;
  const job: LazChunkJob = {
    chunk: span.slice(rel, rel + c.byteLength),
    pointCount: c.pointCount,
    firstPointIndex: c.firstPointIndex,
    pointDataRecordFormat: header.pointFormat,
    pointRecordLength: header.pointDataRecordLength,
    scale: header.scale,
    offset: header.offset,
    ctx,
  };
  const raw = decodeLazChunkLocal(lazPerf, job);
  // Narrow colours per chunk, exactly as the LAS sliced reader finalizes per
  // batch, so `packTileRecord` sees `raw.colors` rather than the 16-bit staging.
  finalizeRawColors(raw);
  const records = new Uint8Array(c.pointCount * recordBytes);
  const view = new DataView(records.buffer);
  for (let i = 0; i < c.pointCount; i++) {
    packTileRecord(raw, i, schema, view, i * recordBytes);
  }
  return { positions: raw.positions, count: c.pointCount, records, recordBytes };
}

/**
 * The trusted {@link SourceHeader} that lets the indexer skip its bounds pass.
 *
 * The LAS header carries the point count and the axis-aligned bounds in WORLD
 * coordinates; the decoded batches yield positions in the origin-relative,
 * Float32 frame `decodeRecord` produces (`local = int * scale + offset - origin`,
 * narrowed to Float32). The world bounds are moved into that same frame here —
 * `Math.fround(worldBound - origin)`, one subtraction then a Float32 narrowing,
 * mirroring the decode — so the grid the header builds is the grid the bounds
 * pass would build. `pointCount` is the chunk table's total, which
 * {@link readLazChunkTable} has already checked equals the header count.
 *
 * When the count is not a finite point or the box is degenerate the header is
 * dropped and the build keeps its two-pass path. The indexer re-checks both, so
 * an honest-but-imprecise header stays correct, only slower.
 */
function chunkedSourceHeader(
  worldMin: readonly [number, number, number],
  worldMax: readonly [number, number, number],
  origin: readonly [number, number, number],
  pointCount: number,
): SourceHeader | undefined {
  if (!Number.isFinite(pointCount) || pointCount < 1) return undefined;
  const min: [number, number, number] = [
    Math.fround(worldMin[0] - origin[0]),
    Math.fround(worldMin[1] - origin[1]),
    Math.fround(worldMin[2] - origin[2]),
  ];
  const max: [number, number, number] = [
    Math.fround(worldMax[0] - origin[0]),
    Math.fround(worldMax[1] - origin[1]),
    Math.fround(worldMax[2] - origin[2]),
  ];
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a])) return undefined;
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(extent > 0)) return undefined;
  return { pointCount, min, max };
}
