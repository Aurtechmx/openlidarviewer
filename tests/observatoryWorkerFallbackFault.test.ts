/**
 * observatoryWorkerFallbackFault.test.ts: when the worker reports a failure
 * and the in-thread fallback then throws, the job must reject and the runner
 * must leave "running" for the failed state, with a fixed user message and
 * no second attempt.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const inThread = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/app/observatoryFromCloud', async (orig) => {
  const real = await orig<typeof import('../src/app/observatoryFromCloud')>();
  return {
    ...real,
    runObservatoryOverCloud: () => {
      inThread.calls++;
      throw new Error('internal pipeline detail');
    },
  };
});

import { computeObservatoryInWorker } from '../src/app/observatoryWorkerClient';
import { createObservatoryRunner, OBSERVATORY_FAILED_MESSAGE } from '../src/app/observatoryRunner';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

/** A worker that answers every job with ok:false on the next task. */
class FailingWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(msg: { jobId: number }): void {
    setTimeout(() => this.onmessage?.({ data: { jobId: msg.jobId, ok: false, error: 'boom' } } as MessageEvent), 0);
  }
  terminate(): void {}
}

const cloud = wallAndGroundCloud('DECLARED');
const opts = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' };
const within = <T>(p: Promise<T>, ms = 500) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('did not settle')), ms))]);

beforeEach(() => { inThread.calls = 0; vi.stubGlobal('Worker', FailingWorker); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Observatory worker fallback fault', () => {
  it('rejects when the worker fails and the in-thread fallback throws', async () => {
    await expect(within(computeObservatoryInWorker(cloud, opts))).rejects.toThrow('internal pipeline detail');
    expect(inThread.calls).toBe(1);
  });

  it('the runner lands in the failed state with the fixed message and runs no second fallback', async () => {
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-1',
      getCrsRevision: () => 0,
      buildOptions: () => opts,
    });
    expect(runner.run().phase).toBe('running');
    for (let i = 0; i < 100 && runner.getState().phase === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(runner.getState()).toEqual({ phase: 'failed', message: OBSERVATORY_FAILED_MESSAGE });
    expect(OBSERVATORY_FAILED_MESSAGE).not.toMatch(/internal|Error/);
    expect(inThread.calls).toBe(1);
  });

  it('a failure for an aborted run stays quiet', async () => {
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-1',
      getCrsRevision: () => 0,
      buildOptions: () => opts,
    });
    runner.run();
    runner.abortAndClearCache();
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.getState().phase).toBe('idle');
  });
});
