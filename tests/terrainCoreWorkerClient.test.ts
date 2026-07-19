/**
 * tests/terrainCoreWorkerClient.test.ts
 *
 * Drives the REAL {@link TerrainCoreWorkerClient} against a fake `Worker` global
 * to pin the recovery behaviour after a worker-level `onerror`: the dead worker
 * must be dropped so the NEXT job respawns a fresh one instead of posting into a
 * corpse that never replies. The integration half proves the correctness win —
 * {@link computeTerrainCoreAsync}'s main-thread fallback still fires after a
 * worker crash, on the crashing run AND on the run after it.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { TerrainCoreWorkerClient } from '../src/terrain/worker/terrainCoreWorkerClient';
import {
  computeTerrainCoreAsync,
  getLastTerrainComputePath,
  setTerrainCoreClientFactory,
} from '../src/terrain/worker/computeTerrainCoreAsync';
import {
  computeTerrainCore,
  type TerrainCore,
  type TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';

function hillScene(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 25; x++) {
    for (let y = 0; y <= 25; y++) {
      const dx = x - 12.5;
      const dy = y - 12.5;
      pts.push(x, y, 8 * Math.exp(-(dx * dx + dy * dy) / 200));
    }
  }
  return Float32Array.from(pts);
}

const PARAMS: TerrainCoreParams = {
  cellSizeM: 2,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
};

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

/** A fake Worker that crashes (fires onerror) once on its first post, then dies. */
class CrashOnceWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  crashed = false;
  constructor() {
    instances.push(this);
  }
  postMessage(): void {
    if (this.crashed) return; // dead: never replies (models a crashed worker)
    this.crashed = true;
    queueMicrotask(() => this.onerror?.({}));
  }
  terminate(): void {}
}

let instances: Array<FakeWorker | CrashOnceWorker> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  setTerrainCoreClientFactory(null);
});

describe('TerrainCoreWorkerClient — recovery after onerror', () => {
  test('drops the dead worker and respawns a fresh one on the next job', async () => {
    instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    const client = new TerrainCoreWorkerClient();
    const pos = hillScene();
    const n = pos.length / 3;

    const first = client.computeCore(pos, n, PARAMS, undefined);
    expect(instances).toHaveLength(1);
    const dead = instances[0] as FakeWorker;
    dead.onerror?.({});
    await expect(first).rejects.toThrow(/worker failed/i);

    // The next job must NOT reuse the dead worker (which would never reply and
    // hang forever) — a fresh worker is constructed and receives the post.
    const sentinel = { __respawned: true } as unknown as TerrainCore;
    const second = client.computeCore(pos, n, PARAMS, undefined);
    expect(instances).toHaveLength(2);
    const fresh = instances[1] as FakeWorker;
    const jobId = fresh.posted[0].jobId as number;
    fresh.onmessage?.({ data: { jobId, ok: true, core: sentinel } } as MessageEvent);
    await expect(second).resolves.toBe(sentinel);
  });
});

describe('computeTerrainCoreAsync — fallback survives a dead worker', () => {
  test('falls back to the main thread after a worker crash, on the crash run and the run after it', async () => {
    instances = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('Worker', CrashOnceWorker);
    // One shared real client, exactly as production wires it.
    setTerrainCoreClientFactory(async () => new TerrainCoreWorkerClient());

    const pos = hillScene();
    const n = pos.length / 3;
    const direct = computeTerrainCore(pos, PARAMS);

    const first = await computeTerrainCoreAsync(pos, n, PARAMS);
    expect(getLastTerrainComputePath()).toBe('fallback');
    expect(Array.from(first.dtm.z)).toEqual(Array.from(direct.dtm.z));

    // The retained-dead-worker defect would leave the shared client posting to
    // the crashed worker here — a promise that never settles. Guard with a
    // timeout so the bug fails fast instead of hanging the suite.
    const second = await withTimeout(computeTerrainCoreAsync(pos, n, PARAMS), 1000);
    expect(getLastTerrainComputePath()).toBe('fallback');
    expect(Array.from(second.dtm.z)).toEqual(Array.from(direct.dtm.z));

    warnSpy.mockRestore();
  });
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timed out — worker promise never settled')), ms),
    ),
  ]);
}
