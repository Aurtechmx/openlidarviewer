/**
 * eptTransport.test.ts — v0.3.4 EPT-maturity tests for the hardened remote
 * transport. Verifies retry-with-backoff + per-attempt timeout + abort
 * composition behave like the COPC `HttpRangeSource` does for the COPC
 * path. The injected `fetchImpl` + `sleep` + `random` make every retry /
 * timeout path deterministic.
 */

import { describe, expect, test } from 'vitest';
import { createEptTransport } from '../src/io/ept/eptTransport';

/** Build a fetch fake that returns a scripted sequence of responses. */
function scriptedFetch(
  steps: Array<
    | { status: number; body?: string }
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
