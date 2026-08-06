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
 * Pure — no DOM, no three.js. Uses only `Response` and web streams, both of
 * which exist on the main thread and in workers.
 */

import { RangeReadError } from './RangeSource';

/**
 * A remote body that blew past the caller's byte ceiling, or arrived short.
 * Distinct from {@link RangeReadError} because the non-range callers (the EPT
 * transport, the EPT manifest) have no range semantics to report — they have a
 * limit and a resource name.
 */
export class BoundedReadError extends Error {
  /** The ceiling that was exceeded, in bytes. */
  readonly limitBytes: number;
  /** What was being read — "EPT hierarchy file", "EPT manifest", … */
  readonly what: string;
  constructor(what: string, limitBytes: number, message: string) {
    super(message);
    this.name = 'BoundedReadError';
    this.what = what;
    this.limitBytes = limitBytes;
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
  signal?: AbortSignal,
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
  try {
    for (;;) {
      if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
      const { done, value } = await reader.read();
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
  signal?: AbortSignal,
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
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        throw new BoundedReadError(
          what,
          maxBytes,
          `${what} exceeds the ${maxBytes}-byte limit — refusing to read further.`,
        );
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await cancelQuietly(reader);
    throw err;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** {@link readAtMostBounded}, decoded as UTF-8. For JSON documents. */
export async function readTextAtMost(
  response: Response,
  maxBytes: number,
  what: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readAtMostBounded(response, maxBytes, what, signal);
  return new TextDecoder('utf-8').decode(bytes);
}
