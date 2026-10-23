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
import { lasOriginFor } from '../lasDataOrigin';
import { lazRecord0 } from './lazRecord0';
import type { RangeSource } from '../range/RangeSource';
import { decodeContext, finalizeRawColors } from '../lasDecodeShared';
import { openSlicedLas } from './slicedLasReader';
import { readLazChunkTable } from './lazChunkTable';
import { withinDecodedByteBudget } from './heavyByteBudget';
import { CHUNK_DECODE_FORMATS, decodeLazChunkLocal } from './decodeLazChunked';
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
/** Longest run of consecutive records an uncompressed LAS preview reads at one place. */
const LAS_RUN_RECORDS = 1024;

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

  // Short runs over many bands: a long run of consecutive records is a few
  // whole scanner sweeps, which shows as rings rather than an even thinning.
  const bands = Math.min(total, Math.max(strata, Math.ceil(target / LAS_RUN_RECORDS)));
  const step = total / bands;
  const perBand = Math.max(1, Math.min(Math.floor(target / bands), Math.floor(total / bands)));

  const chunks: Uint8Array[] = [];
  // Sampled positions, kept only to frame a file whose header bounds are untrusted.
  const positions: Float32Array[] = [];
  let sampled = 0;
  for (let b = 0; b < bands && sampled < target; b++) {
    signal?.throwIfAborted();
    const start = Math.min(Math.floor(b * step), total - perBand);
    const count = Math.min(perBand, target - sampled);
    const batch = await opened.readBatch(start, count);
    chunks.push(packBatch(batch.raw, batch.count, schema, recordBytes));
    if (!opened.boundsTrusted) positions.push(batch.raw.positions.subarray(0, batch.count * 3));
    sampled += batch.count;
  }
  if (sampled === 0) return null;

  const { min, max } = opened.boundsTrusted
    ? localExtent(opened.header.min, opened.header.max, opened.origin)
    : extentOf(positions);
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
 * set (0 to 3, 6 to 8) — the same fail-closed set the full LAZ build supports.
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
  if (!CHUNK_DECODE_FORMATS.has(header.pointFormat)) return null;
  const chunks = table.chunks;
  if (chunks.length === 0) return null;

  const total = header.pointCount;
  if (total < MIN_PREVIEW_POINTS) return null;

  const choice = lasOriginFor(header, await lazRecord0(range, header, undefined, signal));
  const origin = choice.origin;
  const ctx = decodeContext(header, origin);
  const schema = tileSchemaForHeader(header.pointFormat, ctx);
  const recordBytes = tileRecordBytes(schema);
  const lazPerf = await getLazPerf();

  // Pick a spread of chunk indices across the file, so the decoded points span
  // the whole flight rather than its first chunks. Each pick gives an equal
  // share of the target, and there are enough picks that a share is a part of
  // a chunk: a whole chunk per pick would reach the target before the last
  // picks and leave the end of the file out.
  const meanChunk = Math.max(1, total / chunks.length);
  const wanted = Math.min(chunks.length, Math.max(strata, 4 * Math.ceil(target / meanChunk)));
  const stride = chunks.length / wanted;
  const share = Math.max(1, Math.ceil(target / wanted));

  const packed: Uint8Array[] = [];
  // Sampled positions, kept only to frame a file whose header bounds are untrusted.
  const positions: Float32Array[] = [];
  let sampled = 0;
  for (let i = 0; i < wanted && sampled < target; i++) {
    signal?.throwIfAborted();
    const c = chunks[Math.min(chunks.length - 1, Math.floor(i * stride))];
    // Per-chunk decoded-byte refusal, the same cap the full build enforces. The
    // sampler decodes a WHOLE chunk before taking the `take` points it
    // needs, so a chunk whose `pointCount * pointDataRecordLength` is over budget
    // would stage the whole over-budget decode just for a preview. Skip this
    // chunk rather than decode it — a "preview skipped: chunk exceeds safe decode
    // budget" case, distinct from the "preview unavailable" that a null table or
    // an unsupported format yields. readLazChunkTable already refuses such a
    // chunk, so a supported table should never reach here; this stays as the
    // sampler's own guard against decoding past budget.
    // `pointSemantics` is omitted (defaults off) below: the sampler has no
    // option of its own to see — it always decodes into the tile schema,
    // which never carries those five channels.
    if (!withinDecodedByteBudget(c.pointCount, header.pointDataRecordLength, undefined, header.pointFormat)) {
      continue;
    }
    // One bounded range read per chunk — never the whole file.
    const bytes = await range.readRange(c.byteOffset, c.byteLength, signal);
    // `pointSemantics` is left at its default (off): the preview repacks into
    // the same tile schema as the out-of-core path, which carries none of
    // those five channels.
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
    const take = Math.min(c.pointCount, share, target - sampled);
    // Spread the share across the whole chunk: a chunk is a stretch of scan
    // time, and its first records alone trace a few whole scanner sweeps.
    const picks = spreadIndices(c.pointCount, take);
    packed.push(packBatch(raw, take, schema, recordBytes, picks));
    if (!choice.boundsTrusted) positions.push(pickedPositions(raw.positions, picks));
    sampled += take;
  }
  if (sampled === 0) return null;

  const { min, max } = choice.boundsTrusted
    ? localExtent(header.min, header.max, origin)
    : extentOf(positions);
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

/** Local extent of the sampled positions themselves. */
function extentOf(parts: readonly Float32Array[]): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a];
        if (!Number.isFinite(v)) continue;
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  for (let a = 0; a < 3; a++) {
    if (!(min[a] <= max[a])) {
      min[a] = 0;
      max[a] = 0;
    }
  }
  return { min, max };
}

/** `count` indices spread evenly over `0 .. total - 1`, ascending. */
function spreadIndices(total: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  const step = total / count;
  for (let i = 0; i < count; i++) out[i] = Math.min(total - 1, Math.floor(i * step));
  return out;
}

/** The positions of the picked points, for framing a file with untrusted bounds. */
function pickedPositions(positions: Float32Array, picks: Uint32Array): Float32Array {
  const out = new Float32Array(picks.length * 3);
  for (let i = 0; i < picks.length; i++) out.set(positions.subarray(picks[i] * 3, picks[i] * 3 + 3), i * 3);
  return out;
}

/** Pack `count` points of a decoded batch into tile records: the first ones, or the `picks`. */
function packBatch(
  raw: import('../lasDecodeShared').RawPoints,
  count: number,
  schema: TileSchema,
  recordBytes: number,
  picks?: Uint32Array,
): Uint8Array {
  const out = new Uint8Array(count * recordBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) packTileRecord(raw, picks ? picks[i] : i, schema, view, i * recordBytes);
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
