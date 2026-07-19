/**
 * decodeFullWorker.test.ts
 *
 * `decodeFull` must NOT run the loader (parseBuffer, incl. the synchronous
 * laz-perf decompression loop) in the calling realm — that froze the UI for
 * seconds-to-minutes on a full-res re-decode or a batch conversion. It now
 * routes through the shared parse worker, exactly like `loadFile`. These tests
 * drive that seam with a fake worker (no browser): they prove the decode is
 * dispatched to the worker with a plan-less, unbounded-budget request, and
 * that an in-flight decode is cancellable via its `AbortSignal`.
 *
 * Structure, not timing — no wall-clock assertions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as parseBufferMod from '../src/io/parseBuffer';
import { decodeFull } from '../src/convert/decodeFull';
import { __setParseWorkerFactoryForTests } from '../src/io/loadFile';

interface Posted {
  buffer: ArrayBuffer;
  format: string;
  name: string;
  budget?: number;
  plan?: unknown;
}

/** A fake parse worker that records posts and lets the test drive replies. */
class FakeParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Posted[] = [];
  terminated = false;
  /** Reply the fake sends back for the next post; when null it stays silent. */
  reply: unknown = null;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message as Posted);
    if (this.reply != null) {
      const r = this.reply;
      queueMicrotask(() => this.onmessage?.({ data: r } as MessageEvent));
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** A minimal `done` reply the client turns into a PointCloud. */
function doneReply(name: string): unknown {
  return {
    type: 'done',
    cloud: {
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'xyz',
      name,
    },
    originalPointCount: 2,
    downsampled: false,
    telemetry: {},
  };
}

afterEach(() => {
  __setParseWorkerFactoryForTests(undefined);
  vi.restoreAllMocks();
});

describe('decodeFull routes through the shared parse worker', () => {
  it('dispatches the decode to the worker instead of running parseBuffer in the calling realm', async () => {
    const worker = new FakeParseWorker();
    worker.reply = doneReply('scan.xyz');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const spy = vi.spyOn(parseBufferMod, 'parseBuffer');

    const buffer = new TextEncoder().encode('0 0 0\n1 1 1\n').buffer;
    const cloud = await decodeFull(buffer, 'scan.xyz');

    // The loader ran off the calling realm: parseBuffer was never invoked here.
    expect(spy).not.toHaveBeenCalled();
    // The request reached the worker as a full-res, plan-less decode.
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].format).toBe('xyz');
    expect(worker.posted[0].budget).toBe(Number.MAX_SAFE_INTEGER);
    expect(worker.posted[0].plan).toBeUndefined();
    // The worker's cloud is returned intact.
    expect(cloud.name).toBe('scan.xyz');
    expect(cloud.pointCount).toBe(2);
  });

  it('rejects with the worker error message on an error reply', async () => {
    const worker = new FakeParseWorker();
    worker.reply = { type: 'error', error: 'corrupt header' };
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);

    await expect(decodeFull(new ArrayBuffer(8), 'bad.las')).rejects.toThrow(/corrupt header/);
  });

  it('aborts an in-flight decode via its AbortSignal', async () => {
    const worker = new FakeParseWorker();
    // No reply — the decode stays in flight until the signal aborts it.
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrl = new AbortController();

    const promise = decodeFull(new ArrayBuffer(8), 'scan.las', ctrl.signal);
    // Wait until the decode is actually in the worker before aborting, so we
    // exercise the mid-flight terminate path (not the pre-post guard).
    while (worker.posted.length === 0) await Promise.resolve();
    ctrl.abort();

    await expect(promise).rejects.toThrow(/cancel/i);
    // Aborting mid-decode terminates the worker so no orphan decode is left.
    expect(worker.terminated).toBe(true);
  });
});
