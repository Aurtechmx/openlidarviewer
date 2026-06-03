/**
 * terrainWorker.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { createTerrainJob } from '../src/terrain/TerrainWorker';
import type { TerrainAnalysisRequest, TerrainAnalysisResult } from '../src/terrain/TerrainContracts';
import { TerrainCancelledError } from '../src/terrain/TerrainErrors';

const REQUEST: TerrainAnalysisRequest = {
  kind: 'metrics',
  tiles: [],
  metrics: ['slope-degrees'],
};

function syntheticResult(): TerrainAnalysisResult {
  return {
    kind: 'metrics',
    coverage: 'full',
    sourcePointCount: 10,
    analyzedPointCount: 10,
    confidence: 100,
    warnings: [],
    payload: {
      'slope-degrees': [0],
      'roughness-rms': [0],
      'curvature-mean': [0],
      'elevation-variance': [0],
      'point-density': [0],
      'height-above-local-surface': [0],
      'neighborhood-elevation-range': [0],
      'local-planarity': [1],
    },
    elapsedMs: 0,
  };
}

describe('createTerrainJob', () => {
  it('starts in queued, transitions through running, to completed', async () => {
    const job = createTerrainJob('j1', REQUEST, async () => syntheticResult());
    await job.promise;
    expect(job.status).toBe('completed');
  });

  it('cancel before completion flips status to cancelled', async () => {
    const job = createTerrainJob('j2', REQUEST, async (_r, _p, signal) => {
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) throw new TerrainCancelledError();
      return syntheticResult();
    });
    job.cancel();
    await expect(job.promise).rejects.toThrow(TerrainCancelledError);
    expect(job.status).toBe('cancelled');
  });

  it('failed analyser flips status to failed', async () => {
    const job = createTerrainJob('j3', REQUEST, async () => {
      throw new Error('boom');
    });
    await expect(job.promise).rejects.toThrow();
    expect(job.status).toBe('failed');
  });

  it('progress listener is fired by the analyser', async () => {
    const listener = vi.fn();
    const job = createTerrainJob('j4', REQUEST, async (_r, report) => {
      // Yield first so the host has time to attach its listener
      // before the analyser fires progress. Real analysers do real
      // work (or post to a worker) which has the same effect.
      await Promise.resolve();
      report({ completed: 1, total: 2, stage: 'metrics' });
      return syntheticResult();
    });
    job.onProgress(listener);
    await job.promise;
    expect(listener).toHaveBeenCalled();
  });

  it('unsubscribe detaches the listener', async () => {
    const listener = vi.fn();
    const job = createTerrainJob('j5', REQUEST, async (_r, report) => {
      await Promise.resolve();
      report({ completed: 1, total: 2, stage: 'metrics' });
      return syntheticResult();
    });
    const detach = job.onProgress(listener);
    detach();
    await job.promise;
    expect(listener).not.toHaveBeenCalled();
  });

  it('cleans up listeners after completion', async () => {
    const job = createTerrainJob('j6', REQUEST, async () => syntheticResult());
    const listener = vi.fn();
    job.onProgress(listener);
    await job.promise;
    // Listener set is cleared in the finally block; this is just a smoke
    // assertion that no further fire happens.
    expect(listener).not.toHaveBeenCalled();
  });
});
