/**
 * tests/decodeWorkerPool.test.ts
 *
 * The decode worker pool — the machinery both the COPC and the EPT laszip
 * decode clients run on. Everything here is driven through fake workers, so
 * dispatch, cancellation, failure isolation and buffer ownership are pinned in
 * Node with no browser and no WASM.
 *
 * The fake worker below models transfer semantics FAITHFULLY: a transferred
 * `ArrayBuffer` is really detached (via `structuredClone` with a transfer
 * list), and re-transferring a detached buffer throws the way a real
 * `postMessage` would. That is what makes "no buffer is transferred twice" an
 * assertion rather than a claim — a double transfer fails the test by throwing,
 * not by a counter someone remembered to check.
 *
 * The pool-size POLICY (core bands, caps, overrides) is a separate pure module
 * and is covered by `decodePoolSize.test.ts`; sizes here are always pinned so
 * these cases never depend on the host's core count.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  DecodeWorkerPool,
  type DecodePoolMessages,
  type WorkerLike,
} from '../src/io/workerPool/DecodeWorkerPool';
import { isDetached, transferBuffer } from './bufferTransfer';

interface PostedMessage {
  type: string;
  requestId: number;
  [key: string]: unknown;
}

const MESSAGES: DecodePoolMessages = {
  disposed: 'The test decode worker has been disposed.',
  failed: 'The test decode worker failed.',
  aborted: 'Decode aborted',
  queueFull: 'The test decode queue is full.',
};

/**
 * A worker stand-in that records posts, really detaches transferred buffers,
 * and lets a test push replies and error events at will.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  /** Set to make the next posts throw synchronously, as a DataCloneError does. */
  postThrows: Error | null = null;
  /** Decode messages posted but not yet replied to — must never exceed 1. */
  inFlight = 0;
  /** Peak of {@link inFlight} over this worker's life. The concurrency proof. */
  peakInFlight = 0;

  /** Slot this worker was built for — useful when a failure names a worker. */
  readonly index: number;

  constructor(index: number) {
    this.index = index;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.postThrows) throw this.postThrows;
    for (const item of transfer ?? []) {
      if (item instanceof ArrayBuffer) {
        // A real postMessage refuses an already-detached buffer. Modelling that
        // here is what turns "transferred exactly once" into a hard failure.
        transferBuffer(item); // genuinely detaches it
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

  /** Every decode message this worker was given, oldest first. */
  get decodes(): PostedMessage[] {
    return this.posted.filter((m) => m.type === 'decode');
  }

  /** The decode this worker is currently running, if any. */
  get current(): PostedMessage | undefined {
    return this.decodes[this.decodes.length - 1];
  }

  /** Reply with a decoded payload for a request id. */
  resolve(requestId: number, pointCount: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.onmessage?.({
      data: { type: 'decoded', requestId, decoded: { pointCount } },
    } as MessageEvent);
  }

  /** Reply with a decode error for a request id. */
  fail(requestId: number, error: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.onmessage?.({ data: { type: 'error', requestId, error } } as MessageEvent);
  }

  /** Raw reply — for stale ids and duplicates, where bookkeeping must not move. */
  raw(reply: unknown): void {
    this.onmessage?.({ data: reply } as MessageEvent);
  }

  /** The worker process died. */
  die(): void {
    this.inFlight = 0;
    this.onerror?.(new Event('error'));
  }
}

interface Harness {
  pool: DecodeWorkerPool<{ pointCount: number }>;
  workers: FakeWorker[];
}

/** A pool over `size` slots, each getting its own fake worker. */
function mkPool(
  size: number,
  options: {
    failCreateAfter?: number;
    maxQueueDepth?: number;
    respawnBudget?: number;
    now?: () => number;
  } = {},
): Harness {
  const workers: FakeWorker[] = [];
  const pool = new DecodeWorkerPool<{ pointCount: number }>({
    size,
    createWorker: () => {
      if (options.failCreateAfter !== undefined && workers.length >= options.failCreateAfter) {
        throw new Error('Worker construction failed');
      }
      const worker = new FakeWorker(workers.length);
      workers.push(worker);
      return worker;
    },
    messages: MESSAGES,
    maxQueueDepth: options.maxQueueDepth,
    respawnBudget: options.respawnBudget,
    now: options.now,
  });
  return { pool, workers };
}

/** A submission with a fresh, transferable buffer. */
function job(pool: Harness['pool'], tag: number, signal?: AbortSignal, value?: number) {
  const buffer = new ArrayBuffer(16);
  const promise = pool.submit({
    payload: { tag, chunk: buffer },
    transfer: [buffer],
    signal,
    value,
  });
  return { promise, buffer };
}

/** Silence a rejection we assert on later, so Node never sees it unhandled. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

describe('DecodeWorkerPool — dispatch', () => {
  test('never runs two jobs on one worker at the same time', async () => {
    const { pool, workers } = mkPool(2);
    const jobs = [0, 1, 2, 3, 4, 5].map((i) => job(pool, i));
    // Two slots, six jobs: four must be waiting, not stuffed into a worker.
    expect(pool.activeCount).toBe(2);
    expect(pool.queuedCount).toBe(4);

    // Drain, replying one at a time. After every reply the invariant is
    // re-checked: no worker is ever holding more than one live decode.
    for (let done = 0; done < 6; done++) {
      for (const worker of workers) {
        expect(worker.inFlight).toBeLessThanOrEqual(1);
      }
      const busy = workers.find((w) => w.inFlight === 1);
      expect(busy).toBeDefined();
      const current = busy?.current as PostedMessage;
      busy?.resolve(current.requestId, done);
    }
    for (const worker of workers) {
      expect(worker.peakInFlight).toBe(1);
      expect(worker.inFlight).toBe(0);
    }
    await Promise.all(jobs.map((j) => j.promise));
    expect(pool.pendingCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(0);
  });

  test('a queued job is dispatched as soon as a worker frees up', async () => {
    const { pool, workers } = mkPool(1);
    const first = job(pool, 1);
    const second = job(pool, 2);
    expect(workers[0].decodes).toHaveLength(1);
    expect(pool.queuedCount).toBe(1);

    workers[0].resolve(workers[0].decodes[0].requestId, 11);
    await first.promise;
    // The reply freed the worker, which immediately took the queued job.
    expect(workers[0].decodes).toHaveLength(2);
    expect(pool.queuedCount).toBe(0);

    workers[0].resolve(workers[0].decodes[1].requestId, 22);
    expect((await second.promise).pointCount).toBe(22);
  });

  test('workers are grown on demand, not all at construction', () => {
    const { pool, workers } = mkPool(4);
    // Slot 0 is eager (it pre-warms laz-perf); the rest wait for real demand.
    expect(workers).toHaveLength(1);
    quiet(job(pool, 1).promise);
    expect(workers).toHaveLength(1);
    quiet(job(pool, 2).promise);
    expect(workers).toHaveLength(2);
    quiet(job(pool, 3).promise);
    quiet(job(pool, 4).promise);
    expect(workers).toHaveLength(4);
    // And never past the configured size.
    quiet(job(pool, 5).promise);
    expect(workers).toHaveLength(4);
    expect(pool.queuedCount).toBe(1);
    pool.dispose();
  });

  test('an empty queue leaves the pool idle and ready', async () => {
    const { pool, workers } = mkPool(3);
    expect(pool.pendingCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(0);
    expect(pool.stats().dispatched).toBe(0);
    // Replies for an empty pool are inert, not a crash.
    expect(() => workers[0].raw({ type: 'decoded', requestId: 99, decoded: {} })).not.toThrow();
    expect(pool.pendingCount).toBe(0);
    // And it still serves the next job normally.
    const only = job(pool, 1);
    workers[0].resolve(workers[0].decodes[0].requestId, 5);
    expect((await only.promise).pointCount).toBe(5);
    expect(pool.activeCount).toBe(0);
  });
});

describe('DecodeWorkerPool — value ordering', () => {
  test('with no values supplied, dispatch order is strictly enqueue order (FIFO)', async () => {
    const { pool, workers } = mkPool(1);
    const promises = [];
    for (let i = 0; i < 8; i++) promises.push(quiet(job(pool, i).promise));
    // Drain one at a time and record the tag each dispatch carried.
    const order: number[] = [];
    for (let i = 0; i < 8; i++) {
      const current = workers[0].current as PostedMessage;
      order.push(current.tag as number);
      workers[0].resolve(current.requestId, i);
    }
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await Promise.all(promises);
  });

  test('a higher value decodes sooner; equal values keep enqueue order', async () => {
    const { pool, workers } = mkPool(1);
    const promises = [
      quiet(job(pool, 0).promise), // dispatched at once — the pool was idle
      quiet(job(pool, 1, undefined, 0).promise),
      quiet(job(pool, 2, undefined, 5).promise),
      quiet(job(pool, 3, undefined, 0).promise),
      quiet(job(pool, 4, undefined, 5).promise),
    ];
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      const current = workers[0].current as PostedMessage;
      order.push(current.tag as number);
      workers[0].resolve(current.requestId, i);
    }
    // 0 was already running. Then the two value-5 entries in enqueue order,
    // then the two value-0 entries in enqueue order.
    expect(order).toEqual([0, 2, 4, 1, 3]);
    await Promise.all(promises);
  });

  test('no starvation: every queued job is eventually dispatched exactly once', async () => {
    const { pool, workers } = mkPool(3);
    const count = 40;
    const promises: Array<Promise<{ pointCount: number }>> = [];
    for (let i = 0; i < count; i++) promises.push(job(pool, i).promise);

    let guard = 0;
    while (pool.pendingCount > 0) {
      if (guard++ > count * 4) throw new Error('pool failed to drain');
      for (const worker of workers) {
        if (worker.inFlight === 1) {
          const current = worker.current as PostedMessage;
          worker.resolve(current.requestId, current.tag as number);
        }
      }
    }
    const decoded = await Promise.all(promises);
    expect(decoded.map((d) => d.pointCount).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
    // Every job ran once and only once, across all three workers.
    const tags = workers.flatMap((w) => w.decodes.map((m) => m.tag as number));
    expect(tags.sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(pool.stats().dispatched).toBe(count);
  });
});

describe('DecodeWorkerPool — cancellation', () => {
  test('a queued job cancelled before dispatch never reaches a worker', async () => {
    const { pool, workers } = mkPool(1);
    const running = job(pool, 1);
    const controller = new AbortController();
    const queued = job(pool, 2, controller.signal);
    expect(pool.queuedCount).toBe(1);

    controller.abort();
    await expect(queued.promise).rejects.toThrow(/abort/i);
    expect(pool.queuedCount).toBe(0);
    // Never posted: no decode for it, and no cancel message either — there is
    // nothing in any worker to cancel.
    expect(workers[0].decodes).toHaveLength(1);
    expect(workers[0].posted.some((m) => m.type === 'cancel')).toBe(false);
    // Its buffer was never transferred, so it is still intact.
    expect(isDetached(queued.buffer)).toBe(false);

    // The pool keeps serving the job that was actually running.
    workers[0].resolve(workers[0].decodes[0].requestId, 7);
    expect((await running.promise).pointCount).toBe(7);
    expect(pool.pendingCount).toBe(0);
  });

  test('cancelling an active job rejects at once and drops the late result', async () => {
    const { pool, workers } = mkPool(1);
    const controller = new AbortController();
    const active = job(pool, 1, controller.signal);
    const id = workers[0].decodes[0].requestId;

    controller.abort();
    await expect(active.promise).rejects.toThrow(/abort/i);
    expect(pool.pendingCount).toBe(0);
    // A cancel was posted so a not-yet-started decode is skipped.
    expect(workers[0].posted.find((m) => m.type === 'cancel')?.requestId).toBe(id);

    // The worker was mid-WASM and finishes anyway. The result must be dropped,
    // and must not blow up or resolve anything.
    expect(() => workers[0].resolve(id, 99)).not.toThrow();
    expect(pool.pendingCount).toBe(0);
  });

  test('a cancelled active job keeps its worker busy until the reply arrives', async () => {
    const { pool, workers } = mkPool(1);
    const controller = new AbortController();
    const active = job(pool, 1, controller.signal);
    const queued = job(pool, 2);
    const activeId = workers[0].decodes[0].requestId;

    controller.abort();
    await expect(active.promise).rejects.toThrow(/abort/i);
    // The worker is still inside an uninterruptible decode. Handing it the
    // queued job now would put two live decodes on one worker.
    expect(workers[0].decodes).toHaveLength(1);
    expect(pool.queuedCount).toBe(1);
    expect(pool.activeCount).toBe(1);

    workers[0].resolve(activeId, 0); // the abandoned decode finally reports
    expect(workers[0].decodes).toHaveLength(2);
    workers[0].resolve(workers[0].decodes[1].requestId, 42);
    expect((await queued.promise).pointCount).toBe(42);
  });

  test('an already-aborted signal rejects without queueing or posting anything', async () => {
    const { pool, workers } = mkPool(1);
    const controller = new AbortController();
    controller.abort();
    await expect(job(pool, 1, controller.signal).promise).rejects.toThrow(/abort/i);
    expect(workers[0].posted).toHaveLength(0);
    expect(pool.pendingCount).toBe(0);
  });

  test('abort listeners are detached on every terminal path', async () => {
    // Resolve, reject-on-error, abort, sync post failure, worker death and
    // dispose all have to leave the signal clean: a listener that outlives its
    // request leaks one entry per decode for the life of the session.
    const removals: string[] = [];
    const track = (name: string): { signal: AbortSignal; abort: () => void } => {
      const controller = new AbortController();
      const spy = vi.spyOn(controller.signal, 'removeEventListener');
      spy.mockImplementation(((...args: unknown[]) => {
        removals.push(name);
        return AbortSignal.prototype.removeEventListener.apply(
          controller.signal,
          args as Parameters<AbortSignal['removeEventListener']>,
        );
      }) as AbortSignal['removeEventListener']);
      return { signal: controller.signal, abort: () => controller.abort() };
    };

    // 1. resolve
    {
      const { pool, workers } = mkPool(1);
      const s = track('resolve');
      const j = job(pool, 1, s.signal);
      workers[0].resolve(workers[0].decodes[0].requestId, 1);
      await j.promise;
      expect(() => s.abort()).not.toThrow();
    }
    // 2. worker-reported decode error
    {
      const { pool, workers } = mkPool(1);
      const s = track('error');
      const j = job(pool, 1, s.signal);
      workers[0].fail(workers[0].decodes[0].requestId, 'malformed chunk');
      await expect(j.promise).rejects.toThrow(/malformed/);
      expect(() => s.abort()).not.toThrow();
    }
    // 3. abort
    {
      const { pool } = mkPool(1);
      const s = track('abort');
      const j = job(pool, 1, s.signal);
      s.abort();
      await expect(j.promise).rejects.toThrow(/abort/i);
    }
    // 4. synchronous post failure
    {
      const { pool, workers } = mkPool(1);
      workers[0].postThrows = new Error('DataCloneError: could not be cloned');
      const s = track('post-failure');
      const j = job(pool, 1, s.signal);
      await expect(j.promise).rejects.toThrow(/DataCloneError/);
      expect(() => s.abort()).not.toThrow();
    }
    // 5. worker death
    {
      const { pool, workers } = mkPool(1);
      const s = track('worker-death');
      const j = job(pool, 1, s.signal);
      workers[0].die();
      await expect(j.promise).rejects.toThrow(/failed/i);
      expect(() => s.abort()).not.toThrow();
      expect(pool.pendingCount).toBe(0);
    }
    // 6. dispose
    {
      const { pool } = mkPool(1);
      const s = track('dispose');
      const j = job(pool, 1, s.signal);
      pool.dispose();
      await expect(j.promise).rejects.toThrow(/disposed/i);
      expect(() => s.abort()).not.toThrow();
    }

    expect(removals).toEqual([
      'resolve',
      'error',
      'abort',
      'post-failure',
      'worker-death',
      'dispose',
    ]);
  });
});

describe('DecodeWorkerPool — failure isolation', () => {
  test('one worker dying rejects only its job; the pool keeps serving', async () => {
    const { pool, workers } = mkPool(3);
    const a = job(pool, 1);
    const b = job(pool, 2);
    const c = job(pool, 3);
    expect(workers).toHaveLength(3);

    workers[1].die();
    await expect(quiet(b.promise)).rejects.toThrow(/failed/i);
    expect(workers[1].terminated).toBe(true);

    // The other two are untouched and still resolve.
    workers[0].resolve(workers[0].decodes[0].requestId, 10);
    workers[2].resolve(workers[2].decodes[0].requestId, 30);
    expect((await a.promise).pointCount).toBe(10);
    expect((await c.promise).pointCount).toBe(30);
    expect(pool.pendingCount).toBe(0);
  });

  test('a dead slot is respawned while siblings are alive, and keeps serving', async () => {
    const { pool, workers } = mkPool(2);
    const a = job(pool, 1);
    const b = job(pool, 2);
    expect(workers).toHaveLength(2);

    workers[1].die();
    await expect(quiet(b.promise)).rejects.toThrow(/failed/i);
    expect(pool.stats().respawns).toBe(1);

    // New work brings a replacement worker up rather than piling onto slot 0.
    const c = job(pool, 3);
    const d = job(pool, 4);
    expect(workers).toHaveLength(3); // slot 1 respawned
    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    workers[2].resolve(workers[2].decodes[0].requestId, 3);
    await a.promise;
    await c.promise;
    workers[0].resolve(workers[0].decodes[1].requestId, 4);
    expect((await d.promise).pointCount).toBe(4);
    expect(pool.pendingCount).toBe(0);
  });

  test('the LAST worker dying breaks the pool instead of respawning into a loop', async () => {
    // A death with no sibling alive is indistinguishable from a systemic
    // failure. The pool reports it so the caller's error path runs, rather
    // than respawning forever while nodes sit in 'loading'.
    const { pool, workers } = mkPool(1);
    const active = job(pool, 1);
    const queued = job(pool, 2);

    workers[0].die();
    await expect(quiet(active.promise)).rejects.toThrow(/failed/i);
    await expect(quiet(queued.promise)).rejects.toThrow(/failed/i);
    expect(pool.pendingCount).toBe(0);
    expect(pool.stats().broken).toBe(true);

    // Later submissions reject at once — never posted into a corpse.
    await expect(quiet(job(pool, 3).promise)).rejects.toThrow(/failed/i);
    expect(workers).toHaveLength(1);
    expect(workers[0].decodes).toHaveLength(1);
  });

  test('a job on a dead worker is never rescheduled onto a healthy one', async () => {
    // Its buffer went into the worker that died and is detached — re-posting it
    // would throw, or silently ship an empty buffer.
    const { pool, workers } = mkPool(2);
    const a = job(pool, 1);
    const b = job(pool, 2);
    expect(isDetached(b.buffer)).toBe(true);

    workers[1].die();
    await expect(quiet(b.promise)).rejects.toThrow(/failed/i);
    // Slot 0 only ever saw its own job.
    expect(workers[0].decodes.map((m) => m.tag)).toEqual([1]);
    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    await a.promise;
  });

  test('a stale reply from a replaced worker cannot free its successor slot', async () => {
    const { pool, workers } = mkPool(2);
    const a = job(pool, 1);
    const b = job(pool, 2);
    const deadId = workers[1].decodes[0].requestId;
    workers[1].die();
    await expect(quiet(b.promise)).rejects.toThrow(/failed/i);

    const c = job(pool, 3); // respawns slot 1
    expect(workers).toHaveLength(3);
    // The corpse speaks. Nothing may move.
    expect(() => workers[1].raw({ type: 'decoded', requestId: deadId, decoded: {} })).not.toThrow();
    expect(pool.activeCount).toBe(2);

    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    workers[2].resolve(workers[2].decodes[0].requestId, 3);
    await a.promise;
    expect((await c.promise).pointCount).toBe(3);
  });

  test('falls back to a single worker when the pool cannot build more', async () => {
    // Slot 0 builds; every later slot throws. The pool degrades to one worker
    // and still drains the queue rather than wedging.
    const { pool, workers } = mkPool(4, { failCreateAfter: 1 });
    const promises = [0, 1, 2].map((i) => job(pool, i).promise);
    expect(workers).toHaveLength(1);
    expect(pool.stats().liveWorkers).toBe(1);
    expect(pool.stats().retiredSlots).toBe(3);

    for (let i = 0; i < 3; i++) {
      const current = workers[0].current as PostedMessage;
      workers[0].resolve(current.requestId, current.tag as number);
    }
    expect((await Promise.all(promises)).map((d) => d.pointCount)).toEqual([0, 1, 2]);
  });

  test('a decode error reply rejects that request only', async () => {
    const { pool, workers } = mkPool(1);
    const bad = job(pool, 1);
    const good = job(pool, 2);
    workers[0].fail(workers[0].decodes[0].requestId, 'chunk is malformed');
    await expect(bad.promise).rejects.toThrow(/malformed/);
    workers[0].resolve(workers[0].decodes[1].requestId, 5);
    expect((await good.promise).pointCount).toBe(5);
  });
});

describe('DecodeWorkerPool — settlement guarantees', () => {
  test('dispose settles queued and active requests alike and zeroes every counter', async () => {
    const { pool, workers } = mkPool(2);
    const active = [job(pool, 1), job(pool, 2)];
    const queued = [job(pool, 3), job(pool, 4), job(pool, 5)];
    expect(pool.activeCount).toBe(2);
    expect(pool.queuedCount).toBe(3);

    pool.dispose();
    for (const j of [...active, ...queued]) {
      await expect(quiet(j.promise)).rejects.toThrow(/disposed/i);
    }
    expect(pool.pendingCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(0);
    expect(pool.liveWorkerCount).toBe(0);
    for (const worker of workers) expect(worker.terminated).toBe(true);
    // No cancel traffic on the way out — the workers are gone.
    expect(workers.every((w) => !w.posted.some((m) => m.type === 'cancel'))).toBe(true);
    // And a submission afterwards rejects immediately.
    await expect(quiet(job(pool, 6).promise)).rejects.toThrow(/disposed/i);
  });

  test('dispose is idempotent', async () => {
    const { pool } = mkPool(2);
    const j = job(pool, 1);
    pool.dispose();
    expect(() => pool.dispose()).not.toThrow();
    await expect(quiet(j.promise)).rejects.toThrow(/disposed/i);
  });

  test('a synchronous postMessage failure cannot strand a request', async () => {
    const { pool, workers } = mkPool(1);
    workers[0].postThrows = new Error('DataCloneError: could not be cloned');
    const first = job(pool, 1);
    await expect(first.promise).rejects.toThrow(/DataCloneError/);
    expect(pool.pendingCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(0);

    // The pool is not wedged: the slot is still usable once posting works.
    workers[0].postThrows = null;
    const second = job(pool, 2);
    workers[0].resolve(workers[0].decodes[0].requestId, 3);
    expect((await second.promise).pointCount).toBe(3);
  });

  test('a queue that is failing every post drains rather than spinning', async () => {
    const { pool, workers } = mkPool(1);
    const promises = [0, 1, 2, 3].map((i) => quiet(job(pool, i).promise));
    // The first post succeeded; make every later one throw.
    workers[0].postThrows = new Error('DataCloneError: could not be cloned');
    workers[0].resolve(workers[0].decodes[0].requestId, 0);
    const results = await Promise.allSettled(promises);
    expect(results[0].status).toBe('fulfilled');
    expect(results.slice(1).every((r) => r.status === 'rejected')).toBe(true);
    expect(pool.pendingCount).toBe(0);
  });

  test('request ids stay unique across queueing, cancellation and failure', async () => {
    const { pool, workers } = mkPool(2);
    const seen: number[] = [];
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 12; i++) promises.push(quiet(job(pool, i).promise));

    let guard = 0;
    while (pool.pendingCount > 0) {
      if (guard++ > 100) throw new Error('pool failed to drain');
      for (const worker of workers) {
        if (worker.inFlight === 1) {
          const current = worker.current as PostedMessage;
          worker.resolve(current.requestId, 0);
        }
      }
    }
    for (const worker of workers) {
      for (const message of worker.decodes) seen.push(message.requestId);
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    await Promise.allSettled(promises);
  });

  test('the queue is bounded; overflow rejects the new job, never an accepted one', async () => {
    const { pool, workers } = mkPool(1, { maxQueueDepth: 3 });
    const accepted = [0, 1, 2, 3].map((i) => quiet(job(pool, i).promise)); // 1 active + 3 queued
    expect(pool.queuedCount).toBe(3);
    await expect(quiet(job(pool, 4).promise)).rejects.toThrow(/queue is full/i);
    // The accepted four are untouched and still drain.
    let guard = 0;
    while (pool.pendingCount > 0) {
      if (guard++ > 40) throw new Error('pool failed to drain');
      const current = workers[0].current as PostedMessage;
      workers[0].resolve(current.requestId, current.tag as number);
    }
    expect((await Promise.all(accepted)).map((d) => (d as { pointCount: number }).pointCount))
      .toEqual([0, 1, 2, 3]);
  });
});

describe('DecodeWorkerPool — buffer ownership', () => {
  test('each buffer is transferred exactly once', async () => {
    const { pool, workers } = mkPool(2);
    const jobs = [0, 1, 2, 3].map((i) => job(pool, i));
    // The two dispatched buffers are detached; the two queued ones are not yet.
    expect(jobs.filter((j) => isDetached(j.buffer))).toHaveLength(2);

    let guard = 0;
    while (pool.pendingCount > 0) {
      if (guard++ > 20) throw new Error('pool failed to drain');
      for (const worker of workers) {
        if (worker.inFlight === 1) {
          const current = worker.current as PostedMessage;
          worker.resolve(current.requestId, current.tag as number);
        }
      }
    }
    await Promise.all(jobs.map((j) => j.promise));
    // All four went across, once each. A second transfer would have thrown in
    // the fake worker (as a real postMessage does on a detached buffer).
    for (const j of jobs) expect(isDetached(j.buffer)).toBe(true);
    const transferred = workers.flatMap((w) => w.transfers.flat());
    expect(transferred).toHaveLength(4);
    expect(new Set(transferred).size).toBe(4);
  });

  test('a cancelled queued job releases its buffer without transferring it', async () => {
    const { pool, workers } = mkPool(1);
    const running = job(pool, 1);
    const controller = new AbortController();
    const cancelled = job(pool, 2, controller.signal);
    controller.abort();
    await expect(cancelled.promise).rejects.toThrow(/abort/i);
    expect(isDetached(cancelled.buffer)).toBe(false);
    expect(workers[0].transfers.flat()).toHaveLength(1);
    workers[0].resolve(workers[0].decodes[0].requestId, 1);
    await running.promise;
  });

  test('a disposed pool never transfers a queued buffer', async () => {
    const { pool, workers } = mkPool(1);
    const active = job(pool, 1);
    const queued = job(pool, 2);
    pool.dispose();
    await expect(quiet(active.promise)).rejects.toThrow(/disposed/i);
    await expect(quiet(queued.promise)).rejects.toThrow(/disposed/i);
    expect(isDetached(active.buffer)).toBe(true); // it was already posted
    expect(isDetached(queued.buffer)).toBe(false); // it never left the main thread
    expect(workers[0].transfers.flat()).toHaveLength(1);
  });
});

describe('DecodeWorkerPool — timing hooks', () => {
  test('queue wait is reported separately and never counted as decode time', async () => {
    // A scripted clock: every read advances by 1 ms, so the two spans are
    // exact integers rather than a racy wall-clock measurement.
    let clock = 0;
    const now = (): number => ++clock;
    const { pool, workers } = mkPool(1, { now });
    const decodeMs: number[] = [];
    const queueMs: number[] = [];
    pool.onDecodeMs = (ms) => decodeMs.push(ms);
    pool.onQueueWaitMs = (ms) => queueMs.push(ms);

    const first = job(pool, 1); // enqueued at 1, dispatched at 2 → waited 1
    const second = job(pool, 2); // enqueued at 3, dispatched only later
    expect(queueMs).toEqual([1]);

    clock = 20;
    workers[0].resolve(workers[0].decodes[0].requestId, 1); // reply at 21
    await first.promise;
    expect(decodeMs).toEqual([19]); // 21 - 2, the time inside the worker
    // The second job waited from 3 to 22 — long — but its decode is measured
    // from dispatch, so the wait cannot leak into the decode figure.
    expect(queueMs).toEqual([1, 19]);

    clock = 40;
    workers[0].resolve(workers[0].decodes[1].requestId, 2);
    await second.promise;
    expect(decodeMs).toEqual([19, 19]); // 41 - 22
    const stats = pool.stats();
    expect(stats.queueWaitMs).toBe(20);
    expect(stats.activeMs).toBe(38);
  });

  test('onDecodeMs fires once per SUCCESSFUL decode, never for a failure', async () => {
    const { pool, workers } = mkPool(1);
    const hook = vi.fn();
    pool.onDecodeMs = hook;
    const bad = job(pool, 1);
    workers[0].fail(workers[0].decodes[0].requestId, 'boom');
    await expect(bad.promise).rejects.toThrow(/boom/);
    expect(hook).not.toHaveBeenCalled();

    const good = job(pool, 2);
    workers[0].resolve(workers[0].decodes[1].requestId, 1);
    await good.promise;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(typeof hook.mock.calls[0][0]).toBe('number');
  });
});

describe('DecodeWorkerPool — diagnostics', () => {
  test('stats report the pool state without exposing a worker handle', () => {
    const { pool } = mkPool(2);
    quiet(job(pool, 1).promise);
    quiet(job(pool, 2).promise);
    quiet(job(pool, 3).promise);
    const stats = pool.stats();
    expect(stats).toEqual({
      size: 2,
      liveWorkers: 2,
      retiredSlots: 0,
      active: 2,
      queued: 1,
      dispatched: 2,
      respawns: 0,
      queueWaitMs: expect.any(Number),
      activeMs: 0,
      broken: false,
      disposed: false,
    });
    // Nothing in the snapshot is anything but a number or a boolean.
    for (const value of Object.values(stats)) {
      expect(['number', 'boolean']).toContain(typeof value);
    }
    pool.dispose();
    expect(pool.stats().disposed).toBe(true);
    expect(pool.stats().liveWorkers).toBe(0);
  });

  test('a size of zero still yields a usable one-worker pool', async () => {
    const { pool, workers } = mkPool(0);
    expect(pool.stats().size).toBe(1);
    const only = job(pool, 1);
    workers[0].resolve(workers[0].decodes[0].requestId, 9);
    expect((await only.promise).pointCount).toBe(9);
  });
});
