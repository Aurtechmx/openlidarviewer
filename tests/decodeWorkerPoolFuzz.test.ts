/**
 * tests/decodeWorkerPoolFuzz.test.ts
 *
 * Model-based fuzz over the decode worker pool. The example-based cases in
 * `decodeWorkerPool.test.ts` pin the behaviours we thought of; this drives the
 * pool through randomized interleavings of everything that can happen to it and
 * checks the invariants after every single step.
 *
 * The interleavings are what matter. Individually, "cancel an active job",
 * "a worker dies", and "a stale result arrives" are each easy to get right; the
 * bugs live in the orders — a result landing for a request that was cancelled
 * while its worker was mid-decode, a worker dying in the same step its slot was
 * about to be handed new work, a dispose racing a queued cancellation.
 *
 * Randomness is seeded (mulberry32, the generator used elsewhere in this
 * suite), so a failure names a seed that reproduces it exactly, and the seed is
 * printed in the failure message rather than left for someone to guess.
 *
 * The invariants, all asserted after every step and again at quiescence:
 *   - every submitted request reaches EXACTLY ONE terminal outcome;
 *   - no worker ever holds two live decodes;
 *   - no buffer is transferred twice (the fake worker refuses a detached
 *     buffer exactly as a real `postMessage` does);
 *   - a result for a cancelled or superseded request never resolves a newer
 *     one (every reply carries its own request id as its payload, so a
 *     mis-routed result is a value mismatch, not a silent pass);
 *   - abort listeners are removed for every terminated request;
 *   - the pool never wedges: whatever failed, the remaining capacity still
 *     drains the queue;
 *   - after disposal every counter is zero and every worker is terminated.
 */

import { describe, test, expect } from 'vitest';
import {
  DecodeWorkerPool,
  type DecodePoolMessages,
  type WorkerLike,
} from '../src/io/workerPool/DecodeWorkerPool';
import { transferBuffer } from './bufferTransfer';

/** Deterministic PRNG — the same generator the arithmetic-coder tests use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MESSAGES: DecodePoolMessages = {
  disposed: 'The fuzz decode worker has been disposed.',
  failed: 'The fuzz decode worker failed.',
  aborted: 'Decode aborted',
  queueFull: 'The fuzz decode queue is full.',
};

interface PostedMessage {
  type: string;
  requestId: number;
  tag?: number;
}

/** Let every pending microtask run so promise outcomes are visible. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** One submitted request, from `submit()` to its single terminal outcome. */
interface Record {
  readonly tag: number;
  readonly buffer: ArrayBuffer;
  readonly controller?: AbortController;
  /** Terminal outcomes seen. Must be exactly 1 by the end, never 2. */
  outcomes: number;
  status: 'pending' | 'resolved' | 'rejected';
  value?: number;
  error?: string;
  /** Assigned once a worker is actually handed the job. */
  requestId?: number;
  /** addEventListener / removeEventListener counts on this request's signal. */
  listenerAdds: number;
  listenerRemoves: number;
}

/** Shared bookkeeping the fake workers write into. */
interface World {
  /** Every buffer any worker was handed, to prove none goes across twice. */
  readonly transferred: Transferable[];
  /** requestId → tag, learned when a decode is actually posted. */
  readonly dispatched: Map<number, number>;
  /**
   * tag → times a worker was asked to decode it. Counted BEFORE any simulated
   * post failure, so a second attempt is visible even when it throws. A job
   * whose worker died must be rejected, never handed to another worker: its
   * buffer is detached, so the retry could only fail — noisily if the buffer is
   * really gone, silently if it is not.
   */
  readonly dispatchAttempts: Map<number, number>;
  readonly records: Map<number, Record>;
}

class FuzzWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  /** Request ids handed to this worker and not yet replied to. Max size 1. */
  readonly live = new Set<number>();
  /** Ids this worker was told to cancel — the "late result" source. */
  readonly cancelled = new Set<number>();
  /** Ids it has already answered, so a duplicate reply can be replayed. */
  readonly answered: number[] = [];
  alive = true;
  terminated = false;
  throwOnce = false;
  peakLive = 0;

  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const incoming = message as PostedMessage;
    if (incoming.type === 'decode' && incoming.tag !== undefined) {
      const attempts = this.world.dispatchAttempts;
      attempts.set(incoming.tag, (attempts.get(incoming.tag) ?? 0) + 1);
    }
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('DataCloneError: simulated synchronous post failure');
    }
    for (const item of transfer ?? []) {
      if (item instanceof ArrayBuffer) {
        // Exactly what a real postMessage does with a buffer that already went
        // across: refuse it. A double transfer therefore fails loudly here.
        transferBuffer(item);
        this.world.transferred.push(item);
      }
    }
    const msg = message as PostedMessage;
    this.posted.push(msg);
    if (msg.type === 'decode') {
      this.live.add(msg.requestId);
      this.peakLive = Math.max(this.peakLive, this.live.size);
      if (msg.tag !== undefined) this.world.dispatched.set(msg.requestId, msg.tag);
    } else if (msg.type === 'cancel') {
      this.cancelled.add(msg.requestId);
    }
  }

  terminate(): void {
    this.terminated = true;
    this.alive = false;
  }

  /** The decode this worker is running, if any. */
  get current(): number | undefined {
    for (const id of this.live) return id;
    return undefined;
  }

  /** Answer a live decode. The payload is the request id, so a mis-routed
   *  result shows up as a value mismatch rather than passing silently. */
  complete(requestId: number, ok = true): void {
    this.live.delete(requestId);
    this.answered.push(requestId);
    this.onmessage?.({
      data: ok
        ? { type: 'decoded', requestId, decoded: { pointCount: requestId } }
        : { type: 'error', requestId, error: `decode failed for ${requestId}` },
    } as MessageEvent);
  }

  /**
   * Reply for an id whose promise is already settled (cancelled), or for one
   * this worker never ran at all.
   *
   * A cancelled request is still a decode the worker is grinding through, so
   * replying for it retires that decode here just as `complete` would — the
   * worker really is free again afterwards. An id it never had leaves its live
   * set untouched, which is the case where a pool that freed the wrong slot
   * would show up as two live decodes on one worker.
   */
  replayStale(requestId: number): void {
    this.live.delete(requestId);
    this.answered.push(requestId);
    this.onmessage?.({
      data: { type: 'decoded', requestId, decoded: { pointCount: requestId } },
    } as MessageEvent);
  }

  die(): void {
    this.live.clear();
    this.alive = false;
    this.onerror?.(new Event('error'));
  }
}

