import { RangeReadError, clampRange } from '../src/io/range/RangeSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';

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
  const src = new HttpRangeSource('https://example.com/a.copc.laz');
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
  const src = new HttpRangeSource('https://example.com/a.copc.laz');
  await expect(src.probe()).rejects.toMatchObject({ code: 'range-unsupported' });
});

test('HttpRangeSource.probe reports a CORS-aware transport error', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/a.copc.laz');
  await expect(src.probe()).rejects.toMatchObject({ code: 'transport' });
});

test('HttpRangeSource.probe rejects a non-ok HTTP status', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const src = new HttpRangeSource('https://example.com/missing.copc.laz');
  await expect(src.probe()).rejects.toMatchObject({ code: 'transport' });
});

test('HttpRangeSource.readRange rejects an already-aborted signal', async () => {
  const src = new HttpRangeSource('https://example.com/a.copc.laz');
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
      : new Response(new Uint8Array([1, 2, 3]).buffer, { status: 206 })) as typeof fetch;
  const ok = new HttpRangeSource('https://example.com/a.copc.laz');
  expect(new Uint8Array(await ok.readRange(0, 3)).length).toBe(3);

  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD'
      ? head.clone()
      : new Response(new Uint8Array(100).buffer, { status: 200 })) as typeof fetch;
  const ignored = new HttpRangeSource('https://example.com/a.copc.laz');
  await expect(ignored.readRange(0, 3)).rejects.toMatchObject({
    code: 'range-unsupported',
  });
});
