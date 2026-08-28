/**
 * heavyByteBudget.ts — one shared decoded-byte budget for the heavy/streaming
 * decode path.
 *
 * Every out-of-core reader sizes an allocation from a count it read out of a
 * file: a chunk's point count, a node's point count, a batch of fixed records, a
 * chunk table's entry count, a leaf tile's bytes. A malformed or adversarial file
 * can drive any of those counts far past what the out-of-core spill was built to
 * protect, because the spill caps RESIDENCY over a whole build while these are
 * single up-front allocations that happen BEFORE the first point is spilled. A
 * point-count cap alone does not bound them: the byte cost is `count *
 * recordLength`, and LAS Extra Bytes lets one record reach 65535 bytes, so a
 * count that looks modest can still stage gigabytes.
 *
 * The fix is one policy, here, rather than five arbitrary constants scattered
 * across the readers. Limits are derived from a device-reasonable ceiling on a
 * single staged buffer and from the file's own record length; a site over budget
 * REFUSES (throws {@link HeavyByteBudgetError}, or reports the reader's existing
 * `supported: false` / typed-refusal shape) rather than allocating past it, and
 * never falls back to a whole-file path on refusal.
 *
 * Pure — no Viewer, no three.js, no DOM. Node-testable.
 */

/**
 * The ceiling on ONE staged decode buffer, in bytes. A single chunk decoded
 * whole, a single COPC node's records, or a window of LAZ chunks held at once
 * must all stay under this. 128 MiB is the figure the rest of the heavy path
 * already treats as its staging budget (the LAZ window-span cap is the same
 * number); it is comfortably allocatable on a low-end device yet far above any
 * honest single-unit decode, whose real size is sub-megabyte.
 */
export const MAX_DECODED_ALLOCATION_BYTES = 128 * 1024 * 1024;

/**
 * The largest single SOURCE range-read a fixed-record LAS batch may issue, in
 * bytes. Uncompressed records are read straight off disk into one buffer, so the
 * read size is `batchPoints * recordLength`; 16 MiB keeps that one read small
 * regardless of the record length, which with Extra Bytes can otherwise make a
 * default-sized batch a gigabyte.
 */
export const MAX_BATCH_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * The ceiling on the chunk-table staging a plain-LAZ reader allocates BEFORE it
 * validates any individual chunk: the two `Float64Array(numChunks)` delta
 * streams plus one range object per chunk. 64 MiB bounds that up-front cost;
 * {@link MAX_CHUNK_TABLE_ENTRIES} turns it into a hard chunk-count ceiling.
 */
export const MAX_CHUNK_TABLE_BYTES = 64 * 1024 * 1024;

/**
 * Staging cost charged per chunk-table entry: two Float64 deltas (16 bytes) plus
 * one {@link LazChunkRange}-shaped object, accounted at a conservative 32 bytes.
 * Deriving the entry ceiling from this and {@link MAX_CHUNK_TABLE_BYTES} keeps
 * the chunk-count cap honest about the memory it protects rather than a round
 * number picked in the air.
 */
export const CHUNK_TABLE_ENTRY_BYTES = 48;

/**
 * Hard ceiling on the declared chunk count, derived from the byte budget above.
 * Real files are far under it: a fixed 50 000-point chunk size turns even a
 * 60-billion-point cloud into ~1.2 million chunks. A table declaring more is
 * refused before its delta arrays are allocated. Much lower than the old flat
 * 16,777,216, whose delta arrays alone reached ~256 MiB.
 */
export const MAX_CHUNK_TABLE_ENTRIES = Math.floor(
  MAX_CHUNK_TABLE_BYTES / CHUNK_TABLE_ENTRY_BYTES,
);

/**
 * The ceiling on the TOTAL simultaneous working set of a single LAZ window decode,
 * in bytes. The per-chunk compressed cap, the per-window decoded cap
 * ({@link MAX_DECODED_ALLOCATION_BYTES}), and the window-span cap
 * ({@link chunkedLazSource.MAX_LAZ_WINDOW_SPAN_BYTES}) each bound ONE allocation,
 * but a window decode holds several at once — the compressed span, the raw decoded
 * records, and the packed tile records — so the summed peak can reach several
 * hundred megabytes while every single piece stays under its own cap. 256 MiB is
 * the device-reasonable ceiling on that joint working set; it sits below the naive
 * 384 MiB sum of the three separate caps, so it actually constrains a window the
 * individual caps would each pass, and a window is shrunk (never below one chunk)
 * to keep its span + decoded + packed within it.
 */
export const MAX_DECODE_PEAK_BYTES = 256 * 1024 * 1024;

/**
 * The ceiling on ONE leaf tile the streaming reader loads whole, in bytes. The
 * out-of-core indexer buckets points into leaves; a degenerate cloud (millions
 * of identical XYZ, which share a leaf key and an LOD hash) can pile far past a
 * leaf's target into one logical node, and the reader reads a whole tile into
 * memory. 256 MiB is well above a healthy leaf (about `pointsPerLeaf` points)
 * yet bounds the pathological pile; a node over it is refused at index time so no
 * oversized tile is ever produced.
 */
