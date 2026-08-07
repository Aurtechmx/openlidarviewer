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
 * IDENTITY PINNING. A COPC load is dozens of range reads spread over
 * seconds or minutes against an object the server may replace at any moment.
 * Nothing tied one read to the next: `probe()` learned a size, `readRange()`
 * checked only that the first and last byte numbers came back as asked, and
 * the `Content-Range` TOTAL was discarded by a non-capturing group. A file
 * swapped mid-load therefore mixed two versions of the object into one point
 * cloud, and a same-size re-upload — a re-run of the same processing job, the
 * common case — decoded cleanly and produced WRONG COORDINATES WITH NO ERROR.
 * `docs/threat-model.md` ranks that first precisely because a wrong number is
 * silent where a crash is not. So: pin the object's validators at probe time,
 * send `If-Match` on every subsequent range read where the server gave us a
 * strong ETag, and re-check the validators and the total on every response.
 * A mismatch is `resource-changed` — a distinct code that deliberately does
 * not retry, because retrying fetches bytes from the new object to sit beside
 * the bytes we already hold from the old one.
 *
 * BOUNDED READS. Every body is read through
 * {@link readExactlyBounded}, which stops at the requested length instead of
 * materialising whatever the server chose to send and checking afterwards.
 *
 * DEADLINES THAT OUTLIVE THE HEADERS. The per-attempt timer used to be cleared
 * — and the composed abort listener torn down — the instant `fetch` resolved,
 * which is when the HEADERS arrive, not the body. After that moment a server
 * could stall the body forever with no deadline running and no way for the
 * user's Cancel to reach the stream. `_fetchWithRetryAndTimeout` therefore
 * hands back a {@link TimedResponse} whose timer and listeners stay armed, and
 * the caller `release()`s only once the body has been consumed.
 *
 * Pure of three.js; uses `fetch`, which is available on both the main thread
 * and in workers.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';
import { RangeReadError, clampRange, sanitizeUrlForDisplay } from './RangeSource';
import { readAtMostBounded, readExactlyBounded } from './boundedRead';

/** Per-attempt timeout for one HTTP request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Maximum number of retry attempts after the initial try (so up to 4 total). */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff before the first retry — doubled each attempt, jittered. */
const DEFAULT_RETRY_BASE_MS = 250;
/** HTTP statuses we DO retry on (transient transport faults). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/**
 * `412 Precondition Failed` is the server's answer to our `If-Match`: the
 * object no longer has the ETag we pinned. It is not in
 * {@link RETRYABLE_STATUSES} and must never be added to it — a retry would
 * just fetch the NEW object's bytes to mix with the old object's bytes we
 * already decoded, which is the exact failure the precondition exists to
 * prevent.
 */
const PRECONDITION_FAILED = 412;

/**
 * A response whose request deadline is still running.
 *
 * The whole point is `release`. Everything a `fetch` promise settling tells you
 * is that the response HEADERS arrived; the body is still in flight, still on
 * the same connection, and still needs both a deadline and a route for the
 * user's cancel. Holding the timer and the composed signal until the caller
 * says it is done reading is what makes a stalled body terminate.
 */