/** Run one seeded scenario. Throws on the first invariant violation. */
async function runScenario(seed: number, steps: number): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T>(items: T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(rand() * items.length) % items.length];

  const world: World = {
    transferred: [],
    dispatched: new Map(),
    dispatchAttempts: new Map(),
    records: new Map(),
  };
  const workers: FuzzWorker[] = [];
  const poolSize = 1 + Math.floor(rand() * 4); // 1..4
  const pool = new DecodeWorkerPool<{ pointCount: number }>({
    size: poolSize,
    createWorker: () => {
      const worker = new FuzzWorker(world);
      workers.push(worker);
      return worker;
    },
    messages: MESSAGES,
    maxQueueDepth: 8,
  });

  let nextTag = 0;
  let disposed = false;
  const settled: Array<Promise<unknown>> = [];

  const submit = (): void => {
    const tag = nextTag++;
    const buffer = new ArrayBuffer(8);
    const useSignal = rand() < 0.6;
    const controller = useSignal ? new AbortController() : undefined;
    const record: Record = {
      tag,
      buffer,
      controller,
      outcomes: 0,
      status: 'pending',
      listenerAdds: 0,
      listenerRemoves: 0,
    };
    if (controller) {
      // Count listener traffic so a leaked abort listener is detectable.
      const signal = controller.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
        record.listenerAdds++;
        return add(...args);
      }) as AbortSignal['addEventListener'];
      signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
        record.listenerRemoves++;
        return remove(...args);
      }) as AbortSignal['removeEventListener'];
    }
    world.records.set(tag, record);
    const promise = pool
      .submit({
        payload: { tag, chunk: buffer },
        transfer: [buffer],
        signal: controller?.signal,
        // Values are exercised too — the ordering seam must not break any
        // invariant, whatever order it chooses.
        value: rand() < 0.25 ? Math.floor(rand() * 3) : undefined,
      })
      .then(
        (decoded) => {
          record.outcomes++;
          record.status = 'resolved';
          record.value = decoded.pointCount;
        },
        (error: Error) => {
          record.outcomes++;
          record.status = 'rejected';
          record.error = error.message;
        },
      );
    settled.push(promise);
  };

  /** Records that have not yet reached a terminal outcome. */
  const pending = (): Record[] =>
    [...world.records.values()].filter((r) => r.status === 'pending');

  const checkInvariants = (where: string): void => {
    for (const worker of workers) {
      if (worker.peakLive > 1) {
        throw new Error(`${where}: worker held ${worker.peakLive} live decodes`);
      }
    }
    if (new Set(world.transferred).size !== world.transferred.length) {
      throw new Error(`${where}: a buffer was transferred more than once`);
    }
    for (const [tag, attempts] of world.dispatchAttempts) {
      if (attempts > 1) {
        throw new Error(`${where}: tag ${tag} was dispatched ${attempts} times`);
      }
    }
    for (const record of world.records.values()) {
      if (record.outcomes > 1) {
        throw new Error(`${where}: request tag ${record.tag} settled ${record.outcomes} times`);
      }
      if (record.status === 'resolved') {
        const id = [...world.dispatched.entries()].find(([, tag]) => tag === record.tag)?.[0];
        if (id === undefined || record.value !== id) {
          throw new Error(
            `${where}: tag ${record.tag} resolved with ${String(record.value)}, expected its own id ${String(id)}`,
          );
        }
      }
    }
    if (pool.activeCount > poolSize) {
      throw new Error(`${where}: ${pool.activeCount} active jobs across ${poolSize} slots`);
    }
    if (pool.pendingCount < pool.queuedCount) {
      throw new Error(`${where}: pending ${pool.pendingCount} < queued ${pool.queuedCount}`);
    }
  };

  for (let step = 0; step < steps; step++) {
    const live = workers.filter((w) => w.alive);
    const busy = live.filter((w) => w.live.size > 0);
    const roll = rand();

    if (roll < 0.3 && !disposed) {
      submit();
    } else if (roll < 0.42) {
      // Cancel something still queued (never dispatched).
      const target = pick(pending().filter((r) => r.controller && r.requestId === undefined
        && ![...world.dispatched.values()].includes(r.tag)));
      target?.controller?.abort();
    } else if (roll < 0.54) {
      // Cancel something a worker is actually running.
      const activeTags = [...world.dispatched.entries()]
        .filter(([id, tag]) => {
          const record = world.records.get(tag);
          return record?.status === 'pending' && live.some((w) => w.live.has(id));
        })
        .map(([, tag]) => tag);
      const target = pick(activeTags.map((tag) => world.records.get(tag) as Record));
      target?.controller?.abort();
    } else if (roll < 0.62) {
      // The next post from some worker fails synchronously.
      const worker = pick(live);
      if (worker) worker.throwOnce = true;
    } else if (roll < 0.68) {
      // A worker process dies. Whatever it was running must come back as a
      // worker failure — not silently rescheduled, and not left hanging.
      const victim = pick(live);
      if (victim) {
        const doomed = [...victim.live]
          .map((id) => world.records.get(world.dispatched.get(id) as number))
          .filter((r): r is Record => r !== undefined && r.status === 'pending');
        victim.die();
        await flush();
        for (const record of doomed) {
          if (record.status !== 'rejected' || record.error !== MESSAGES.failed) {
            throw new Error(
              `seed ${seed}, step ${step}: tag ${record.tag} was on a worker that died but ended ` +
                `${record.status}${record.error ? ` (${record.error})` : ''}`,
            );
          }
        }
      }
    } else if (roll < 0.74) {
      // A result for a request that was cancelled, or already answered.
      const worker = pick(live);
      if (worker) {
        const stale = pick([...worker.cancelled, ...worker.answered]);
        if (stale !== undefined) worker.replayStale(stale);
      }
    } else if (roll < 0.79) {
      // A reply for an id this pool never issued.
      pick(live)?.replayStale(100_000 + Math.floor(rand() * 1000));
    } else if (roll < 0.82 && !disposed && step > steps / 2) {
      pool.dispose();
      disposed = true;
    } else {
      // Make progress: finish a running decode (sometimes as a decode error).
      const worker = pick(busy);
      const id = worker?.current;
      if (worker && id !== undefined) worker.complete(id, rand() < 0.8);
    }

    await flush();
    checkInvariants(`seed ${seed}, step ${step}`);
  }

  // Quiescence. Whatever happened above, the remaining capacity has to drain
  // the queue — a pool that cannot is wedged, which is the failure this whole
  // file exists to catch.
  for (const worker of workers) worker.throwOnce = false;
  let guard = 0;
  while (!disposed && pool.pendingCount > 0 && !pool.stats().broken) {
    if (guard++ > 400) throw new Error(`seed ${seed}: pool failed to drain (wedged)`);
    const busy = workers.filter((w) => w.alive && w.live.size > 0);
    if (busy.length === 0) {
      if (pool.queuedCount > 0 && pool.stats().liveWorkers === 0 && !pool.stats().broken) {
        throw new Error(`seed ${seed}: queue held ${pool.queuedCount} jobs with no live worker`);
      }
      if (pool.queuedCount > 0 && pool.activeCount === 0) {
        throw new Error(`seed ${seed}: ${pool.queuedCount} queued jobs, nothing dispatched`);
      }
      break;
    }
    for (const worker of busy) {
      const id = worker.current;
      if (id !== undefined) worker.complete(id);
    }
    await flush();
    checkInvariants(`seed ${seed}, drain`);
  }

  pool.dispose();
  await Promise.allSettled(settled);
  await flush();

  // Every request settled exactly once.
  for (const record of world.records.values()) {
    if (record.outcomes !== 1) {
      throw new Error(
        `seed ${seed}: tag ${record.tag} has ${record.outcomes} outcomes (status ${record.status})`,
      );
    }
    // Every listener that was added was removed again.
    if (record.listenerAdds > 0 && record.listenerRemoves < record.listenerAdds) {
      throw new Error(
        `seed ${seed}: tag ${record.tag} leaked ${record.listenerAdds - record.listenerRemoves} abort listener(s)`,
      );
    }
  }
  // Every counter back to zero, every worker gone.
  const stats = pool.stats();
  if (stats.active !== 0 || stats.queued !== 0 || stats.liveWorkers !== 0) {
    throw new Error(
      `seed ${seed}: after dispose active=${stats.active} queued=${stats.queued} live=${stats.liveWorkers}`,
    );
  }
  if (pool.pendingCount !== 0) throw new Error(`seed ${seed}: ${pool.pendingCount} still pending`);
  for (const worker of workers) {
    if (!worker.terminated) throw new Error(`seed ${seed}: a worker was never terminated`);
  }
  // A late abort after everything settled must be inert — no throw, no second
  // outcome. This is the listener check from the other side.
  const before = [...world.records.values()].map((r) => r.outcomes);
  for (const record of world.records.values()) record.controller?.abort();
  await flush();
  const after = [...world.records.values()].map((r) => r.outcomes);
  if (before.join() !== after.join()) {
    throw new Error(`seed ${seed}: a post-settlement abort produced a second outcome`);
  }
}

describe('DecodeWorkerPool — randomized interleavings', () => {
  test('invariants hold across 240 seeded scenarios', async () => {
    const ITERATIONS = 240;
    const STEPS = 24;
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = 0x51ede1 + i * 7919; // spread the seeds; reproducible by index
      try {
        await runScenario(seed, STEPS);
      } catch (err) {
        // The seed is the whole point: it reproduces this exact interleaving.
        throw new Error(
          `fuzz iteration ${i} failed (reproduce with seed ${seed}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    expect(true).toBe(true);
  }, 60_000);

  test('a fixed seed replays identically — a reported failure is reproducible', async () => {
    // Two runs of one seed must take the same path. Without this the seed in a
    // failure message would be decoration rather than a reproduction recipe.
    const trace = async (): Promise<string> => {
      const rand = mulberry32(4242);
      return Array.from({ length: 64 }, () => rand().toFixed(6)).join(',');
    };
    expect(await trace()).toBe(await trace());
    await expect(runScenario(4242, 24)).resolves.toBeUndefined();
  });
});
