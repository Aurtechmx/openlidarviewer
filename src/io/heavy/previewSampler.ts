/**
 * previewSampler.ts — a stratified, bounded sample of a heavy cloud.
 *
 * The out-of-core index build blocks for a long time on a multi-gigabyte file,
 * and until it returns nothing is on screen. This module reads a small,
 * spatially spread SAMPLE of the cloud from bounded range reads so a
 * representative view can render immediately while the full index builds behind
 * it. The sample is a spread ACROSS the whole file, not the first N points:
 * airborne LAS is flightline-ordered, so the front of the file is one corner of
 * the flight, and a front-only sample would show a sliver rather than the scene.
 *
 * The reads are bounded exactly like the rest of the out-of-core path. For an
 * uncompressed LAS the point records are fixed-size and randomly addressable, so
 * the sampler seeks to evenly spaced strata and reads one small batch at each
 * ({@link openSlicedLas}'s `readBatch`), never the whole file. For a chunked LAZ
 * it reads the chunk table ({@link readLazChunkTable}) and decodes a spread of
 * individual chunks, one bounded range read each. The largest single read is one
 * stratum batch (LAS) or one chunk span (LAZ), far smaller than the file.
 *
 * The decoded points are packed into the same fixed-length tile records the
 * out-of-core store uses ({@link packTileRecord}), so the preview streams
 * through the existing {@link TileChunkDecoder} rather than a parallel decoder.
 * A lighter direct read is used rather than the sequential
 * {@link openSlicedLasSource} / {@link openChunkedLazSource} `PointSource`
 * wrappers because those iterate the WHOLE file in order; the sample needs to
 * seek to a spread of positions and stop, which is cleaner expressed directly on
 * the reader and the chunk table while reusing their record packing.
 *
 * Pure, RangeSource-only — Node-testable over an ArrayBufferRangeSource.
 */
import type { RangeSource } from '../range/RangeSource';
import { decodeContext, finalizeRawColors } from '../lasDecodeShared';
import { openSlicedLas } from './slicedLasReader';
import { readLazChunkTable } from './lazChunkTable';
import { withinDecodedByteBudget } from './heavyByteBudget';
import { decodeLazChunkLocal } from './decodeLazChunked';
import { getLazPerf } from '../lazDecode';
import {
  packTileRecord,
  tileRecordBytes,
  tileSchemaForHeader,
  type TileSchema,
} from './tileRecord';

/** A bounded, stratified sample ready to wrap as a preview streaming source. */
export interface PreviewSample {
  /** Every sampled point packed as a fixed-length tile record, back to back. */
  readonly records: Uint8Array;
  readonly recordBytes: number;
  readonly schema: TileSchema;
  /** How many points the sample holds — the ONLY count a preview may claim. */
  readonly pointCount: number;
  /** The recentring origin (floored header minimum), world = local + origin. */
  readonly origin: [number, number, number];
  /** The file's tight extent in local (render) space, from the LAS header. */
  readonly localMin: [number, number, number];
  readonly localMax: [number, number, number];
}

export interface PreviewSampleOptions {
  /** Upper bound on the sampled point count. Default one million. */
  readonly targetPoints?: number;
  /** How many strata to spread the reads across. Default 64. */
  readonly strata?: number;
  readonly signal?: AbortSignal;
}

/** Target sampled points — the cap the design names, on the order of a million. */
const DEFAULT_TARGET_POINTS = 1_000_000;
/** Strata to spread the reads across the file. */
const DEFAULT_STRATA = 64;
/**
 * Below this the file is not worth previewing: the full build will return about
 * as fast as the sample renders, so a preview only adds a flash of a second
 * cloud. Heavy files are far larger than this; a tiny fixture returns null.
 */
const MIN_PREVIEW_POINTS = 50_000;

/** Local (render) extent of the file from its world header bounds and origin. */
function localExtent(
  worldMin: readonly number[],
  worldMax: readonly number[],
  origin: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [
      Math.fround(worldMin[0] - origin[0]),
      Math.fround(worldMin[1] - origin[1]),
      Math.fround(worldMin[2] - origin[2]),
    ],
    max: [
      Math.fround(worldMax[0] - origin[0]),
      Math.fround(worldMax[1] - origin[1]),
      Math.fround(worldMax[2] - origin[2]),
    ],
  };
}

/**
 * Build a stratified preview sample, or null when the file is too small to be
 * worth one or the sample cannot be built. Null covers two distinct cases, both
 * best-effort and neither a failed open: "preview unavailable" (an unsupported
 * LAZ table, a point format outside the decoder's set, a decode fault, or a file
 * under the preview-worth threshold) and "preview skipped: chunk exceeds safe
 * decode budget" (a chunk whose decoded records are over the byte budget is not
 * decoded for a preview). The caller opens with no preview and waits for the full
 * index either way.
 */
export async function buildPreviewSample(
  range: RangeSource,
  facts: { readonly format: 'las' | 'laz'; readonly offsetToPointData: number },
  options: PreviewSampleOptions = {},
): Promise<PreviewSample | null> {
  const target = Math.max(1, Math.floor(options.targetPoints ?? DEFAULT_TARGET_POINTS));
  const strata = Math.max(1, Math.floor(options.strata ?? DEFAULT_STRATA));
  const signal = options.signal;
  try {
    return facts.format === 'laz'
      ? await sampleLaz(range, facts.offsetToPointData, target, strata, signal)
      : await sampleLas(range, target, strata, signal);
  } catch {
    // Best effort: any read or decode fault means no preview, not a failed open.
    return null;
  }
}

