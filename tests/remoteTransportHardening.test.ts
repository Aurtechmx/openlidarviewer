/**
 * remoteTransportHardening.test.ts
 *
 * Three defects in remote input handling, one describe-block each:
 *
 *   1. Remote object identity was not pinned. `probe()` learned a size and
 *      nothing checked that later range reads came from the same object; the
 *      `Content-Range` TOTAL was discarded by a non-capturing group. A file
 *      replaced mid-load mixed two versions, and a same-size re-upload
 *      decoded cleanly into wrong coordinates with no error at all.
 *   2. Remote reads were unbounded. Three of four body reads in
 *      `HttpRangeSource` were `arrayBuffer()`-then-check, including the
 *      `bytes=0-0` probe, which read an unbounded body into a discarded
 *      promise before anything was known about the object.
 *   3. EPT hierarchy values and keys were under-validated. Any finite number
 *      was accepted as a point count, and any digits-shaped address was
 *      accepted as a key regardless of whether the octree could contain it.
 */

import { describe, expect, it } from 'vitest';

import { HttpRangeSource } from '../src/io/range/HttpRangeSource';
import { RangeReadError } from '../src/io/range/RangeSource';
import {
  BoundedReadError,
  readAtMostBounded,
  readExactlyBounded,
  readTextAtMost,
} from '../src/io/range/boundedRead';
import { parseHierarchyFile, MAX_HIERARCHY_ENTRIES_PER_FILE } from '../src/io/ept/eptHierarchy';
import { eptStringToKey, MAX_EPT_DEPTH } from '../src/io/ept/eptTypes';
import {
  createEptTransport,
  MAX_EPT_HIERARCHY_BYTES,
  MAX_EPT_TILE_BYTES,
} from '../src/io/ept/eptTransport';

const FAST = { sleep: () => Promise.resolve(), random: () => 0 };
const URL_A = 'https://example.com/a.copc.laz';

/** Response builders for a server whose object identity we control. */
function headResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 200, headers });
}
function partialResponse(
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes.slice().buffer, { status: 206, headers });
}

/**
 * A fetch fake that records every request's headers and answers HEAD and
 * ranged GET separately.
 */
function recordingFetch(handlers: {
  head: () => Response;
  get: (init: RequestInit) => Response | Promise<Response>;
}): { fn: typeof fetch; requests: RequestInit[] } {
  const requests: RequestInit[] = [];
  const fn = (async (_url: string, init: RequestInit = {}) => {
    requests.push(init);
    return init.method === 'HEAD' ? handlers.head() : handlers.get(init);
  }) as typeof fetch;
  return { fn, requests };
}

/** Read the `If-Match` off a recorded request, whatever header shape was used. */
function ifMatchOf(init: RequestInit): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers['If-Match'];
}

// ────────────────────────────────────────────────────────────────────────────
// FIX 2 — remote object identity
// ────────────────────────────────────────────────────────────────────────────

