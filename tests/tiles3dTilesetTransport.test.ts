/**
 * tiles3dTilesetTransport.test.ts — the hardened 3D Tiles remote fetch.
 *
 * The injected `fetchImpl`, `sleep` and `random` make every retry, timeout and
 * abort path deterministic with no network, the same way the EPT transport's
 * tests do. What is asserted is mostly what the transport REFUSES: an oversized
 * body, a redirect, a permanent status it must not retry, and a cancel that
 * must stay distinguishable from a deadline.
 */

import { describe, expect, test } from 'vitest';
import { bodyCancelFetch } from './helpers/bodyCancelFetch';
import {
  createTilesetTransport,
  TilesetTimeoutError,
} from '../src/io/tiles3d/tilesetTransport';

/** A fetch returning a scripted sequence of responses. */
function scriptedFetch(
  steps: Array<{ status: number; body?: string; headers?: Record<string, string> } | { throws: Error }>,
): { fn: typeof fetch; calls: number; init: RequestInit[] } {
  let i = 0;
  const handle = { calls: 0, init: [] as RequestInit[], fn: undefined as unknown as typeof fetch };
  handle.fn = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    handle.calls++;
    if (init) handle.init.push(init);
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if ('throws' in step) throw step.throws;
    return new Response(step.body ?? '', {
      status: step.status,
      statusText: step.status === 200 ? 'OK' : 'Err',
      headers: step.headers,
    });
  }) as typeof fetch;
  return handle;
}

/** A fetch that answers only when the signal it was handed aborts. */
function neverAnsweringFetch(): { fn: typeof fetch; calls: number } {
  const handle = { calls: 0, fn: undefined as unknown as typeof fetch };
  handle.fn = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    handle.calls++;
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      const onAbort = (): void => reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  return handle;
}

const NOW = () => Promise.resolve();
const URL_JSON = 'https://tiles.example.org/scan/a/tileset.json';

