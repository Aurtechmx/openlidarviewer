/**
 * tests/copcWorkerClient.test.ts
 *
 * Protocol tests for the COPC decode worker CLIENT. Unlike the EPT client this
 * one constructs its `Worker` directly, so the real `Worker` global is stubbed
 * with a fake that records posts and lets the test drive `onmessage`/`onerror`.
 * The worker body (laz-perf + WASM) is browser-bound and covered elsewhere.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { CopcWorkerClient } from '../src/io/copc/worker/copcWorkerClient';
import type {
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** A fake Worker that records posts and lets the test push replies / errors. */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor() {
    instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(reply: unknown): void {
    this.onmessage?.({ data: reply } as MessageEvent);
  }
}

let instances: FakeWorker[] = [];

function mkClient(): { client: CopcWorkerClient; worker: FakeWorker } {
  instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  const client = new CopcWorkerClient();
  return { client, worker: instances[0] };
}

const META = {} as ChunkDecodeMetadata;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CopcWorkerClient protocol', () => {
  test('posts a decode message and resolves on the matching reply', async () => {
    const { client, worker } = mkClient();
    const chunk = new ArrayBuffer(64);
    const promise = client.decode(chunk, META);
    expect(worker.posted).toHaveLength(1);
    const id = worker.posted[0].requestId as number;
    worker.reply({ type: 'decoded', requestId: id, decoded: { pointCount: 7 } as DecodedChunk });
    expect((await promise).pointCount).toBe(7);
  });

  test('a worker onerror fails all in-flight decodes', async () => {
    const { client, worker } = mkClient();
    const promise = client.decode(new ArrayBuffer(8), META);
    worker.onerror?.({});
    await expect(promise).rejects.toThrow(/worker failed/i);
  });

  test('a decode after a worker onerror settles instead of hanging on the dead worker', async () => {
    const { client, worker } = mkClient();
    const inflight = client.decode(new ArrayBuffer(8), META);
    worker.onerror?.({});
    await expect(inflight).rejects.toThrow(/worker failed/i);
    // The dead worker is terminated, not left installed.
    expect(worker.terminated).toBe(true);
    // A NEW decode must not post to the dead worker (which would never reply) —
    // it rejects promptly so the streaming scheduler's error path runs and the
    // node is not left stuck 'loading' forever.
    const after = client.decode(new ArrayBuffer(8), META);
    expect(worker.posted).toHaveLength(1); // no second decode posted
    await expect(after).rejects.toThrow(/worker failed/i);
  });
});
