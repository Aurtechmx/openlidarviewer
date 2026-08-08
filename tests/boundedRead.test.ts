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
  BoundedReadError,
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
  const r = new Response(bytes, { headers });
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
});

describe('readTextAtMost', () => {
  it('decodes a bounded body as UTF-8', async () => {
    const payload = new TextEncoder().encode('{"ept":"json"}');
    const out = await readTextAtMost(streamingResponse([payload]), 1000, 'EPT manifest');
    expect(out).toBe('{"ept":"json"}');
  });
});
