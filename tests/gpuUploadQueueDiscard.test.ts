/**
 * Two gaps that block wiring this queue into live streaming.
 *
 * A discarded item still reaches its decoded chunk through `commit`'s closure,
 * so dropping it without a cleanup hook leaves the payload reachable: the
 * queue reports the bytes as no longer pending while they are still held.
 *
 * A time-only budget cannot bound what the next frame absorbs. Three.js defers
 * the real buffer upload to render, so a pass can spend almost no CPU and still
 * hand the GPU more than a frame's work. Bytes and node count bound the cost a
 * user actually sees.
 */

import { describe, expect, it, vi } from 'vitest';

import { GpuUploadQueue, type UploadItem } from '../src/render/gpuUploadQueue';

function item(over: Partial<UploadItem> & { id: string }): UploadItem {
  return {
    datasetId: 'ds',
    generationId: 1,
    estBytes: 1_000,
    commit: () => {},
    ...over,
  };
}

describe('discard cleanup', () => {
  it('releases a stale payload instead of dropping it silently', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    const commit = vi.fn();
    q.enqueue(item({ id: 'a', generationId: 1, commit, onDiscard }));
    q.setGeneration('ds', 2); // the node was superseded before it could show

    const r = q.process(10);
    expect(commit).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith('stale-generation');
    expect(r.discarded).toBe(1);
    expect(q.pendingBytes).toBe(0);
  });

  it('releases payloads when a dataset is cancelled', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'a', onDiscard }));
    q.enqueue(item({ id: 'b', datasetId: 'other', onDiscard }));
    expect(q.cancelDataset('ds')).toBe(1);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('dataset-canceled');
  });

  it('releases every payload on clear', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'a', onDiscard }));
    q.enqueue(item({ id: 'b', onDiscard }));
    expect(q.clear()).toBe(2);
    expect(onDiscard).toHaveBeenCalledTimes(2);
    expect(q.pendingBytes).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it('never discards an item that committed', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'a', onDiscard }));
    q.process(10);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('keeps draining when a cleanup callback throws', () => {
    const q = new GpuUploadQueue();
    const commitB = vi.fn();
    q.enqueue(item({ id: 'a', onDiscard: () => { throw new Error('boom'); } }));
    q.enqueue(item({ id: 'b', generationId: 1, commit: commitB }));
    q.setGeneration('ds', 1);
    // 'a' is current here, so cancel instead to force the throwing path.
    expect(() => q.clear()).not.toThrow();
  });
});

describe('multi-dimensional frame budget', () => {
  it('stops on the node limit', () => {
    const q = new GpuUploadQueue();
    for (const id of ['a', 'b', 'c']) q.enqueue(item({ id }));
    const r = q.process({ budgetMs: 1_000, maxNodes: 2 });
    expect(r.uploaded).toBe(2);
    expect(r.stoppedBy).toBe('nodes');
    expect(r.remaining).toBe(1);
  });

  it('stops on the byte limit before exceeding it', () => {
    const q = new GpuUploadQueue();
    for (const id of ['a', 'b', 'c']) q.enqueue(item({ id, estBytes: 4_000 }));
    const r = q.process({ budgetMs: 1_000, maxBytes: 9_000 });
    expect(r.uploaded).toBe(2);
    expect(r.uploadedBytes).toBe(8_000);
    expect(r.stoppedBy).toBe('bytes');
  });

  it('always commits one item, so a limit below a single node cannot stall', () => {
    // A queue that never commits never shows the scan, which is worse than a
    // frame that runs long.
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'huge', estBytes: 50_000_000 }));
    const r = q.process({ budgetMs: 0, maxBytes: 1, maxNodes: 0 });
    expect(r.uploaded).toBe(1);
    expect(r.remaining).toBe(0);
  });

  it('reports drained when nothing limited the pass', () => {
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'a' }));
    expect(q.process({ budgetMs: 1_000 }).stoppedBy).toBe('drained');
  });

  it('still accepts a bare millisecond budget', () => {
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'a' }));
    expect(q.process(4).uploaded).toBe(1);
  });
});
