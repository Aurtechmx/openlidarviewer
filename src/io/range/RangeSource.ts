/**
 * RangeSource.ts
 *
 * A range-readable byte source — the streaming primitive behind COPC. Unlike
 * the v0.2.9 `PointCloudSource` (which decodes a whole cloud in one shot), a
 * `RangeSource` answers arbitrary `[offset, offset + length)` byte reads, so
 * the COPC pipeline can fetch just a header, a hierarchy page, or a single
 * octree node's chunk without ever reading the rest of the file.
 *
 * Three implementations ship: a dropped `File`, an in-memory `ArrayBuffer`
 * (the test substrate), and an HTTP Range source that streams a remote COPC
 * scan over `Range:` requests.
 *
 * Pure interface — no DOM, no three.js.
 */

/** The kind of byte source behind a {@link RangeSource}. */
export type RangeSourceKind = 'local-file' | 'array-buffer' | 'http-range';

/** A range-readable byte source. */
export interface RangeSource {
  /** A stable identifier — a file name, a URL, or a synthetic id. */
  id(): string;
  /** Which kind of source this is — drives diagnostics and routing. */
  kind(): RangeSourceKind;
  /** The total byte length of the source. */
  size(): Promise<number>;
  /**
   * Read `length` bytes starting at `offset`. A read that runs past the end is
   * truncated to the end; a zero-length read yields an empty buffer. Rejects
   * with a {@link RangeReadError} on a nonsensical request, an aborted signal,
   * or a transport failure.
   */
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** Release any held resources. Optional — a `File` source needs nothing. */
  close?(): Promise<void>;
}

/**
 * Why a range read failed — drives clear, categorised messaging. The set is
 * deliberately small but precise; v0.3.1 added the `timeout`,
 * `content-mismatch`, and `server-error` codes so the remote-COPC UX can show
 * a specific message instead of falling back to a generic transport label.
 */
export type RangeReadErrorCode =
  | 'out-of-range'
  | 'aborted'
  | 'transport'
  | 'range-unsupported'
  | 'timeout'
  | 'content-mismatch'
  | 'server-error';

/** A typed range-read failure. */
export class RangeReadError extends Error {
  readonly code: RangeReadErrorCode;
  constructor(code: RangeReadErrorCode, message: string) {
    super(message);
    this.name = 'RangeReadError';
    this.code = code;
  }
}

/**
 * Validate a requested `[offset, length)` against a known total size and
 * return the *clamped* length: a read that runs past the end is truncated to
 * the end, and a zero-length read is legal. A negative or non-finite request,
 * or an offset past the end, throws `RangeReadError('out-of-range')`.
 *
 * Pure — the single shared range-validation routine for every implementation.
 */
export function clampRange(offset: number, length: number, size: number): number {
  if (
    !Number.isFinite(offset) ||
    !Number.isFinite(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw new RangeReadError(
      'out-of-range',
      `Invalid range request: offset=${offset}, length=${length}`,
    );
  }
  if (offset > size) {
    throw new RangeReadError(
      'out-of-range',
      `Range offset ${offset} is past the source size ${size}`,
    );
  }
  return Math.min(length, size - offset);
}

/** Maximum acceptable length of a `?copc=` URL — guards URL-bomb input. */
export const MAX_REMOTE_COPC_URL_LENGTH = 2048;

/**
 * URL hygiene — URL hygiene for the remote-COPC entry. The URL must parse, use
 * `http:` or `https:`, fit within {@link MAX_REMOTE_COPC_URL_LENGTH}, and
 * carry no userinfo (`user:pass@…` — never expose credentials through a
 * scan link). Returns the original URL on success and a precise reason on
 * failure for the error UX.
 */
export function validateRemoteCopcUrl(
  raw: string,
):
  | { ok: true; url: string }
  | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'No URL was provided.' };
  }
  if (raw.length > MAX_REMOTE_COPC_URL_LENGTH) {
    return {
      ok: false,
      reason: `URL is longer than ${MAX_REMOTE_COPC_URL_LENGTH} characters.`,
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is not parseable.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'Only http:// and https:// URLs are accepted.',
    };
  }
  if (u.username !== '' || u.password !== '') {
    return {
      ok: false,
      reason: 'URLs with embedded credentials are not accepted.',
    };
  }
  return { ok: true, url: raw };
}

/**
 * Strip userinfo (`user:pass@`) from a URL so it is safe to surface in error
 * messages, telemetry, or logs. Falls back to a literal substring strip when
 * the URL doesn't parse, so a malformed input is still scrubbed.
 */
export function sanitizeUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // Best-effort textual scrub for inputs that won't parse — strip the
    // first `userinfo@` segment between the scheme and the host.
    return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/@]*@/, '$1');
  }
}
