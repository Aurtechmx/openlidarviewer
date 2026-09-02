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
 *
 * STRIDE. A fast-load decode keeps one record per bucket of `stride`, and
 * `strideSample.ts` is the reference definition of WHICH records those are — a
 * pure function of the count, the step and a fixed seed. So the kept set is
 * computed once up front, split across the chunk table, and each chunk emits
 * only its own slice of it, in ascending order; the reassembly is the same
 * ascending order the legacy decoder writes in. Every chunk is still decoded
 * (laz-perf decompresses a chunk as a unit, and a bucket is far smaller than a
 * chunk), so a strided parallel decode does the same decompression work as
 * `decodeLaz` — only spread over cores, and storing only the kept records.
 */
import { readLazChunkTable, type LazChunkRange } from './lazChunkTable';
import { ArrayBufferRangeSource } from '../range/ArrayBufferRangeSource';
import { decompressChunk } from '../copc/copcChunkDecompress';
import { getLazPerf, type LazPerfModule } from '../lazDecode';
import {
  decodeContext,
  decodeRecord,
  allocRawPoints,
  decodingUpdate,
  finalizeRawColors,
  type DecodeContext,
  type RawPoints,
} from '../lasDecodeShared';
import { stratifiedSampleIndices } from '../strideSample';
import type { ProgressUpdate } from '../loadProgress';
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
  /**
   * The chunk's compressed bytes. An `ArrayBuffer` (the whole-file and worker
   * paths own a standalone copy that structured-clone can transfer), or a
   * `Uint8Array` VIEW into a larger already-resident buffer — the out-of-core
   * window path hands a view into its window span so the chunk is not copied out
   * of the span a second time. A view-bearing job must be decoded in-process
   * ({@link decodeLazChunkLocal}), never posted to a worker, since cloning a view
   * would carry its whole backing buffer.
   */
  readonly chunk: ArrayBuffer | Uint8Array;
  readonly pointCount: number;
  readonly firstPointIndex: number;
  readonly pointDataRecordFormat: number;
  readonly pointRecordLength: number;
  readonly scale: [number, number, number];
  readonly offset: [number, number, number];
  readonly ctx: DecodeContext;
  /**
   * Ascending chunk-LOCAL record indices to emit, or undefined to emit every
   * record. This is the chunk's slice of the whole-file stratified sample (see
   * `strideSample.ts`); filtering here rather than after assembly is what keeps
   * a strided decode's buffers sized to the sample instead of the file. Small
   * enough to be copied into a worker message (one uint32 per kept record).
   */
  readonly keep?: Uint32Array;
  /**
   * Where this chunk's emitted records start in the whole-file output. Equal to
   * `firstPointIndex` for a full decode; for a strided one it is the number of
   * records the earlier chunks keep. Defaults to `firstPointIndex`.
   */
  readonly outIndex?: number;
}

/**
 * Decode ONE chunk into a chunk-local `RawPoints`, holding the records `keep`
 * selects (every record when it is absent) at indices 0..kept-1, in the order
 * `keep` lists them. Colours are left STAGED (16-bit, not narrowed): the
 * whole-file narrowing is a per-file decision the caller applies once after
 * every chunk is assembled, so two chunks can never disagree on colour depth.
 * Shared by the sequential decoder, the parallel orchestrator, and the worker,
 * so all three extract the SAME way the legacy path does.
 *
 * The whole chunk is still decompressed whatever `keep` holds — a laszip chunk
 * is one arithmetic-coded unit and its records cannot be reached out of order.
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
  const keep = job.keep;
  const kept = keep ? keep.length : job.pointCount;
  const local = allocRawPoints(kept, job.ctx.gpsTimeOffset !== null, job.ctx.rgbOffset !== null);
  for (let j = 0; j < kept; j++) {
    const record = keep ? keep[j] : j;
    decodeRecord(view, record * job.pointRecordLength, j, job.ctx, local);
  }
  return local;
}

/** Copy a chunk-local `RawPoints` into the whole-file `out` at `at`. */
function placeChunk(out: RawPoints, local: RawPoints, at: number): void {
  const p = at;
  out.positions.set(local.positions, p * 3);
  out.intensity.set(local.intensity, p);
  out.classification.set(local.classification, p);
  out.returnNumber.set(local.returnNumber, p);
  out.returnCount.set(local.returnCount, p);
  out.pointSourceId.set(local.pointSourceId, p);
  if (out.gpsTime && local.gpsTime) out.gpsTime.set(local.gpsTime, p);
  if (out.colors16 && local.colors16) out.colors16.set(local.colors16, p * 3);
}