/**
 * Sample an uncompressed LAS: divide the readable points into `strata` even
 * bands and read one small batch at the start of each, so the sample spans the
 * whole file. Each batch is one bounded {@link RangeSource} range.
 */
async function sampleLas(
  range: RangeSource,
  target: number,
  strata: number,
  signal: AbortSignal | undefined,
): Promise<PreviewSample | null> {
  const opened = await openSlicedLas(range, { signal });
  const total = opened.readablePointCount;
  if (total < MIN_PREVIEW_POINTS) return null;

  const ctx = decodeContext(opened.header, opened.origin);
  const schema = tileSchemaForHeader(opened.header.pointFormat, ctx);
  const recordBytes = tileRecordBytes(schema);

  const bands = Math.min(strata, total);
  const step = total / bands;
  const perBand = Math.max(1, Math.min(Math.floor(target / bands), Math.floor(total / bands)));

  const chunks: Uint8Array[] = [];
  let sampled = 0;
  for (let b = 0; b < bands && sampled < target; b++) {
    signal?.throwIfAborted();
    const start = Math.min(Math.floor(b * step), total - perBand);
    const count = Math.min(perBand, target - sampled);
    const batch = await opened.readBatch(start, count);
    chunks.push(packBatch(batch.raw, batch.count, schema, recordBytes));
    sampled += batch.count;
  }
  if (sampled === 0) return null;

  const { min, max } = localExtent(opened.header.min, opened.header.max, opened.origin);
  return {
    records: concat(chunks, sampled * recordBytes),
    recordBytes,
    schema,
    pointCount: sampled,
    origin: opened.origin,
    localMin: min,
    localMax: max,
  };
}

/**
 * Sample a chunked LAZ: read the chunk table, pick a spread of chunks across the
 * file, and decode each one from its own bounded range read. Returns null when
 * the table is unusable or the point format is outside the per-chunk decoder's
 * set (6, 7, 8) — the same fail-closed set the full LAZ build supports.
 */
async function sampleLaz(
  range: RangeSource,
  offsetToPointData: number,
  target: number,
  strata: number,
  signal: AbortSignal | undefined,
): Promise<PreviewSample | null> {
  const table = await readLazChunkTable(range, signal, offsetToPointData);
  if (!table.supported) return null;
  const header = table.header;
  if (![6, 7, 8].includes(header.pointFormat)) return null;
  const chunks = table.chunks;
  if (chunks.length === 0) return null;

  const total = header.pointCount;
  if (total < MIN_PREVIEW_POINTS) return null;

  const origin: [number, number, number] = [
    Math.floor(header.min[0]),
    Math.floor(header.min[1]),
    Math.floor(header.min[2]),
  ];
  const ctx = decodeContext(header, origin);
  const schema = tileSchemaForHeader(header.pointFormat, ctx);
  const recordBytes = tileRecordBytes(schema);
  const lazPerf = await getLazPerf();

  // Pick a spread of chunk indices across the file, so the decoded points span
  // the whole flight rather than its first chunks.
  const wanted = Math.min(strata, chunks.length);
  const stride = chunks.length / wanted;

  const packed: Uint8Array[] = [];
  let sampled = 0;
  for (let i = 0; i < wanted && sampled < target; i++) {
    signal?.throwIfAborted();
    const c = chunks[Math.min(chunks.length - 1, Math.floor(i * stride))];
    // Per-chunk decoded-byte refusal, the same cap the full build enforces. The
    // sampler decodes a WHOLE chunk before taking the first `take` points it
    // needs, so a chunk whose `pointCount * pointDataRecordLength` is over budget
    // would stage the whole over-budget decode just for a preview. Skip this
    // chunk rather than decode it — a "preview skipped: chunk exceeds safe decode
    // budget" case, distinct from the "preview unavailable" that a null table or
    // an unsupported format yields. readLazChunkTable already refuses such a
    // chunk, so a supported table should never reach here; this stays as the
    // sampler's own guard against decoding past budget.
    if (!withinDecodedByteBudget(c.pointCount, header.pointDataRecordLength)) continue;
    // One bounded range read per chunk — never the whole file.
    const bytes = await range.readRange(c.byteOffset, c.byteLength, signal);
    const raw = decodeLazChunkLocal(lazPerf, {
      chunk: bytes,
      pointCount: c.pointCount,
      firstPointIndex: c.firstPointIndex,
      pointDataRecordFormat: header.pointFormat,
      pointRecordLength: header.pointDataRecordLength,
      scale: header.scale,
      offset: header.offset,
      ctx,
    });
    finalizeRawColors(raw);
    const take = Math.min(c.pointCount, target - sampled);
    packed.push(packBatch(raw, take, schema, recordBytes));
    sampled += take;
  }
  if (sampled === 0) return null;

  const { min, max } = localExtent(header.min, header.max, origin);
  return {
    records: concat(packed, sampled * recordBytes),
    recordBytes,
    schema,
    pointCount: sampled,
    origin,
    localMin: min,
    localMax: max,
  };
}

/** Pack the first `count` points of a decoded batch into tile records. */
function packBatch(
  raw: import('../lasDecodeShared').RawPoints,
  count: number,
  schema: TileSchema,
  recordBytes: number,
): Uint8Array {
  const out = new Uint8Array(count * recordBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) packTileRecord(raw, i, schema, view, i * recordBytes);
  return out;
}

/** Concatenate packed batches into one contiguous record buffer. */
function concat(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
