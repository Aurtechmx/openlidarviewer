/**
 * tests/storageHistoryWorkerClient.test.ts
 *
 * The worker client against a fake Worker: a normal reply, an `ok: false` reply, an error event,
 * an unreadable reply and a worker that never answers. After each failure the next queued job
 * still runs, in a new worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageHistoryRequest } from '../src/science/storageHistory';
import type { StorageHistoryOutcome } from '../src/analysis/storageHistoryRow';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  posted: { jobId: number }[] = [];
  constructor() { FakeWorker.instances.push(this); }
  postMessage(msg: { jobId: number; request: StorageHistoryRequest }, transfer: ArrayBuffer[]): void {
    this.posted.push(msg);
    // Transferring detaches the buffer, as a real worker does.
    structuredClone(msg.request.xy.buffer, { transfer });
  }
  terminate(): void { this.terminated = true; }
  reply(data: unknown): void { this.onmessage?.({ data }); }
}

const SUPPORTED: StorageHistoryOutcome = { kind: 'none', candidatesTested: 8, windows: 20, points: 12_000 };
const DID_NOT_FINISH: StorageHistoryOutcome = { kind: 'not-tested', reason: 'the test did not finish' };

function req(): StorageHistoryRequest {
  return { xy: new Float32Array(8), sourceOrigin: [0, 0], scale: [0.001, 0.001], offset: [0, 0], unitToMetres: 1 };
}

describe('runStorageHistoryInWorker', () => {
  let run: typeof import('../src/app/storageHistoryWorkerClient').runStorageHistoryInWorker;
  let timeoutMs: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    const mod = await import('../src/app/storageHistoryWorkerClient');
    run = mod.runStorageHistoryInWorker;
    timeoutMs = mod.JOB_TIMEOUT_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves with the worker outcome and runs queued jobs in order', async () => {
    const a = run(req());
    const b = run(req());
    const [w] = FakeWorker.instances;
    expect(w.posted.map((m) => m.jobId)).toHaveLength(1);
    w.reply({ jobId: w.posted[0].jobId, ok: true, outcome: SUPPORTED });
    await expect(a).resolves.toEqual(SUPPORTED);
    expect(w.posted).toHaveLength(2);
    w.reply({ jobId: w.posted[1].jobId, ok: true, outcome: SUPPORTED });
    await expect(b).resolves.toEqual(SUPPORTED);
  });

  it('settles an error event as not finished and still runs the next job', async () => {
    const a = run(req());
    const b = run(req());
    const [w1] = FakeWorker.instances;
    w1.onerror?.();
    await expect(a).resolves.toEqual(DID_NOT_FINISH);
    expect(w1.terminated).toBe(true);
    const w2 = FakeWorker.instances[1];
    expect(w2.posted).toHaveLength(1);
    w2.reply({ jobId: w2.posted[0].jobId, ok: true, outcome: SUPPORTED });
    await expect(b).resolves.toEqual(SUPPORTED);
  });

  it('settles a message that cannot be read as not finished and still runs the next job', async () => {
    const a = run(req());
    const b = run(req());
    const [w1] = FakeWorker.instances;
    w1.onmessageerror?.();
    await expect(a).resolves.toEqual(DID_NOT_FINISH);
    expect(w1.terminated).toBe(true);
    const w2 = FakeWorker.instances[1];
    w2.reply({ jobId: w2.posted[0].jobId, ok: true, outcome: SUPPORTED });
    await expect(b).resolves.toEqual(SUPPORTED);
  });

  it('terminates a worker that never answers, settles the job and runs the next one', async () => {
    const a = run(req());
    const b = run(req());
    const [w1] = FakeWorker.instances;
    vi.advanceTimersByTime(timeoutMs - 1);
    expect(w1.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(a).resolves.toEqual(DID_NOT_FINISH);
    expect(w1.terminated).toBe(true);
    const w2 = FakeWorker.instances[1];
    w2.reply({ jobId: w2.posted[0].jobId, ok: true, outcome: SUPPORTED });
    await expect(b).resolves.toEqual(SUPPORTED);
    // The finished job's timer is cleared, so it cannot terminate the new worker later.
    vi.advanceTimersByTime(timeoutMs * 2);
    expect(w2.terminated).toBe(false);
  });

  it('settles an ok:false reply as not finished (the buffer was transferred)', async () => {
    const a = run(req());
    const [w] = FakeWorker.instances;
    w.reply({ jobId: w.posted[0].jobId, ok: false, error: 'boom' });
    await expect(a).resolves.toEqual(DID_NOT_FINISH);
  });
});