/** One chunk's share of the decode: its byte range, what it keeps, where it lands. */
interface PlannedChunk {
  readonly range: LazChunkRange;
  /** Chunk-local indices to keep, or undefined for a full (stride 1) decode. */
  readonly keep?: Uint32Array;
  /** First output index this chunk writes. */
  readonly outIndex: number;
}

/**
 * Split the whole-file stratified sample across the chunk table.
 *
 * `stratifiedSampleIndices` is the reference definition of the record set a
 * strided decode keeps — the same indices `decodeLaz` reaches one bucket at a
 * time — so slicing that ascending list at the chunk boundaries gives each
 * chunk exactly the records it owns, and concatenating the slices in chunk
 * order reproduces the list. `readLazChunkTable` accumulates `firstPointIndex`
 * chunk by chunk and refuses a table whose counts do not sum to the header's,
 * so the ranges are contiguous, ascending and cover every record: one forward
 * walk assigns the whole sample.
 */
function partitionSample(
  chunks: readonly LazChunkRange[],
  count: number,
  step: number,
): PlannedChunk[] {
  const sample = stratifiedSampleIndices(count, step);
  const planned: PlannedChunk[] = [];
  let read = 0;
  let outIndex = 0;
  for (const range of chunks) {
    const end = range.firstPointIndex + range.pointCount;
    const start = read;
    while (read < sample.length && sample[read] < end) read++;
    const keep = new Uint32Array(read - start);
    for (let j = 0; j < keep.length; j++) keep[j] = sample[start + j] - range.firstPointIndex;
    planned.push({ range, keep, outIndex });
    outIndex += keep.length;
  }
  return planned;
}

/** Build the per-chunk job for `planned`, slicing its bytes out of the file. */
function jobFor(
  buffer: ArrayBuffer,
  header: LasHeader,
  ctx: DecodeContext,
  planned: PlannedChunk,
): LazChunkJob {
  const c = planned.range;
  return {
    chunk: buffer.slice(c.byteOffset, c.byteOffset + c.byteLength),
    pointCount: c.pointCount,
    firstPointIndex: c.firstPointIndex,
    pointDataRecordFormat: header.pointFormat,
    pointRecordLength: header.pointDataRecordLength,
    scale: header.scale,
    offset: header.offset,
    ctx,
    keep: planned.keep,
    outIndex: planned.outIndex,
  };
}

/** What both orchestrators need: the per-chunk shares and the whole-file output. */
interface ChunkedPlan {
  readonly chunks: readonly PlannedChunk[];
  readonly out: RawPoints;
  readonly ctx: DecodeContext;
  /** Records the finished decode holds — the sample size, not the file's count. */
  readonly total: number;
}

/** Options shared by the sequential and parallel whole-file chunked decoders. */
export interface ChunkedDecodeOptions {
  readonly signal?: AbortSignal;
  /**
   * Keep one record per bucket of `stride`, at the jittered offset
   * `strideSample.ts` defines (1 = every record). Same contract as `decodeLaz`.
   */
  readonly stride?: number;
  readonly onProgress?: (u: ProgressUpdate) => void;
}

/**
 * Parse the chunk table and decide whether this file can take the chunked path.
 * Returns the per-chunk shares and a fresh whole-file `out`, or `null` to fall
 * back to the legacy decoder (unsupported table, record format, or a count
 * mismatch).
 */
