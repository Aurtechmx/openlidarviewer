/**
 * remoteObjectIdentity.test.ts
 *
 * A COPC/EPT load is dozens of range reads over seconds to minutes. If the
 * object is re-uploaded partway through, the reads before and after splice two
 * versions into one decode — silent where a crash is not. HttpRangeSource pins
 * the object's validators (ETag / Last-Modified / total size) at probe time and
 * re-checks every read: a changed validator, a changed total, or a 412 from our
 * `If-Match` fails the read with the non-retryable `resource-changed` code.
 */

import { describe, it, expect } from 'vitest';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';
import { RangeReadError } from '../src/io/range/RangeSource';

const opts = { maxRetries: 0, sleep: async () => {} } as const;
const URL = 'https://example.com/a.copc.laz';

/** A HEAD response advertising range support, a size, and the given validators. */
function head(headers: Record<string, string>): Response {
  return new Response(null, {
    status: 200,
    headers: { 'accept-ranges': 'bytes', 'content-length': '1000', ...headers },
  });
}

/** A 206 range response for [0,3] with the given headers. */
function range206(headers: Record<string, string>): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
    status: 206,
    headers: { 'content-range': 'bytes 0-3/1000', ...headers },
  });
}

async function readErr(src: HttpRangeSource): Promise<RangeReadError> {
  try {
    await src.readRange(0, 4);
  } catch (e) {
    return e as RangeReadError;
  }
  throw new Error('expected readRange to throw');
}

describe('remote object identity pinning', () => {
  it('reads normally when the object is unchanged', async () => {
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? head({ etag: '"v1"' })
          : range206({ etag: '"v1"' })) as unknown as typeof fetch,
    });
    const buf = await src.readRange(0, 4);
    expect(buf.byteLength).toBe(4);
  });

  it('fails with resource-changed when the ETag changes mid-load', async () => {
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? head({ etag: 'W/"v1"' }) // weak, so no If-Match; client-side check still runs
          : range206({ etag: 'W/"v2"' })) as unknown as typeof fetch,
    });
    expect((await readErr(src)).code).toBe('resource-changed');
  });

  it('fails with resource-changed when the Content-Range total changes', async () => {
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? head({}) // size 1000 pinned from content-length
          : new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
              status: 206,
              headers: { 'content-range': 'bytes 0-3/2048' }, // re-uploaded, bigger
            })) as unknown as typeof fetch,
    });
    expect((await readErr(src)).code).toBe('resource-changed');
  });

  it('fails with resource-changed when the Last-Modified changes (no ETag)', async () => {
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? head({ 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' })
          : range206({ 'last-modified': 'Thu, 02 Jan 2025 00:00:00 GMT' })) as unknown as typeof fetch,
    });
    expect((await readErr(src)).code).toBe('resource-changed');
  });

  it('fails with resource-changed on a 412 Precondition Failed', async () => {
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? head({ etag: '"v1"' })
          : new Response(null, { status: 412 })) as unknown as typeof fetch,
    });
    expect((await readErr(src)).code).toBe('resource-changed');
  });

  it('sends If-Match with a strong ETag and reads when the server accepts it', async () => {
    let sentIfMatch: string | null = null;
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') return head({ etag: '"strong-v1"' });
        sentIfMatch = new Headers(init?.headers).get('if-match');
        return range206({ etag: '"strong-v1"' });
      }) as unknown as typeof fetch,
    });
    await src.readRange(0, 4);
    expect(sentIfMatch).toBe('"strong-v1"');
  });

  it('does not send If-Match for a weak ETag', async () => {
    let sentIfMatch: string | null = 'unset';
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') return head({ etag: 'W/"weak-v1"' });
        sentIfMatch = new Headers(init?.headers).get('if-match');
        return range206({ etag: 'W/"weak-v1"' });
      }) as unknown as typeof fetch,
    });
    await src.readRange(0, 4);
    expect(sentIfMatch).toBeNull();
  });

  it('downgrades to unconditional reads when If-Match trips a transport error, then succeeds', async () => {
    // A CORS preflight rejecting If-Match surfaces as an opaque transport
    // error. The first conditional read downgrades once; the retry omits
    // If-Match and succeeds, and the client-side validator check still runs.
    const ifMatchSeen: Array<string | null> = [];
    const src = new HttpRangeSource(URL, {
      ...opts,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') return head({ etag: '"strong-v1"' });
        const im = new Headers(init?.headers).get('if-match');
        ifMatchSeen.push(im);
        if (im !== null) throw new TypeError('Failed to fetch'); // preflight rejection
        return range206({ etag: '"strong-v1"' });
      }) as unknown as typeof fetch,
    });
    const buf = await src.readRange(0, 4);
    expect(buf.byteLength).toBe(4);
    expect(ifMatchSeen[0]).toBe('"strong-v1"'); // tried conditional
    expect(ifMatchSeen[ifMatchSeen.length - 1]).toBeNull(); // then unconditional
  });
});
