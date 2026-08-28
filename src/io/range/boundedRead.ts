/**
 * boundedRead.ts
 *
 * Bounded body readers for untrusted remote responses.
 *
 * Every remote read in this codebase used to be `await response.arrayBuffer()`
 * followed — if at all — by a length check. That is read-then-validate: the
 * body is already fully materialised in memory before anyone asks whether it
 * was the right size. A host that answers a 3 KB range request with a 4 GB
 * body wins that exchange; the tab dies before the check runs. The `bytes=0-0`
 * probe was worse still, because it discarded the promise (`void
 * response.arrayBuffer()`) and so read an unbounded body into a buffer nobody
 * would ever look at, before anything at all was known about the object.
 *
 * These helpers invert the order: consult the declared length, then stream the
 * body through `ReadableStreamDefaultReader` and stop the moment it exceeds
 * what was asked for, cancelling the body so the transfer is torn down rather
 * than drained. Nothing materially larger than the caller's ceiling is ever
 * allocated.
 *
 * `response.body` is absent on some runtimes and on the hand-rolled Response
 * stand-ins used in tests. That degrades to `arrayBuffer()` plus the same
 * validation — read-then-validate again, but only where streaming genuinely
 * isn't available, and still with a pre-read `Content-Length` refusal in front
 * of it.
 *
 * A BYTE ceiling alone is not a bound. A server that returns headers promptly
 * and then never sends a body sits under every byte limit forever, and so does
 * one trickling a byte a minute. Bounding size without bounding time turns a
 * hostile host into a hang, which in the manifest path wedged the app's
 * `loading` flag until a page reload. So every chunk read RACES the caller's
 * abort and two clocks — an idle timeout (silence between chunks) and a
 * whole-body ceiling (the trickle) — rather than checking a flag before an
 * unbounded await, where a body that goes quiet never reaches the check again.
 *
 * Pure — no DOM, no three.js. Uses only `Response` and web streams, both of
 * which exist on the main thread and in workers.
 */

import { RangeReadError } from './RangeSource';

/**
 * Default silence budget between two chunks, in ms.
 *
 * Matches the per-request header timeout the transports already use: 20 s of a
 * connection saying nothing at all is the same evidence of a dead host either
 * side of the response headers.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 20_000;

/**
 * Default ceiling on consuming ONE body, in ms.
 *
 * Deliberately far above the idle budget. A total deadline as tight as the
 * header deadline would fail a large tile on a slow-but-healthy mobile link —
 * trading a rare hostile-host hang for a common legitimate failure. Five
 * minutes is past any real read (a 128 MiB tile at 500 KB/s is four) while
 * still terminating a byte-a-minute trickle that the idle budget alone would
 * let run forever.
 */
export const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

/**
 * The largest buffer the known-length fast path will allocate up front, in bytes.
 *
 * The declared-length path used to allocate `new Uint8Array(declared)` the
 * instant a valid `Content-Length` sat at or below the ceiling — so a hostile
 * server could force an allocation as large as the ceiling (up to 256 MiB for a
 * tile) with a header alone, before delivering a single meaningful byte. The
 * eager allocation only pays off when the body actually arrives; a lie earns a
 * free quarter-gigabyte. This bounds the immediate allocation to a small initial
 * size; only once this many GENUINE bytes have arrived (confirming a substantial
 * real body, not a header claim) does the reader allocate exactly `declared`
 * once and stream the remainder straight into it, still refusing anything past
 * `declared`. An honest small body (declared at or below this) is one allocation
 * and is never reallocated; a large honest one pays a single final copy, so the
 * transient peak is about `declared + MAX_DECLARED_PREALLOC_BYTES` rather than
 * the ~1.5x declared that continued doubling would hold at its last step.
 * 16 MiB keeps the common case single-shot while capping what a header alone can
 * reserve.
 */
export const MAX_DECLARED_PREALLOC_BYTES = 16 * 1024 * 1024;

