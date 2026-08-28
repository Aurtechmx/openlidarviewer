/**
 * tilesetTransport.ts — the hardened remote fetch for 3D Tiles.
 *
 * WHY THIS IS NOT `createEptTransport`. The EPT transport carries the same
 * discipline this needs (per-attempt timeout, bounded retry with jittered
 * backoff, `redirect: 'error'`, bounded body reads), but it is EPT-specific in
 * two ways that matter rather than one that is cosmetic. Its two read shapes
 * are named `hierarchy` and `tile` and it embeds those words in the error
 * messages it throws, and `describeRemoteEptError` PATTERN-MATCHES those exact
 * strings to build the user-facing message. Borrowing it would make a failed
 * `.pnts` fetch tell the user that "EPT tile fetch failed", and would tie any
 * future change to the 3D Tiles messages to the EPT classifier's regexes. The
 * ceilings differ too: a tileset.json and a `.pnts` are not an ept.json and a
 * LAZ chunk. So the discipline is mirrored and the vocabulary is this format's.
 *
 * The bounded reads are genuinely shared: `readTextAtMost` / `readAtMostBounded`
 * refuse a declared oversize before the first byte, stop on the chunk that
 * crosses the ceiling, carry an idle-silence budget, and stay wired to the
 * caller's cancel. Nothing about them is EPT-flavoured.
 *
 * Pure apart from `fetch` itself — the injected `fetchImpl`, `sleep` and
 * `random` make every retry, timeout and abort path deterministically testable
 * with no network, the way the EPT transport's tests do.
 */

import { sanitizeUrlForDisplay } from '../range/RangeSource';
import { ownedExactBuffer, readAtMostBounded, readTextAtMost } from '../range/boundedRead';

/**
 * Best-effort cancel a response body we are about to abandon (a retryable error
 * response, or a permanent non-success the caller throws on). Cancelling the
 * stream releases the connection instead of leaving an error page's body to
 * trickle in the background. Guarded for runtimes / test stand-ins whose
 * Response carries no streaming body, and for a `cancel()` that itself rejects.
 * Mirrors `HttpRangeSource.cancelResponseBody`.
 */
function cancelResponseBody(response: Response): void {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.cancel === 'function') {
    void body.cancel().catch(() => undefined);
  }
}

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/**
 * Ceiling for a `tileset.json` body. The document is JSON metadata — bounding
 * volumes, geometric errors, content URIs — while the geometry lives in the
 * `.pnts` files it names, so even a continent-scale tileset's entry document is
 * kilobytes to low megabytes. Well above any real document and far below a
 * memory hazard. The tile COUNT inside a document this size is separately
 * capped by `parseTileset`, because a few hundred kilobytes of minified JSON
 * can still name a very large tree.
 */
export const MAX_TILESET_JSON_BYTES = 8 * 1024 * 1024;
/**
 * Ceiling for one `.pnts` body. PNTS is uncompressed, so its size is bounded by
 * its point count: 4M points carrying position, colour and normal is roughly
 * 130 MB. 128 MiB refuses a hostile body without rejecting a legitimate tile
 * from a writer that produced unusually large tiles.
 */
export const MAX_PNTS_TILE_BYTES = 128 * 1024 * 1024;
/**
 * Ceiling for one `.subtree` body.
 *
 * A subtree carries three availability bitstreams and nothing else: one bit per
 * tile over the levels it covers. The widest subtree this reader will read at
 * all is bounded by `MAX_TILES_PER_SUBTREE`, which at about a million tiles is
 * 128 KB per bitstream, so a legitimate document is orders of magnitude below
 * this. It is separate from the tile ceiling because a `.subtree` is metadata,
 * not geometry, and reading it at the 128 MiB a point tile is allowed would
 * make availability the largest allocation in an implicit open.
 */
export const MAX_SUBTREE_BYTES = 8 * 1024 * 1024;
/** Maximum retries beyond the initial attempt (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses that are transient transport faults worth retrying. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * An internal per-attempt request deadline elapsed.
 *
 * Deliberately distinct from a user cancel: a timeout is a real failure the
 * user should see, not a silent cancellation. `code: 'timeout'` matches the
 * convention COPC's `RangeReadError` and EPT's `EptTimeoutError` already use,
 * so `isAbortError` in the streaming open path refuses to read it as a cancel.
 */
export class TilesetTimeoutError extends Error {
  readonly code = 'timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TilesetTimeoutError';
  }
}

