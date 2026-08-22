/**
 * validateCount.ts
 *
 * Shared allocation guard for declared point / record counts.
 *
 * Every binary loader reads a count from a header and then allocates
 * output arrays sized by it — and every one of those headers can arrive
 * from a remote URL. A malformed (or hostile) file that declares 10^12
 * points would otherwise drive a multi-terabyte `TypedArray` allocation
 * before a single record is decoded: at best an opaque RangeError, at
 * worst a tab-killing OOM. The fix is the same everywhere, so it lives
 * here once: bound the declared count by what the bytes we actually
 * hold could plausibly decompress to.
 *
 * The bound is deliberately loose — `minBytesPerPoint` is a conservative
 * floor, because the goal is blocking absurd allocations, not byte-exact
 * validation. A real file is never within orders of magnitude of the limit; a
 * header lying about its count by 1000x is. Mirrors the silent clamp
 * `loadLas.ts` applies to uncompressed records, but throws instead of clamping:
 * a compressed stream whose header wildly disagrees with its payload
 * cannot be partially trusted the way fixed-length records can.
 *
 * For a LAZ stream the floor comes from {@link compressedBytesPerPointFloor},
 * which derives it from the point record length rather than fixing it at one
 * byte. One byte per point is a different compression ratio for every point
 * format: 20x for PDRF 0's twenty-byte record and 36x for PDRF 7's thirty-six,
 * so the guard was strictest on exactly the formats that carry least. Deriving
 * the floor from the record makes the admitted ratio the same everywhere and
 * keeps the allocation bound where it was.
 *
 * Throws the typed {@link LoadError} (`malformed-file`) so the toast
 * explains the failure clearly. The message also contains the word
 * "malformed" on purpose: workers post `error.message` strings across
 * the thread boundary, and `classifyLoadError` keys on that word to
 * recover the category on the main thread.
 *
 * Pure — no DOM, no three.js — safe to import from workers and tests.
 */

import { LoadError } from './loadErrors';

/**
 * Smallest floor the guard will use, whatever a caller passes.
 *
 * A zero or negative floor makes the bound vacuous, which is the one thing this
 * guard must never be. A hundredth of a byte per point still refuses a header
 * claiming a trillion points behind a kilobyte.
 */
export const MIN_BYTES_PER_POINT_FLOOR = 0.01;

/**
 * Compression ratio above which a LAZ stream is treated as impossible.
 *
 * A committed 120,000-point PDRF 7 fixture compresses 14.8x, and published
 * ratios for airborne survey data sit between 5x and 20x. Degenerate content
 * goes far higher: a node whose points share one classification, one intensity
 * and a near-constant coordinate delta feeds the arithmetic coder almost no
 * entropy, and a bare-earth node on a plane can pass 30x without being
 * malformed in any way. Fifty leaves that headroom while keeping the allocation
 * this guard exists to bound at roughly what it was.
 */
export const MAX_LAZ_COMPRESSION_RATIO = 50;

/**
 * The bytes-per-point floor for a LAZ stream of the given record length.
 *
 * Callers pass the uncompressed point record length from the LAS header, so the
 * floor scales with what a point actually carries.
 */
export function compressedBytesPerPointFloor(pointRecordLength: number): number {
  if (!Number.isFinite(pointRecordLength) || pointRecordLength <= 0) {
    return MIN_BYTES_PER_POINT_FLOOR;
  }
  return pointRecordLength / MAX_LAZ_COMPRESSION_RATIO;
}

/**
 * Validate a header-declared point/record count against the bytes that
 * actually back it. Returns the count unchanged when plausible; throws
 * a `malformed-file` {@link LoadError} when the count is not a safe
 * non-negative integer, or when even `minBytesPerPoint` bytes per point
 * could not fit `declared` points into `bytesAvailable`.
 *
 * @param declared        The count the file's header claims.
 * @param bytesAvailable  The bytes actually present (compressed or raw).
 * @param minBytesPerPoint Conservative floor on bytes consumed per point. May
 *                         be fractional for a compressed stream; clamped to
 *                         {@link MIN_BYTES_PER_POINT_FLOOR}, because a zero or
 *                         negative floor would make the bound vacuous.
 * @param context         Loader name for the error message ("LAZ",
 *                        "COPC node", "E57 CompressedVector", …).
 */
export function validateDeclaredPointCount(
  declared: number,
  bytesAvailable: number,
  minBytesPerPoint: number,
  context: string,
): number {
  // Non-finite, negative, fractional, or beyond 2^53 — none of these can
  // be a real record count; all of them poison downstream arithmetic
  // (array lengths, byte offsets) in ways that surface far from here.
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new LoadError(
      'malformed-file',
      `malformed ${context}: invalid declared point count (${declared}).`,
    );
  }
  const floor = Number.isFinite(minBytesPerPoint)
    ? Math.max(MIN_BYTES_PER_POINT_FLOOR, minBytesPerPoint)
    : MIN_BYTES_PER_POINT_FLOOR;
  const plausibleMax = Math.floor(Math.max(0, bytesAvailable) / floor);
  if (declared > plausibleMax) {
    throw new LoadError(
      'malformed-file',
      `malformed ${context}: header declares ${declared.toLocaleString('en-US')} points, ` +
        `but only ${bytesAvailable.toLocaleString('en-US')} bytes are available ` +
        `(at least ${floor.toFixed(2)} byte(s) per point expected).`,
    );
  }
  return declared;
}
