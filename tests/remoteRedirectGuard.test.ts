/**
 * remoteRedirectGuard.test.ts
 *
 * The SSRF host block-list is a LITERAL check — it does not resolve DNS or
 * follow redirects. A validated public URL that 302s to 127.0.0.1 / 192.168.x.x
 * would, under the browser default `redirect: 'follow'`, be fetched anyway. Every
 * runtime remote point-cloud read therefore passes `redirect: 'error'`, so a
 * redirect is refused rather than followed to an address the validator never saw.
 *
 * These pin that each path requests `redirect: 'error'`, and that an actual
 * redirect (which the browser surfaces as a rejected fetch under that mode) comes
 * out as an error instead of a followed hop.
 */

import { describe, it, expect } from 'vitest';
import { createEptTransport } from '../src/io/ept/eptTransport';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';
import { handleRemoteEpt } from '../src/app/openStreaming';
import type { OpenStreamingDeps } from '../src/app/openStreaming';

/** A fetch that records the init it was handed and returns a usable 206 body. */
function recordingFetch(record: { init?: RequestInit }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    record.init = init;
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: { 'content-range': 'bytes 0-3/4' },
    });
  }) as unknown as typeof fetch;
}

/** The browser rejects a fetch with a TypeError when redirect:'error' hits a 3xx. */
function redirectingFetch(): typeof fetch {
  return (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

describe('runtime remote reads refuse redirects (SSRF hardening)', () => {
  it('EPT hierarchy fetch requests redirect: error', async () => {
    const rec: { init?: RequestInit } = {};
    const t = createEptTransport({ fetchImpl: recordingFetch(rec), maxRetries: 0 });
    await t.fetchText('https://example.com/ept/h/0-0-0-0.json', undefined);
    expect(rec.init?.redirect).toBe('error');
  });

  it('EPT tile fetch requests redirect: error', async () => {
    const rec: { init?: RequestInit } = {};
    const t = createEptTransport({ fetchImpl: recordingFetch(rec), maxRetries: 0 });
    await t.fetchBytes('https://example.com/ept/d/0-0-0-0.bin', undefined);
    expect(rec.init?.redirect).toBe('error');
  });

  it('COPC range read requests redirect: error', async () => {
    const rec: { init?: RequestInit } = {};
    const src = new HttpRangeSource('https://example.com/a.copc.laz', { fetchImpl: recordingFetch(rec) });
    await src.readRange(0, 4);
    expect(rec.init?.redirect).toBe('error');
  });

  it('EPT manifest fetch requests redirect: error', async () => {
    let seen: RequestInit | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response('not json', { status: 502 }); // stop after the manifest GET
    }) as unknown as typeof fetch;

    const eptMod = {
      validateRemoteEptUrl: (u: string) => ({ ok: true as const, url: u }),
      EptTimeoutError: class extends Error {},
      describeRemoteEptError: (e: unknown) => String(e),
    } as unknown as Awaited<ReturnType<OpenStreamingDeps['loadEpt']>>;
    const deps = {
      isLoading: () => false, setLoading: () => {}, prewarmForUrl: () => {},
      streamingPanel: { setSourceUrl: () => {}, setPhase: () => {}, show: () => {} },
      loadEpt: async () => eptMod, viewerReady: Promise.resolve(), getViewer: () => ({}) as never,
      debug: false, showToast: () => {}, closeStreaming: () => {},
      dropZone: { setError: () => {}, setOpening: () => {}, setCancelHandler: () => {}, setProgress: () => {} },
    } as unknown as OpenStreamingDeps;

    try {
      await handleRemoteEpt('https://example.com/ept.json', undefined, deps);
    } catch { /* the 502 path may throw; we only assert the fetch init */ }
    globalThis.fetch = realFetch;
    expect(seen?.redirect).toBe('error');
  });

  it('an actual redirect surfaces as an error on both transports, never a followed hop', async () => {
    const src = new HttpRangeSource('https://example.com/a.copc.laz', { fetchImpl: redirectingFetch() });
    await expect(src.readRange(0, 4)).rejects.toThrow();
    const t = createEptTransport({ fetchImpl: redirectingFetch(), maxRetries: 0 });
    await expect(t.fetchText('https://example.com/ept.json', undefined)).rejects.toThrow();
  });
});
