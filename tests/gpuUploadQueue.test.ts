/**
 * gpuUploadQueue.test.ts
 *
 * Pins the P7 upload queue: the per-frame time budget is honoured (with a
 * deterministic injected clock), at least one item always makes progress, stale
 * (superseded-generation) items are discarded without upload, cancellation and
 * pending-byte accounting are correct, and the adaptive budget shrinks under
 * frame pressure.
 */

import { describe, it, expect } from 'vitest';
import {
  GpuUploadQueue,
  adaptiveUploadBudgetMs,
  MIN_FRAME_BUDGET_MS,
  type UploadItem,
} from '../src/render/gpuUploadQueue';

/** A clock that advances by `perTick` ms every time it is READ, simulating work. */
function fakeClock(perTick: number) {
  let t = 0;
  return () => {
    const now = t;
    t += perTick;
    return now;
  };
}

function item(
  id: string,
  onCommit: () => void,
  opts: { datasetId?: string; generationId?: number; estBytes?: number } = {},
): UploadItem {
  return {
    id,
    datasetId: opts.datasetId ?? 'ds',
    generationId: opts.generationId ?? 1,
    estBytes: opts.estBytes ?? 1000,
    commit: onCommit,
  };
}

describe('GpuUploadQueue.process — time budget', () => {
  it('uploads only as many items as fit the per-frame budget', () => {
    // Clock advances 3 ms per read; budget 4 ms. First upload is free (uploaded=0),
    // then each budget check reads the clock. Two items should upload, one remains.
    const q = new GpuUploadQueue({ now: fakeClock(3) });
    const committed: string[] = [];
    for (const id of ['a', 'b', 'c']) q.enqueue(item(id, () => committed.push(id)));
    const r = q.process(4);
    expect(r.uploaded).toBe(2);
    expect(committed).toEqual(['a', 'b']);
    expect(r.remaining).toBe(1);
    expect(q.pendingCount).toBe(1);
  });

  it('always makes progress on at least one item, even with a zero budget', () => {
    const q = new GpuUploadQueue({ now: fakeClock(100) });
    let n = 0;
    q.enqueue(item('a', () => { n++; }));
    q.enqueue(item('b', () => { n++; }));
    const r = q.process(0);
    expect(r.uploaded).toBe(1);
    expect(n).toBe(1);
  });

  it('drains the whole queue across successive frames', () => {
    const q = new GpuUploadQueue({ now: fakeClock(3) });
    const committed: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) q.enqueue(item(id, () => committed.push(id)));
    while (q.pendingCount > 0) q.process(4);
    expect(committed).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('GpuUploadQueue — staleness & cancellation', () => {
  it('discards items from a superseded generation without uploading them', () => {
    const q = new GpuUploadQueue({ now: fakeClock(0) });
    let uploads = 0;
    q.enqueue(item('old', () => { uploads++; }, { generationId: 1 }));
    q.enqueue(item('new', () => { uploads++; }, { generationId: 2 }));
    q.setGeneration('ds', 2); // gen 1 is now stale
    const r = q.process(100);
    expect(uploads).toBe(1); // only the current-generation item uploaded
    expect(r.discarded).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(q.pendingBytes).toBe(0);
  });

  it('cancelDataset drops all of a dataset\'s pending items and its bytes', () => {
    const q = new GpuUploadQueue();
    q.enqueue(item('a', () => {}, { datasetId: 'x', estBytes: 500 }));
    q.enqueue(item('b', () => {}, { datasetId: 'y', estBytes: 700 }));
    q.enqueue(item('c', () => {}, { datasetId: 'x', estBytes: 300 }));
    expect(q.pendingBytes).toBe(1500);
    expect(q.cancelDataset('x')).toBe(2);
    expect(q.pendingCount).toBe(1);
    expect(q.pendingBytes).toBe(700);
  });
});

describe('GpuUploadQueue — backpressure', () => {
  it('reports saturation once pending bytes hit the ceiling', () => {
    const q = new GpuUploadQueue({ maxPendingBytes: 1000 });
    q.enqueue(item('a', () => {}, { estBytes: 600 }));
    expect(q.isSaturated()).toBe(false);
    q.enqueue(item('b', () => {}, { estBytes: 600 }));
    expect(q.isSaturated()).toBe(true);
  });
});

describe('adaptiveUploadBudgetMs', () => {
  it('returns the base budget when frames are on time', () => {
    expect(adaptiveUploadBudgetMs(4, 10, 1000 / 60)).toBe(4);
  });
  it('shrinks proportionally under frame pressure', () => {
    // Frame took twice the target → half the budget.
    expect(adaptiveUploadBudgetMs(4, (1000 / 60) * 2, 1000 / 60)).toBeCloseTo(2, 6);
  });
  it('never shrinks below the floor', () => {
    expect(adaptiveUploadBudgetMs(4, 10_000, 1000 / 60)).toBe(MIN_FRAME_BUDGET_MS);
  });
});