/** What a 3D Tiles open reads over the wire. */
export interface TilesetTransport {
  /** The entry or an external `tileset.json`, capped at {@link MAX_TILESET_JSON_BYTES}. */
  fetchTilesetJson(url: string, signal?: AbortSignal): Promise<string>;
  /** One `.pnts` body, capped at {@link MAX_PNTS_TILE_BYTES}. */
  fetchTileBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  /**
   * One `.subtree` body, or one external availability buffer it names, capped
   * at {@link MAX_SUBTREE_BYTES}.
   *
   * A required member rather than an optional one. An implicit tileset's
   * availability is fetched from the same untrusted origin its tiles are, so it
   * needs the same per-attempt deadline, the same refused redirects and the
   * same bounded read; an optional method is one a caller can be missing
   * without noticing, and the fallback would be a plain fetch with none of them.
   */
  fetchSubtreeBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** Tunables for {@link createTilesetTransport}. Defaulted; injected for tests. */
export interface TilesetTransportOptions {
  /** Per-attempt timeout, in ms. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Maximum retries beyond the initial attempt. */
  maxRetries?: number;
  /** Base backoff before the first retry, ms. */
  retryBaseMs?: number;
  /** Replacement `fetch` — production callers omit this; tests inject a fake. */
  fetchImpl?: typeof fetch;
  /** PRNG in `[0, 1)`; tests inject a deterministic version for jitter. */
  random?: () => number;
  /** Sleep helper, ms. Tests can substitute a synchronous resolver. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the tileset.json ceiling. Tests use a tiny one. */
  maxTilesetJsonBytes?: number;
  /** Override the `.pnts` ceiling. Tests use a tiny one. */
  maxTileBytes?: number;
  /** Override the `.subtree` ceiling. Tests use a tiny one. */
  maxSubtreeBytes?: number;
}

/** What kind of resource a request is reading, for the error vocabulary. */
type ReadLabel = 'tileset' | 'tile' | 'subtree';

/**
 * Build a hardened 3D Tiles transport: per-attempt timeout, bounded retry with
 * jittered backoff, refused redirects, and bounded body reads.
 */
export function createTilesetTransport(
  options: TilesetTransportOptions = {},
): TilesetTransport {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const fetchFn = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxJsonBytes = options.maxTilesetJsonBytes ?? MAX_TILESET_JSON_BYTES;
  const maxTileBytes = options.maxTileBytes ?? MAX_PNTS_TILE_BYTES;
  const maxSubtreeBytes = options.maxSubtreeBytes ?? MAX_SUBTREE_BYTES;

  /**
   * One GET with a hard deadline, composed with the caller's outer signal.
   *
   * The composed controller is what the fetch sees, so either source aborts it;
   * which of the two fired is recovered afterwards, because both surface as an
   * indistinguishable `AbortError` on the rejection itself.
   */
  async function fetchOnce(url: string, outer?: AbortSignal): Promise<Response> {
    if (outer?.aborted) {
      throw outer.reason ?? new DOMException('3D Tiles fetch aborted before request', 'AbortError');
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);
    const composed = new AbortController();
    const onAbort = (): void => composed.abort();
    if (outer) outer.addEventListener('abort', onAbort, { once: true });
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    try {
      // `redirect: 'error'`: the host passed the SSRF block-list as a literal
      // string, but a 3xx could send the fetch to a private address no check
      // ever resolved. Refuse the hop rather than follow it.
      return await fetchFn(url, { signal: composed.signal, redirect: 'error' });
    } catch (err) {
      if (deadline.signal.aborted && !outer?.aborted) {
        throw new TilesetTimeoutError(
          `3D Tiles request timed out after ${requestTimeoutMs} ms for ${sanitizeUrlForDisplay(url)}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
      deadline.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Exponential backoff, jittered ±50 % so clients do not retry in lockstep. */
  function backoffMs(n: number): number {
    const exp = retryBaseMs * Math.pow(2, n - 1);
    return Math.max(0, Math.round(exp * (1 + (random() - 0.5))));
  }

  async function fetchWithRetry(
    url: string,
    label: ReadLabel,
    outer?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (outer?.aborted) {
        throw outer.reason ?? new DOMException('3D Tiles fetch aborted between retries', 'AbortError');
      }
      let response: Response | null = null;
      // Only the transport call sits inside the try; the status classification
      // below is outside it so a permanent-error throw is not swallowed back
      // into the retry loop.
      try {
        response = await fetchOnce(url, outer);
      } catch (err) {
        if (outer?.aborted) throw err;
        lastError = err;
      }
      if (response) {
        if (response.ok) return response;
        // Non-success: this response is being abandoned, to retry or to throw.
        // Cancel its body first so the connection is released rather than left
        // to trickle an error page in the background. Mirrors
        // `HttpRangeSource.cancelResponseBody`.
        cancelResponseBody(response);
        const message =
          `3D Tiles ${label} fetch failed (${response.status} ${response.statusText}) ` +
          `for ${sanitizeUrlForDisplay(url)}`;
        // 4xx other than 408/429 is permanent; retrying only delays the error.
        if (!RETRYABLE_STATUSES.has(response.status)) throw new Error(message);
        lastError = new Error(message);
      }
      if (attempt < maxRetries) await sleep(backoffMs(attempt + 1));
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`3D Tiles ${label} fetch failed for ${sanitizeUrlForDisplay(url)}`);
  }

  return {
    fetchTilesetJson: async (url, signal) => {
      const response = await fetchWithRetry(url, 'tileset', signal);
      // The retry loop bounds the header round-trip only; the bytes that follow
      // need their own ceiling and stall clock.
      return readTextAtMost(
        response,
        maxJsonBytes,
        `3D Tiles tileset at ${sanitizeUrlForDisplay(url)}`,
        { signal },
      );
    },
    fetchSubtreeBytes: async (url, signal) => {
      const response = await fetchWithRetry(url, 'subtree', signal);
      const bytes = await readAtMostBounded(
        response,
        maxSubtreeBytes,
        `3D Tiles subtree at ${sanitizeUrlForDisplay(url)}`,
        { signal },
      );
      // Exact-size, for the same reason the tile read below is: the subtree
      // reader indexes chunk offsets against the buffer length, so a pooled
      // backing buffer would present trailing bytes as part of the document.
      // `ownedExactBuffer` skips the copy when the body already owns its buffer.
      return ownedExactBuffer(bytes);
    },
    fetchTileBytes: async (url, signal) => {
      const response = await fetchWithRetry(url, 'tile', signal);
      const bytes = await readAtMostBounded(
        response,
        maxTileBytes,
        `3D Tiles tile at ${sanitizeUrlForDisplay(url)}`,
        { signal },
      );
      // An exact-size ArrayBuffer: a pooled or oversized backing buffer would
      // hand the PNTS decoder trailing bytes that are not part of the tile, and
      // the decoder reads its header offsets against the buffer length.
      // `ownedExactBuffer` avoids the copy when the body already owns its buffer.
      return ownedExactBuffer(bytes);
    },
  };
}
