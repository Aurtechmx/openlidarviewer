/**
 * HttpRangeSource.ts
 *
 * A {@link RangeSource} backed by HTTP Range requests against a remote URL.
 *
 * `probe()` performs the HEAD request and verifies the server can serve byte
 * ranges; `readRange()` issues real `Range:` requests. This drives the
 * remote-COPC flow — the "open from URL" field and the `?copc=<url>` deep
 * link — so a Cloud Optimized Point Cloud hosted on a CORS-enabled server
 * streams exactly like a local file.
 *
 * Hardens the remote path with: (a) bounded exponential-
 * backoff retries on transient transport failures (retry-with-backoff), (b) hard
 * per-attempt request timeouts (per-attempt timeout), (c) `Content-Range` validation on
 * 206 responses (Content-Range validation), (d) a `Range: bytes=0-0` GET fallback when HEAD
 * is unusable (ranged-GET fallback). The new behaviour is fully dependency-injected for
 * deterministic tests — pass a fake `fetchImpl`, `now`, and `random` and
 * exercise the retry / timeout / mismatch paths exactly.
 *
 * Pure of three.js; uses `fetch`, which is available on both the main thread
 * and in workers.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';
import { RangeReadError, clampRange, sanitizeUrlForDisplay } from './RangeSource';

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Maximum number of retry attempts after the initial try (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses we DO retry on (transient transport faults). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Tunables for {@link HttpRangeSource}. Defaulted, injected for unit tests. */
export interface HttpRangeSourceOptions {
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
  /**
   * Sleep helper, ms. Defaults to `setTimeout`. Tests can substitute a
   * synchronous resolver to advance through every retry deterministically.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** A range-readable source over a remote URL using HTTP Range requests. */
export class HttpRangeSource implements RangeSource {
  private readonly _url: string;
  private readonly _requestTimeoutMs: number;
  private readonly _maxRetries: number;
  private readonly _retryBaseMs: number;
  private readonly _fetch: typeof fetch;
  private readonly _random: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;
  private _size: number | undefined;