async function planChunked(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  stride: number,
  signal?: AbortSignal,
): Promise<ChunkedPlan | null> {
  const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), signal);
  if (!table.supported) return null;
  if (!CHUNK_DECODE_FORMATS.has(header.pointFormat)) return null;
  const tableTotal = table.chunks.reduce((a, c) => a + c.pointCount, 0);
  if (tableTotal !== header.pointCount) return null;

  const step = Math.max(1, Math.floor(stride));
  const ctx = decodeContext(header, origin);
  const chunks =
    step > 1
      ? partitionSample(table.chunks, header.pointCount, step)
      : table.chunks.map((range) => ({ range, outIndex: range.firstPointIndex }));
  // Sized to what the decode KEEPS. At stride 10 on a 90 M-point file that is
  // the 9 M-record sample, not the file.
  const total = step > 1 ? Math.ceil(header.pointCount / step) : header.pointCount;
  const out = allocRawPoints(total, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
  return { chunks, out, ctx, total };
}

/**
 * Progress reporter matching the legacy decoder's cadence: about twenty updates
 * across the decode, counted in kept records.
 */
function progressReporter(
  total: number,
  onProgress?: (u: ProgressUpdate) => void,
): (done: number) => void {
  if (!onProgress) return () => {};
  const every = Math.max(1, Math.floor(total / 20));
  let reported = 0;
  return (done: number) => {
    if (done - reported < every && done < total) return;
    reported = done;
    onProgress(decodingUpdate(done, total));
  };
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
  options: ChunkedDecodeOptions = {},
): Promise<RawPoints | null> {
  const { signal } = options;
  const plan = await planChunked(buffer, header, origin, options.stride ?? 1, signal);
  if (plan === null) return null;
  const lazPerf = await getLazPerf();
  const report = progressReporter(plan.total, options.onProgress);
  let done = 0;
  for (const planned of plan.chunks) {
    signal?.throwIfAborted();
    // A chunk the sample skips entirely holds no output record, so decompressing
    // it could not change one. Every other chunk is decoded in full.
    if (planned.keep && planned.keep.length === 0) continue;
    const job = jobFor(buffer, header, plan.ctx, planned);
    placeChunk(plan.out, decodeLazChunkLocal(lazPerf, job), planned.outIndex);
    done += planned.keep ? planned.keep.length : planned.range.pointCount;
    report(done);
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

/** {@link ChunkedDecodeOptions} plus the parallel orchestrator's in-flight bound. */
export interface ParallelDecodeOptions extends ChunkedDecodeOptions {
  /**
   * How many chunk decodes to keep in flight. Bounds both the pool's queue
   * pressure and peak memory; the default keeps the pool saturated for any real
   * cloud.
   */
  readonly maxInFlight?: number;
}

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
 * order — each is placed at its own output index, into a disjoint span of
 * `out`, so order never matters.
 *
 * With `stride > 1` each chunk emits only its slice of the stratified sample,
 * so the result is the same points `decodeLaz` keeps at that stride, in the same
 * order, in an output sized to the sample.
 */
export async function decodeLazParallel(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  decodeChunk: LazChunkDecoder,
  options: ParallelDecodeOptions = {},
): Promise<RawPoints | null> {
  const { signal } = options;
  const plan = await planChunked(buffer, header, origin, options.stride ?? 1, signal);
  if (plan === null) return null;

  const chunks = plan.chunks;
  const maxInFlight = options.maxInFlight ?? MAX_CHUNK_DECODES_IN_FLIGHT;
  const lanes = Math.max(1, Math.min(Math.floor(maxInFlight), chunks.length));
  const report = progressReporter(plan.total, options.onProgress);
  let next = 0;
  let done = 0;

  // Each lane pulls the next chunk index, slices its bytes, decodes it, and
  // places it before pulling again — so at most `lanes` compressed chunks and
  // `lanes` decodes are in flight, and each chunk-local is freed the moment it
  // is copied into `out`. Slicing here rather than up front keeps the file's
  // compressed bytes from being duplicated whole.
  const runLane = async (): Promise<void> => {
    for (let i = next++; i < chunks.length; i = next++) {
      signal?.throwIfAborted();
      const planned = chunks[i];
      // A chunk the sample skips entirely holds no output record.
      if (planned.keep && planned.keep.length === 0) continue;
      const job = jobFor(buffer, header, plan.ctx, planned);
      placeChunk(plan.out, await decodeChunk(job, signal), planned.outIndex);
      done += planned.keep ? planned.keep.length : planned.range.pointCount;
      report(done);
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));

  finalizeRawColors(plan.out);
  return plan.out;
}
