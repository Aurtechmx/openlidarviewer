import {
  RangeReadError,
  clampRange,
  sanitizeUrlForDisplay,
  validateRemoteCopcUrl,
  MAX_REMOTE_COPC_URL_LENGTH,
} from '../src/io/range/RangeSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';

// Default test options — disable retries and use a no-op sleep so failure
// cases don't burn real wall time on the production backoff schedule.
const testOpts = { maxRetries: 0, sleep: async () => {} } as const;

// --- clampRange --------------------------------------------------------------

test('clampRange returns the full length when the range fits', () => {
  expect(clampRange(10, 20, 100)).toBe(20);
});

test('clampRange truncates a read that runs past the end', () => {
  expect(clampRange(90, 50, 100)).toBe(10);
});

test('clampRange allows a zero-length read and an offset at the very end', () => {
  expect(clampRange(0, 0, 100)).toBe(0);
  expect(clampRange(100, 5, 100)).toBe(0);
});

test('clampRange rejects a negative or past-the-end offset', () => {
  expect(() => clampRange(-1, 10, 100)).toThrow(RangeReadError);
  expect(() => clampRange(0, -1, 100)).toThrow(RangeReadError);
  expect(() => clampRange(200, 10, 100)).toThrow(RangeReadError);
});

// --- ArrayBufferRangeSource --------------------------------------------------

function rampBytes(n: number): ArrayBuffer {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = i & 0xff;
  return a.buffer;
}

test('ArrayBufferRangeSource reads an exact sub-range', async () => {
  const src = new ArrayBufferRangeSource(rampBytes(256));
  expect(src.kind()).toBe('array-buffer');
  expect(await src.size()).toBe(256);
  const got = new Uint8Array(await src.readRange(10, 4));
  expect([...got]).toEqual([10, 11, 12, 13]);
});

test('ArrayBufferRangeSource truncates a past-the-end read', async () => {
  const src = new ArrayBufferRangeSource(rampBytes(16));
  expect((await src.readRange(12, 100)).byteLength).toBe(4);
});

test('ArrayBufferRangeSource rejects an aborted read', async () => {
  const src = new ArrayBufferRangeSource(rampBytes(16));
  const controller = new AbortController();
  controller.abort();
  await expect(src.readRange(0, 4, controller.signal)).rejects.toThrow(RangeReadError);
});

// --- HttpRangeSource (mocked fetch) -----------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('HttpRangeSource.probe validates Accept-Ranges and Content-Length', async () => {
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '5000' },
    })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  expect(src.kind()).toBe('http-range');
  expect(await src.probe()).toBe(5000);
  expect(await src.size()).toBe(5000);
});

test('HttpRangeSource.probe rejects a server without range support', async () => {
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 200,
      headers: { 'content-length': '5000' },
    })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  await expect(src.probe()).rejects.toMatchObject({ code: 'range-unsupported' });
});

test('HttpRangeSource.probe reports a CORS-aware transport error', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  await expect(src.probe()).rejects.toMatchObject({ code: 'transport' });
});

test('HttpRangeSource.probe rejects a non-ok HTTP status', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/missing.copc.laz');
  await expect(src.probe()).rejects.toMatchObject({ code: 'transport' });
});

test('HttpRangeSource.readRange rejects an already-aborted signal', async () => {
  const src = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  const controller = new AbortController();
  controller.abort();
  await expect(src.readRange(0, 10, controller.signal)).rejects.toMatchObject({
    code: 'aborted',
  });
});

test('HttpRangeSource.readRange accepts a 206 and rejects a 200 full-file response', async () => {
  const head = new Response(null, {
    status: 200,
    headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
  });

  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? head.clone()
      : new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 206,
          headers: { 'content-range': 'bytes 0-2/100' },
        })) as typeof fetch;
  const ok = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  expect(new Uint8Array(await ok.readRange(0, 3)).length).toBe(3);

  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? head.clone()
      : new Response(new Uint8Array(100).buffer, { status: 200 })) as typeof fetch;
  const ignored = new HttpRangeSource('https://example.com/a.copc.laz', testOpts);
  await expect(ignored.readRange(0, 3)).rejects.toMatchObject({
    code: 'range-unsupported',
  });
});

// --- retry, timeout, Content-Range, HEAD-fallback, URL hygiene ----

test('retry recovers from a transient 503 within the retry budget', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return headOk();
    calls++;
    if (calls < 3) return new Response(null, { status: 503 });
    return new Response(new Uint8Array([7, 8, 9]).buffer, {
      status: 206,
      headers: { 'content-range': 'bytes 0-2/100' },
    });
  }) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 3,
    sleep: async () => {},
    random: () => 0.5,
  });
  const got = new Uint8Array(await src.readRange(0, 3));
  expect([...got]).toEqual([7, 8, 9]);
  expect(calls).toBe(3); // two 503s + one success
});

test('404 fails immediately without retry (non-retryable status)', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return headOk();
    calls++;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 3,
    sleep: async () => {},
  });
  await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'transport' });
  expect(calls).toBe(1);
});

