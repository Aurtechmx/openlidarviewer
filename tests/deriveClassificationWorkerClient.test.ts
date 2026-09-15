/**
 * tests/deriveClassificationWorkerClient.test.ts
 *
 * Protocol tests for the classification worker CLIENT, mirroring
 * `tests/terrainCoreWorkerClient.test.ts` (recovery after `onerror`) and
 * `tests/copcWorkerClient.test.ts` (settlement on a synchronous `postMessage`
 * failure). The worker body itself is browser-bound and covered elsewhere; the
 * real `Worker` global is stubbed with a fake that records posts and lets the
 * test drive `onmessage` / `onerror`.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { DeriveClassificationWorkerClient } from '../src/render/class/deriveClassificationWorkerClient';
import type { DeriveClassificationOptions } from '../src/render/class/deriveClassification';
import {
  deriveClassificationAsync,
  getLastClassifyComputePath,
} from '../src/render/class/deriveClassificationAsync';

/** A fake Worker recording posts; the test drives onmessage / onerror. */
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
}

let instances: FakeWorker[] = [];

function positions(): Float32Array {
  return Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
}

const OPTIONS: DeriveClassificationOptions = { cellSizeM: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeriveClassificationWorkerClient — recovery after onerror', () => {
  test('drops the dead worker and respawns a fresh one on the next job', async () => {
    instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DeriveClassificationWorkerClient();
    const pos = positions();

    const first = client.classify(pos, 3, OPTIONS);
    expect(instances).toHaveLength(1);
    const dead = instances[0];
    dead.onerror?.({});
    await expect(first).rejects.toThrow(/worker failed/i);

    // The next job must NOT reuse the dead worker (which would never reply) —
    // a fresh worker is constructed and receives the post.
    const second = client.classify(pos, 3, OPTIONS);
    expect(instances).toHaveLength(2);
    const fresh = instances[1];
    expect(fresh.posted).toHaveLength(1);
    expect(dead.posted).toHaveLength(1); // the dead worker never got the second job

    const jobId = fresh.posted[0].jobId as number;
    fresh.onmessage?.({
      data: {
        jobId,
        ok: true,
        codes: new Uint8Array([2]),
        counts: {},
        cellSizeM: 1,
        gridWidth: 1,
        gridHeight: 1,
        provenance: 'derived',
        confidence: 1,
        classConfidence: {},
        warnings: [],
      },
    } as MessageEvent);
    await expect(second).resolves.toMatchObject({ derived: true });
  });
});

describe('DeriveClassificationWorkerClient — synchronous postMessage failure', () => {
  test('rejects and leaves no pending state', async () => {
    instances = [];
    // The worker is constructed lazily inside classify()'s own call stack, so
    // there's no handle to override postMessage on before the first post — the
    // fake throws itself, driven by this closed-over flag.
    let throwOnPost = true;
    class ThrowingFakeWorker extends FakeWorker {
      override postMessage(message: unknown): void {
        if (throwOnPost) throw new Error('DataCloneError: could not be cloned');
        super.postMessage(message);
      }
    }
    vi.stubGlobal('Worker', ThrowingFakeWorker);
    const client = new DeriveClassificationWorkerClient();
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');

    await expect(client.classify(positions(), 3, OPTIONS, ctrl.signal)).rejects.toThrow(
      /DataCloneError/,
    );
    // The worker is constructed lazily, so it only exists after the call above.
    const worker = instances[0];
    expect(client.pendingCount).toBe(0);
    expect(removeSpy).toHaveBeenCalled();
    expect(() => ctrl.abort()).not.toThrow();

    // Not wedged: a later classify still completes.
    throwOnPost = false;
    const ok = client.classify(positions(), 3, OPTIONS);
    const id = (worker.posted[worker.posted.length - 1] as { jobId: number }).jobId;
    worker.onmessage?.({
      data: {
        jobId: id,
        ok: true,
        codes: new Uint8Array([2]),
        counts: {},
        cellSizeM: 1,
        gridWidth: 1,
        gridHeight: 1,
        provenance: 'derived',
        confidence: 1,
        classConfidence: {},
        warnings: [],
      },
    } as MessageEvent);
    await expect(ok).resolves.toMatchObject({ derived: true });
    expect(client.pendingCount).toBe(0);
  });
});

