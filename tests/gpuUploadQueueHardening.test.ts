/**
 * Three ways the upload queue could hand the streaming path a corrupt or
 * unreadable answer, each pinned here.
 *
 * A throwing `commit` used to escape `process` after the pending bytes were
 * already subtracted but before the processed prefix was removed, so the queue
 * came back with bytes and items disagreeing and the same payload still in line
 * to be committed a second time.
 *
 * Nothing enforced item identity, so the same node decoded twice under one
 * generation could sit in the queue twice, be committed twice, and have its
 * payload released twice or not at all.
 *
 * The "first item always progresses" rule waived every limit for the head of
 * the queue, including a byte limit meant as a memory ceiling, so one absurdly
 * large node was admitted rather than refused.
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

/** A clock that advances by `perTick` ms every time it is READ, simulating work. */
function fakeClock(perTick: number) {
  let t = 0;
  return () => {
    const now = t;
    t += perTick;
    return now;
  };
}

const boom = () => {
  throw new Error('mesh build failed');
};

describe('a commit that throws (STREAM-007)', () => {
  it('keeps accounting exact when the FIRST item throws', () => {
    const onCommitError = vi.fn();
    const q = new GpuUploadQueue({ onCommitError });
    const onDiscard = vi.fn();
    const committed: string[] = [];
    q.enqueue(item({ id: 'a', commit: boom, onDiscard }));
    q.enqueue(item({ id: 'b', commit: () => committed.push('b') }));
    q.enqueue(item({ id: 'c', commit: () => committed.push('c') }));
    expect(q.pendingBytes).toBe(3_000);

    const r = q.process({ budgetMs: 1_000 });

    expect(committed).toEqual(['b', 'c']);
    expect(r.uploaded).toBe(2);
    expect(r.uploadedBytes).toBe(2_000);
    expect(r.failed).toBe(1);
    expect(r.discarded).toBe(1);
    expect(r.remaining).toBe(0);
    expect(q.pendingCount).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('commit-failed');
    expect(onCommitError).toHaveBeenCalledTimes(1);
  });

  it('keeps accounting exact when a MIDDLE item throws', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    const committed: string[] = [];
    q.enqueue(item({ id: 'a', commit: () => committed.push('a') }));
    q.enqueue(item({ id: 'b', commit: boom, onDiscard }));
    q.enqueue(item({ id: 'c', commit: () => committed.push('c') }));

    const r = q.process({ budgetMs: 1_000 });

    expect(committed).toEqual(['a', 'c']);
    expect(r.uploaded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('commit-failed');
  });

  it('keeps accounting exact when the FINAL item throws', () => {
    const q = new GpuUploadQueue();
    const onDiscard = vi.fn();
    const committed: string[] = [];
    q.enqueue(item({ id: 'a', commit: () => committed.push('a') }));
    q.enqueue(item({ id: 'b', commit: () => committed.push('b') }));
    q.enqueue(item({ id: 'c', commit: boom, onDiscard }));

    const r = q.process({ budgetMs: 1_000 });

    expect(committed).toEqual(['a', 'b']);
    expect(r.uploaded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(0);
    expect(q.pendingCount).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('commit-failed');
  });

  it('never lets the throw reach the render loop', () => {
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'a', commit: boom }));
    expect(() => q.process({ budgetMs: 1_000 })).not.toThrow();
  });

  it('removes the failed item exactly once, so a later pass cannot replay it', () => {
    const q = new GpuUploadQueue();
    const commit = vi.fn(boom);
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'a', commit, onDiscard }));

    const first = q.process({ budgetMs: 1_000 });
    const second = q.process({ budgetMs: 1_000 });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(first.failed).toBe(1);
    expect(second.failed).toBe(0);
    expect(second.uploaded).toBe(0);
    expect(q.pendingBytes).toBe(0);
  });

  it('leaves exact pending bytes when a limit stops the pass after a failure', () => {
    // The failure must not distort what the survivors are still charged for.
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'a', estBytes: 1_500, commit: boom }));
    q.enqueue(item({ id: 'b', estBytes: 2_000 }));
    q.enqueue(item({ id: 'c', estBytes: 700 }));

    const r = q.process({ budgetMs: 1_000, maxNodes: 1 });

    expect(r.failed).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(r.stoppedBy).toBe('nodes');
    expect(r.remaining).toBe(1);
    expect(q.pendingBytes).toBe(700);
  });

  it('holds the next item to the time budget after a failed attempt', () => {
    // A failed commit still spent the frame's one free admission, or a queue of
    // throwing items would walk past every limit in a single frame.
    const q = new GpuUploadQueue({ now: fakeClock(10) });
    const commitB = vi.fn();
    q.enqueue(item({ id: 'a', commit: boom }));
    q.enqueue(item({ id: 'b', commit: commitB }));

    const r = q.process({ budgetMs: 1 });

    expect(r.failed).toBe(1);
    expect(commitB).not.toHaveBeenCalled();
    expect(r.stoppedBy).toBe('time');
    expect(q.pendingBytes).toBe(1_000);
  });

  it('reports the error and the item it came from', () => {
    const seen: Array<{ error: unknown; id: string }> = [];
    const q = new GpuUploadQueue({
      onCommitError: (error, it) => seen.push({ error, id: it.id }),
    });
    const err = new Error('device lost');
    q.enqueue(item({ id: 'node-42', commit: () => { throw err; } }));

    q.process({ budgetMs: 1_000 });

    expect(seen).toEqual([{ error: err, id: 'node-42' }]);
  });

  it('survives a diagnostics hook that throws as well', () => {
    const q = new GpuUploadQueue({ onCommitError: boom });
    const commitB = vi.fn();
    q.enqueue(item({ id: 'a', commit: boom }));
    q.enqueue(item({ id: 'b', commit: commitB }));

    expect(() => q.process({ budgetMs: 1_000 })).not.toThrow();
    expect(commitB).toHaveBeenCalledTimes(1);
    expect(q.pendingBytes).toBe(0);
  });

  it('discarded is exactly stale + failed + oversized', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 5_000 });
    q.enqueue(item({ id: 'stale', generationId: 1 }));
    q.enqueue(item({ id: 'huge', generationId: 2, estBytes: 50_000 }));
    q.enqueue(item({ id: 'bad', generationId: 2, commit: boom }));
    q.enqueue(item({ id: 'good', generationId: 2 }));
    q.setGeneration('ds', 2);

    const r = q.process({ budgetMs: 1_000 });

    expect(r.stale).toBe(1);
    expect(r.oversized).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.discarded).toBe(3);
    expect(r.uploaded).toBe(1);
    expect(q.pendingBytes).toBe(0);
  });

  it('stays consistent when a commit clears the queue underneath it', () => {
    // A detach can land while a mesh is being built. The recorded contract is
    // narrow on purpose: no throw escapes, the committing payload keeps its one
    // outcome, everything else is released once, and nothing is left behind to
    // be committed a second time. Who is allowed to detach mid-commit is the
    // scheduler's lifecycle question, not the queue's.
    const q = new GpuUploadQueue();
    const discardB = vi.fn();
    const discardC = vi.fn();
    const commitA = vi.fn(() => { q.clear(); });
    const discardA = vi.fn();
    const commitB = vi.fn();
    q.enqueue(item({ id: 'a', commit: commitA, onDiscard: discardA }));
    q.enqueue(item({ id: 'b', commit: commitB, onDiscard: discardB }));
    q.enqueue(item({ id: 'c', onDiscard: discardC }));

    const r = q.process({ budgetMs: 1_000 });

    expect(commitA).toHaveBeenCalledTimes(1);
    expect(discardA).not.toHaveBeenCalled(); // committed, so not also discarded
    expect(commitB).not.toHaveBeenCalled();
    expect(discardB).toHaveBeenCalledExactlyOnceWith('queue-cleared');
    expect(discardC).toHaveBeenCalledExactlyOnceWith('queue-cleared');
    expect(r.uploaded).toBe(1);
    expect(q.pendingCount).toBe(0);
    expect(q.pendingBytes).toBe(0);
  });
});

