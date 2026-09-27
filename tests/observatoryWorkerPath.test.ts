/**
 * observatoryWorkerPath.test.ts: OB-RT-03. Without an injected compute, the
 * runner hands the pipeline to `observatoryWorkerClient.ts`; under Node there
 * is no `Worker`, so the client runs it on the main thread, and the result
 * must match the direct call byte for byte (worker count never changes a
 * digest, OB-INV-07). A late result for a superseded run never overwrites
 * the newer run's state.
 */
import { describe, it, expect } from 'vitest';
import { createObservatoryRunner } from '../src/app/observatoryRunner';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';
import { WORKER_REGISTRY } from '../src/workers/workerRegistry';

const cloud = wallAndGroundCloud('DECLARED');
const opts = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' };

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('Observatory worker path', () => {
  it('is registered once in WORKER_REGISTRY', () => {
    expect(WORKER_REGISTRY.filter((w) => w.workerModule === 'src/app/observatoryWorker.ts')).toHaveLength(1);
  });

  it('run() returns running at once and commits the same field digest the direct call gives', async () => {
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-1',
      getCrsRevision: () => 0,
      buildOptions: () => opts,
    });
    expect(runner.run().phase).toBe('running');
    await until(() => runner.getState().phase === 'committed');
    const state = runner.getState();
    if (state.phase !== 'committed' || state.outcome.status !== 'ok') throw new Error('expected a committed ok run');
    const direct = runObservatoryOverCloud(cloud, { ...opts, voxelEdge: 0.5, declaredStepBudget: 50_000_000 });
    if (direct.status !== 'ok') throw new Error('direct run failed');
    expect(state.outcome.record.fieldDigest).toBe(direct.record.fieldDigest);
  });

  it('a result for a superseded run does not overwrite the newer run', async () => {
    let dataset = 'scan-1';
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => dataset,
      getCrsRevision: () => 0,
      buildOptions: () => opts,
    });
    runner.run();
    runner.abortAndClearCache();
    dataset = 'scan-2';
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.getState().phase).toBe('idle');
  });
});