describe('createTilesetTransport — success and retry', () => {
  test('returns the tileset body on a first-attempt 200', async () => {
    const h = scriptedFetch([{ status: 200, body: '{"asset":{}}' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await expect(t.fetchTilesetJson(URL_JSON)).resolves.toBe('{"asset":{}}');
    expect(h.calls).toBe(1);
  });

  test('refuses to follow a redirect on every request', async () => {
    const h = scriptedFetch([{ status: 200, body: '{}' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await t.fetchTilesetJson(URL_JSON);
    expect(h.init[0]!.redirect).toBe('error');
  });

  test('retries a transient status and then succeeds', async () => {
    const h = scriptedFetch([{ status: 503 }, { status: 200, body: 'ok' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW, random: () => 0.5 });
    await expect(t.fetchTilesetJson(URL_JSON)).resolves.toBe('ok');
    expect(h.calls).toBe(2);
  });

  test('does not retry a permanent 404', async () => {
    const h = scriptedFetch([{ status: 404 }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await expect(t.fetchTilesetJson(URL_JSON)).rejects.toThrow(/3D Tiles tileset fetch failed \(404/);
    expect(h.calls).toBe(1);
  });

  test('gives up after the retry budget', async () => {
    const h = scriptedFetch([{ status: 500 }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW, maxRetries: 2, random: () => 0.5 });
    await expect(t.fetchTilesetJson(URL_JSON)).rejects.toThrow(/500/);
    expect(h.calls).toBe(3);
  });
});

describe('createTilesetTransport — bounds and cancellation', () => {
  test('refuses a tileset body past the ceiling', async () => {
    const h = scriptedFetch([{ status: 200, body: 'x'.repeat(4096) }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW, maxTilesetJsonBytes: 64 });
    await expect(t.fetchTilesetJson(URL_JSON)).rejects.toThrow(/3D Tiles tileset/);
  });

  test('refuses a tile body past the ceiling', async () => {
    const h = scriptedFetch([{ status: 200, body: 'x'.repeat(4096) }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW, maxTileBytes: 64 });
    await expect(t.fetchTileBytes('https://tiles.example.org/scan/a/0.pnts')).rejects.toThrow(
      /3D Tiles tile/,
    );
  });

  test('refuses a subtree body past the ceiling, in its own vocabulary', async () => {
    const h = scriptedFetch([{ status: 200, body: 'x'.repeat(4096) }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW, maxSubtreeBytes: 64 });
    await expect(
      t.fetchSubtreeBytes('https://tiles.example.org/scan/a/subtrees/0/0/0.subtree'),
    ).rejects.toThrow(/3D Tiles subtree/);
  });

  test('a subtree read refuses a redirect and retries a transient status', async () => {
    // The same discipline the tile read gets: availability is fetched from the
    // same untrusted origin the tiles are, and a 3xx could send it to a host no
    // block-list ever resolved.
    const h = scriptedFetch([{ status: 503 }, { status: 200, body: 'ok' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    const bytes = await t.fetchSubtreeBytes(
      'https://tiles.example.org/scan/a/subtrees/0/0/0.subtree',
    );
    expect(bytes.byteLength).toBe(2);
    expect(h.calls).toBe(2);
    expect(h.init.every((i) => i.redirect === 'error')).toBe(true);
  });

  test('a subtree body arrives in an exact-size buffer', async () => {
    const h = scriptedFetch([{ status: 200, body: 'subtree-bytes' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    const bytes = await t.fetchSubtreeBytes(
      'https://tiles.example.org/scan/a/subtrees/0/0/0.subtree',
    );
    expect(bytes.byteLength).toBe('subtree-bytes'.length);
  });

  test('a stalled request surfaces as a timeout, not as a cancel', async () => {
    const h = neverAnsweringFetch();
    const t = createTilesetTransport({
      fetchImpl: h.fn,
      sleep: NOW,
      maxRetries: 0,
      requestTimeoutMs: 5,
    });
    const err = await t.fetchTilesetJson(URL_JSON).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TilesetTimeoutError);
    expect((err as TilesetTimeoutError).code).toBe('timeout');
    expect((err as Error).name).not.toBe('AbortError');
  });

  test('an outer cancel propagates as an abort and stops the retry loop', async () => {
    const h = neverAnsweringFetch();
    const controller = new AbortController();
    const t = createTilesetTransport({
      fetchImpl: h.fn,
      sleep: NOW,
      maxRetries: 3,
      requestTimeoutMs: 10_000,
    });
    const promise = t.fetchTilesetJson(URL_JSON, controller.signal);
    controller.abort();
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(h.calls).toBe(1);
  });

  test('an already-aborted signal issues no request at all', async () => {
    const h = scriptedFetch([{ status: 200, body: 'ok' }]);
    const controller = new AbortController();
    controller.abort();
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await expect(t.fetchTilesetJson(URL_JSON, controller.signal)).rejects.toThrow();
    expect(h.calls).toBe(0);
  });

  test('a returned tile buffer is exactly the bytes, with no trailing slack', async () => {
    const h = scriptedFetch([{ status: 200, body: 'abcd' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    const buf = await t.fetchTileBytes('https://tiles.example.org/scan/a/0.pnts');
    expect(buf.byteLength).toBe(4);
  });
});


describe('createTilesetTransport — abandoned response bodies are cancelled', () => {
  test('cancels a retryable 503 body before the retry proceeds', async () => {
    const h = bodyCancelFetch([{ status: 503 }, { status: 200, body: '{"asset":{}}' }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await expect(t.fetchTilesetJson(URL_JSON)).resolves.toBe('{"asset":{}}');
    expect(h.cancels).toBe(1);
  });

  test('cancels a permanent 404 body before it throws', async () => {
    const h = bodyCancelFetch([{ status: 404 }]);
    const t = createTilesetTransport({ fetchImpl: h.fn, sleep: NOW });
    await expect(
      t.fetchTileBytes('https://tiles.example.org/scan/a/0.pnts'),
    ).rejects.toThrow(/404/);
    expect(h.cancels).toBe(1);
  });
});