describe('item identity and duplicates (STREAM-008)', () => {
  it('refuses a repeat of a pending identity and releases the newcomer', () => {
    const q = new GpuUploadQueue();
    const firstCommit = vi.fn();
    const firstDiscard = vi.fn();
    const secondCommit = vi.fn();
    const secondDiscard = vi.fn();

    expect(q.enqueue(item({ id: 'n1', commit: firstCommit, onDiscard: firstDiscard })))
      .toBe('accepted');
    expect(q.enqueue(item({ id: 'n1', commit: secondCommit, onDiscard: secondDiscard })))
      .toBe('duplicate');

    // The loser never occupies a slot and never charges bytes.
    expect(q.pendingCount).toBe(1);
    expect(q.pendingBytes).toBe(1_000);
    expect(secondDiscard).toHaveBeenCalledExactlyOnceWith('duplicate-item');
    expect(secondCommit).not.toHaveBeenCalled();

    q.process({ budgetMs: 1_000 });

    // The winner is the one that was already in line, committed once, never discarded.
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(firstDiscard).not.toHaveBeenCalled();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(secondDiscard).toHaveBeenCalledTimes(1);
  });

  it('releases every loser exactly once under a flood of repeats', () => {
    const q = new GpuUploadQueue();
    const discards: string[] = [];
    const commits = vi.fn();
    for (let n = 0; n < 5; n++) {
      q.enqueue(item({
        id: 'n1',
        commit: commits,
        onDiscard: (reason) => discards.push(`${n}:${reason}`),
      }));
    }
    expect(q.pendingCount).toBe(1);
    expect(q.pendingBytes).toBe(1_000);

    q.process({ budgetMs: 1_000 });

    expect(commits).toHaveBeenCalledTimes(1);
    expect(discards).toEqual([
      '1:duplicate-item',
      '2:duplicate-item',
      '3:duplicate-item',
      '4:duplicate-item',
    ]);
  });

  it('treats a different generation of the same node as a different item', () => {
    // Identity includes the generation, so a re-decode after a generation bump
    // is a new payload: it must queue, and the old one must go stale on its own.
    const q = new GpuUploadQueue();
    expect(q.enqueue(item({ id: 'n1', generationId: 1 }))).toBe('accepted');
    expect(q.enqueue(item({ id: 'n1', generationId: 2 }))).toBe('accepted');
    expect(q.pendingCount).toBe(2);

    q.setGeneration('ds', 2);
    const r = q.process({ budgetMs: 1_000 });
    expect(r.stale).toBe(1);
    expect(r.uploaded).toBe(1);
  });

  it('treats the same node id in another dataset as a different item', () => {
    const q = new GpuUploadQueue();
    expect(q.enqueue(item({ id: 'n1', datasetId: 'a' }))).toBe('accepted');
    expect(q.enqueue(item({ id: 'n1', datasetId: 'b' }))).toBe('accepted');
    expect(q.pendingCount).toBe(2);
  });

  it('frees the identity once the item commits, so a reload can queue again', () => {
    const q = new GpuUploadQueue();
    const second = vi.fn();
    q.enqueue(item({ id: 'n1' }));
    q.process({ budgetMs: 1_000 });

    expect(q.enqueue(item({ id: 'n1', commit: second }))).toBe('accepted');
    q.process({ budgetMs: 1_000 });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('frees the identity after a discard, whatever discarded it', () => {
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'n1' }));
    q.clear();
    expect(q.enqueue(item({ id: 'n1' }))).toBe('accepted');

    q.cancelDataset('ds');
    expect(q.enqueue(item({ id: 'n1' }))).toBe('accepted');

    q.enqueue(item({ id: 'n2', generationId: 1 }));
    q.setGeneration('ds', 9);
    q.process({ budgetMs: 1_000 }); // both dropped as stale
    expect(q.enqueue(item({ id: 'n1', generationId: 9 }))).toBe('accepted');
    expect(q.pendingCount).toBe(1);
  });

  it('frees the identity of a failed commit too', () => {
    // The payload is gone, so the node is allowed to be decoded and queued
    // again rather than being locked out by a failure it did not choose.
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'n1', commit: boom }));
    q.process({ budgetMs: 1_000 });
    expect(q.enqueue(item({ id: 'n1' }))).toBe('accepted');
    expect(q.pendingBytes).toBe(1_000);
  });
});

