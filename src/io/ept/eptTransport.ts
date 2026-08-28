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
 *   - Throws typed messages the `describeRemoteEptError` classifier knows:
 *     `EPT hierarchy fetch failed (...)`, `EPT tile fetch failed (...)`
 *
 * Pure — no DOM, no three.js. The injected `fetchImpl`, `sleep`, and
 * `random` make every retry/timeout path deterministically testable.
 *
 * KNOWN LIMITATION — no dataset-wide snapshot pinning. COPC is one object, so
 * `HttpRangeSource` can pin a single ETag / Last-Modified / size and reject a
 * range read the moment the object changes underneath the session. EPT is a
 * TREE of independent objects (`ept.json`, many hierarchy pages, many tiles)
 * fetched over the life of a scan, with no equivalent whole-dataset validator.
 * If the dataset is REPUBLISHED mid-stream — Entwine rewriting the pyramid, a
 * bucket sync swapping objects — this transport can mix pages/tiles from the old
 * and new versions and would not detect it. Each fetch is otherwise independent,
 * so a per-request ETag pin (record the first `ept.json` response's validator,
 * send `If-Match` / compare on every derived request, reject on mismatch) is the
 * natural fix, but it has to thread a validator from the manifest fetch through
 * `EptStreamingPointCloud` into every hierarchy + tile request and depends on
 * the host emitting stable validators (many CDNs and S3-compatible stores vary
 * them per node) — a real change, deferred rather than half-built here. Until
 * then the practical guard is operational: treat a published EPT as immutable
 * for the duration of a session, and re-open the scan after a republish. The
 * per-tile / per-page integrity checks elsewhere (exact-stride binary decode,
 * hierarchy-vs-tile count reconciliation, the point-count total reconciliation)
 * still catch a tile that is internally inconsistent — they do not catch a
 * consistent tile from a DIFFERENT snapshot.
 */

import type { EptTransport } from '../../render/streaming/EptStreamingPointCloud';
import { sanitizeUrlForDisplay } from '../range/RangeSource';
import { readAtMostBounded, readTextAtMost } from '../range/boundedRead';

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/**
 * Whole-body ceilings for the two EPT read shapes. Without a cap, `.text()` /
 * `.arrayBuffer()` read whatever a host returns — a hostile or misconfigured
 * server can stream a multi-GB body and OOM the tab. These are defense-in-depth
 * limits set far above any legitimate document, not tight fits: a hierarchy
 * page is JSON metadata (KBs–low MBs); a single node's point payload is bounded
 * by its point count (a 4M-point node in the widest binary layout is ~140 MB).
 * The `boundedRead` helper refuses a `Content-Length` above the cap before
 * reading a byte, then streams with a running counter that cancels the body on
 * the chunk that would cross it — so a lying or absent length can't slip past.
 */
const HIERARCHY_MAX_BYTES = 64 * 1024 * 1024;
const TILE_MAX_BYTES = 256 * 1024 * 1024;
/** Maximum retries beyond the initial attempt (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses we DO retry on (transient transport faults). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * An internal per-attempt request deadline elapsed. This is deliberately a
 * distinct type from a user cancel: a timeout is a real failure the user
 * should see, not a silent cancellation. It carries `code: 'timeout'` to mirror
 * the COPC path's `RangeReadError('timeout', …)`, keeping one cancel-vs-timeout
 * convention across EPT and COPC. The streaming `isAbortError` classifier does
 * NOT match this (its name is not `AbortError`), so a timeout never gets
 * swallowed as a cancel; `describeRemoteEptError` renders it as a timeout.
 */
export class EptTimeoutError extends Error {
  readonly code = 'timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EptTimeoutError';
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
    if (outer?.aborted) throw outer.reason ?? new DOMException('EPT fetch aborted before request', 'AbortError');
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), requestTimeoutMs);
    // Compose: abort when either the outer signal or our timeout fires.
    const composed = new AbortController();
    const onOuterAbort = (): void => composed.abort();
    if (outer) outer.addEventListener('abort', onOuterAbort, { once: true });
    const onTimeoutAbort = (): void => composed.abort();
    timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
    try {
      // `redirect: 'error'`: the EPT host was validated against the SSRF
      // block-list, but a redirect could reach a private address the literal
      // check never resolved. Refuse redirect hops on every hierarchy/tile read.
      const response = await fetchFn(url, { signal: composed.signal, redirect: 'error' });
      return response;
    } catch (err) {
      // A per-attempt timeout aborts the in-flight fetch exactly as a user
      // cancel does, so the raw rejection is an indistinguishable AbortError.
      // Recover the distinction from which controller fired: the timeout
      // controller aborting while the OUTER signal has not is an internal
      // deadline. Surface that as a distinct EptTimeoutError so it stays a
      // visible timeout and is never classified as a silent user cancel; a real
      // outer-signal abort propagates unchanged for the caller to treat as one.
      if (timeoutController.signal.aborted && !outer?.aborted) {
        throw new EptTimeoutError(
          `EPT request timed out after ${requestTimeoutMs} ms for ${sanitizeUrlForDisplay(url)}`,
        );
      }
      throw err;
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
    label: 'hierarchy' | 'tile',
    outer?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (outer?.aborted) throw outer.reason ?? new DOMException('EPT fetch aborted between retries', 'AbortError');
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
        if (!RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(
            `EPT ${label} fetch failed (${response.status} ${response.statusText}) for ${sanitizeUrlForDisplay(url)}`,
          );
        }
        lastError = new Error(
          `EPT ${label} fetch failed (${response.status} ${response.statusText}) for ${sanitizeUrlForDisplay(url)}`,
        );
      }
      // Backoff before the next attempt (unless we're out of retries).
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt + 1));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`EPT ${label} fetch failed for ${sanitizeUrlForDisplay(url)}`);
  }

  return {
    fetchText: async (url, signal) => {
      const response = await fetchWithRetry(url, 'hierarchy', signal);
      // Cap the body: the retry loop only bounds the header round-trip, not the
      // bytes that follow. `boundedRead` carries the size ceiling plus its own
      // idle/total stall clock, and stays wired to the caller's cancel.
      return readTextAtMost(
        response,
        HIERARCHY_MAX_BYTES,
        `EPT hierarchy at ${sanitizeUrlForDisplay(url)}`,
        { signal },
      );
    },
    fetchBytes: async (url, signal) => {
      const response = await fetchWithRetry(url, 'tile', signal);
      const bytes = await readAtMostBounded(
        response,
        TILE_MAX_BYTES,
        `EPT tile at ${sanitizeUrlForDisplay(url)}`,
        { signal },
      );
      // Hand back an exact-size ArrayBuffer; a pooled/oversized backing buffer
      // would hand the decoder trailing bytes that aren't part of the tile. The
      // cast is sound — a fetch body is never a SharedArrayBuffer — and mirrors
      // the fixture transport's own slice.
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
}