/**
 * The ceiling on an UNKNOWN-length body, in bytes — the branch with no
 * trustworthy identity `Content-Length`.
 *
 * That branch cannot stream straight into one exact target: it collects chunks
 * and concatenates them at the end, so near the caller's ceiling it holds the
 * chunk list AND the joined buffer at once and peaks at ~2x the body. A tile
 * caller passes a `maxBytes` as high as 256 MiB, so an unknown-length body could
 * transiently need ~512 MiB to assemble — over the 256 MiB decode-peak policy the
 * rest of the pipeline promises. Capping the unknown-length branch at 64 MiB
 * keeps its ~2x assembly peak (~128 MiB) inside that policy. An honest server
 * that declares an identity `Content-Length` takes the streaming fast path above
 * and is unaffected; only a body that refuses to declare its length is held to
 * this lower bound. Legitimate manifests and hierarchies are far under it, so
 * their own (smaller) `maxBytes` still governs via the `min` below.
 */
export const MAX_UNKNOWN_LENGTH_BODY_BYTES = 64 * 1024 * 1024;

/** Timing and cancellation for one bounded body read. */
export interface BoundedReadOptions {
  /**
   * Aborts the read.
   *
   * The transports pass the SAME composed signal the `fetch` was issued with,
   * still wired to the caller's cancel and the request deadline, so aborting
   * it errors the underlying body stream rather than leaving a dangling read.
   * That wiring is the fix for a subtler half of the same bug: the transports
   * used to tear the listener down as soon as the headers arrived, after which
   * neither the deadline nor the user's Cancel could reach the body at all.
   */
  readonly signal?: AbortSignal;
  /**
   * The deadline half of `signal`, when the caller composed one.
   *
   * Both a user cancel and an expired request deadline arrive here as the same
   * event — the composed signal aborting — but they are not the same thing to
   * a person. A cancel should surface as a cancel (the app shows nothing; the
   * user already knows) and an expired deadline should surface as an error
   * naming a server that stopped responding. Handing the deadline's own signal
   * in is what lets the read tell them apart instead of reporting every
   * stalled host as something the user did.
   */
  readonly timeoutSignal?: AbortSignal;
  /** Silence budget between chunks. Default {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
  /** Whole-body ceiling. Default {@link DEFAULT_TOTAL_TIMEOUT_MS}. */
  readonly totalTimeoutMs?: number;
}

/** Why a bounded read failed. */
export type BoundedReadReason = 'too-large' | 'stalled';

/**
 * A remote body that blew past the caller's byte ceiling, arrived short, or
 * stopped arriving. Distinct from {@link RangeReadError} because the non-range
 * callers (the EPT transport, the EPT manifest) have no range semantics to
 * report — they have a limit and a resource name.
 */
export class BoundedReadError extends Error {
  /** The ceiling that was exceeded, in bytes. */
  readonly limitBytes: number;
  /** What was being read — "EPT hierarchy file", "EPT manifest", … */
  readonly what: string;
  /** Size failure or time failure. */
  readonly reason: BoundedReadReason;
  constructor(
    what: string,
    limitBytes: number,
    message: string,
    reason: BoundedReadReason = 'too-large',
  ) {
    super(message);
    this.name = 'BoundedReadError';
    this.what = what;
    this.limitBytes = limitBytes;
    this.reason = reason;
  }
}

/** The abort shape a cancelled `fetch` produces, so callers classify it alike. */
function abortError(): Error {
  return new DOMException('The read was aborted.', 'AbortError');
}

/**
 * Read ONE chunk, racing the reader against the caller's abort and the two
 * clocks.
 *
 * The ordering matters and is the whole point. Polling `signal.aborted` before
 * `await reader.read()` bounds nothing: the check happens, then control leaves
 * for an await that may never return, and the check is never reached again.
 * Racing puts the timer and the abort listener on the same footing as the read
 * itself, so whichever settles first wins.
 *
 * When a clock or the abort wins, the underlying `read()` is left pending. The
 * caller cancels the reader on its error path, which settles it.
 */
