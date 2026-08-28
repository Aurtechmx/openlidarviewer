/**
 * boundedRead.test.ts
 *
 * The bounded body readers invert read-then-validate into validate-then-read:
 * a declared length above the ceiling is refused before a byte is consumed, a
 * streamed body that crosses the ceiling stops and cancels on the offending
 * chunk, a short body is rejected, and a body that goes silent is bounded by an
 * idle clock rather than hanging. These tests pin each of those, plus the
 * arrayBuffer fallback for runtimes without a streaming body.
 */

import { describe, it, expect } from 'vitest';
import {
  readExactlyBounded,
  readAtMostBounded,
  readTextAtMost,
  ownedExactBuffer,
  BoundedReadError,
  MAX_DECLARED_PREALLOC_BYTES,
} from '../src/io/range/boundedRead';
import { RangeReadError } from '../src/io/range/RangeSource';

/** A Response whose body streams the given chunks, with optional per-chunk gaps. */
function streamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  gapMs = 0,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(next);
    },
  });
  return new Response(stream, { headers });
}

/** A Response with no streaming body — exercises the arrayBuffer fallback. */
function bufferResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  // `bytes.slice().buffer` is a fresh, exactly-sized ArrayBuffer — a BodyInit
  // the Response type accepts, where a bare Uint8Array view is not.
  const r = new Response(bytes.slice().buffer, { headers });
  Object.defineProperty(r, 'body', { value: null });
  return r;
}

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

