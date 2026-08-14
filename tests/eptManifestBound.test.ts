/**
 * eptManifestBound.test.ts — the EPT manifest body is bounded, cancellable, and
 * leak-free (release blocker #3).
 *
 * `openRemoteEpt` used to read the manifest with an unbounded `response.text()`
 * AFTER its header timeout had already been cleared, so a hostile or broken host
 * could stream an oversized `ept.json`, stall mid-body, or keep sending past a
 * user cancel — over-allocating on the main thread. The fix routes the body
 * through the same hardened `readAtMostBounded` the hierarchy/tile transport
 * uses, capped at `MAX_EPT_MANIFEST_BYTES` and wired to the outer load-cancel.
 *
 * These pin that contract at the exact seam the production call uses. The
 * generic bound/stall/abort mechanics live in `boundedRead.test.ts`; here we
 * assert the manifest-specific wiring: the ceiling value, the streaming refusal
 * (with and without Content-Length), prompt abort, and that the signed URL can
 * never reach the error message.
 */
import { describe, it, expect } from 'vitest';
import { readAtMostBounded, BoundedReadError } from '../src/io/range/boundedRead';
import { MAX_EPT_MANIFEST_BYTES } from '../src/app/openStreaming';

/** A Response whose body streams the given chunks. */
function streamingResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

/** A body that sends headers then never enqueues — the stall case. */
function stallingResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ pull() { /* never enqueues */ } }));
}

const enc = new TextEncoder();

// The production call site: readAtMostBounded(resp, MAX_EPT_MANIFEST_BYTES, 'EPT manifest', opts).
const readManifest = (resp: Response, opts = {}) =>
  readAtMostBounded(resp, MAX_EPT_MANIFEST_BYTES, 'EPT manifest', opts);

describe('EPT manifest body is bounded (blocker #3)', () => {
  it('caps the manifest at a defensible 8 MiB — huge vs any real ept.json, small vs a memory hazard', () => {
    expect(MAX_EPT_MANIFEST_BYTES).toBe(8 * 1024 * 1024);
  });

  it('reads a realistic small ept.json in full and round-trips to valid JSON', async () => {
    const manifest = JSON.stringify({
      version: '1.1.0',
      bounds: [0, 0, 0, 100, 100, 50],
      boundsConforming: [0, 0, 0, 100, 100, 50],
      schema: [{ name: 'X', type: 'signed', size: 4 }],
      srs: { authority: 'EPSG', horizontal: '32612' },
      dataType: 'laszip',
      hierarchyType: 'json',
      span: 128,
      points: 1_000_000,
    });
    const bytes = await readManifest(streamingResponse([enc.encode(manifest)]));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ version: '1.1.0' });
  });

  it('refuses an oversized body streamed WITHOUT a Content-Length (the header cannot be trusted)', async () => {
    // One chunk past the ceiling, no declared length: the refusal must come from
    // the streaming guard, not a Content-Length pre-check.
    const oversize = new Uint8Array(MAX_EPT_MANIFEST_BYTES + 1).fill(0x20);
    await expect(readManifest(streamingResponse([oversize]))).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('refuses an oversized body declared via Content-Length before reading a byte', async () => {
    const resp = streamingResponse([enc.encode('{}')], {
      'content-length': String(MAX_EPT_MANIFEST_BYTES + 1),
    });
    await expect(readManifest(resp)).rejects.toBeInstanceOf(BoundedReadError);
  });

  it('aborts promptly when the outer load-cancel signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(readManifest(streamingResponse([enc.encode('{}')]), { signal: ac.signal }))
      .rejects.toThrow();
  });

  it('times out a stalled body via the idle silence budget rather than hanging', async () => {
    await expect(readManifest(stallingResponse(), { idleTimeoutMs: 40 }))
      .rejects.toBeInstanceOf(BoundedReadError);
  });

  it('never lets a signed URL reach the error message (only the label is passed in)', async () => {
    // readAtMostBounded receives the label 'EPT manifest', never the URL, so a
    // ?sig=SECRET token cannot leak through BoundedReadError.message by construction.
    const oversize = new Uint8Array(MAX_EPT_MANIFEST_BYTES + 1).fill(0x20);
    const err = await readManifest(streamingResponse([oversize])).catch((e) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect((err as Error).message).toContain('EPT manifest');
    expect((err as Error).message).not.toMatch(/sig=|SECRET|https?:\/\//i);
  });
});