describe('HttpRangeSource — identity pinning', () => {
  it('pins a strong ETag at probe and sends it as If-Match on range reads', async () => {
    const { fn, requests } = recordingFetch({
      head: () =>
        headResponse({
          'accept-ranges': 'bytes',
          'content-length': '100',
          etag: '"v1"',
        }),
      get: () =>
        partialResponse(new Uint8Array([1, 2, 3]), {
          'content-range': 'bytes 0-2/100',
          etag: '"v1"',
        }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    expect((await src.readRange(0, 3)).byteLength).toBe(3);
    const ranged = requests.filter((r) => r.method !== 'HEAD');
    expect(ranged).toHaveLength(1);
    expect(ifMatchOf(ranged[0])).toBe('"v1"');
  });

  it('does NOT send a weak ETag as If-Match, but still compares it', async () => {
    // If-Match is defined to use strong comparison; a W/ tag must not be sent
    // as a precondition. It is still a usable change signal on the way back.
    const { fn, requests } = recordingFetch({
      head: () =>
        headResponse({
          'accept-ranges': 'bytes',
          'content-length': '100',
          etag: 'W/"v1"',
        }),
      get: () =>
        partialResponse(new Uint8Array([1, 2, 3]), {
          'content-range': 'bytes 0-2/100',
          etag: 'W/"v2"',
        }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({
      code: 'resource-changed',
    });
    const ranged = requests.filter((r) => r.method !== 'HEAD');
    expect(ifMatchOf(ranged[0])).toBeUndefined();
  });

  it('fails with resource-changed when the ETag moves mid-load', async () => {
    const { fn } = recordingFetch({
      head: () =>
        headResponse({ 'accept-ranges': 'bytes', 'content-length': '100', etag: '"v1"' }),
      get: () =>
        partialResponse(new Uint8Array([9, 9, 9]), {
          'content-range': 'bytes 0-2/100',
          etag: '"v2"',
        }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    const err = await src.readRange(0, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('resource-changed');
    expect((err as Error).message).toMatch(/changed while it was loading/i);
  });

  it('fails with resource-changed when Last-Modified moves and there is no ETag', async () => {
    const { fn } = recordingFetch({
      head: () =>
        headResponse({
          'accept-ranges': 'bytes',
          'content-length': '100',
          'last-modified': 'Wed, 21 Oct 2020 07:28:00 GMT',
        }),
      get: () =>
        partialResponse(new Uint8Array([1, 2, 3]), {
          'content-range': 'bytes 0-2/100',
          'last-modified': 'Thu, 22 Oct 2020 07:28:00 GMT',
        }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({
      code: 'resource-changed',
    });
  });

  it('catches a SAME-SIZE-header re-upload through the Content-Range total', async () => {
    // The silent case the threat model puts first: no ETag, no Last-Modified,
    // just a different total. Before the fix the total was discarded by
    // `(?:\d+|\*)` and this read succeeded with bytes from the new object.
    const { fn } = recordingFetch({
      head: () => headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' }),
      get: () =>
        partialResponse(new Uint8Array([1, 2, 3]), { 'content-range': 'bytes 0-2/240' }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    const err = await src.readRange(0, 3).catch((e: unknown) => e);
    expect((err as RangeReadError).code).toBe('resource-changed');
    expect((err as Error).message).toContain('240');
  });

  it('treats 412 Precondition Failed as resource-changed and does NOT retry it', async () => {
    let getCalls = 0;
    const { fn } = recordingFetch({
      head: () =>
        headResponse({ 'accept-ranges': 'bytes', 'content-length': '100', etag: '"v1"' }),
      get: () => {
        getCalls++;
        return new Response(null, { status: 412 });
      },
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, maxRetries: 3, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({
      code: 'resource-changed',
    });
    // One attempt. A retry would fetch the NEW object's bytes to sit beside
    // the old object's bytes already decoded — the exact failure the
    // precondition exists to prevent.
    expect(getCalls).toBe(1);
  });

  it('does not retry a mid-stream identity change either', async () => {
    let getCalls = 0;
    const { fn } = recordingFetch({
      head: () =>
        headResponse({ 'accept-ranges': 'bytes', 'content-length': '100', etag: '"v1"' }),
      get: () => {
        getCalls++;
        return partialResponse(new Uint8Array([1, 2, 3]), {
          'content-range': 'bytes 0-2/100',
          etag: '"v2"',
        });
      },
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, maxRetries: 3, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({
      code: 'resource-changed',
    });
    expect(getCalls).toBe(1);
  });

  it('fails when the object changes BETWEEN the two probe requests', async () => {
    const { fn } = recordingFetch({
      // No Accept-Ranges → the probe falls through to a ranged GET.
      head: () => headResponse({ 'content-length': '100', etag: '"v1"' }),
      get: () =>
        partialResponse(new Uint8Array([0]), {
          'content-range': 'bytes 0-0/100',
          etag: '"v2"',
        }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.probe()).rejects.toMatchObject({ code: 'resource-changed' });
  });

  it('degrades gracefully on a host that exposes no validator at all', async () => {
    // The S3-default CORS case. No ETag, no Last-Modified, no Content-Range.
    // This must keep working exactly as it did — absence is not agreement,
    // but it is also not a failure.
    const { fn, requests } = recordingFetch({
      head: () => headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' }),
      get: () => partialResponse(new Uint8Array([1, 2, 3])),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    expect(new Uint8Array(await src.readRange(0, 3))).toEqual(new Uint8Array([1, 2, 3]));
    expect(ifMatchOf(requests[requests.length - 1])).toBeUndefined();
  });

  it('downgrades to unconditional reads once when If-Match trips a CORS preflight', async () => {
    // `If-Match` is not CORS-safelisted. A bucket that allows `Range` but not
    // `*` fails the preflight, and the browser reports an opaque rejection.
    // Refusing to load such a dataset would trade a rare hazard for a common
    // outage, so the first conditional read that dies at the transport layer
    // downgrades — once — and response-side checking continues.
    const seen: (string | undefined)[] = [];
    const fn = (async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'HEAD') {
        return headResponse({
          'accept-ranges': 'bytes',
          'content-length': '100',
          etag: '"v1"',
        });
      }
      const ifMatch = ifMatchOf(init);
      seen.push(ifMatch);
      if (ifMatch !== undefined) throw new TypeError('Failed to fetch');
      return partialResponse(new Uint8Array([1, 2, 3]), {
        'content-range': 'bytes 0-2/100',
        etag: '"v1"',
      });
    }) as typeof fetch;
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, maxRetries: 0, ...FAST });
    expect((await src.readRange(0, 3)).byteLength).toBe(3);
    expect(seen[0]).toBe('"v1"');
    expect(seen[seen.length - 1]).toBeUndefined();
    // Downgrade is sticky — the second read doesn't re-pay the failed preflight.
    await src.readRange(0, 3);
    expect(seen.filter((h) => h !== undefined)).toHaveLength(1);
  });

  it('still rejects a genuinely mismatched Content-Range span', async () => {
    // The pre-existing span assertion must survive the total-checking work.
    const { fn } = recordingFetch({
      head: () => headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' }),
      get: () =>
        partialResponse(new Uint8Array([1, 2, 3]), { 'content-range': 'bytes 7-9/100' }),
    });
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({
      code: 'content-mismatch',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// FIX 3 — bounded remote reads
// ────────────────────────────────────────────────────────────────────────────

/**
 * A body that delivers headers and then nothing, ever — the shape a byte
 * ceiling cannot catch, because zero bytes is under every limit.
 */
function stallingStream(): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // Never resolves: the connection is open and silent.
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

/** A stream that yields `chunks` and reports whether it was cancelled. */
function trackedStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
  pulls: () => number;
} {
  let i = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled, pulls: () => pulls };
}

const kb = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);
/** The same bytes as a standalone ArrayBuffer, which is what `Response` takes. */
const body = (n: number): ArrayBuffer => kb(n).buffer as ArrayBuffer;

describe('bounded reads', () => {
  it('readExactlyBounded returns the body when the length is exact', async () => {
    const out = await readExactlyBounded(new Response(body(8)), 8);
    expect(out.byteLength).toBe(8);
  });

  it('readExactlyBounded refuses and CANCELS an over-long body', async () => {
    const { stream, cancelled } = trackedStream([kb(64), kb(64), kb(64)]);
    const err = await readExactlyBounded(new Response(stream), 8).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('content-mismatch');
    // Cancelled, not drained: the transfer is torn down at the first chunk
    // that crosses the line rather than read to completion and discarded.
    expect(cancelled()).toBe(true);
  });

  it('readExactlyBounded stops reading at the first over-long chunk', async () => {
    const { stream, pulls } = trackedStream([kb(4), kb(4), kb(4), kb(4), kb(4)]);
    await readExactlyBounded(new Response(stream), 6).catch(() => undefined);
    // 4 fits, the next 4 overflows 6 and the read stops there. The exact pull
    // count is the stream's business (its high-water mark pre-pulls, and
    // cancelling can provoke one more); what this pins is that the reader
    // stopped early rather than draining all five chunks.
    expect(pulls()).toBeLessThanOrEqual(3);
  });

  it('readExactlyBounded rejects a SHORT body', async () => {
    await expect(readExactlyBounded(new Response(body(3)), 8)).rejects.toMatchObject({
      code: 'content-mismatch',
    });
  });

  it('readExactlyBounded refuses on Content-Length BEFORE reading a byte', async () => {
    const { stream, cancelled, pulls } = trackedStream([kb(4096), kb(4096), kb(4096)]);
    const response = new Response(stream, { headers: { 'content-length': '12288' } });
    await expect(readExactlyBounded(response, 8)).rejects.toMatchObject({
      code: 'content-mismatch',
    });
    // A ReadableStream fills its own one-chunk high-water mark whether or not
    // anyone reads, so `pulls() === 1` is the stream's doing, not ours; what
    // matters is that no consumer read happened and the body was torn down.
    expect(pulls()).toBeLessThanOrEqual(1);
    expect(cancelled()).toBe(true);
  });

  it('readExactlyBounded rejects a nonsensical expected length', async () => {
    await expect(readExactlyBounded(new Response(body(1)), 1.5)).rejects.toMatchObject({
      code: 'out-of-range',
    });
    await expect(
      readExactlyBounded(new Response(body(1)), Number.POSITIVE_INFINITY),
    ).rejects.toMatchObject({ code: 'out-of-range' });
  });

  it('readAtMostBounded accepts under the ceiling and refuses above it', async () => {
    expect((await readAtMostBounded(new Response(body(10)), 16, 'thing')).byteLength).toBe(10);
    const { stream, cancelled } = trackedStream([kb(32), kb(32)]);
    await expect(readAtMostBounded(new Response(stream), 16, 'thing')).rejects.toBeInstanceOf(
      BoundedReadError,
    );
    expect(cancelled()).toBe(true);
  });

  it('readTextAtMost decodes UTF-8 under the ceiling', async () => {
    expect(await readTextAtMost(new Response('{"a":1}'), 64, 'doc')).toBe('{"a":1}');
  });

  it('HttpRangeSource.readRange refuses an over-long 206 body', async () => {
    // The read-then-validate path: a 206 with no Content-Range whose body is
    // enormous used to be materialised in full, then measured.
    const { stream, cancelled } = trackedStream([kb(1024), kb(1024)]);
    const fn = (async (_url: string, init: RequestInit = {}) =>
      init.method === 'HEAD'
        ? headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' })
        : new Response(stream, { status: 206 })) as typeof fetch;
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'content-mismatch' });
    expect(cancelled()).toBe(true);
  });

  it('HttpRangeSource.readRange refuses an over-long body even WITH a matching Content-Range', async () => {
    // The header said 3 bytes; the body says otherwise. Nothing tied the two
    // together before, so this returned the whole oversized buffer.
    // Several chunks, so the body is still open when the overflow is caught —
    // a single-chunk fake would close on its own and there'd be nothing left
    // to cancel.
    const { stream, cancelled } = trackedStream([kb(4096), kb(4096), kb(4096)]);
    const fn = (async (_url: string, init: RequestInit = {}) =>
      init.method === 'HEAD'
        ? headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' })
        : new Response(stream, {
            status: 206,
            headers: { 'content-range': 'bytes 0-2/100' },
          })) as typeof fetch;
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'content-mismatch' });
    expect(cancelled()).toBe(true);
  });

  it('the bytes=0-0 probe cancels an over-long body instead of buffering it', async () => {
    // This body was previously read by `void response.arrayBuffer()` — an
    // unbounded read into a discarded promise, during the probe, before
    // anything was known about the object.
    const { stream, cancelled, pulls } = trackedStream([kb(4096), kb(4096), kb(4096)]);
    const fn = (async (_url: string, init: RequestInit = {}) =>
      init.method === 'HEAD'
        ? headResponse({ 'content-length': '100' }) // no accept-ranges → ranged probe
        : new Response(stream, {
            status: 206,
            headers: { 'content-range': 'bytes 0-0/100' },
          })) as typeof fetch;
    const src = new HttpRangeSource(URL_A, { fetchImpl: fn, ...FAST });
    // The probe still succeeds — the drain is advisory, the 206 already
    // proved range support — but the body is torn down, not buffered.
    expect(await src.probe()).toBe(100);
    expect(cancelled()).toBe(true);
    // One consumer read past the stream's own pre-pull, then cancel. The old
    // code would have run the whole 12 KiB (and any amount beyond it) into a
    // buffer nobody would ever look at.
    expect(pulls()).toBeLessThanOrEqual(2);
  });

  it('the EPT transport refuses a hierarchy body that declares more than the ceiling', async () => {
    const fn = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MAX_EPT_HIERARCHY_BYTES + 1) },
      })) as typeof fetch;
    const t = createEptTransport({ fetchImpl: fn, sleep: () => Promise.resolve() });
    await expect(
      t.fetchText('https://example.com/ept-hierarchy/0-0-0-0.json'),
    ).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('the EPT transport refuses a tile body that declares more than the ceiling', async () => {
    const fn = (async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(MAX_EPT_TILE_BYTES + 1) },
      })) as typeof fetch;
    const t = createEptTransport({ fetchImpl: fn, sleep: () => Promise.resolve() });
    await expect(
      t.fetchBytes('https://example.com/ept-data/0-0-0-0.laz'),
    ).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('the EPT ceilings are ordered sanely and stay explicit', () => {
    expect(MAX_EPT_HIERARCHY_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_EPT_TILE_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_EPT_TILE_BYTES).toBeGreaterThan(MAX_EPT_HIERARCHY_BYTES);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Bounded in TIME as well as bytes
//
// A byte ceiling is not a bound on its own. A server that sends headers and
// then goes quiet stays under every limit forever, and so does one trickling a
// byte a minute. Worse, the deadline used to be cleared the moment `fetch`
// resolved — which is when the HEADERS arrive — taking the caller's abort
// listener with it, so after that point neither the timeout nor the user's
// Cancel could reach the body at all.
// ────────────────────────────────────────────────────────────────────────────

describe('stalled bodies', () => {
  it('readExactlyBounded gives up on a body that never yields', async () => {
    const { stream, cancelled } = stallingStream();
    const err = await readExactlyBounded(new Response(stream), 8, {
      idleTimeoutMs: 25,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('timeout');
    expect((err as Error).message).toMatch(/stalled/i);
    expect(cancelled()).toBe(true);
  });

  it('readAtMostBounded gives up on a body that never yields', async () => {
    const { stream } = stallingStream();
    const err = await readAtMostBounded(new Response(stream), 1024, 'thing', {
      idleTimeoutMs: 25,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect((err as BoundedReadError).reason).toBe('stalled');
  });

  it('a caller abort reaches a stalled body', async () => {
    // The abort must WIN the race against a pending read, not be polled for
    // before one. Polling checked the flag and then left for an await that
    // never returned.
    const { stream, cancelled } = stallingStream();
    const controller = new AbortController();
    const reading = readAtMostBounded(new Response(stream), 1024, 'thing', {
      signal: controller.signal,
      // Far beyond the test's lifetime: only the abort can end this.
      idleTimeoutMs: 60_000,
    });
    controller.abort();
    const err = await reading.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(cancelled()).toBe(true);
  });

  it('the whole-body clock stops a trickle that never breaches the idle budget', async () => {
    // One byte every 10 ms forever: every gap is well inside the idle budget,
    // the byte total stays far below the ceiling, and only the total deadline
    // can end it.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            // The trickle keeps firing after the read gives up and cancels;
            // enqueueing onto a closed controller throws, so let it go.
            try {
              controller.enqueue(new Uint8Array(1));
            } catch {
              /* already cancelled — that is the outcome under test */
            }
            resolve();
          }, 10);
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    const err = await readAtMostBounded(new Response(stream), 1_000_000, 'thing', {
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 60,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect((err as BoundedReadError).reason).toBe('stalled');
    expect((err as Error).message).toMatch(/did not finish within 60 ms/);
    expect(cancelled).toBe(true);
  });

  it('HttpRangeSource.readRange times out on a body that stalls after the headers', async () => {
    const { stream, cancelled } = stallingStream();
    const fn = (async (_url: string, init: RequestInit = {}) =>
      init.method === 'HEAD'
        ? headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' })
        : new Response(stream, {
            status: 206,
            headers: { 'content-range': 'bytes 0-2/100' },
          })) as typeof fetch;
    const src = new HttpRangeSource(URL_A, {
      fetchImpl: fn,
      requestTimeoutMs: 30,
      maxRetries: 0,
      ...FAST,
    });
    // The request deadline — which now stays armed through the body — wins
    // this race and surfaces as a timeout, NOT as a user abort.
    await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'timeout' });
    expect(cancelled()).toBe(true);
  });

  it('a caller abort reaches a stalled range body', async () => {
    const { stream } = stallingStream();
    const fn = (async (_url: string, init: RequestInit = {}) =>
      init.method === 'HEAD'
        ? headResponse({ 'accept-ranges': 'bytes', 'content-length': '100' })
        : new Response(stream, {
            status: 206,
            headers: { 'content-range': 'bytes 0-2/100' },
          })) as typeof fetch;
    const src = new HttpRangeSource(URL_A, {
      fetchImpl: fn,
      // Long enough that only the abort can end the read.
      requestTimeoutMs: 60_000,
      maxRetries: 0,
      ...FAST,
    });
    await src.probe();
    const controller = new AbortController();
    const reading = src.readRange(0, 3, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
  });

  it('the EPT transport times out a hierarchy body that stalls after the headers', async () => {
    const { stream, cancelled } = stallingStream();
    const fn = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const t = createEptTransport({
      fetchImpl: fn,
      requestTimeoutMs: 30,
      maxRetries: 0,
      sleep: () => Promise.resolve(),
    });
    const err = await t
      .fetchText('https://example.com/ept-hierarchy/0-0-0-0.json')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect((err as BoundedReadError).reason).toBe('stalled');
    expect(cancelled()).toBe(true);
  });

  it('the EPT transport times out a tile body that stalls after the headers', async () => {
    const { stream } = stallingStream();
    const fn = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const t = createEptTransport({
      fetchImpl: fn,
      requestTimeoutMs: 30,
      maxRetries: 0,
      sleep: () => Promise.resolve(),
    });
    const err = await t
      .fetchBytes('https://example.com/ept-data/0-0-0-0.laz')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect((err as BoundedReadError).reason).toBe('stalled');
  });

  it('a caller abort reaches a stalled EPT tile body', async () => {
    const { stream } = stallingStream();
    const fn = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const t = createEptTransport({
      fetchImpl: fn,
      requestTimeoutMs: 60_000,
      maxRetries: 0,
      sleep: () => Promise.resolve(),
    });
    const controller = new AbortController();
    const reading = t.fetchBytes(
      'https://example.com/ept-data/0-0-0-0.laz',
      controller.signal,
    );
    controller.abort();
    await expect(reading).rejects.toThrow();
  });

  it('a healthy body still completes well inside the budgets', async () => {
    // The guard must not fire on a slow-but-progressing transfer, which is
    // why the idle budget re-arms per chunk instead of capping the total at
    // the header timeout.
    const chunks = [kb(4), kb(4)];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (i < chunks.length) controller.enqueue(chunks[i++]);
            else controller.close();
            resolve();
          }, 15);
        });
      },
    });
    const out = await readExactlyBounded(new Response(stream), 8, {
      idleTimeoutMs: 200,
    });
    expect(out.byteLength).toBe(8);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// FIX 4 — EPT hierarchy values and keys
// ────────────────────────────────────────────────────────────────────────────

describe('EPT hierarchy values', () => {
  const file = (map: Record<string, number>): string => JSON.stringify(map);

  it('accepts -1 (a link) and non-negative whole point counts', () => {
    const parsed = parseHierarchyFile(
      file({ '0-0-0-0': 100, '1-0-0-0': -1, '1-1-0-0': 0 }),
    );
    expect(parsed.links).toHaveLength(1);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.totalPoints).toBe(100);
  });

  it('rejects a fractional point count', () => {
    // 3.7 became a node with a fractional pointCount the budgeter then did
    // arithmetic on.
    expect(() => parseHierarchyFile(file({ '0-0-0-0': 3.7 }))).toThrow(/must be -1/);
  });

  it('rejects an absurd magnitude that would poison totalPoints', () => {
    expect(() => parseHierarchyFile(file({ '0-0-0-0': 1e300 }))).toThrow(/must be -1/);
    expect(() =>
      parseHierarchyFile(file({ '0-0-0-0': Number.MAX_SAFE_INTEGER + 2 })),
    ).toThrow(/must be -1/);
  });

  it('rejects a negative value other than -1 instead of swallowing it', () => {
    // -2 matched neither branch and vanished: not a link, not a node, no
    // error, the subtree simply absent.
    expect(() => parseHierarchyFile(file({ '0-0-0-0': -2 }))).toThrow(/must be -1/);
  });

  it('still rejects non-numeric and non-finite values', () => {
    expect(() => parseHierarchyFile('{"0-0-0-0":"12"}')).toThrow(/non-numeric/);
    expect(() => parseHierarchyFile('{"0-0-0-0":null}')).toThrow(/non-numeric/);
  });

  it('caps the number of entries in one file', () => {
    const map: Record<string, number> = {};
    // Keys must be valid, so walk depth 24's x axis — 2^24 cells is plenty.
    for (let i = 0; i <= MAX_HIERARCHY_ENTRIES_PER_FILE; i++) map[`24-${i}-0-0`] = 1;
    expect(() => parseHierarchyFile(JSON.stringify(map))).toThrow(/per-file limit/);
  });
});

describe('EPT hierarchy keys', () => {
  it('rejects a coordinate outside the cube at its depth', () => {
    // Depth 5 has 2^5 = 32 cells per axis. `5-9999-0-0` names no node that
    // can exist, yet it used to get fabricated bounds and a scheduled fetch.
    expect(eptStringToKey('5-9999-0-0')).toBeNull();
    expect(eptStringToKey('5-0-32-0')).toBeNull();
    expect(eptStringToKey('0-1-0-0')).toBeNull();
  });

  it('accepts the last legal coordinate at a depth', () => {
    expect(eptStringToKey('5-31-31-31')).toEqual({ d: 5, x: 31, y: 31, z: 31 });
    expect(eptStringToKey('0-0-0-0')).toEqual({ d: 0, x: 0, y: 0, z: 0 });
  });

  it('rejects a depth past the octree cap', () => {
    expect(eptStringToKey(`${MAX_EPT_DEPTH}-0-0-0`)).not.toBeNull();
    expect(eptStringToKey(`${MAX_EPT_DEPTH + 1}-0-0-0`)).toBeNull();
  });

  it('rejects components past the safe-integer range', () => {
    expect(eptStringToKey('9007199254740993-0-0-0')).toBeNull();
    expect(eptStringToKey('3-9007199254740993-0-0')).toBeNull();
  });

  it('surfaces a bad key as a parse error naming the constraint', () => {
    expect(() => parseHierarchyFile('{"5-9999-0-0":10}')).toThrow(/D-X-Y-Z address/);
    expect(() => parseHierarchyFile('{"5-9999-0-0":10}')).toThrow(/below 2\^depth/);
  });
});

