/**
 * eptTransport.test.ts — v0.3.4 EPT-maturity tests for the hardened remote
 * transport. Verifies retry-with-backoff + per-attempt timeout + abort
 * composition behave like the COPC `HttpRangeSource` does for the COPC
 * path. The injected `fetchImpl` + `sleep` + `random` make every retry /
 * timeout path deterministic.
 */

import { describe, expect, test } from 'vitest';
import { createEptTransport, EptTimeoutError } from '../src/io/ept/eptTransport';

/**
 * A fetch that never answers on its own; it rejects only when the signal handed
 * to it aborts, with that signal's reason. The transport composes its per-attempt
 * timeout into that signal, so a small `requestTimeoutMs` makes this time out
 * deterministically — the shape of a server that accepts the connection but never
 * responds. Reused to prove a timeout is a distinct outcome from a user cancel.
 */
function neverAnsweringFetch(): { fn: typeof fetch; calls: number } {
  const handle = { calls: 0, fn: undefined as unknown as typeof fetch };
  handle.fn = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    handle.calls++;
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      const onAbort = (): void =>
        reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  return handle;
}

/** Build a fetch fake that returns a scripted sequence of responses. */
function scriptedFetch(
  steps: Array<
    | { status: number; body?: string; headers?: Record<string, string> }
    | { throws: Error }
  >,
): { fn: typeof fetch; calls: number } {
  let i = 0;
  const handle = { calls: 0, fn: undefined as unknown as typeof fetch };
  handle.fn = (async (_input: RequestInfo | URL): Promise<Response> => {
    handle.calls++;
    const step = steps[Math.min(i++, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    return new Response(step.body ?? '', {
      status: step.status,
      statusText: step.status === 200 ? 'OK' : 'Err',
      headers: step.headers,
    });
  }) as typeof fetch;
  return handle;
}

describe('createEptTransport — happy path', () => {
  test('fetchText returns the body on first-attempt 200', async () => {
    const handle = scriptedFetch([{ status: 200, body: '{"hello":"world"}' }]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const out = await t.fetchText('https://example.com/ept-hierarchy/0-0-0-0.json');
    expect(out).toBe('{"hello":"world"}');
    expect(handle.calls).toBeGreaterThanOrEqual(1);
  });

  test('fetchBytes returns the bytes on first-attempt 200', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: 'AAAA' }]);
    const t = createEptTransport({ fetchImpl: fn, sleep: () => Promise.resolve() });
    const buf = await t.fetchBytes('https://example.com/ept-data/0-0-0-0.bin');
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});

describe('createEptTransport — retry-with-backoff', () => {
  test('retries on a transient 503 and succeeds on the retry', async () => {
    const handle = scriptedFetch([
      { status: 503 },
      { status: 200, body: 'ok' },
    ]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const out = await t.fetchText('https://example.com/ept.json');
    expect(out).toBe('ok');
    expect(handle.calls).toBe(2);
  });

  test('retries on 429 (Too Many Requests)', async () => {
    const handle = scriptedFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: 'ok' },
    ]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const out = await t.fetchText('https://example.com/ept.json');
    expect(out).toBe('ok');
    expect(handle.calls).toBe(3);
  });

  test('retries on network-error transients', async () => {
    const handle = scriptedFetch([
      { throws: new TypeError('Failed to fetch') },
      { status: 200, body: 'ok' },
    ]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const out = await t.fetchText('https://example.com/ept.json');
    expect(out).toBe('ok');
    expect(handle.calls).toBe(2);
  });

  test('gives up after maxRetries on a persistent 502', async () => {
    const handle = scriptedFetch([
      { status: 502 },
      { status: 502 },
      { status: 502 },
      { status: 502 },
    ]);
    const t = createEptTransport({
      fetchImpl: handle.fn,
      sleep: () => Promise.resolve(),
      maxRetries: 3,
    });
    await expect(
      t.fetchText('https://example.com/ept-hierarchy/3-1-2-0.json'),
    ).rejects.toThrow(/hierarchy fetch failed/);
    // 1 initial + 3 retries = 4 attempts
    expect(handle.calls).toBe(4);
  });

  test('does NOT retry on 404 (permanent client error)', async () => {
    const handle = scriptedFetch([{ status: 404 }, { status: 200, body: 'ok' }]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    await expect(t.fetchText('https://example.com/ept.json')).rejects.toThrow(/404/);
    // Only the initial attempt — no retry on 404.
    expect(handle.calls).toBe(1);
  });
});

describe('createEptTransport — error message shape', () => {
  test('hierarchy errors carry the "hierarchy" label and URL', async () => {
    const { fn } = scriptedFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const t = createEptTransport({
      fetchImpl: fn,
      sleep: () => Promise.resolve(),
      maxRetries: 3,
    });
    await expect(
      t.fetchText('https://example.com/ept-hierarchy/0-0-0-0.json'),
    ).rejects.toThrow(/EPT hierarchy fetch failed.*ept-hierarchy.*0-0-0-0\.json/);
  });

  test('tile errors carry the "tile" label and URL', async () => {
    const { fn } = scriptedFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const t = createEptTransport({
      fetchImpl: fn,
      sleep: () => Promise.resolve(),
      maxRetries: 3,
    });
    await expect(
      t.fetchBytes('https://example.com/ept-data/0-0-0-0.laz'),
    ).rejects.toThrow(/EPT tile fetch failed.*ept-data.*0-0-0-0\.laz/);
  });
});

describe('createEptTransport — abort composition', () => {
  test('an outer-signal abort surfaces as "aborted" without further fetches', async () => {
    const handle = scriptedFetch([{ status: 200, body: 'should-not-arrive' }]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const controller = new AbortController();
    controller.abort();
    await expect(
      t.fetchText('https://example.com/ept.json', controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(handle.calls).toBe(0);
  });
});

describe('createEptTransport — internal timeout is a distinct outcome from a user cancel', () => {
  test('a per-attempt timeout throws a typed EptTimeoutError, not an abort', async () => {
    const handle = neverAnsweringFetch();
    const t = createEptTransport({
      fetchImpl: handle.fn,
      sleep: () => Promise.resolve(),
      requestTimeoutMs: 5,
      maxRetries: 0,
    });
    const err = await t
      .fetchText('https://example.com/ept-hierarchy/0-0-0-0.json')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EptTimeoutError);
    expect((err as EptTimeoutError).code).toBe('timeout');
    expect((err as Error).message).toMatch(/timed out/i);
    // A timeout must never wear the AbortError name the cancel classifier reads
    // as a silent user cancellation.
    expect((err as Error).name).not.toBe('AbortError');
  });

  test('a timeout retries like a transient fault, then still surfaces as a timeout', async () => {
    const handle = neverAnsweringFetch();
    const t = createEptTransport({
      fetchImpl: handle.fn,
      sleep: () => Promise.resolve(),
      requestTimeoutMs: 5,
      maxRetries: 2,
    });
    await expect(
      t.fetchBytes('https://example.com/ept-data/0-0-0-0.bin'),
    ).rejects.toBeInstanceOf(EptTimeoutError);
    // 1 initial + 2 retries: the deadline was retried, never silently cancelled.
    expect(handle.calls).toBe(3);
  });

  test('a real user cancel mid-flight surfaces as an abort, distinct from a timeout', async () => {
    const handle = neverAnsweringFetch();
    const t = createEptTransport({
      fetchImpl: handle.fn,
      sleep: () => Promise.resolve(),
      requestTimeoutMs: 60_000, // long, so only the user cancel can fire
      maxRetries: 3,
    });
    const controller = new AbortController();
    const p = t.fetchText('https://example.com/ept.json', controller.signal);
    controller.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EptTimeoutError);
    expect((err as Error).name).toBe('AbortError');
    expect(handle.calls).toBe(1);
  });

  test('a signal already aborted before the first request throws a recognisable AbortError, not a generic error', async () => {
    const handle = scriptedFetch([{ status: 200, body: 'never reached' }]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const controller = new AbortController();
    controller.abort(); // user cancel BEFORE the first attempt runs
    const err = await t
      .fetchText('https://example.com/ept.json', controller.signal)
      .catch((e: unknown) => e);
    // Not the old generic Error('aborted') — a real AbortError, so isAbortError
    // reads a pre-request cancel as a cancel rather than a transport failure.
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(EptTimeoutError);
    expect(handle.calls).toBe(0); // short-circuited before any fetch
  });

  test('a cancel that lands between retries surfaces as an AbortError, not a generic error', async () => {
    // First attempt is a transient 503, so the transport backs off and retries.
    const handle = scriptedFetch([{ status: 503 }, { status: 200, body: 'never reached' }]);
    const controller = new AbortController();
    const t = createEptTransport({
      fetchImpl: handle.fn,
      // The cancel arrives during the backoff sleep, before the retry's pre-check.
      sleep: () => { controller.abort(); return Promise.resolve(); },
    });
    const err = await t
      .fetchText('https://example.com/ept.json', controller.signal)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(EptTimeoutError);
    expect(handle.calls).toBe(1); // only the first attempt ran; the retry pre-check caught the cancel
  });
});

describe('createEptTransport — bounded bodies (OOM defense)', () => {
  test('fetchText refuses a hierarchy whose Content-Length exceeds the 64 MiB cap', async () => {
    const handle = scriptedFetch([
      { status: 200, body: '{}', headers: { 'content-length': String(65 * 1024 * 1024) } },
    ]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const err = await t
      .fetchText('https://example.com/ept-hierarchy/0-0-0-0.json')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/limit/i);
  });

  test('fetchBytes refuses a tile whose Content-Length exceeds the 256 MiB cap', async () => {
    const handle = scriptedFetch([
      { status: 200, body: 'AAAA', headers: { 'content-length': String(257 * 1024 * 1024) } },
    ]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const err = await t
      .fetchBytes('https://example.com/ept-data/0-0-0-0.bin')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/limit/i);
  });

  test('a legitimate small body still passes through unchanged', async () => {
    const handle = scriptedFetch([{ status: 200, body: 'AAAA' }]);
    const t = createEptTransport({ fetchImpl: handle.fn, sleep: () => Promise.resolve() });
    const buf = await t.fetchBytes('https://example.com/ept-data/0-0-0-0.bin');
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('AAAA');
  });
});
