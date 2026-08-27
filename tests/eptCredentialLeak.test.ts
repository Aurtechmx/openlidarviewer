/**
 * eptCredentialLeak.test.ts
 *
 * A signed EPT dataset carries its credential in the URL's query string, and
 * `eptUrls.ts` re-attaches that query to every hierarchy and tile request by
 * design — otherwise a SAS-signed dataset loads `ept.json` and then 401s on
 * the first hierarchy fetch. So every remote EPT URL is, by construction, a
 * live bearer token.
 *
 * The transport used to interpolate that raw URL into its thrown messages, and
 * those messages are displayed (the full-cloud grade action paints
 * `err.message` into the streaming panel, where it reaches screenshots and
 * support tickets). These tests pin that every error path scrubs the query
 * before the URL reaches a message a human or a log could see.
 */

import { describe, expect, it } from 'vitest';
import { createEptTransport } from '../src/io/ept/eptTransport';
import {
  eptBaseUrl,
  eptUrlSearch,
  eptHierarchyUrl,
  eptTileUrl,
} from '../src/io/ept/eptUrls';

/** The credential. Nothing user-visible may contain this string. */
const TOKEN = 'TOP_SECRET_TOKEN';
const MANIFEST_URL = `https://example.com/dataset/ept.json?sv=2021&sig=${TOKEN}`;

// The real URL derivation — the same call chain `openStreaming` uses — so the
// URLs under test carry the credential exactly the way production does.
const BASE = eptBaseUrl(MANIFEST_URL);
const SEARCH = eptUrlSearch(MANIFEST_URL);
const HIERARCHY_URL = eptHierarchyUrl(BASE, { d: 3, x: 1, y: 2, z: 0 }, SEARCH);
const TILE_URL = eptTileUrl(BASE, { d: 3, x: 1, y: 2, z: 0 }, 'laszip', SEARCH);

/** A fetch that always answers with the given status and no body. */
function statusFetch(status: number): typeof fetch {
  return (async () =>
    new Response(null, { status, statusText: 'Forbidden' })) as unknown as typeof fetch;
}

/** A fetch that never resolves — for the timeout path. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;
}

async function messageFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw');
}

describe('EPT transport — signed URLs never leak into error messages', () => {
  it('the credential appears in the URLs the transport is handed (guards the test)', () => {
    expect(HIERARCHY_URL).toContain(TOKEN);
    expect(TILE_URL).toContain(TOKEN);
  });

  it('scrubs the token from a permanent 4xx hierarchy error', async () => {
    const t = createEptTransport({ fetchImpl: statusFetch(403), maxRetries: 0 });
    const msg = await messageFrom(() => t.fetchText(HIERARCHY_URL));
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('?…'); // the scrubbed marker, so the URL is still identifiable
  });

  it('scrubs the token from a permanent 4xx tile error', async () => {
    const t = createEptTransport({ fetchImpl: statusFetch(403), maxRetries: 0 });
    const msg = await messageFrom(() => t.fetchBytes(TILE_URL));
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('?…');
  });

  it('scrubs the token from an exhausted-retry (retryable status) error', async () => {
    const t = createEptTransport({
      fetchImpl: statusFetch(503), // retryable, so it exhausts retries
      maxRetries: 1,
      retryBaseMs: 0,
      sleep: async () => {},
    });
    const msg = await messageFrom(() => t.fetchText(HIERARCHY_URL));
    expect(msg).not.toContain(TOKEN);
  });

  it('scrubs the token from a request-timeout error', async () => {
    const t = createEptTransport({
      fetchImpl: hangingFetch(),
      requestTimeoutMs: 1,
      maxRetries: 0,
    });
    const msg = await messageFrom(() => t.fetchText(HIERARCHY_URL));
    expect(msg).not.toContain(TOKEN);
  });
});

// ── The manifest-timeout seam in openStreaming.handleRemoteEpt ────────────────
import { vi } from 'vitest';
import { handleRemoteEpt } from '../src/app/openStreaming';
import type { OpenStreamingDeps } from '../src/app/openStreaming';

/** A minimal fake of the lazy EPT module, enough to reach the manifest fetch. */
function fakeEptModule() {
  class EptTimeoutError extends Error {
    readonly code = 'timeout';
    constructor(message: string) {
      super(message);
      this.name = 'EptTimeoutError';
    }
  }
  return {
    validateRemoteEptUrl: (u: string) => ({ ok: true as const, url: u }),
    EptTimeoutError,
    describeRemoteEptError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    parseEptMetadata: undefined,
    EptStreamingPointCloud: undefined,
    EptChunkDecoder: undefined,
  } as unknown as Awaited<ReturnType<OpenStreamingDeps['loadEpt']>>;
}

describe('openStreaming manifest timeout — the signed URL never reaches the debug console', () => {
  it('scrubs the token from the EptTimeoutError logged under ?debug=1', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    // A fetch that fails as a manifest timeout would (AbortError), with the outer
    // controller NOT aborted — the exact condition that mints the EptTimeoutError.
    globalThis.fetch = (async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown as typeof fetch;

    const deps = {
      isLoading: () => false,
      setLoading: () => {},
      prewarmForUrl: () => {},
      streamingPanel: { setSourceUrl: () => {}, setPhase: () => {}, show: () => {} },
      loadEpt: async () => fakeEptModule(),
      viewerReady: Promise.resolve(),
      getViewer: () => ({}) as never,
      debug: true,
      showToast: () => {},
      closeStreaming: () => {},
      dropZone: {
        setError: () => {},
        setOpening: () => {},
        setCancelHandler: () => {},
        setProgress: () => {},
      },
    } as unknown as OpenStreamingDeps;

    try {
      await handleRemoteEpt(MANIFEST_URL, undefined, deps);
    } catch {
      /* the error path may rethrow after logging; the log is what we assert */
    }

    globalThis.fetch = realFetch;
    // The debug path logged the remote-EPT error; its message must not carry the token.
    const logged = errorSpy.mock.calls.flat().map((a) => (a instanceof Error ? a.message : String(a)));
    expect(logged.join(' | ')).not.toContain(TOKEN);
    // Sanity: the manifest-timeout error was actually reached (message present, scrubbed).
    expect(logged.some((m) => /manifest request timed out/i.test(m))).toBe(true);
    errorSpy.mockRestore();
  });
});
