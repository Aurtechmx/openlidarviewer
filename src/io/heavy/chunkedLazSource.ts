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
 * A LAZ the chunked out-of-core path cannot serve: no usable chunk table, or a
 * point format the per-chunk decoder does not support. Named so the open path
 * can route on it (e.g. fall back to the whole-file loader) rather than reading
 * the file whole here.
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
      for (let start = 0; start < chunks.length; start += window) {
        signal?.throwIfAborted();
        const end = Math.min(start + window, chunks.length);
        const windowChunks = chunks.slice(start, end);
        // One contiguous range read for the whole window: chunks are packed
        // back to back, so the span runs from the first chunk's offset to the
        // last chunk's end. Nothing outside this window is resident.
        const spanStart = windowChunks[0].byteOffset;
        const last = windowChunks[windowChunks.length - 1];
        const spanLength = last.byteOffset + last.byteLength - spanStart;
        const span = await range.readRange(spanStart, spanLength, signal);
        for (const c of windowChunks) {
          signal?.throwIfAborted();
          yield decodeChunkBatch(lazPerf, span, spanStart, header, ctx, schema, recordBytes, c);
        }
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