function readChunkRacing(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
  idleTimeoutMs: number,
  totalTimeoutMs: number,
  msLeftOfTotal: () => number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      act();
    };
    // An abort that the caller's deadline caused is a stalled server, not a
    // cancel — the transports arm the request deadline through the body now,
    // so it is the deadline, not the idle timer, that usually wins that race.
    const abortReason = (): Error =>
      timeoutSignal?.aborted
        ? new BoundedReadStall(
            'the request deadline expired while the body was still arriving',
            'total',
          )
        : abortError();
    function onAbort(): void {
      settle(() => reject(abortReason()));
    }
    if (signal?.aborted) {
      settle(() => reject(abortReason()));
      return;
    }
    const totalLeft = msLeftOfTotal();
    // Whichever clock expires first governs this chunk. `totalLeft` shrinks
    // across chunks, so a trickle eventually gets a zero budget even though
    // every individual gap stayed under the idle limit.
    const budget = Math.max(0, Math.min(idleTimeoutMs, totalLeft));
    // Which clock we were actually waiting on, decided up front: if the total
    // budget is what capped this chunk, expiry means the whole body ran out of
    // time, not that this one gap was too long.
    const cappedByTotal = totalLeft <= idleTimeoutMs;
    timer = setTimeout(() => {
      settle(() =>
        reject(
          cappedByTotal
            ? new BoundedReadStall(
                `body did not finish within ${totalTimeoutMs} ms`,
                'total',
              )
            : new BoundedReadStall(`body sent nothing for ${idleTimeoutMs} ms`, 'idle'),
        ),
      );
    }, budget);
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (err) => settle(() => reject(err)),
    );
  });
}

/** Internal marker for a body that stopped arriving; translated per caller. */
class BoundedReadStall extends Error {
  readonly kind: 'idle' | 'total';
  constructor(message: string, kind: 'idle' | 'total') {
    super(message);
    this.name = 'BoundedReadStall';
    this.kind = kind;
  }
}

/**
 * The body length the response declares, or `null` when it declares nothing
 * usable.
 *
 * `Content-Length` is only trustworthy as an upper bound when the body is not
 * re-encoded in transit: with `Content-Encoding: gzip` the header counts
 * compressed bytes while `arrayBuffer()` yields decompressed ones, so a
 * perfectly honest server would look like it under-reported. We therefore
 * return `null` for any non-identity encoding rather than reason about a
 * number that doesn't describe what we're about to receive.
 */
function declaredBodyLength(response: Response): number | null {
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') return null;
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/** Cancel a body reader without letting the cancellation mask the real error. */
async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A body that is already errored or closed rejects `cancel()`. We are on
    // an error path either way; the original failure is the one worth raising.
  }
}

/**
 * Tear down a body we have decided not to read at all.
 *
 * The declared-length refusals below happen before a single chunk is
 * consumed, and an un-cancelled body holds the connection open until the
 * whole transfer arrives — which is precisely the transfer we just refused.
 */
async function discardBody(response: Response): Promise<void> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    await body.cancel();
  } catch {
    // Already consumed, errored, or locked. Nothing left to release.
  }
}

/** Resolve the timing options once and start the whole-body clock. */
function startClock(options: BoundedReadOptions): {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  msLeftOfTotal: () => number;
} {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const startedAt = Date.now();
  return {
    idleTimeoutMs,
    totalTimeoutMs,
    msLeftOfTotal: () => totalTimeoutMs - (Date.now() - startedAt),
  };
}

/** True when the response exposes a real streaming body we can read in chunks. */
function streamableBody(
  response: Response,
): ReadableStream<Uint8Array> | null {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') return null;
  return body;
}

/**
 * Read exactly `expectedBytes` from a response body, refusing anything longer
 * or shorter.
 *
 * This is the range-read shape: the caller asked for a precise span and the
 * only acceptable answer is that span. Overflow is detected on the chunk that
 * crosses the line — the read stops there and cancels — so a hostile or broken
 * server cannot force an allocation beyond one chunk past the ceiling. Short
 * bodies are rejected too: a truncated range silently decoded is exactly the
 * "wrong number rather than a crash" failure the threat model puts first.
 */