test('gives up after maxRetries on a persistent 502', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return headOk();
    calls++;
    return new Response(null, { status: 502 });
  }) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 2,
    sleep: async () => {},
  });
  await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'server-error' });
  // 1 initial attempt + 2 retries = 3 calls
  expect(calls).toBe(3);
});

test('per-attempt timeout aborts the fetch and surfaces "timeout"', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return Promise.resolve(headOk());
    // Hang forever — only the timeout signal can break it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  }) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 0,
    requestTimeoutMs: 5,
    sleep: async () => {},
  });
  await expect(src.readRange(0, 3)).rejects.toMatchObject({ code: 'timeout' });
});

test('Content-Range validation — a 206 with a mismatched Content-Range is rejected as content-mismatch', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? headOk()
      : new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 206,
          // Wrong byte range — proxy stripped or mangled it.
          headers: { 'content-range': 'bytes 7-9/100' },
        })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
  await expect(src.readRange(0, 3)).rejects.toMatchObject({
    code: 'content-mismatch',
  });
});

test('HEAD 405 falls back to a ranged-GET probe to discover size', async () => {
  let probeGets = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 405 });
    probeGets++;
    return new Response(new Uint8Array([0]).buffer, {
      status: 206,
      headers: { 'content-range': 'bytes 0-0/42424242' },
    });
  }) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
  expect(await src.probe()).toBe(42424242);
  expect(probeGets).toBe(1);
});

test('HEAD without Content-Length falls back to the ranged-GET probe', async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? new Response(null, {
          status: 200,
          headers: { 'accept-ranges': 'bytes' }, // no content-length
        })
      : new Response(new Uint8Array([0]).buffer, {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/9999' },
        })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
  expect(await src.probe()).toBe(9999);
});

// --- URL hygiene — URL hygiene ---------------------------------------------------

test('validateRemoteCopcUrl accepts a plain http(s) URL', () => {
  expect(validateRemoteCopcUrl('https://example.com/scan.copc.laz')).toEqual({
    ok: true,
    url: 'https://example.com/scan.copc.laz',
  });
  expect(validateRemoteCopcUrl('http://example.com/scan.copc.laz').ok).toBe(true);
});

test('validateRemoteCopcUrl rejects empty, non-string, and unparseable input', () => {
  expect(validateRemoteCopcUrl('').ok).toBe(false);
  // @ts-expect-error — runtime null defence
  expect(validateRemoteCopcUrl(null).ok).toBe(false);
  expect(validateRemoteCopcUrl('not-a-url').ok).toBe(false);
});

test('validateRemoteCopcUrl rejects non-http(s) schemes', () => {
  expect(validateRemoteCopcUrl('file:///etc/passwd').ok).toBe(false);
  expect(validateRemoteCopcUrl('javascript:alert(1)').ok).toBe(false);
  expect(validateRemoteCopcUrl('ftp://example.com/scan.copc.laz').ok).toBe(false);
});

test('validateRemoteCopcUrl rejects URLs with embedded credentials', () => {
  const res = validateRemoteCopcUrl('https://user:pass@example.com/scan.copc.laz');
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toMatch(/credentials/i);
});

test('validateRemoteCopcUrl rejects URLs longer than the configured cap', () => {
  const long = `https://example.com/${'a'.repeat(MAX_REMOTE_COPC_URL_LENGTH + 1)}`;
  expect(validateRemoteCopcUrl(long).ok).toBe(false);
});

test('sanitizeUrlForDisplay strips userinfo from a parseable URL', () => {
  expect(sanitizeUrlForDisplay('https://user:pass@example.com/scan.copc.laz')).toBe(
    'https://example.com/scan.copc.laz',
  );
});

test('sanitizeUrlForDisplay scrubs userinfo from a marginally-malformed URL', () => {
  // Trailing space — strict parsing may refuse, but the textual scrub still
  // removes the credentials so we don't leak them into a log line.
  const result = sanitizeUrlForDisplay('https://user:pass@example.com/file ');
  expect(result.includes('user:pass')).toBe(false);
});

// --- Debug-pass — composeSignals leak prevention ----------------------------

test('repeated reads with the same long-lived AbortSignal do not accumulate listeners', async () => {
  const headOk = (): Response =>
    new Response(null, {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '100' },
    });
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? headOk()
      : new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 206,
          headers: { 'content-range': 'bytes 0-2/100' },
        })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz', {
    fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
  // Wrap a single long-lived signal in a listener counter.
  const controller = new AbortController();
  let listenerCount = 0;
  const realAdd = controller.signal.addEventListener.bind(controller.signal);
  const realRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') listenerCount++;
    // @ts-expect-error — relaying the call shape verbatim
    return realAdd(type, ...rest);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') listenerCount--;
    // @ts-expect-error — relaying the call shape verbatim
    return realRemove(type, ...rest);
  }) as typeof controller.signal.removeEventListener;

  // 20 successful reads on the same signal should net zero leaked listeners.
  for (let i = 0; i < 20; i++) {
    await src.readRange(0, 3, controller.signal);
  }
  expect(listenerCount).toBe(0);
});
