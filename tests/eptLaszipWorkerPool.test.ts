/**
 * tests/eptLaszipWorkerPool.test.ts
 *
 * The EPT laszip decode client as a POOL — several workers behind one
 * `decodeTile()` surface. `eptLaszipWorkerClient.test.ts` pins the single-worker
 * wire protocol; this file pins what changes when there is more than one worker:
 * parallel dispatch, queueing behind a busy pool, cancellation before and during
 * a decode, isolation of a single worker's death, and disposal.
 *
 * The equivalent COPC cases run against the generic pool in
 * `decodeWorkerPool.test.ts` — both clients are the same pool with a different
 * wire format, so this file also serves as the proof that the EPT wire format
 * survives pooling unchanged (tile transferred once, `renderOrigin` copied,
 * `rgbEightBit` passed through and never re-derived per worker).
 */

import { describe, test, expect } from 'vitest';
import {
  EptLaszipWorkerClient,
  type WorkerLike,
} from '../src/io/ept/worker/eptLaszipWorkerClient';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';
import { isDetached, transferBuffer } from './bufferTransfer';

interface PostedMessage {
  type: string;
  requestId: number;
  tile?: ArrayBuffer;
  renderOrigin?: number[];
  rgbEightBit?: boolean;
}

/** A fake worker that really detaches what it is handed, as postMessage does. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  inFlight = 0;
  peakInFlight = 0;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    for (const item of transfer ?? []) {
      if (item instanceof ArrayBuffer) {
        transferBuffer(item);
      }
    }
    const msg = message as PostedMessage;
    this.posted.push(msg);
    this.transfers.push([...(transfer ?? [])]);
    if (msg.type === 'decode') {
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  get decodes(): PostedMessage[] {
    return this.posted.filter((m) => m.type === 'decode');
  }

  get current(): PostedMessage | undefined {
    return this.decodes[this.decodes.length - 1];
  }

  resolve(requestId: number, pointCount: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.onmessage?.({
      data: { type: 'decoded', requestId, decoded: { pointCount } as DecodedChunk },
    } as MessageEvent);
  }

  die(): void {
    this.inFlight = 0;
    this.onerror?.(new Event('error'));
  }
}

function mkClient(size: number): { client: EptLaszipWorkerClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new EptLaszipWorkerClient(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    { poolSize: size },
  );
  return { client, workers };
}

/** Silence a rejection we assert on later, so Node never sees it unhandled. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

describe('EptLaszipWorkerClient — the shipping default', () => {
  test('with no options and no flags, exactly ONE worker is built', () => {
    // The EPT half of the same guarantee: pooled decoding is opt-in, so a
    // default client is behaviourally the pre-pool single-worker client.
    const workers: FakeWorker[] = [];
    const client = new EptLaszipWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    for (let i = 0; i < 3; i++) {
      quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0]));
    }
    expect(workers).toHaveLength(1);
    expect(workers[0].decodes).toHaveLength(1);
    expect(client.poolStats().size).toBe(1);
    expect(client.poolStats().queued).toBe(2);
    client.dispose();
  });
});

describe('EptLaszipWorkerClient pool — dispatch', () => {
  test('tiles decode in parallel across workers, one tile per worker', async () => {
    const { client, workers } = mkClient(3);
    const tiles = [0, 1, 2].map(() => new ArrayBuffer(32));
    const promises = tiles.map((tile) => client.decodeTile(tile, [1, 2, 3]));
    expect(workers).toHaveLength(3);
    for (const worker of workers) {
      expect(worker.decodes).toHaveLength(1);
      expect(worker.peakInFlight).toBe(1);
    }
    workers.forEach((worker, i) => worker.resolve(worker.decodes[0].requestId, i + 1));
    expect((await Promise.all(promises)).map((d) => d.pointCount)).toEqual([1, 2, 3]);
    expect(client.pendingCount).toBe(0);
  });

  test('a fourth tile waits for a worker rather than doubling one up', async () => {
    const { client, workers } = mkClient(2);
    const promises = [0, 1, 2].map(() => quiet(client.decodeTile(new ArrayBuffer(32), [0, 0, 0])));
    expect(client.poolStats().active).toBe(2);
    expect(client.poolStats().queued).toBe(1);
    expect(workers[0].decodes).toHaveLength(1);
    expect(workers[1].decodes).toHaveLength(1);

    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    await promises[0];
    expect(workers[0].decodes).toHaveLength(2); // the queued tile went here
    expect(client.poolStats().queued).toBe(0);
    workers[1].resolve(workers[1].decodes[0].requestId, 2);
    workers[0].resolve(workers[0].decodes[1].requestId, 3);
    await Promise.all(promises);
    for (const worker of workers) expect(worker.peakInFlight).toBe(1);
  });

  test('the EPT wire format survives pooling: one transfer, copied origin, passed-through colour depth', async () => {
    const { client, workers } = mkClient(2);
    const tile = new ArrayBuffer(64);
    const origin: [number, number, number] = [10, 20, 30];
    const promise = client.decodeTile(tile, origin, undefined, true);
    const message = workers[0].decodes[0];

    expect(message.renderOrigin).toEqual([10, 20, 30]);
    // A COPY of the caller's origin — mutating theirs afterwards cannot reach
    // the worker's message.
    expect(message.renderOrigin).not.toBe(origin);
    // The dataset-level colour decision is forwarded verbatim. No worker
    // derives its own, which is what keeps a pooled cloud at one colour depth.
    expect(message.rgbEightBit).toBe(true);
    expect(workers[0].transfers[0]).toContain(tile);
    expect(workers[0].transfers[0]).toHaveLength(1);
    expect(isDetached(tile)).toBe(true);

    workers[0].resolve(message.requestId, 7);
    expect((await promise).pointCount).toBe(7);
  });

  test('every tile in a burst is decoded exactly once, ids unique across workers', async () => {
    const { client, workers } = mkClient(3);
    const count = 24;
    const promises = Array.from({ length: count }, (_, i) =>
      client.decodeTile(new ArrayBuffer(8), [0, 0, 0]).then((d) => d.pointCount + i * 0),
    );
    let guard = 0;
    while (client.pendingCount > 0) {
      if (guard++ > count * 4) throw new Error('pool failed to drain');
      for (const worker of workers) {
        if (worker.inFlight === 1) {
          const current = worker.current as PostedMessage;
          worker.resolve(current.requestId, current.requestId);
        }
      }
    }
    const results = await Promise.all(promises);
    const ids = workers.flatMap((w) => w.decodes.map((m) => m.requestId));
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
    expect(results.slice().sort((a, b) => a - b)).toEqual(ids.slice().sort((a, b) => a - b));
  });
});

describe('EptLaszipWorkerClient pool — cancellation', () => {
  test('a queued tile cancelled before dispatch never reaches a worker', async () => {
    const { client, workers } = mkClient(1);
    const running = quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0]));
    const controller = new AbortController();
    const queuedTile = new ArrayBuffer(8);
    const queued = client.decodeTile(queuedTile, [0, 0, 0], controller.signal);

    controller.abort();
    await expect(queued).rejects.toThrow(/EPT decode aborted/);
    expect(workers[0].decodes).toHaveLength(1);
    expect(workers[0].posted.some((m) => m.type === 'cancel')).toBe(false);
    expect(isDetached(queuedTile)).toBe(false); // never transferred

    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    await running;
    expect(client.pendingCount).toBe(0);
  });

  test('cancelling an in-flight tile posts a cancel and drops the late result', async () => {
    const { client, workers } = mkClient(2);
    const controller = new AbortController();
    const promise = client.decodeTile(new ArrayBuffer(8), [0, 0, 0], controller.signal);
    const id = workers[0].decodes[0].requestId;

    controller.abort();
    await expect(promise).rejects.toThrow(/EPT decode aborted/);
    expect(workers[0].posted.find((m) => m.type === 'cancel')?.requestId).toBe(id);
    expect(client.pendingCount).toBe(0);
    expect(() => workers[0].resolve(id, 99)).not.toThrow();
    expect(client.pendingCount).toBe(0);
  });
});

describe('EptLaszipWorkerClient pool — failure and disposal', () => {
  test('one worker dying takes only its tile with it', async () => {
    const { client, workers } = mkClient(3);
    const promises = [0, 1, 2].map(() => quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0])));
    workers[1].die();
    await expect(promises[1]).rejects.toThrow(/EPT laszip decode worker failed/);
    expect(workers[1].terminated).toBe(true);

    workers[0].resolve(workers[0].decodes[0].requestId, 10);
    workers[2].resolve(workers[2].decodes[0].requestId, 30);
    expect((await promises[0]).pointCount).toBe(10);
    expect((await promises[2]).pointCount).toBe(30);
    expect(client.pendingCount).toBe(0);

    // And the client is still open for business.
    const after = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const busy = workers.find((w) => w.inFlight === 1);
    busy?.resolve((busy.current as PostedMessage).requestId, 5);
    expect((await after).pointCount).toBe(5);
  });

  test('dispose terminates every worker and settles queued and active tiles', async () => {
    const { client, workers } = mkClient(2);
    const promises = [0, 1, 2, 3].map(() =>
      quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0])),
    );
    expect(client.poolStats().active).toBe(2);
    expect(client.poolStats().queued).toBe(2);

    client.dispose();
    for (const promise of promises) {
      await expect(promise).rejects.toThrow(/disposed/i);
    }
    expect(client.pendingCount).toBe(0);
    expect(client.poolStats().queued).toBe(0);
    expect(client.poolStats().active).toBe(0);
    expect(client.poolStats().liveWorkers).toBe(0);
    for (const worker of workers) expect(worker.terminated).toBe(true);
    await expect(quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0]))).rejects.toThrow(
      /disposed/i,
    );
  });

  test('the pool falls back to one worker when no more can be built', async () => {
    const workers: FakeWorker[] = [];
    const client = new EptLaszipWorkerClient(
      () => {
        if (workers.length >= 1) throw new Error('Worker construction failed');
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      { poolSize: 4 },
    );
    const promises = [0, 1, 2].map(() => client.decodeTile(new ArrayBuffer(8), [0, 0, 0]));
    expect(workers).toHaveLength(1);
    expect(client.poolStats().liveWorkers).toBe(1);

    let guard = 0;
    while (client.pendingCount > 0) {
      if (guard++ > 20) throw new Error('pool failed to drain');
      const current = workers[0].current as PostedMessage;
      workers[0].resolve(current.requestId, current.requestId);
    }
    await Promise.all(promises);
    expect(workers[0].peakInFlight).toBe(1);
  });
});

describe('EptLaszipWorkerClient pool — timing hooks', () => {
  test('decode timing is reported per tile and queue wait separately', async () => {
    const { client, workers } = mkClient(1);
    const decodeMs: number[] = [];
    const queueMs: number[] = [];
    client.onDecodeMs = (ms) => decodeMs.push(ms);
    client.onQueueWaitMs = (ms) => queueMs.push(ms);

    const first = client.decodeTile(new ArrayBuffer(8), [0, 0, 0]);
    const second = quiet(client.decodeTile(new ArrayBuffer(8), [0, 0, 0]));
    // Only the dispatched tile has a queue-wait figure so far.
    expect(queueMs).toHaveLength(1);

    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    await first;
    expect(decodeMs).toHaveLength(1);
    expect(queueMs).toHaveLength(2);
    workers[0].resolve(workers[0].decodes[1].requestId, 2);
    await second;
    expect(decodeMs).toHaveLength(2);
    for (const ms of [...decodeMs, ...queueMs]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    // The hook is a plain accessor pair — clearing it stops the reporting.
    client.onDecodeMs = undefined;
    expect(client.onDecodeMs).toBeUndefined();
  });
});