export async function readExactlyBounded(
  response: Response,
  expectedBytes: number,
  options: BoundedReadOptions = {},
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new RangeReadError(
      'out-of-range',
      `Refusing to read a body of ${expectedBytes} bytes — not a valid length.`,
    );
  }
  const declared = declaredBodyLength(response);
  if (declared !== null && declared > expectedBytes) {
    // Refuse before reading a single byte. This is the whole point of the
    // helper: the server has already told us it intends to send too much.
    await discardBody(response);
    throw new RangeReadError(
      'content-mismatch',
      `Server declared a ${declared}-byte body for a ${expectedBytes}-byte request.`,
    );
  }
  const body = streamableBody(response);
  if (body === null) {
    // No streaming body available (older runtime, or a test stand-in). The
    // `Content-Length` refusal above is the only pre-read guard we get here.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expectedBytes) {
      throw new RangeReadError(
        'content-mismatch',
        `Server returned ${buffer.byteLength} bytes for a ${expectedBytes}-byte request.`,
      );
    }
    return buffer;
  }
  const out = new Uint8Array(expectedBytes);
  let filled = 0;
  const reader = body.getReader();
  const clock = startClock(options);
  try {
    for (;;) {
      const { done, value } = await readChunkRacing(
        reader,
        options.signal,
        options.timeoutSignal,
        clock.idleTimeoutMs,
        clock.totalTimeoutMs,
        clock.msLeftOfTotal,
      );
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (filled + value.byteLength > expectedBytes) {
        throw new RangeReadError(
          'content-mismatch',
          `Server returned more than the requested ${expectedBytes} bytes.`,
        );
      }
      out.set(value, filled);
      filled += value.byteLength;
    }
  } catch (err) {
    await cancelQuietly(reader);
    if (err instanceof BoundedReadStall) {
      throw new RangeReadError(
        'timeout',
        `Range read stalled — ${err.message}. The server sent headers but stopped sending data.`,
      );
    }
    throw err;
  }
  if (filled !== expectedBytes) {
    throw new RangeReadError(
      'content-mismatch',
      `Server returned ${filled} bytes for a ${expectedBytes}-byte request.`,
    );
  }
  return out.buffer;
}

/**
 * Read a body of unknown length, refusing anything above `maxBytes`.
 *
 * This is the manifest / hierarchy / tile shape: we don't know the size in
 * advance, only that a legitimate one is far below the ceiling. Everything
 * else matches {@link readExactlyBounded} — declared-length refusal first,
 * then a streaming read that stops and cancels on the chunk that crosses the
 * limit.
 */
