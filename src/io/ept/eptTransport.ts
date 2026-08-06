/**
 * eptTransport.ts — EPT remote-fetch hardening.
 *
 * The remote-EPT fetch path uses the same retry-with-backoff + per-attempt
 * timeout discipline `HttpRangeSource` brings to remote COPC. EPT spreads
 * the dataset across `ept.json` + many hierarchy + tile files, so a single
 * transient failure on any one of them should not collapse the whole load.
 *
 * This module builds a `{ fetchText, fetchBytes }` object the
 * `EptStreamingPointCloud` consumes:
 *
 *   - Per-attempt request timeout (default 20 s)
 *   - Bounded retries on transient transport faults: 408 / 429 / 5xx and
 *     network errors (`fetch` itself rejects)
 *   - Exponential backoff with jitter between attempts
 *   - Aborts cleanly when the outer signal cancels
 *   - Throws a typed {@link EptFetchError} whose message the
 *     `describeRemoteEptError` classifier knows:
 *     `EPT hierarchy fetch failed (...)`, `EPT tile fetch failed (...)`
 *
 * CREDENTIALS. `eptUrls.ts` re-attaches the manifest's query string to every
 * hierarchy and tile URL, by design, so that signed datasets (Azure SAS, a CDN
 * `?token=`, an AWS presigned prefix) keep working past `ept.json`. That makes
 * the URL a live credential by construction, and this module used to
 * interpolate it raw into every thrown message. Those messages travel: the
 * full-cloud grade action paints `err.message` straight into the streaming
 * panel, which lands in screenshots and support tickets. Every field on
 * {@link EptFetchError} is therefore scrubbed at construction — the class
 * carries structured, already-safe values so no downstream formatter can
 * reassemble the token.
 *
 * BYTE CEILINGS. Hierarchy and tile bodies are read through the bounded
 * readers in `io/range/boundedRead`, so a host cannot answer a hierarchy
 * request with an endless body.
 *
 * Pure — no DOM, no three.js. The injected `fetchImpl`, `sleep`, and
 * `random` make every retry/timeout path deterministically testable.
 */