describe('readExactlyBounded', () => {
  it('returns the buffer when the streamed body is exactly the requested size', async () => {
    const out = await readExactlyBounded(streamingResponse([bytes(4), bytes(4)]), 8);
    expect(out.byteLength).toBe(8);
  });

  it('refuses before reading when Content-Length declares more than requested', async () => {
    const resp = streamingResponse([bytes(8)], { 'content-length': '999999' });
    await expect(readExactlyBounded(resp, 8)).rejects.toMatchObject({
      name: 'RangeReadError',
      code: 'content-mismatch',
    });
  });

  it('stops and rejects on the chunk that overflows the ceiling', async () => {
    // No Content-Length, so the overflow is caught mid-stream, not up front.
    const resp = streamingResponse([bytes(4), bytes(4), bytes(4)]);
    await expect(readExactlyBounded(resp, 8)).rejects.toMatchObject({ code: 'content-mismatch' });
  });

  it('rejects a body shorter than requested', async () => {
    await expect(readExactlyBounded(streamingResponse([bytes(4)]), 8)).rejects.toMatchObject({
      code: 'content-mismatch',
    });
  });

  it('rejects a negative/invalid expected length', async () => {
    await expect(readExactlyBounded(streamingResponse([]), -1)).rejects.toBeInstanceOf(RangeReadError);
  });

  it('ignores Content-Length under a non-identity encoding (compressed length lies)', async () => {
    // gzip: declared length counts compressed bytes, so it must NOT gate the read.
    const resp = streamingResponse([bytes(8)], {
      'content-length': '3',
      'content-encoding': 'gzip',
    });
    const out = await readExactlyBounded(resp, 8);
    expect(out.byteLength).toBe(8);
  });

  it('bounds a silent body with the idle clock instead of hanging', async () => {
    // A body that never enqueues: the idle timer must fire.
    const never = new Response(new ReadableStream<Uint8Array>({ pull() { /* never enqueues */ } }));
    await expect(
      readExactlyBounded(never, 8, { idleTimeoutMs: 30, totalTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('falls back to arrayBuffer when there is no streaming body, still checking exact length', async () => {
    await expect(readExactlyBounded(bufferResponse(bytes(4)), 8)).rejects.toMatchObject({
      code: 'content-mismatch',
    });
    const ok = await readExactlyBounded(bufferResponse(bytes(8)), 8);
    expect(ok.byteLength).toBe(8);
  });
});

describe('readAtMostBounded', () => {
  it('returns a body under the ceiling', async () => {
    const out = await readAtMostBounded(streamingResponse([bytes(10)]), 100, 'EPT manifest');
    expect(out.byteLength).toBe(10);
  });

  it('refuses before reading when the declared length exceeds the ceiling', async () => {
    const resp = streamingResponse([bytes(10)], { 'content-length': '10000' });
    await expect(readAtMostBounded(resp, 100, 'EPT manifest')).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('stops and rejects on the streamed chunk that crosses the ceiling', async () => {
    const resp = streamingResponse([bytes(60), bytes(60)]);
    await expect(readAtMostBounded(resp, 100, 'EPT tile')).rejects.toMatchObject({
      name: 'BoundedReadError',
      limitBytes: 100,
      what: 'EPT tile',
    });
  });

  it('rejects an invalid ceiling', async () => {
    await expect(readAtMostBounded(streamingResponse([]), 0, 'x')).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('preallocates ONE exact target for a declared length and streams into it', async () => {
    // A valid identity Content-Length at or below the ceiling must drive the
    // single-allocation path: no chunk list, no second full-size buffer. We
    // count constructions of `Uint8Array(declared)` and assert exactly one,
    // proving chunks stream directly into the preallocated target.
    const chunks = [bytes(40), bytes(40), bytes(20)];
    const declared = 100;
    const RealU8 = globalThis.Uint8Array;
    let targetAllocs = 0;
    class SpyU8 extends RealU8 {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        super(...(args as [number]));
        if (typeof args[0] === 'number' && args[0] === declared) targetAllocs += 1;
      }
    }
    (globalThis as { Uint8Array: typeof Uint8Array }).Uint8Array = SpyU8;
    try {
      const resp = streamingResponse(chunks, { 'content-length': String(declared) });
      const out = await readAtMostBounded(resp, 256, 'EPT tile');
      expect(out.byteLength).toBe(declared);
      // Exact ownership: whole-buffer view, no trailing bytes past the payload.
      expect(out.byteOffset).toBe(0);
      expect(out.buffer.byteLength).toBe(declared);
    } finally {
      (globalThis as { Uint8Array: typeof Uint8Array }).Uint8Array = RealU8;
    }
    expect(targetAllocs).toBe(1);
  });

  it('trims a body shorter than its declared length to what arrived', async () => {
    const resp = streamingResponse([bytes(30)], { 'content-length': '100' });
    const out = await readAtMostBounded(resp, 256, 'EPT tile');
    expect(out.byteLength).toBe(30);
    expect(out.buffer.byteLength).toBe(30);
  });

  it('refuses a body that runs past its declared length', async () => {
    const resp = streamingResponse([bytes(60), bytes(60)], { 'content-length': '100' });
    await expect(readAtMostBounded(resp, 256, 'EPT tile')).rejects.toMatchObject({
      name: 'BoundedReadError',
      what: 'EPT tile',
    });
  });
});

describe('ownedExactBuffer', () => {
  it('returns the same underlying buffer for an already-exact view (no clone)', () => {
    const src = bytes(64);
    const ab = ownedExactBuffer(src);
    expect(ab).toBe(src.buffer);
  });

  it('copies out only the viewed span for a partial view', () => {
    const backing = new Uint8Array(64).fill(7);
    const view = backing.subarray(8, 24);
    const ab = ownedExactBuffer(view);
    expect(ab).not.toBe(backing.buffer);
    expect(ab.byteLength).toBe(16);
    expect(new Uint8Array(ab).every((b) => b === 7)).toBe(true);
  });
});

describe('readTextAtMost', () => {
  it('decodes a bounded body as UTF-8', async () => {
    const payload = new TextEncoder().encode('{"ept":"json"}');
    const out = await readTextAtMost(streamingResponse([payload]), 1000, 'EPT manifest');
    expect(out).toBe('{"ept":"json"}');
  });
});

describe('readAtMostBounded — declared length does not eagerly allocate', () => {
  it('a large Content-Length with few bytes delivered never allocates the full declared size', async () => {
    // Declared 200 MiB (under the 256 MiB ceiling) but only 30 bytes arrive: the
    // pre-fix path did `new Uint8Array(declared)` on the header alone. The
    // bounded-growth path must never allocate past the small prealloc bound when
    // the promised bytes never come.
    const declared = 200 * 1024 * 1024;
    const cap = 256 * 1024 * 1024;
    const Real = globalThis.Uint8Array;
    let overPrealloc = 0;
    class U8 extends Real {
      constructor(...args: unknown[]) {
        if (typeof args[0] === 'number' && args[0] > MAX_DECLARED_PREALLOC_BYTES) {
          overPrealloc++;
        }
        // @ts-expect-error forward whatever the reader passed
        super(...args);
      }
    }
    (globalThis as { Uint8Array: unknown }).Uint8Array = U8;
    try {
      const resp = streamingResponse([bytes(30)], { 'content-length': String(declared) });
      const out = await readAtMostBounded(resp, cap, 'EPT tile');
      expect(out.byteLength).toBe(30);
    } finally {
      (globalThis as { Uint8Array: unknown }).Uint8Array = Real;
    }
    // Nothing larger than the bounded initial prealloc was ever constructed,
    // even though the header promised 200 MiB.
    expect(overPrealloc).toBe(0);
  });

  it('an honest large body still delivers every byte via bounded growth', async () => {
    // 40 MiB actually delivered in chunks, declared honestly: the growth path
    // must reach the full size and return all of it.
    const size = 40 * 1024 * 1024;
    const chunk = 8 * 1024 * 1024;
    const parts: Uint8Array[] = [];
    for (let at = 0; at < size; at += chunk) parts.push(bytes(Math.min(chunk, size - at), 7));
    const resp = streamingResponse(parts, { 'content-length': String(size) });
    const out = await readAtMostBounded(resp, 256 * 1024 * 1024, 'EPT tile');
    expect(out.byteLength).toBe(size);
    expect(out[0]).toBe(7);
    expect(out[size - 1]).toBe(7);
  });
});
