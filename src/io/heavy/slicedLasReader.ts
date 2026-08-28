/**
 * slicedLasReader.ts — out-of-core batches from an uncompressed LAS file.
 *
 * Uncompressed LAS records are fixed-length and randomly addressable, so a
 * file of any size reads as a sequence of bounded slices: one header read,
 * then one {@link RangeSource} range per batch of records. Peak memory is one
 * batch — never the file — which removes the single-ArrayBuffer ceiling for
 * plain LAS, and batches are independent, so a worker pool can decode them
 * concurrently the same way the LAZ path decodes chunks.
 *
 * Decoding reuses the shared per-record path (`decodeContext` /
 * `decodeRecord`), so a batch's values are bit-identical to what the
 * whole-file loader produces for the same records — the parity the test
 * suite asserts against a fixture. Batches surface the shared {@link RawPoints}
 * shape; positions in it are origin-relative source-local, the frame every
 * consumer of that shape already handles.
 *
 * Pure, RangeSource-only — unit-tested in Node.
 */
import type { RangeSource } from '../range/RangeSource';
import { parseLasHeader, pointFormatHasRgb, type LasHeader } from '../lasHeader';
import {
  allocRawPoints,
  decodeContext,
  decodeRecord,
  finalizeRawColors,
  type RawPoints,
} from '../lasDecodeShared';
import {
  MAX_BATCH_SOURCE_BYTES,
  batchPointsForRecordLength,
  maxPointsForRecordLength,
} from './heavyByteBudget';

/** One decoded batch of consecutive records. */
export interface SlicedLasBatch {
  /** Index of the batch's first point in file order. */
  readonly firstPointIndex: number;
  readonly count: number;
  /** Shared decoded shape; colours are finalized per batch. */
  readonly raw: RawPoints;
}

export interface SlicedLasOptions {
  /** Points per batch. The default keeps a batch under ~10 MB decoded. */
  readonly batchPoints?: number;
  /**
   * Recentring origin. Defaults to the floored header minimum — the same
   * origin the whole-file loader derives, so batch positions line up with it.
   */
  readonly origin?: [number, number, number];
  readonly signal?: AbortSignal;
}

const DEFAULT_BATCH_POINTS = 262_144;

/** Head read covering header + VLRs, capped against hostile offsets. */
const MAX_HEAD_BYTES = 4 * 1024 * 1024;

export interface SlicedLasOpen {
  readonly header: LasHeader;
  /**
   * Points actually readable: the declared count clamped to what the bytes
   * after the header can hold, mirroring the whole-file loader's clamp so a
   * truncated file yields its readable prefix instead of a fault.
   */
  readonly readablePointCount: number;
  /** The point count the header declares, before any truncation clamp. */
  readonly declaredPointCount: number;
  /**
   * Whether the file physically holds every declared point. `false` when the
   * bytes after the header cannot back the declared count — a truncated scan.
   * Carried so a truncated file is never presented as a complete smaller one:
   * `readablePointCount < declaredPointCount` iff this is `false`.
   */
  readonly complete: boolean;
  readonly origin: [number, number, number];
  /** Read one batch of `count` records starting at `firstPointIndex`. */
  readBatch(firstPointIndex: number, count: number): Promise<SlicedLasBatch>;
  /** Iterate every batch in file order. */
  batches(): AsyncGenerator<SlicedLasBatch>;
}

/**
 * Open an uncompressed LAS file for sliced batch reading. Throws what
 * {@link parseLasHeader} throws on a non-LAS buffer.
 */
export async function openSlicedLas(
  range: RangeSource,
  options: SlicedLasOptions = {},
): Promise<SlicedLasOpen> {
  const size = await range.size();
  const head = await range.readRange(0, Math.min(size, MAX_HEAD_BYTES), options.signal);
  const header = parseLasHeader(head);

  const recordLength = header.pointDataRecordLength;
  const capacity =
    size > header.offsetToPointData
      ? Math.floor((size - header.offsetToPointData) / recordLength)
      : 0;
  const readablePointCount = Math.min(header.pointCount, capacity);
  const declaredPointCount = header.pointCount;
  const complete = readablePointCount >= declaredPointCount;

  const origin: [number, number, number] =
    options.origin ?? [Math.floor(header.min[0]), Math.floor(header.min[1]), Math.floor(header.min[2])];
  const ctx = decodeContext(header, origin);
  const hasColor = pointFormatHasRgb(header.pointFormat);
  const hasGps = ctx.gpsTimeOffset !== null;
  // Cap the batch by a source-byte ceiling, not a flat point count: one batch is
  // read straight off disk as `batchPoints * recordLength` bytes, and LAS Extra
  // Bytes lets recordLength reach 65535, so the default 262 144 points would read
  // ~1 GiB+ in a single range read. `batchPointsForRecordLength` clamps the read
  // to MAX_BATCH_SOURCE_BYTES while never dropping below one point.
  const batchPoints = batchPointsForRecordLength(
    recordLength,
    Math.max(1, options.batchPoints ?? DEFAULT_BATCH_POINTS),
  );
  const signal = options.signal;

  async function readBatch(firstPointIndex: number, count: number): Promise<SlicedLasBatch> {
    if (firstPointIndex < 0 || count <= 0 || firstPointIndex + count > readablePointCount) {
      throw new RangeError(
        `batch [${firstPointIndex}, ${firstPointIndex + count}) is outside the readable ` +
          `range [0, ${readablePointCount})`,
      );
    }
    // Enforce the source-byte cap INSIDE readBatch, not only in `batches()`, so a
    // caller passing a large `count` directly (the preview sampler reads
    // strata-sized counts) can never issue a single range read above the ceiling:
    // with Extra Bytes the record length reaches 65535, and `count * recordLength`
    // would otherwise read a gigabyte in one shot. The batch is assembled from
    // bounded sub-ranges of at most MAX_BATCH_SOURCE_BYTES; the returned `count`
    // points are unchanged, and nothing beyond the returned batch is materialised.
    const raw = allocRawPoints(count, hasGps, hasColor);
    const maxPerRead = maxPointsForRecordLength(recordLength, MAX_BATCH_SOURCE_BYTES);
    for (let done = 0; done < count; done += maxPerRead) {
      signal?.throwIfAborted();
      const n = Math.min(maxPerRead, count - done);
      const byteOffset = header.offsetToPointData + (firstPointIndex + done) * recordLength;
      const bytes = await range.readRange(byteOffset, n * recordLength, signal);
      const view = new DataView(bytes);
      for (let i = 0; i < n; i++) {
        decodeRecord(view, i * recordLength, done + i, ctx, raw);
      }
    }
    finalizeRawColors(raw);
    return { firstPointIndex, count, raw };
  }

  async function* batches(): AsyncGenerator<SlicedLasBatch> {
    for (let first = 0; first < readablePointCount; first += batchPoints) {
      yield readBatch(first, Math.min(batchPoints, readablePointCount - first));
    }
  }

  return { header, readablePointCount, declaredPointCount, complete, origin, readBatch, batches };
}
