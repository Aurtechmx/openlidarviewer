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
import { readLazChunkTable, type LazChunkRange } from './lazChunkTable';
import { ArrayBufferRangeSource } from '../range/ArrayBufferRangeSource';
import { decompressChunk } from '../copc/copcChunkDecompress';
import { getLazPerf, type LazPerfModule } from '../lazDecode';
import {
  decodeContext,
  decodeRecord,
  allocRawPoints,
  finalizeRawColors,
  type DecodeContext,
  type RawPoints,
} from '../lasDecodeShared';
import type { LasHeader } from '../lasHeader';

/** Record formats the per-chunk laz-perf decoder is exercised for (COPC's set). */
const CHUNK_DECODE_FORMATS = new Set([6, 7, 8]);

/**
 * Everything one chunk needs to decode into a chunk-LOCAL `RawPoints`, with no
 * reference to the whole file: the compressed bytes plus the small scalars the
 * record decoder reads. This is the unit a worker receives; `chunk` is the only
 * transferable and the rest are copied into the message.
 */
export interface LazChunkJob {
  readonly chunk: ArrayBuffer;
  readonly pointCount: number;
  readonly firstPointIndex: number;
  readonly pointDataRecordFormat: number;
  readonly pointRecordLength: number;
  readonly scale: [number, number, number];
  readonly offset: [number, number, number];
  readonly ctx: DecodeContext;
}

/**
 * Decode ONE chunk into a chunk-local `RawPoints`, indices 0..pointCount-1.
 * Colours are left STAGED (16-bit, not narrowed): the whole-file narrowing is a
 * per-file decision the caller applies once after every chunk is assembled, so
 * two chunks can never disagree on colour depth. Shared by the sequential
 * decoder, the parallel orchestrator, and the worker, so all three extract the
 * SAME way the legacy path does.
 */
export function decodeLazChunkLocal(lazPerf: LazPerfModule, job: LazChunkJob): RawPoints {
  const records = decompressChunk(lazPerf, job.chunk, {
    pointDataRecordFormat: job.pointDataRecordFormat,
    pointRecordLength: job.pointRecordLength,
    pointCount: job.pointCount,
    scale: job.scale,
    offset: job.offset,
    renderOrigin: job.ctx.origin,
  });
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const local = allocRawPoints(job.pointCount, job.ctx.gpsTimeOffset !== null, job.ctx.rgbOffset !== null);
  for (let j = 0; j < job.pointCount; j++) {
    decodeRecord(view, j * job.pointRecordLength, j, job.ctx, local);
  }
  return local;
}

/** Copy a chunk-local `RawPoints` into the whole-file `out` at `firstPointIndex`. */
function placeChunk(out: RawPoints, local: RawPoints, firstPointIndex: number): void {
  const p = firstPointIndex;
  out.positions.set(local.positions, p * 3);
  out.intensity.set(local.intensity, p);
  out.classification.set(local.classification, p);
  out.returnNumber.set(local.returnNumber, p);
  out.returnCount.set(local.returnCount, p);
  out.pointSourceId.set(local.pointSourceId, p);
  if (out.gpsTime && local.gpsTime) out.gpsTime.set(local.gpsTime, p);
  if (out.colors16 && local.colors16) out.colors16.set(local.colors16, p * 3);
}

/** Build the per-chunk job for chunk `c`, slicing its bytes out of the file. */
function jobFor(buffer: ArrayBuffer, header: LasHeader, ctx: DecodeContext, c: LazChunkRange): LazChunkJob {
  return {
    chunk: buffer.slice(c.byteOffset, c.byteOffset + c.byteLength),
    pointCount: c.pointCount,
    firstPointIndex: c.firstPointIndex,
    pointDataRecordFormat: header.pointFormat,
    pointRecordLength: header.pointDataRecordLength,
    scale: header.scale,
    offset: header.offset,
    ctx,
  };
}