  constructor(url: string, options: HttpRangeSourceOptions = {}) {
    this._url = url;
    this._requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this._fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this._random = options.random ?? Math.random;
    this._sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  id(): string {
    return this._url;
  }

  kind(): RangeSourceKind {
    return 'http-range';
  }

  /**
   * Discover the server's size and confirm range support. Tries HEAD first;
   * if that returns a hard 4xx (most often a CDN that refuses HEAD) or
   * arrives without a usable `Content-Length`, falls back to a single
   * `Range: bytes=0-0` GET which proves range support
   * and discovers the total size via the response's `Content-Range`.
   *
   * Throws a categorised {@link RangeReadError} on failure: `transport` for
   * an unreachable / 4xx host, `range-unsupported` for a host that cannot
   * do ranges, `timeout` if every attempt exceeded the request timeout,
   * `aborted` if the caller cancelled. The caller turns these into clear,
   * user-facing messages via the `describeRemoteCopcError` helper.
   */
  async probe(signal?: AbortSignal): Promise<number> {
    try {
      const head = await this._fetchWithRetryAndTimeout(
        { method: 'HEAD' },
        signal,
      );
      if (!head.ok) {
        // A 4xx HEAD often means the CDN refuses HEADs but happily serves
        // GETs — try the bytes=0-0 fallback before giving up.
        if (head.status >= 400 && head.status < 500) {
          return await this._probeViaRangedGet(signal);
        }
        throw new RangeReadError(
          'server-error',
          `Server returned ${head.status} for ${sanitizeUrlForDisplay(this._url)}`,
        );
      }
      const acceptRanges = head.headers.get('accept-ranges');
      if (acceptRanges === 'none') {
        // Server explicitly declares it doesn't support ranges.
        // Tightened per the error-handling-ux principle "what happened
        // + what to do" — concise and actionable, no jargon stack.
        throw new RangeReadError(
          'range-unsupported',
          'The host can\'t stream this file. It served the request but doesn\'t support partial reads.',
        );
      }
      // `Content-Length` is a CORS-safelisted response header — browsers
      // expose it cross-origin by default even when the bucket's CORS
      // configuration doesn't list it under `ExposeHeader`. Capture it now,
      // before any fallback path that depends on a less-friendly header
      // (`Accept-Ranges`, `Content-Range`), and pass it through as a size
      // hint to the ranged-GET probe.
      const headLength = Number(head.headers.get('content-length'));
      const sizeHint =
        Number.isFinite(headLength) && headLength > 0 ? headLength : undefined;

      if (acceptRanges !== 'bytes') {
        // Header is missing or unreadable. The likeliest cause is a
        // CORS-restricted bucket — S3 (data.entwine.io, hobu-lidar,
        // many other LiDAR hosts) supports range requests but does not
        // expose the `Accept-Ranges` header to cross-origin responses
        // unless the bucket's CORS configuration adds it to
        // `ExposeHeader`. Trust nothing — try a real ranged GET and
        // accept range support only if the server returns 206. A 200
        // means the server ignored the range header (true "no
        // support") and the inner probe will throw the proper error.
        // The `sizeHint` lets the inner probe reuse HEAD's Content-Length
        // when `Content-Range` is also CORS-stripped (the same buckets
        // hide both headers by default).
        return await this._probeViaRangedGet(signal, sizeHint);
      }
      if (sizeHint === undefined) {
        // Some hosts (notably proxied CDNs) strip Content-Length. The
        // ranged-GET probe recovers the size from Content-Range.
        return await this._probeViaRangedGet(signal);
      }
      this._size = sizeHint;
      return sizeHint;
    } catch (err) {
      if (err instanceof RangeReadError) throw err;
      throw new RangeReadError(
        'transport',
        `Could not reach ${sanitizeUrlForDisplay(this._url)} — check the URL and that the server allows cross-origin requests.`,
      );
    }
  }

  async size(): Promise<number> {
    if (this._size === undefined) await this.probe();
    return this._size as number;
  }

  async readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
    const total = await this.size();
    const clamped = clampRange(offset, length, total);
    if (clamped === 0) return new ArrayBuffer(0);

    const end = offset + clamped - 1;
    const response = await this._fetchWithRetryAndTimeout(
      { headers: { Range: `bytes=${offset}-${end}` } },
      signal,
    );
    // 206 Partial Content is the expected success. A 200 means the server
    // ignored the Range header and is sending the whole file — that defeats
    // streaming, so it is treated as range-unsupported rather than accepted.
    if (response.status === 200) {
      throw new RangeReadError(
        'range-unsupported',
        'This server ignored the range request and returned the whole file.',
      );
    }
    if (response.status !== 206) {
      throw new RangeReadError(
        response.status >= 500 ? 'server-error' : 'transport',
        `Range read returned an unexpected status ${response.status}`,
      );
    }
    // Content-Range validation. A 206 normally carries a Content-Range
    // header identifying the served bytes. S3-style buckets with default
    // CORS hide this header from cross-origin responses — when it's
    // entirely missing, fall back to validating the body byte length
    // against the requested span (the 206 status already guarantees the
    // server honored the Range header). When it IS present, mismatches
    // remain a hard error — we don't accept a server that admits to
    // returning the wrong bytes.
    const contentRange = response.headers.get('content-range');
    const expected = end - offset + 1;
    if (contentRange === null) {
      const body = await response.arrayBuffer();
      if (body.byteLength !== expected) {
        throw new RangeReadError(
          'content-mismatch',
          `Server returned a 206 without Content-Range and a body length ${body.byteLength} that didn't match the requested ${expected} bytes.`,
        );
      }
      return body;
    }
    if (!isContentRangeMatch(contentRange, offset, end)) {
      throw new RangeReadError(
        'content-mismatch',
        `Server returned a 206 with mismatched Content-Range "${contentRange}" for ${offset}-${end}.`,
      );
    }
    return response.arrayBuffer();
  }

  /**
   * Discover size via a `Range: bytes=0-0` GET when HEAD is unusable.
   * Reads the one byte and parses the response's `Content-Range:` to
   * extract the total size. When the server's CORS configuration hides
   * `Content-Range` (the common S3-default case), an optional
   * `sizeHint` captured from a successful HEAD's `Content-Length` is
   * accepted as a fallback — the 206 status alone proves range support,
   * so trusting HEAD's size is safe.
   */
  private async _probeViaRangedGet(
    signal?: AbortSignal,
    sizeHint?: number,
  ): Promise<number> {
    const response = await this._fetchWithRetryAndTimeout(
      { headers: { Range: 'bytes=0-0' } },
      signal,
    );
    if (response.status === 200) {
      throw new RangeReadError(
        'range-unsupported',
        'This server ignored the range request and returned the whole file.',
      );
    }
    if (response.status !== 206) {
      throw new RangeReadError(
        response.status >= 500 ? 'server-error' : 'transport',
        `Probe returned an unexpected status ${response.status}`,
      );
    }
    // Drain the one-byte body so the connection can be reused. Skipping
    // this can leave the response in a half-read state on some runtimes.
    void response.arrayBuffer().catch(() => undefined);
    const total = parseContentRangeTotal(response.headers.get('content-range'));
    if (total !== null && total > 0) {
      this._size = total;
      return total;
    }
    // Content-Range was missing or unparseable. S3-style buckets hide it
    // from cross-origin responses by default; fall back to the HEAD-derived
    // Content-Length when the caller captured one. Range support is already
    // confirmed by the 206 status above.
    if (sizeHint !== undefined && sizeHint > 0) {
      this._size = sizeHint;
      return sizeHint;
    }
    throw new RangeReadError(
      'range-unsupported',
      'The server confirmed range support but didn\'t expose the file size. ' +
        'If you control the bucket, add Content-Length and Content-Range to its CORS ExposeHeaders.',
    );
  }