export const MAX_TILE_BYTES = 256 * 1024 * 1024;

/** A heavy allocation refused for exceeding the decoded-byte budget. */
export class HeavyByteBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeavyByteBudgetError';
  }
}

/**
 * Decoded bytes for `pointCount` records of `recordLength` bytes, or
 * {@link Number.POSITIVE_INFINITY} when either input is not a usable non-negative
 * number. Infinity is deliberate: a nonsense record length must read as
 * over-budget, never as zero.
 */
export function decodedBytesFor(pointCount: number, recordLength: number): number {
  if (
    !Number.isFinite(pointCount) ||
    !Number.isFinite(recordLength) ||
    pointCount < 0 ||
    recordLength <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return pointCount * recordLength;
}

/** Whether `pointCount * recordLength` stays within `ceiling` (default the global cap). */
export function withinDecodedByteBudget(
  pointCount: number,
  recordLength: number,
  ceiling: number = MAX_DECODED_ALLOCATION_BYTES,
): boolean {
  return decodedBytesFor(pointCount, recordLength) <= ceiling;
}

/**
 * The summed peak working set of decoding a span of `spanBytes` compressed bytes
 * into `pointCount` records of `sourceRecordLength` bytes and packing them into
 * `packedRecordBytes`-byte tile records — the three allocations that coexist
 * during a LAZ window decode. A non-usable span or decoded size makes the total
 * {@link Number.POSITIVE_INFINITY}, so a nonsense size reads as over-budget;
 * `packedRecordBytes <= 0` drops the packed term (the caller is not staging one)
 * rather than poisoning the sum.
 */
export function decodePeakBytesFor(
  spanBytes: number,
  pointCount: number,
  sourceRecordLength: number,
  packedRecordBytes: number,
): number {
  const span = Number.isFinite(spanBytes) && spanBytes >= 0 ? spanBytes : Number.POSITIVE_INFINITY;
  const packed = packedRecordBytes > 0 ? decodedBytesFor(pointCount, packedRecordBytes) : 0;
  return span + decodedBytesFor(pointCount, sourceRecordLength) + packed;
}

/** Whether a window/chunk's summed decode peak stays within `ceiling` (default the total cap). */
export function withinDecodePeakBudget(
  spanBytes: number,
  pointCount: number,
  sourceRecordLength: number,
  packedRecordBytes: number,
  ceiling: number = MAX_DECODE_PEAK_BYTES,
): boolean {
  return decodePeakBytesFor(spanBytes, pointCount, sourceRecordLength, packedRecordBytes) <= ceiling;
}

/**
 * The largest point count whose decoded records fit `ceiling` for a given record
 * length, at least 1. Used to size a batch or to derive a per-format point cap.
 */
export function maxPointsForRecordLength(
  recordLength: number,
  ceiling: number = MAX_DECODED_ALLOCATION_BYTES,
): number {
  if (!Number.isFinite(recordLength) || recordLength <= 0) return 1;
  return Math.max(1, Math.floor(ceiling / recordLength));
}

/**
 * Points per fixed-record batch: the caller's desired size, clamped so one
 * source read never exceeds `sourceCeiling` bytes, and never below one point.
 * `min(desired, floor(sourceCeiling / recordLength))`.
 */
export function batchPointsForRecordLength(
  recordLength: number,
  desiredPoints: number,
  sourceCeiling: number = MAX_BATCH_SOURCE_BYTES,
): number {
  const desired = Number.isFinite(desiredPoints) ? Math.floor(desiredPoints) : 1;
  return Math.max(1, Math.min(desired, maxPointsForRecordLength(recordLength, sourceCeiling)));
}

/**
 * Throw {@link HeavyByteBudgetError} when `pointCount * recordLength` exceeds
 * `ceiling`. `context` names the site for the message ("COPC node", "LAZ chunk",
 * "tile"). Callers that own a `supported: false` shape should test
 * {@link withinDecodedByteBudget} instead and report that shape; this is for the
 * sites whose refusal is a throw.
 */
export function assertDecodedByteBudget(
  pointCount: number,
  recordLength: number,
  context: string,
  ceiling: number = MAX_DECODED_ALLOCATION_BYTES,
): void {
  if (!withinDecodedByteBudget(pointCount, recordLength, ceiling)) {
    const bytes = decodedBytesFor(pointCount, recordLength);
    const shown = Number.isFinite(bytes) ? bytes.toLocaleString('en-US') : 'an unbounded number of';
    throw new HeavyByteBudgetError(
      `${context}: ${pointCount.toLocaleString('en-US')} points × ${recordLength} bytes ` +
        `would stage ${shown} bytes, over the ${ceiling.toLocaleString('en-US')}-byte decode budget; ` +
        'convert it to COPC or EPT.',
    );
  }
}
