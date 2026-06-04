/**
 * RangeSource.ts
 *
 * A range-readable byte source — the streaming primitive behind COPC. Unlike
 * the `PointCloudSource` (which decodes a whole cloud in one shot), a
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
 * deliberately small but precise; Added the `timeout`,
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
 * URL hygiene for the remote-COPC entry. The URL must parse, use
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
  // SSRF hardening: refuse loopback, private, link-local, and other
  // internal hosts so a pasted URL can't be used to probe the user's own
  // network (router admin pages, metadata endpoints, intranet services).
  if (isBlockedHost(u.hostname)) {
    return {
      ok: false,
      reason: 'URLs pointing at localhost or a private network address are not accepted.',
    };
  }
  return { ok: true, url: raw };
}

/**
 * True for hostnames that resolve to the local machine or a private /
 * internal network range, which a remote-data URL must never target.
 * Covers IPv4 (loopback, RFC 1918, link-local, CGNAT, unspecified),
 * IPv6 (loopback, unspecified, link-local fe80::/10, unique-local
 * fc00::/7), and the conventional internal name suffixes. This is a
 * best-effort literal check — it does not resolve DNS — which is the
 * correct guard for a browser-side app where the fetch happens from the
 * user's own machine.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '' || h === 'localhost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 loopback / unspecified / link-local / unique-local.
  if (h === '::1' || h === '::') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // fc00::/7
  // IPv4 literals.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  }
  return false;
}

/**
 * Strip userinfo AND query parameters from a URL so it is safe to
 * surface in error messages, telemetry, or logs. The query string is
 * scrubbed because signed-URL schemes (Azure SAS, AWS presigned URLs,
 * Google Cloud Storage signed URLs) carry the credential in the query
 * — leaking it into a thrown error would put a working bearer token
 * into the UI / console / sentry trail.
 *
 * Falls back to a literal substring strip when the URL doesn't parse,
 * so a malformed input is still scrubbed.
 */
export function sanitizeUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    if (u.search) {
      // We strip the entire query string rather than per-key
      // allow-listing — the threat model is "we don't know which key
      // is the credential", so the only safe move is to drop it all
      // and surface "?…" so the caller knows there were params.
      u.search = '';
      return `${u.toString()}?…`;
    }
    return u.toString();
  } catch {
    // Best-effort textual scrub for inputs that won't parse — strip
    // the first `userinfo@` segment AND any query string.
    const noUserInfo = raw.replace(/^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/@]*@/, '$1');
    return noUserInfo.replace(/\?.*$/, '?…');
  }
}