interface TimedResponse {
  readonly response: Response;
  /**
   * The signal the request was issued with — caller cancel composed with the
   * per-attempt deadline. Pass it to the body reader so an abort errors the
   * stream instead of leaving a read pending forever.
   */
  readonly signal: AbortSignal | undefined;
  /**
   * The deadline half of {@link signal}, so the body reader can tell an
   * expired deadline (a stalled server — an error) from the user's Cancel (not
   * an error). Both reach it as the same composed abort otherwise.
   */
  readonly timeoutSignal: AbortSignal;
  /** Drop the timer and the listeners. Call once the body is consumed. */
  readonly release: () => void;
}

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
  /** The `ETag` pinned at probe time, verbatim (quotes and any `W/` included). */
  private _etag: string | null = null;
  /**
   * Whether {@link _etag} is a STRONG validator. `If-Match` is defined to use
   * strong comparison, so a weak `W/"…"` tag must not be sent as a
   * precondition — it would be rejected or, worse, silently mis-evaluated. A
   * weak tag is still worth keeping: we compare it against what comes back.
   */
  private _etagIsStrong = false;
  /** The `Last-Modified` pinned at probe time — the weaker fallback validator. */
  private _lastModified: string | null = null;
  /**
   * Whether to send `If-Match` on range reads. Starts on and downgrades at
   * most once; see {@link _readRangeResponse} for why a working dataset must
   * be able to fall back.
   */
  private _useConditionalRead = true;
  /** True once a conditional read has actually reached a response. */
  private _conditionalReadProven = false;

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
      const headAttempt = await this._fetchWithRetryAndTimeout(
        { method: 'HEAD' },
        signal,
      );
      // A HEAD has no body to read, so the deadline has nothing left to cover.
      headAttempt.release();
      const head = headAttempt.response;
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
      // Pin the object's identity from the first successful response. Every
      // later read is checked against this; see the IDENTITY PINNING note at
      // the top of the file.
      this._pinIdentity(head);
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
    const attempt = await this._readRangeResponse(offset, end, signal);
    try {
      return await this._consumeRangeResponse(attempt, offset, end);
    } finally {
      // The deadline stays armed until the body is fully read — releasing at
      // the headers is what let a stalled body hang with no clock running.
      attempt.release();
    }
  }

  /** Validate a range response and read its body under the attempt's deadline. */
  private async _consumeRangeResponse(
    attempt: TimedResponse,
    offset: number,
    end: number,
  ): Promise<ArrayBuffer> {
    const response = attempt.response;
    // The server evaluated our `If-Match` and says the object is no longer
    // the one we pinned. Distinct from every transport code on purpose: the
    // read cannot be retried into correctness, because the bytes already
    // decoded belong to a version that no longer exists.
    if (response.status === PRECONDITION_FAILED) {
      throw new RangeReadError(
        'resource-changed',
        'The file on the server changed while it was loading. Reload to read the current version.',
      );
    }
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
    if (contentRange !== null) {
      const parsed = parseContentRange(contentRange);
      if (parsed === null || parsed.first !== offset || parsed.last !== end) {
        throw new RangeReadError(
          'content-mismatch',
          `Server returned a 206 with mismatched Content-Range "${contentRange}" for ${offset}-${end}.`,
        );
      }
      // The TOTAL was previously thrown away by a non-capturing group, which
      // is what let a re-uploaded object of a different size go unnoticed. It
      // is the one identity signal every compliant range server sends, with
      // no CORS `ExposeHeader` beyond the Content-Range we already read.
      this._assertSameObject(response, parsed.total);
    } else {
      this._assertSameObject(response, null);
    }
    // Bounded body read for every path: the length is fixed by the request,
    // so anything longer is refused mid-stream rather than allocated first —
    // and, with the attempt's signal, anything SLOWER than the idle budget is
    // refused too rather than waited on forever.
    return readExactlyBounded(response, expected, {
      signal: attempt.signal,
      timeoutSignal: attempt.timeoutSignal,
      idleTimeoutMs: this._requestTimeoutMs,
    });
  }

  /**
   * Issue the range request, sending `If-Match` when we hold a strong ETag.
   *
   * The fallback exists because `If-Match` is not a CORS-safelisted request
   * header. A bucket whose CORS policy lists `Range` explicitly rather than
   * `*` in `AllowedHeaders` will fail the preflight for a request that adds
   * `If-Match`, and the browser reports that as an opaque `fetch` rejection —
   * indistinguishable from a network drop. Refusing to load such a dataset
   * would trade a rare correctness hazard for a common, total outage on hosts
   * that work today. So the FIRST conditional read that dies at the transport
   * layer downgrades this source to unconditional reads, once, and every
   * response is still checked against the pinned validators and total. We lose
   * the server-side precondition on those hosts and keep the client-side
   * detection, which is the honest trade.
   */
  private async _readRangeResponse(
    offset: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<TimedResponse> {
    const conditional =
      this._useConditionalRead && this._etag !== null && this._etagIsStrong;
    const headers: Record<string, string> = { Range: `bytes=${offset}-${end}` };
    if (conditional) headers['If-Match'] = this._etag as string;
    try {
      const attempt = await this._fetchWithRetryAndTimeout({ headers }, signal);
      if (conditional) this._conditionalReadProven = true;
      return attempt;
    } catch (err) {
      const preflightSuspect =
        conditional &&
        !this._conditionalReadProven &&
        err instanceof RangeReadError &&
        err.code === 'transport';
      if (!preflightSuspect) throw err;
      this._useConditionalRead = false;
      return this._fetchWithRetryAndTimeout(
        { headers: { Range: `bytes=${offset}-${end}` } },
        signal,
      );
    }
  }

  /**
   * Record the object's validators from the first response that carries them.
   * Later responses are checked against these, never allowed to overwrite them
   * — a pin that follows the server around isn't a pin.
   */
  private _pinIdentity(response: Response): void {
    if (this._etag === null) {
      const etag = response.headers.get('etag');
      if (etag !== null && etag.trim() !== '') {
        this._etag = etag.trim();
        this._etagIsStrong = !/^W\//i.test(this._etag);
      }
    }
    if (this._lastModified === null) {
      const lastModified = response.headers.get('last-modified');
      if (lastModified !== null && lastModified.trim() !== '') {
        this._lastModified = lastModified.trim();
      }
    }
  }

  /**
   * Fail the read if this response describes a different object than the one
   * pinned at probe time.
   *
   * Each check is skipped when either side is absent, which is the graceful
   * degradation the CORS-restricted hosts need: a bucket that exposes no
   * `ETag`, no `Last-Modified`, and no `Content-Range` gets exactly the
   * behaviour it had before, no worse. A host that exposes any one of them
   * gets that one enforced. Absence is never treated as agreement.
   */
  private _assertSameObject(response: Response, total: number | null = null): void {
    const etag = response.headers.get('etag');
    if (this._etag !== null && etag !== null && etag.trim() !== this._etag) {
      throw new RangeReadError(
        'resource-changed',
        'The file on the server changed while it was loading (its ETag no longer matches). ' +
          'Reload to read the current version.',
      );
    }
    const lastModified = response.headers.get('last-modified');
    if (
      this._lastModified !== null &&
      lastModified !== null &&
      lastModified.trim() !== this._lastModified
    ) {
      throw new RangeReadError(
        'resource-changed',
        'The file on the server changed while it was loading (its Last-Modified date moved). ' +
          'Reload to read the current version.',
      );
    }
    if (total !== null && this._size !== undefined && total !== this._size) {
      throw new RangeReadError(
        'resource-changed',
        `The file on the server changed while it was loading — it is now ${total} bytes, ` +
          `not the ${this._size} it reported when the load started. Reload to read the current version.`,
      );
    }
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
    const attempt = await this._fetchWithRetryAndTimeout(
      { headers: { Range: 'bytes=0-0' } },
      signal,
    );
    try {
      return await this._probeFromRangedResponse(attempt, sizeHint);
    } finally {
      // Released only after the drain below has finished with the body, so a
      // probe whose one byte never arrives still hits the deadline.
      attempt.release();
    }
  }

  /** The body of {@link _probeViaRangedGet}, under the attempt's deadline. */
  private async _probeFromRangedResponse(
    attempt: TimedResponse,
    sizeHint?: number,
  ): Promise<number> {
    const response = attempt.response;
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
    // A HEAD may have run first; if so this response must describe the same
    // object, or the object changed between two probe requests seconds apart
    // and nothing downstream can be trusted. Otherwise this becomes the pin.
    this._assertSameObject(response);
    this._pinIdentity(response);
    // Drain the one-byte body so the connection can be reused — skipping it
    // can leave the response half-read on some runtimes — but drain it
    // BOUNDED. This line used to be `void response.arrayBuffer().catch(…)`: an
    // unbounded body read into a discarded promise, during the probe, before
    // anything at all was known about the object. One byte is the entire legal
    // answer to `bytes=0-0`; anything past it gets cancelled rather than
    // buffered. A server that can't produce even that is not a probe failure —
    // the 206 status already proved range support — so the drain's own outcome
    // stays advisory.
    await readAtMostBounded(response, 1, 'range probe', {
      signal: attempt.signal,
      timeoutSignal: attempt.timeoutSignal,
      idleTimeoutMs: this._requestTimeoutMs,
    }).catch(() => undefined);
    const total = parseContentRange(response.headers.get('content-range'))?.total ?? null;
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
   *
   * Returns a {@link TimedResponse}, not a bare `Response`: the timer and the
   * composed signal survive past the headers so the caller can read the body
   * under the same deadline and the same cancellation. Every caller MUST
   * `release()` on every exit path.
   */
  private async _fetchWithRetryAndTimeout(
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<TimedResponse> {
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
      // Idempotent: the retry paths below release before looping, and the
      // caller releases after reading the body.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        cleanup();
      };
      let response: Response;
      try {
        // `redirect: 'follow'` is the platform default, stated here so it reads
        // as a decision rather than an oversight. `'error'` would refuse the
        // signed-URL and CDN chains public LiDAR hosting is built on (S3 to
        // CloudFront, GCS signed redirects, DOI resolvers). The residual —
        // a validated public host redirecting somewhere private — is bounded
        // by the CSP and by CORS, and is written up in `docs/threat-model.md`.
        response = await this._fetch(this._url, { ...init, signal, redirect: 'follow' });
      } catch (err) {
        release();
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
      if (!RETRYABLE_STATUSES.has(response.status)) {
        // NOT released here — the body still has to be read, and it needs the
        // deadline and the caller's cancel to stay wired while it is.
        return { response, signal, timeoutSignal: timeoutController.signal, release };
      }
      // Retryable HTTP status — discard the body, back off, try again.
      release();
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

/** A parsed `Content-Range:` header. A `null` field means the server sent `*`. */
interface ParsedContentRange {
  /** First byte of the served span. */
  readonly first: number | null;
  /** Last byte of the served span, inclusive. */
  readonly last: number | null;
  /** Total size of the whole representation. */
  readonly total: number | null;
}

/**
 * Parse `bytes <first>-<last>/<total>`, either half of which may be `*`.
 *
 * This replaces two narrower helpers that each threw away what the other
 * needed: the span matcher discarded the total through a non-capturing group,
 * and the total parser was only ever called from the probe. The total is the
 * cheapest identity signal a range server gives us, so it has to survive
 * parsing at both call sites.
 */
function parseContentRange(header: string | null): ParsedContentRange | null {
  if (!header) return null;
  const match = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(?:(\d+)|\*)$/i.exec(header.trim());
  if (!match) return null;
  const num = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  const first = num(match[1]);
  const last = num(match[2]);
  const total = num(match[3]);
  // A digit group that overflows the safe-integer range parses to `null`
  // here, which would read as "the server sent `*`" — a lie by omission. Any
  // digits present must have produced a number.
  if ((match[1] !== undefined && first === null) ||
      (match[2] !== undefined && last === null) ||
      (match[3] !== undefined && total === null)) {
    return null;
  }
  return { first, last, total };
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