export async function readAtMostBounded(
  response: Response,
  maxBytes: number,
  what: string,
  options: BoundedReadOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BoundedReadError(
      what,
      maxBytes,
      `Refusing to read ${what} with a ${maxBytes}-byte ceiling — not a valid limit.`,
    );
  }
  const declared = declaredBodyLength(response);
  if (declared !== null && declared > maxBytes) {
    await discardBody(response);
    throw new BoundedReadError(
      what,
      maxBytes,
      `${what} declares ${declared} bytes, above the ${maxBytes}-byte limit.`,
    );
  }
  const body = streamableBody(response);
  if (body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new BoundedReadError(
        what,
        maxBytes,
        `${what} is ${buffer.byteLength} bytes, above the ${maxBytes}-byte limit.`,
      );
    }
    return new Uint8Array(buffer);
  }
  const reader = body.getReader();
  const clock = startClock(options);
  // Declared-length fast path: an identity-encoded body with a valid
  // Content-Length at or below the ceiling lets us allocate the ONE exact
  // target up front and stream chunks straight into it. That avoids the
  // chunk-list + second full-size allocation the unknown-length path needs,
  // which peaks at ~2x the body size during concatenation. `declared` here is
  // already known to be `<= maxBytes` (the over-cap refusal above ran first),
  // and `declaredBodyLength` returns null under any non-identity
  // content-encoding, so a compressed length can never drive this branch.
  if (declared !== null) {
    // Allocate only a bounded initial buffer, never the whole declared size up
    // front: a large `declared` is a claim, not yet bytes. `declared` is already
    // known `<= maxBytes`. A small honest body (declared at or below the prealloc
    // bound) fits this one buffer and is never reallocated.
    let out = new Uint8Array(Math.min(declared, MAX_DECLARED_PREALLOC_BYTES));
    let filled = 0;
    // Grow `out` so it can hold at least `needed` bytes. The initial buffer is
    // `min(declared, PREALLOC)`, so this only ever fires when `declared` exceeds
    // the prealloc bound AND real bytes have filled it — i.e. at least
    // MAX_DECLARED_PREALLOC_BYTES of genuine body have already arrived,
    // confirming a substantial real body rather than a header alone. At that
    // point allocate exactly `declared` ONCE and stream the remainder straight
    // in, instead of doubling. Doubling's final step held the old and new
    // buffers together at ~1.5x declared (a 128 MiB body peaked ~192 MiB); a
    // single final allocation bounds the transient peak to about
    // `declared + MAX_DECLARED_PREALLOC_BYTES`. A trickle under the prealloc
    // bound never reaches here, so a header claim alone can never force the
    // large allocation. `declared` is the hard ceiling (over-declared bodies are
    // refused before this), so one allocation suffices — no growth loop.
    const ensureCapacity = (needed: number): void => {
      if (needed <= out.length) return;
      const bigger = new Uint8Array(declared);
      bigger.set(out.subarray(0, filled));
      out = bigger;
    };
    try {
      for (;;) {
        const { done, value } = await readChunkRacing(
          reader,
          options.signal,
          options.timeoutSignal,
          clock.idleTimeoutMs,
          clock.totalTimeoutMs,
          clock.msLeftOfTotal,
        );
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (filled + value.byteLength > declared) {
          // The body ran past its own declared length. Refuse rather than
          // grow a second buffer: a Content-Length that undercounts the body
          // is exactly the lie the ceiling exists to contain.
          throw new BoundedReadError(
            what,
            maxBytes,
            `${what} sent more than its declared ${declared} bytes — refusing to read further.`,
          );
        }
        ensureCapacity(filled + value.byteLength);
        out.set(value, filled);
        filled += value.byteLength;
      }
    } catch (err) {
      await cancelQuietly(reader);
      if (err instanceof BoundedReadStall) {
        throw new BoundedReadError(
          what,
          maxBytes,
          `${what} stalled — ${err.message}. The server sent headers but stopped sending data.`,
          'stalled',
        );
      }
      throw err;
    }
    // `out` now spans exactly what arrived when the body matched or grew to its
    // declared length; a short body leaves it longer than `filled`. Trim so no
    // trailing zeros reach the decoder. The exact-length common case (declared
    // at or below the prealloc bound) returns `out` untouched.
    return filled === out.length ? out : out.slice(0, filled);
  }
  // No trustworthy Content-Length: this branch concatenates chunks at the end
  // and so peaks at ~2x the body during the join. Hold it to a lower ceiling
  // than the caller's own so that ~2x assembly stays inside the decode-peak
  // policy; a caller whose maxBytes is already smaller keeps its own limit.
  const unknownMax = Math.min(maxBytes, MAX_UNKNOWN_LENGTH_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunkRacing(
        reader,
        options.signal,
        options.timeoutSignal,
        clock.idleTimeoutMs,
        clock.totalTimeoutMs,
        clock.msLeftOfTotal,
      );
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > unknownMax) {
        throw new BoundedReadError(
          what,
          unknownMax,
          `${what} exceeds the ${unknownMax}-byte unknown-length limit — refusing to read further.`,
        );
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await cancelQuietly(reader);
    if (err instanceof BoundedReadStall) {
      throw new BoundedReadError(
        what,
        maxBytes,
        `${what} stalled — ${err.message}. The server sent headers but stopped sending data.`,
        'stalled',
      );
    }
    throw err;
  }
  // Unknown-length path only: no Content-Length was available, so the size is
  // discovered by reading. This is the branch that peaks at ~2x during the
  // join below (chunk buffers still live while `out` fills). It is bounded by
  // `maxBytes` and, for a single chunk, avoids the copy entirely.
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Return an ArrayBuffer that owns exactly `bytes` and nothing more.
 *
 * A `Uint8Array` can be a window onto a larger backing buffer (non-zero
 * `byteOffset`, or a `byteLength` shorter than the buffer). Handing such a view
 * to a consumer that indexes the raw `ArrayBuffer` — a decoder reading header
 * offsets against `buffer.byteLength`, `new Blob([buffer])` — would leak the
 * trailing bytes. When the view already spans its whole buffer this returns
 * that buffer with no copy; otherwise it copies out just the viewed span. The
 * cast is sound because these buffers are never `SharedArrayBuffer`.
 *
 * Mirrors the inline form in `io/download.ts` so both sites share one rule.
 */
export function ownedExactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}

/** {@link readAtMostBounded}, decoded as UTF-8. For JSON documents. */
export async function readTextAtMost(
  response: Response,
  maxBytes: number,
  what: string,
  options: BoundedReadOptions = {},
): Promise<string> {
  const bytes = await readAtMostBounded(response, maxBytes, what, options);
  return new TextDecoder('utf-8').decode(bytes);
}