import type { EptTransport } from '../../render/streaming/EptStreamingPointCloud';
import { sanitizeUrlForDisplay } from '../range/RangeSource';
import { readAtMostBounded, readTextAtMost } from '../range/boundedRead';

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Maximum retries beyond the initial attempt (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses we DO retry on (transient transport faults). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Byte ceiling for one EPT hierarchy JSON file (16 MiB).
 *
 * A hierarchy page is `"D-X-Y-Z": <count>` pairs, roughly 20–25 bytes each,
 * and Entwine splits pages long before they get large — a few thousand keys
 * is typical, tens of thousands is already unusual. 16 MiB is around 700k
 * keys: three orders of magnitude above any real page, so the limit can only
 * be hit by a host that is not sending a hierarchy file at all.
 */
export const MAX_EPT_HIERARCHY_BYTES = 16 * 1024 * 1024;

/**
 * Byte ceiling for one EPT data tile (128 MiB).
 *
 * A tile holds one octree node's points — Entwine's default is a few hundred
 * thousand. At ~34 bytes per uncompressed LAS point record, half a million
 * points is ~17 MB before compression, and `binary` tiles are stored
 * uncompressed. 128 MiB leaves roughly 8× headroom over that worst case while
 * still bounding the allocation a single hostile response can force.
 */
export const MAX_EPT_TILE_BYTES = 128 * 1024 * 1024;

/** Which EPT resource a fetch was for. Drives the message and the classifier. */
export type EptFetchOperation = 'hierarchy' | 'tile';

/**
 * A typed EPT fetch failure carrying only already-safe fields.
 *
 * The point of the type is that there is no raw URL on it to leak. `host` and
 * `resource` are derived from the request URL with the query string and any
 * userinfo removed, and `message` is composed from those same fields — so a
 * caller that logs the error, serialises it, or interpolates its message into
 * panel text cannot reintroduce the credential that {@link sanitizeUrlForDisplay}
 * stripped. Structured fields exist so callers that want to *classify* a
 * failure (status, operation) don't have to regex the message to do it.
 */
export class EptFetchError extends Error {
  /** Which resource kind failed. */
  readonly operation: EptFetchOperation;
  /** HTTP status, when the failure was a response rather than a transport fault. */
  readonly status?: number;
  /** HTTP status text, when present. */
  readonly statusText?: string;
  /** Host only — no scheme, no userinfo, no query. */
  readonly host: string;
  /** Dataset-relative resource path, e.g. `ept-hierarchy/0-0-0-0.json`. */
  readonly resource: string;
  /** The full URL with userinfo and query stripped — safe to display. */
  readonly safeUrl: string;

  constructor(
    operation: EptFetchOperation,
    url: string,
    detail?: { status?: number; statusText?: string; cause?: unknown },
  ) {
    const safeUrl = sanitizeUrlForDisplay(url);
    const status = detail?.status;
    const statusText = detail?.statusText;
    const statusPart =
      status === undefined ? '' : ` (${status}${statusText ? ` ${statusText}` : ''})`;
    super(`EPT ${operation} fetch failed${statusPart} for ${safeUrl}`);
    this.name = 'EptFetchError';
    this.operation = operation;
    this.status = status;
    this.statusText = statusText;
    this.safeUrl = safeUrl;
    this.host = safeHostOf(safeUrl);
    this.resource = safeResourceOf(safeUrl);
    if (detail?.cause !== undefined) this.cause = detail.cause;
  }
}

/** Host of an already-sanitised URL; the whole sanitised string if it won't parse. */
function safeHostOf(safeUrl: string): string {
  try {
    return new URL(safeUrl).host;
  } catch {
    return safeUrl;
  }
}

/**
 * The last two path segments of an already-sanitised URL — `ept-data/3-1-2-0.laz`
 * rather than the full deploy path. Enough to say *which* file failed without
 * echoing a customer's bucket layout back into a screenshot.
 */
function safeResourceOf(safeUrl: string): string {
  try {
    const segments = new URL(safeUrl).pathname.split('/').filter(Boolean);
    return segments.slice(-2).join('/');
  } catch {
    return safeUrl;
  }
}

/** Tunables for {@link createEptTransport}. Defaulted; injected for tests. */
export interface EptTransportOptions {
  /** Per-attempt timeout, in ms. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Maximum retries beyond the initial attempt. Default {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /** Base backoff before the first retry, ms. Default {@link DEFAULT_RETRY_BASE_MS}. */
  retryBaseMs?: number;
  /** Replacement `fetch` — production callers omit this; tests inject a fake. */
  fetchImpl?: typeof fetch;
  /** PRNG in `[0, 1)`; tests inject a deterministic version for jitter. */
  random?: () => number;
  /** Sleep helper, ms. Tests can substitute a synchronous resolver. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build a hardened EPT transport. Returns the `{ fetchText, fetchBytes }`
 * shape the streaming source expects, with retry-with-backoff + per-attempt
 * timeout under the hood.
 */
export function createEptTransport(options: EptTransportOptions = {}): EptTransport {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const fetchFn = options.fetchImpl ?? ((...args) => fetch(...args));
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * Issue one GET with a hard timeout, composed with the caller's outer abort
   * signal. Returns the Response; throws on transport / timeout / abort.
   */
  async function fetchOnce(url: string, outer?: AbortSignal): Promise<Response> {
    if (outer?.aborted) throw new Error('aborted');
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), requestTimeoutMs);
    // Compose: abort when either the outer signal or our timeout fires.
    const composed = new AbortController();
    const onOuterAbort = (): void => composed.abort();
    if (outer) outer.addEventListener('abort', onOuterAbort, { once: true });
    const onTimeoutAbort = (): void => composed.abort();
    timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
    try {
      const response = await fetchFn(url, { signal: composed.signal });
      return response;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
      timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
    }
  }

  /**
   * Backoff delay before retry attempt `n` (n starts at 1 for the FIRST
   * retry). Exponential — `base * 2^(n-1)` — jittered ±50 % so a thundering
   * herd of clients doesn't all retry on the same millisecond.
   */
  function backoffMs(n: number): number {
    const exp = retryBaseMs * Math.pow(2, n - 1);
    const jitter = 1 + (random() - 0.5);
    return Math.max(0, Math.round(exp * jitter));
  }

  /**
   * Drive `fetchOnce` with bounded retries on transient transport faults.
   * Returns the final successful Response or throws a categorised error.
   */
  async function fetchWithRetry(
    url: string,
    label: EptFetchOperation,
    outer?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (outer?.aborted) throw new Error('aborted');
      let response: Response | null = null;
      // Only the transport / timeout call is inside the try; the status
      // classification below is intentionally outside so a permanent-error
      // throw isn't swallowed back into the retry loop.
      try {
        response = await fetchOnce(url, outer);
      } catch (err) {
        if (outer?.aborted) throw err;
        lastError = err;
      }
      if (response) {
        // 2xx — success.
        if (response.ok) return response;
        // 4xx (except 408/429) — permanent. Don't retry; throw immediately.
        // `url` is never interpolated here: EptFetchError sanitises it, and
        // for a signed dataset the query string IS the credential.
        if (!RETRYABLE_STATUSES.has(response.status)) {
          throw new EptFetchError(label, url, {
            status: response.status,
            statusText: response.statusText,
          });
        }
        lastError = new EptFetchError(label, url, {
          status: response.status,
          statusText: response.statusText,
        });
      }
      // Backoff before the next attempt (unless we're out of retries).
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt + 1));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new EptFetchError(label, url);
  }

  return {
    fetchText: async (url, signal) => {
      const response = await fetchWithRetry(url, 'hierarchy', signal);
      // Bounded read: the body arrives from a host we don't control, and a
      // hierarchy page has a knowable order of magnitude. See
      // MAX_EPT_HIERARCHY_BYTES for why 16 MiB is the ceiling.
      return readTextAtMost(
        response,
        MAX_EPT_HIERARCHY_BYTES,
        'EPT hierarchy file',
        signal,
      );
    },
    fetchBytes: async (url, signal) => {
      const response = await fetchWithRetry(url, 'tile', signal);
      const bytes = await readAtMostBounded(
        response,
        MAX_EPT_TILE_BYTES,
        'EPT tile',
        signal,
      );
      // `readAtMostBounded` may hand back a view into a larger chunk buffer
      // when the whole body arrived in one read. Callers treat the result as
      // an owned ArrayBuffer (they transfer it to a worker), so slice when the
      // view isn't already the whole buffer.
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    },
  };
}
