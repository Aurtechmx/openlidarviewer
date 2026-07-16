/**
 * tests/eptLaszipWorkerClient.test.ts
 *
 * Protocol tests for the EPT laszip decode worker CLIENT — the main-thread half
 * that multiplexes request ids, maps replies, and handles abort / dispose. The
 * worker body itself (laz-perf + WASM) is browser-bound and exercised by the
 * decode-core tests (`eptLaszipDecode.test.ts`); here we drive the client with a
 * fake worker so the request bookkeeping is verified with no browser.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  EptLaszipWorkerClient,
  type WorkerLike,
} from '../src/io/ept/worker/eptLaszipWorkerClient';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

interface PostedMessage {
  type: string;
  requestId: number;
  tile?: ArrayBuffer;
  renderOrigin?: number[];
}

/** A fake Worker that records posts and lets the test push replies back. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message as PostedMessage);
    this.transfers.push(transfer ?? []);
  }
  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker replying for a request id. */
  reply(reply: unknown): void {
    this.onmessage?.({ data: reply } as MessageEvent);
  }
}

/** A sentinel decoded chunk — the client passes it through untouched. */
function fakeDecoded(tag = 1): DecodedChunk {
  return { pointCount: tag } as unknown as DecodedChunk;
}

function mkClient(): { client: EptLaszipWorkerClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const client = new EptLaszipWorkerClient(() => worker);
  return { client, worker };
}

describe('EptLaszipWorkerClient protocol', () => {
  test('posts a decode message and resolves on the matching reply', async () => {
    const { client, worker } = mkClient();
    const tile = new ArrayBuffer(64);
    const promise = client.decodeTile(tile, [10, 20, 30]);

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('decode');
    expect(msg.renderOrigin).toEqual([10, 20, 30]);
    // The tile is transferred zero-copy.
    expect(worker.transfers[0]).toContain(tile);

    worker.reply({ type: 'decoded', requestId: msg.requestId, decoded: fakeDecoded(7) });
    const decoded = await promise;
    expect(decoded.pointCount).toBe(7);
  });

  test('rejects with the worker error message on an error reply', async () => {
    const { client, worker } = mkClient();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const id = worker.posted[0].requestId;
    worker.reply({ type: 'error', requestId: id, error: 'unsupported PDRF 9' });
    await expect(promise).rejects.toThrow(/unsupported PDRF 9/);
  });

  test('concurrent decodes resolve to their own replies (id multiplexing)', async () => {
    const { client, worker } = mkClient();
    const pA = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const pB = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const idA = worker.posted[0].requestId;
    const idB = worker.posted[1].requestId;
    expect(idA).not.toBe(idB);
    // Reply out of order: B first, then A.
    worker.reply({ type: 'decoded', requestId: idB, decoded: fakeDecoded(2) });
    worker.reply({ type: 'decoded', requestId: idA, decoded: fakeDecoded(1) });
    expect((await pA).pointCount).toBe(1);
    expect((await pB).pointCount).toBe(2);
  });

  test('a stale reply for an already-settled request is dropped', async () => {
    const { client, worker } = mkClient();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const id = worker.posted[0].requestId;
    worker.reply({ type: 'decoded', requestId: id, decoded: fakeDecoded(5) });
    await promise;
    // A duplicate / late reply must not throw or double-settle.
    expect(() =>
      worker.reply({ type: 'decoded', requestId: id, decoded: fakeDecoded(9) }),
    ).not.toThrow();
  });

  test('aborting posts a cancel and rejects the request', async () => {
    const { client, worker } = mkClient();
    const ctrl = new AbortController();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0], ctrl.signal);
    const id = worker.posted[0].requestId;
    ctrl.abort();
    const cancel = worker.posted.find((m) => m.type === 'cancel');
    expect(cancel?.requestId).toBe(id);
    await expect(promise).rejects.toThrow(/abort/i);
  });

  test('an already-aborted signal rejects without posting a decode', async () => {
    const { client, worker } = mkClient();
    const ctrl = new AbortController();
    ctrl.abort();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0], ctrl.signal);
    await expect(promise).rejects.toThrow(/abort/i);
    expect(worker.posted).toHaveLength(0);
  });

  test('dispose terminates the worker and rejects in-flight decodes', async () => {
    const { client, worker } = mkClient();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(promise).rejects.toThrow(/disposed/i);
    // A decode after dispose rejects immediately.
    await expect(client.decodeTile(new ArrayBuffer(8), [0, 0, 0])).rejects.toThrow(
      /disposed/i,
    );
  });

  test('a worker onerror fails all in-flight decodes', async () => {
    const { client, worker } = mkClient();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    worker.onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow(/worker failed/i);
  });

  test('a decode after a worker onerror settles instead of hanging on the dead worker', async () => {
    const { client, worker } = mkClient();
    const inflight = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    worker.onerror?.(new Event('error'));
    await expect(inflight).rejects.toThrow(/worker failed/i);
    // The dead worker is terminated, not left installed.
    expect(worker.terminated).toBe(true);
    // A NEW decode must not post to the dead worker (which would never reply) —
    // it rejects promptly so the caller's error path runs.
    const after = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    expect(worker.posted).toHaveLength(1); // no second decode posted
    await expect(after).rejects.toThrow(/worker failed/i);
  });

  test('onDecodeMs fires once per successful decode', async () => {
    const { client, worker } = mkClient();
    const spy = vi.fn();
    client.onDecodeMs = spy;
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const id = worker.posted[0].requestId;
    worker.reply({ type: 'decoded', requestId: id, decoded: fakeDecoded() });
    await promise;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof spy.mock.calls[0][0]).toBe('number');
  });
});
