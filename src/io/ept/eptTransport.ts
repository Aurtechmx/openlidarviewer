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
 */

import type { EptTransport } from '../../render/streaming/EptStreamingPointCloud';

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Maximum retries beyond the initial attempt (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses we DO retry on (transient transport faults). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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
    label: 'hierarchy' | 'tile',
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
        if (!RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(
            `EPT ${label} fetch failed (${response.status} ${response.statusText}) for ${url}`,
          );
        }
        lastError = new Error(
          `EPT ${label} fetch failed (${response.status} ${response.statusText}) for ${url}`,
        );
      }
      // Backoff before the next attempt (unless we're out of retries).
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt + 1));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`EPT ${label} fetch failed for ${url}`);
  }

  return {
    fetchText: async (url, signal) => {
      const response = await fetchWithRetry(url, 'hierarchy', signal);
      return response.text();
    },
    fetchBytes: async (url, signal) => {
      const response = await fetchWithRetry(url, 'tile', signal);
      return response.arrayBuffer();
    },
  };
}