/**
 * Parse the chunk table and decide whether this file can take the chunked path.
 * Returns the chunk jobs and a fresh whole-file `out`, or `null` to fall back to
 * the legacy decoder (unsupported table, record format, or a count mismatch).
 */
async function planChunked(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  signal?: AbortSignal,
): Promise<{ jobs: LazChunkJob[]; out: RawPoints; ctx: DecodeContext } | null> {
  const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), signal);
  if (!table.supported) return null;
  if (!CHUNK_DECODE_FORMATS.has(header.pointFormat)) return null;
  const tableTotal = table.chunks.reduce((a, c) => a + c.pointCount, 0);
  if (tableTotal !== header.pointCount) return null;

  const ctx = decodeContext(header, origin);
  const out = allocRawPoints(header.pointCount, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
  const jobs = table.chunks.map((c) => jobFor(buffer, header, ctx, c));
  return { jobs, out, ctx };
}

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
  const plan = await planChunked(buffer, header, origin, signal);
  if (plan === null) return null;
  const lazPerf = await getLazPerf();
  for (const job of plan.jobs) {
    signal?.throwIfAborted();
    placeChunk(plan.out, decodeLazChunkLocal(lazPerf, job), job.firstPointIndex);
  }
  finalizeRawColors(plan.out);
  return plan.out;
}

/**
 * A decoder for one chunk. The production implementation submits the job to a
 * worker pool and resolves with the worker's chunk-local `RawPoints`; a test
 * implementation runs {@link decodeLazChunkLocal} synchronously. The orchestrator
 * below is identical for both — it only assembles.
 */
export type LazChunkDecoder = (job: LazChunkJob, signal?: AbortSignal) => Promise<RawPoints>;

/**
 * How many chunk decodes to keep in flight at once. A real cloud has many more
 * chunks than a worker pool has workers (a laszip chunk defaults to 50 000
 * points, so an 8 M-point file is ~160 chunks), and a worker pool bounds its
 * wait queue (`DecodeWorkerPool` defaults to 64) — submitting every chunk at
 * once overflows it. This window keeps the pool's four workers (the decode hard
 * cap) saturated with headroom to spare while staying well under that bound, and
 * places each chunk the instant it decodes so only a window's worth of
 * chunk-local buffers is ever held, not the whole cloud twice over.
 */
const MAX_CHUNK_DECODES_IN_FLIGHT = 16;

/**
 * Decode a whole LAZ by feeding its chunks through `decodeChunk` with a bounded
 * number in flight, assembling each into the whole-file `out` the instant it
 * returns. When `decodeChunk` is backed by a worker pool the chunks decode
 * concurrently, one per core; the assembly and the single whole-file colour
 * narrowing are identical to the sequential path, so the output is the same
 * `RawPoints`. Returns `null` for a file the chunked path does not support,
 * exactly like the sequential decoder.
 *
 * `maxInFlight` bounds both the pool's queue pressure and peak memory; the
 * default keeps the pool saturated for any real cloud. Chunks may finish out of
 * order — each is placed at its own `firstPointIndex`, into a disjoint span of
 * `out`, so order never matters.
 */
export async function decodeLazParallel(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  decodeChunk: LazChunkDecoder,
  signal?: AbortSignal,
  maxInFlight: number = MAX_CHUNK_DECODES_IN_FLIGHT,
): Promise<RawPoints | null> {
  const plan = await planChunked(buffer, header, origin, signal);
  if (plan === null) return null;

  const jobs = plan.jobs;
  const lanes = Math.max(1, Math.min(Math.floor(maxInFlight), jobs.length));
  let next = 0;

  // Each lane pulls the next chunk index, decodes it, and places it before
  // pulling again — so at most `lanes` decodes are in flight and each
  // chunk-local is freed the moment it is copied into `out`.
  const runLane = async (): Promise<void> => {
    for (let i = next++; i < jobs.length; i = next++) {
      signal?.throwIfAborted();
      placeChunk(plan.out, await decodeChunk(jobs[i], signal), jobs[i].firstPointIndex);
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));

  finalizeRawColors(plan.out);
  return plan.out;
}
