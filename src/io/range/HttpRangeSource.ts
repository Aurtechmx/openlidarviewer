/**
 * HttpRangeSource.ts
 *
 * A {@link RangeSource} backed by HTTP Range requests against a remote URL.
 *
 * `probe()` performs the HEAD request and verifies the server can serve byte
 * ranges; `readRange()` issues real `Range:` requests. This drives the v0.3.0
 * remote-COPC flow — the "open from URL" field and the `?copc=<url>` deep
 * link — so a Cloud Optimized Point Cloud hosted on a CORS-enabled server
 * streams exactly like a local file.
 *
 * v0.3.1 hardens the remote path with: (a) bounded exponential-
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
import { RangeReadError, clampRange } from './RangeSource';

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
          `Server returned ${head.status} for ${this._url}`,
        );
      }
      if (head.headers.get('accept-ranges') !== 'bytes') {
        throw new RangeReadError(
          'range-unsupported',
          'This server does not support HTTP range requests, so it cannot stream COPC.',
        );
      }
      const length = Number(head.headers.get('content-length'));
      if (!Number.isFinite(length) || length <= 0) {
        // Some hosts (notably proxied CDNs) strip Content-Length. The
        // ranged-GET probe recovers the size from Content-Range.
        return await this._probeViaRangedGet(signal);
      }
      this._size = length;
      return length;
    } catch (err) {
      if (err instanceof RangeReadError) throw err;
      throw new RangeReadError(
        'transport',
        `Could not reach ${this._url} — check the URL and that the server allows cross-origin requests.`,
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
    // Content-Range validation — Content-Range validation. A 206 must carry a Content-Range
    // header identifying the served bytes; any mismatch with what we asked
    // for makes the response untrustworthy.
    const contentRange = response.headers.get('content-range');
    if (!isContentRangeMatch(contentRange, offset, end)) {
      throw new RangeReadError(
        'content-mismatch',
        `Server returned a 206 with mismatched Content-Range "${contentRange ?? '(missing)'}" for ${offset}-${end}.`,
      );
    }
    return response.arrayBuffer();
  }

  /**
   * Discover size via a `Range: bytes=0-0` GET when HEAD is unusable.
   * Reads the one byte and parses the response's `Content-Range:` to
   * extract the total size.
   */
  private async _probeViaRangedGet(signal?: AbortSignal): Promise<number> {
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
    const total = parseContentRangeTotal(response.headers.get('content-range'));
    if (total === null || total <= 0) {
      throw new RangeReadError(
        'range-unsupported',
        'Server returned a 206 but did not report a usable total size in Content-Range.',
      );
    }
    this._size = total;
    return total;
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
            `Request to ${this._url} timed out after ${this._requestTimeoutMs} ms.`,
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
          `Could not reach ${this._url} — check the URL and that the server allows cross-origin requests.`,
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
        `Server returned ${response.status} for ${this._url}`,
      );
      if (attempt < this._maxRetries) {
        await this._sleepWithJitter(attempt);
        continue;
      }
      throw lastError;
    }
    // Unreachable — the loop returns or throws on every iteration.
    throw (lastError as Error | undefined) ??
      new RangeReadError('transport', `Could not reach ${this._url}`);
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