  /**
   * Wrap a single `fetch` call with: a per-attempt hard timeout (per-attempt timeout),
   * exponential-backoff retries on transient transport failures (retry-with-backoff),
   * and proper signal composition so the caller's cancel still wins. Every
   * non-retryable response is returned unchanged for the caller to inspect.
   */
  private async _fetchWithRetryAndTimeout(
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      if (callerSignal?.aborted) {
        throw new RangeReadError('aborted', 'Range read aborted');
      }
      const timeoutController = new AbortController();
      const timer = setTimeout(
        () => timeoutController.abort(),
        this._requestTimeoutMs,
      );
      const { signal, cleanup } = composeSignals(
        callerSignal,
        timeoutController.signal,
      );
      let response: Response;
      try {
        response = await this._fetch(this._url, { ...init, signal });
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        if (callerSignal?.aborted) {
          throw new RangeReadError('aborted', 'Range read aborted');
        }
        if (timeoutController.signal.aborted) {
          lastError = new RangeReadError(
            'timeout',
            `Request to ${sanitizeUrlForDisplay(this._url)} timed out after ${this._requestTimeoutMs} ms.`,
          );
        } else {
          // A transport rejection from `fetch` is most often a network drop or
          // a CORS preflight failure — we retry on it like a 5xx.
          lastError = err;
        }
        if (attempt < this._maxRetries) {
          await this._sleepWithJitter(attempt);
          continue;
        }
        if (lastError instanceof RangeReadError) throw lastError;
        throw new RangeReadError(
          'transport',
          `Could not reach ${sanitizeUrlForDisplay(this._url)} — check the URL and that the server allows cross-origin requests.`,
        );
      }
      clearTimeout(timer);
      cleanup();
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      // Retryable HTTP status — discard the body, back off, try again.
      lastError = new RangeReadError(
        response.status >= 500 ? 'server-error' : 'transport',
        `Server returned ${response.status} for ${sanitizeUrlForDisplay(this._url)}`,
      );
      if (attempt < this._maxRetries) {
        await this._sleepWithJitter(attempt);
        continue;
      }
      throw lastError;
    }
    // Unreachable — the loop returns or throws on every iteration.
    throw (lastError as Error | undefined) ??
      new RangeReadError('transport', `Could not reach ${sanitizeUrlForDisplay(this._url)}`);
  }

  /** Exponential backoff with full jitter — `base × 2^attempt × rand()`. */
  private async _sleepWithJitter(attempt: number): Promise<void> {
    const ceiling = this._retryBaseMs * Math.pow(2, attempt);
    const delay = Math.max(0, Math.floor(ceiling * this._random()));
    await this._sleep(delay);
  }
}

/** Parse the total size out of `bytes 0-0/12345`. Returns `null` on failure. */
function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  // `bytes <start>-<end>/<total>` or `bytes */<total>` (unsatisfied range).
  const match = /^bytes\s+(?:\*|\d+-\d+)\/(\d+)$/i.exec(header.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/** Check a 206 `Content-Range` against the requested first / last byte. */
function isContentRangeMatch(
  header: string | null,
  offset: number,
  end: number,
): boolean {
  if (!header) return false;
  const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(header.trim());
  if (!match) return false;
  return Number(match[1]) === offset && Number(match[2]) === end;
}

/**
 * Compose two abort signals into one — the result aborts if either input
 * aborts. Returns the second signal directly when the first is absent so
 * callers don't pay for a redundant controller in the common case.
 *
 * `cleanup()` MUST be called by the caller on every exit path of the
 * composed request, including success. `{ once: true }` would auto-remove
 * the listener only when it fires; a successful read never fires it, so
 * without explicit cleanup a long-lived `outer` signal would accumulate
 * listeners across many fetches. In normal `StreamingScheduler` use the
 * caller's signal is short-lived (per-decode), so the leak is theoretical
 * — but the API contract is defensive against any future caller pattern.
 */
function composeSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const noop = (): void => {};
  if (!outer) return { signal: inner, cleanup: noop };
  if (outer.aborted) {
    const ctrl = new AbortController();
    ctrl.abort();
    return { signal: ctrl.signal, cleanup: noop };
  }
  const composed = new AbortController();
  const onAbort = (): void => composed.abort();
  outer.addEventListener('abort', onAbort, { once: true });
  inner.addEventListener('abort', onAbort, { once: true });
  return {
    signal: composed.signal,
    cleanup: () => {
      // The inner signal is held only by `composed`'s controller, which is
      // discarded with the fetch — its listener dies with it. The outer
      // listener is the only one that can outlive the call, so we remove
      // exactly that one. `removeEventListener` on a `once: true` listener
      // that has already fired is a no-op (defined behaviour), so this is
      // safe to call regardless of how the request settled.
      outer.removeEventListener('abort', onAbort);
    },
  };
}