describe('DeriveClassificationWorkerClient — abort terminates the computation', () => {
  test('an abort terminates the worker, drops it, and the next job respawns a fresh one', async () => {
    instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DeriveClassificationWorkerClient();
    const ctrl = new AbortController();

    const job = client.classify(positions(), 3, OPTIONS, ctrl.signal);
    expect(instances).toHaveLength(1);
    const running = instances[0];
    ctrl.abort();
    await expect(job).rejects.toThrow(/aborted/i);
    // Rejecting the promise alone would leave the worker computing to the end
    // for nobody; the worker is torn down with the job.
    expect(running.terminated).toBe(true);
    expect(client.pendingCount).toBe(0);

    const next = client.classify(positions(), 3, OPTIONS);
    expect(instances).toHaveLength(2);
    const fresh = instances[1];
    expect(fresh).not.toBe(running);
    const id = (fresh.posted[0] as { jobId: number }).jobId;
    fresh.onmessage?.({
      data: {
        jobId: id, ok: true, codes: new Uint8Array([2]), counts: {}, cellSizeM: 1, gridWidth: 1, gridHeight: 1,
        provenance: {}, confidence: 1, classConfidence: {}, warnings: [], classifier: {},
      },
    } as MessageEvent);
    await expect(next).resolves.toMatchObject({ derived: true });
  });
});

/**
 * A worker that accepts the post and then goes quiet. Before the reply deadline
 * this hung the promise forever, which also meant the bridge's main-thread
 * fallback never ran: Classify simply never finished. Progress messages reset
 * the clock, so the deadline measures SILENCE rather than total run time and a
 * legitimately long derive is never killed.
 */
describe('DeriveClassificationWorkerClient reply deadline', () => {
  test('settles at the injected deadline, terminating the silent worker', async () => {
    instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const client = new DeriveClassificationWorkerClient({ replyDeadlineMs: 5_000 });
      const job = client.classify(positions(), 3, OPTIONS);
      const silent = instances[0];
      expect(client.pendingCount).toBe(1);

      vi.advanceTimersByTime(5_000);
      await expect(job).rejects.toThrow(/5000 ms reply deadline/);
      expect(silent.terminated).toBe(true);
      expect(client.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a progress message resets the deadline, so a long derive survives', async () => {
    instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const phases: string[] = [];
      const client = new DeriveClassificationWorkerClient({ replyDeadlineMs: 5_000 });
      const job = client.classify(positions(), 3, OPTIONS, undefined, (p) => phases.push(p));
      const worker = instances[0];
      const jobId = worker.posted[0].jobId as number;

      // Four minutes of work, reporting every three seconds: far past the
      // deadline in total, never silent for as long as it.
      for (let i = 0; i < 80; i++) {
        vi.advanceTimersByTime(3_000);
        worker.onmessage?.({ data: { jobId, phase: `phase ${i}` } } as MessageEvent);
      }
      expect(phases).toHaveLength(80);
      expect(worker.terminated).toBe(false);
      expect(client.pendingCount).toBe(1);

      // Then it goes quiet, and the deadline fires on the silence.
      vi.advanceTimersByTime(5_000);
      await expect(job).rejects.toThrow(/reply deadline/);
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the deadline routes a silent worker into the bridge fallback', async () => {
    instances = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const client = new DeriveClassificationWorkerClient({ replyDeadlineMs: 1_000 });
      const promise = deriveClassificationAsync(positions(), 3, OPTIONS, undefined, client);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await promise;
      expect(result.derived).toBe(true);
      expect(getLastClassifyComputePath()).toBe('fallback');
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/worker failed/i);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
