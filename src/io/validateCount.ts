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
 * floor (callers pass 1 byte/point for compressed streams), because the
 * goal is blocking absurd allocations, not byte-exact validation. A real
 * file is never within orders of magnitude of the limit; a header lying
 * about its count by 1000x is. Mirrors the silent clamp `loadLas.ts`
 * applies to uncompressed records, but throws instead of clamping:
 * a compressed stream whose header wildly disagrees with its payload
 * cannot be partially trusted the way fixed-length records can.
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
 * Validate a header-declared point/record count against the bytes that
 * actually back it. Returns the count unchanged when plausible; throws
 * a `malformed-file` {@link LoadError} when the count is not a safe
 * non-negative integer, or when even `minBytesPerPoint` bytes per point
 * could not fit `declared` points into `bytesAvailable`.
 *
 * @param declared        The count the file's header claims.
 * @param bytesAvailable  The bytes actually present (compressed or raw).
 * @param minBytesPerPoint Conservative floor on bytes consumed per point.
 *                         Clamped to at least 1 — a 0 floor would make the
 *                         bound vacuous.
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
  const floor = Math.max(1, minBytesPerPoint);
  const plausibleMax = Math.floor(Math.max(0, bytesAvailable) / floor);
  if (declared > plausibleMax) {
    throw new LoadError(
      'malformed-file',
      `malformed ${context}: header declares ${declared.toLocaleString('en-US')} points, ` +
        `but only ${bytesAvailable.toLocaleString('en-US')} bytes are available ` +
        `(at least ${floor} byte(s) per point expected).`,
    );
  }
  return declared;
}