describe('hard per-item ceiling vs soft frame budget (STREAM-009)', () => {
  it('refuses an item past the hard ceiling instead of forcing it through', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 1_000_000 });
    const commit = vi.fn();
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'huge', estBytes: 50_000_000, commit, onDiscard }));

    const r = q.process({ budgetMs: 0, maxBytes: 1 });

    expect(commit).not.toHaveBeenCalled();
    expect(r.oversized).toBe(1);
    expect(r.discarded).toBe(1);
    expect(r.uploaded).toBe(0);
    expect(r.remaining).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('oversized-item');
  });

  it('cannot spin on an impossible item across repeated frames', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 1_000 });
    const onDiscard = vi.fn();
    q.enqueue(item({ id: 'huge', estBytes: 9_999, onDiscard }));

    const first = q.process({ budgetMs: 4 });
    const second = q.process({ budgetMs: 4 });
    const third = q.process({ budgetMs: 4 });

    expect(first.oversized).toBe(1);
    expect(second.oversized).toBe(0);
    expect(third.oversized).toBe(0);
    expect(q.pendingCount).toBe(0);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('still admits one item past the SOFT budget when it fits the ceiling', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 10_000 });
    const commit = vi.fn();
    q.enqueue(item({ id: 'big', estBytes: 9_000, commit }));

    const r = q.process({ budgetMs: 0, maxBytes: 1, maxNodes: 0 });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(r.uploaded).toBe(1);
    expect(r.oversized).toBe(0);
  });

  it('admits an item sitting exactly on the ceiling', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 4_000 });
    q.enqueue(item({ id: 'exact', estBytes: 4_000 }));
    expect(q.process({ budgetMs: 1_000 }).uploaded).toBe(1);
  });

  it('waives the soft budget for one item only', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 10_000 });
    q.enqueue(item({ id: 'a', estBytes: 4_000 }));
    q.enqueue(item({ id: 'b', estBytes: 4_000 }));

    const r = q.process({ budgetMs: 1_000, maxBytes: 1_000 });

    expect(r.uploaded).toBe(1);
    expect(r.stoppedBy).toBe('bytes');
    expect(r.remaining).toBe(1);
    expect(q.pendingBytes).toBe(4_000);
  });

  it('does not let a refused item consume the frame\'s one free admission', () => {
    // Refusing costs nothing, so the item behind it still gets the progress
    // guarantee. Otherwise one oversized head would starve the queue anyway,
    // which is the deadlock the bypass exists to prevent.
    const q = new GpuUploadQueue({ maxItemBytes: 10_000 });
    const commit = vi.fn();
    q.enqueue(item({ id: 'huge', estBytes: 999_999 }));
    q.enqueue(item({ id: 'normal', estBytes: 9_000, commit }));

    const r = q.process({ budgetMs: 0, maxBytes: 1 });

    expect(r.oversized).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(q.pendingCount).toBe(0);
  });

  it('leaves the ceiling off by default, so maxBytes alone keeps its old meaning', () => {
    // The soft budget must not silently become a memory ceiling for callers
    // that never asked for one.
    const q = new GpuUploadQueue();
    q.enqueue(item({ id: 'huge', estBytes: 50_000_000 }));
    const r = q.process({ budgetMs: 0, maxBytes: 1 });
    expect(r.uploaded).toBe(1);
    expect(r.oversized).toBe(0);
  });

  it('ignores a non-positive ceiling rather than refusing everything', () => {
    const q = new GpuUploadQueue({ maxItemBytes: 0 });
    q.enqueue(item({ id: 'a' }));
    expect(q.process({ budgetMs: 1_000 }).uploaded).toBe(1);
  });
});
