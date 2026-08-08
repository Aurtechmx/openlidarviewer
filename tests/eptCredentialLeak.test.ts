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
