/**
 * Unit tests for the metered-commit driver (src/render/streaming/meteredCommit.ts).
 *
 * The driver is the small piece of policy around the already-tested
 * GpuUploadQueue: whether a queue exists this session (the mode) and what
 * per-frame limits to spend when one does. These tests pin the two things the
 * task's correctness rules turn on, without a GPU:
 *
 *   - immediate mode is INERT, so wiring the flag in changes nothing when it is
 *     left at its default (the release-safety guarantee);
 *   - metered mode drains to empty, respects per-frame node and byte budgets,
 *     commits FIFO, starves no node, and forwards cancel / clear to the queue;
 *   - a queued-but-uncommitted node is not pickable.
 *
 * The metered tests enqueue synthetic upload items straight onto the driver's
 * real queue and record commit order in an array, so they exercise the exact
 * queue the production commit path uses.
 */

import { describe, expect, it } from 'vitest';

import {
  makeStreamingCommit,
  meteredCommitConfig,
  frameUploadLimits,
  isPickableNodeState,
  METERED_DATASET_ID,
  type StreamingCommit,
} from '../src/render/streaming/meteredCommit';
import { DEFAULT_FRAME_BUDGET_MS, MOBILE_FRAME_BUDGET_MS, MIN_FRAME_BUDGET_MS } from '../src/render/gpuUploadQueue';
import { StreamingBenchmark } from '../src/render/streaming/streamingBenchmark';
import type { NodeState } from '../src/render/streaming/StreamingNode';

const MIB = 1024 * 1024;

/** Enqueue a fake decoded node whose `commit` records its id, in FIFO order. */
function enqueue(commit: StreamingCommit, id: string, order: string[], estBytes = 100): void {
  const q = commit.queue;
  if (!q) throw new Error('no queue in immediate mode');
  q.enqueue({
    id,
    datasetId: METERED_DATASET_ID,
    generationId: 0,
    estBytes,
    commit: () => order.push(id),
    onDiscard: () => order.push(`discard:${id}`),
  });
}

describe('immediate mode is inert (release-safety parity)', () => {
  it('hands the scheduler empty options, exactly as the pre-flag path', () => {
    const commit = makeStreamingCommit('immediate', false);
    expect(commit.mode).toBe('immediate');
    expect(commit.queue).toBeUndefined();
    // `{}` is what the scheduler constructor defaults to when no options are
    // passed, so an immediate session builds a scheduler identical to origin/main.
    expect(commit.schedulerOptions()).toEqual({});
  });

  it('pump is a no-op and every metric reads zero', () => {
    const commit = makeStreamingCommit('immediate', false);
    expect(commit.pump(9999)).toBeNull();
    expect(commit.clear()).toBe(0);
    expect(commit.cancel()).toBe(0);
    expect(commit.metrics()).toEqual({
      mode: 'immediate',
      pendingNodes: 0,
      pendingBytes: 0,
      committedThisFrame: 0,
      committedBytesThisFrame: 0,
      committedTotal: 0,
      committedBytesTotal: 0,
      peakPendingNodes: 0,
      lastStoppedBy: 'idle',
    });
  });

  it('an unknown mode string falls back to immediate, never stands a queue up', () => {
    // Defence in depth: only the exact 'metered' builds a queue.
    const commit = makeStreamingCommit('nonsense' as 'immediate', false);
    expect(commit.mode).toBe('immediate');
    expect(commit.queue).toBeUndefined();
  });
});

describe('metered mode wiring', () => {
  it('hands the scheduler the queue it drives, keyed on the session dataset id', () => {
    const commit = makeStreamingCommit('metered', false);
    expect(commit.mode).toBe('metered');
    expect(commit.queue).toBeDefined();
    const opts = commit.schedulerOptions();
    expect(opts.uploadQueue).toBe(commit.queue);
    expect(opts.datasetId).toBe(METERED_DATASET_ID);
  });
});

describe('metered draining, budgets, FIFO order', () => {
  it('drains to empty across repeated pumps', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) enqueue(commit, `n${i}`, order);
    expect(commit.metrics().pendingNodes).toBe(10);

    let guard = 0;
    while (commit.metrics().pendingNodes > 0 && guard++ < 100) commit.pump();

    expect(commit.metrics().pendingNodes).toBe(0);
    expect(order).toHaveLength(10);
    expect(commit.metrics().committedTotal).toBe(10);
  });

  it('commits FIFO — enqueue order is commit order', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    for (const id of ['a', 'b', 'c']) enqueue(commit, id, order);
    // Desktop cap is 4 nodes/frame, so all three land in one deterministic pass.
    commit.pump();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('respects the per-frame node budget', () => {
    const commit = makeStreamingCommit('metered', false);
    const cap = meteredCommitConfig(false).maxNodesPerFrame;
    const order: string[] = [];
    for (let i = 0; i < cap + 3; i++) enqueue(commit, `n${i}`, order);

    const res = commit.pump();
    expect(res?.uploaded).toBe(cap);
    expect(res?.stoppedBy).toBe('nodes');
    expect(commit.metrics().pendingNodes).toBe(3);
    // Deterministic prefix: the cap's worth of nodes, in enqueue order.
    expect(order).toEqual(Array.from({ length: cap }, (_, i) => `n${i}`));
  });

  it('respects the per-frame byte budget (soft: one overshoot to guarantee progress)', () => {
    const commit = makeStreamingCommit('metered', false);
    const maxBytes = meteredCommitConfig(false).maxBytesPerFrame;
    const big = Math.floor(maxBytes * 0.4); // two fit, the third would exceed
    const order: string[] = [];
    for (let i = 0; i < 5; i++) enqueue(commit, `big${i}`, order, big);

    const res = commit.pump();
    expect(res?.stoppedBy).toBe('bytes');
    // First commit is exempt from the byte cap so the queue always progresses;
    // after it, the cap governs. 0.4 + 0.4 = 0.8 fits, a third would be 1.2.
    expect(res?.uploaded).toBe(2);
    expect(res?.uploadedBytes).toBeLessThanOrEqual(2 * big);
  });

  it('starves no node: under a shrunk budget, every enqueued node still commits', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    for (const id of ids) enqueue(commit, id, order, MIB);

    // A large frameMs shrinks the per-frame time budget toward the floor, the
    // worst case for starvation. Repeated pumps must still commit them all.
    let guard = 0;
    while (commit.metrics().pendingNodes > 0 && guard++ < 500) commit.pump(1000);

    expect(order).toEqual(ids); // all, in order, none dropped
    expect(commit.metrics().committedTotal).toBe(25);
  });
});

describe('cancellation and close/reset', () => {
  it('cancel removes queued items without committing them', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    for (let i = 0; i < 5; i++) enqueue(commit, `c${i}`, order);

    expect(commit.cancel()).toBe(5);
    expect(commit.metrics().pendingNodes).toBe(0);
    expect(commit.metrics().pendingBytes).toBe(0);
    // Nothing committed; each dropped item took its discard path exactly once.
    expect(order).toEqual(['discard:c0', 'discard:c1', 'discard:c2', 'discard:c3', 'discard:c4']);
    commit.pump();
    expect(commit.metrics().committedTotal).toBe(0);
  });

  it('clear drops everything pending (dataset close / reset)', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    for (let i = 0; i < 5; i++) enqueue(commit, `x${i}`, order, MIB);
    expect(commit.metrics().pendingBytes).toBe(5 * MIB);

    expect(commit.clear()).toBe(5);
    expect(commit.metrics().pendingNodes).toBe(0);
    expect(commit.metrics().pendingBytes).toBe(0);
    expect(order.every((e) => e.startsWith('discard:'))).toBe(true);
  });
});

describe('metrics and telemetry', () => {
  it('metered pump feeds the streaming benchmark', () => {
    const benchmark = new StreamingBenchmark();
    const commit = makeStreamingCommit('metered', false, benchmark);
    const order: string[] = [];
    for (let i = 0; i < 3; i++) enqueue(commit, `b${i}`, order);

    commit.pump();

    const up = benchmark.uploadCounters();
    expect(up.nodesCommitted).toBe(3);
    expect(up.committedPerFrame.count).toBe(1);
    expect(up.peakPendingNodes).toBe(0); // all three drained in the one pass
    const m = commit.metrics();
    expect(m.committedTotal).toBe(3);
    expect(m.committedThisFrame).toBe(3);
    expect(m.lastStoppedBy).toBe('drained');
  });

  it('peak backlog reflects the deepest queue seen at pump time', () => {
    const commit = makeStreamingCommit('metered', false);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) enqueue(commit, `p${i}`, order);
    // 10 pending, desktop cap 4: first pump sees a backlog of 10.
    commit.pump();
    expect(commit.metrics().peakPendingNodes).toBe(10);
  });

  it('an immediate driver never records into the benchmark', () => {
    const benchmark = new StreamingBenchmark();
    const commit = makeStreamingCommit('immediate', false, benchmark);
    commit.pump();
    expect(benchmark.uploadCounters().nodesCommitted).toBe(0);
    expect(benchmark.uploadCounters().committedPerFrame.count).toBe(0);
  });
});

describe('picking predicate excludes uncommitted nodes', () => {
  it('only a resident (committed) node is pickable', () => {
    expect(isPickableNodeState('resident')).toBe(true);
    // `decoded` is the metered in-memory-but-not-drawn state — never pickable.
    const notPickable: NodeState[] = ['unloaded', 'queued', 'loading', 'decoded', 'error'];
    for (const state of notPickable) expect(isPickableNodeState(state)).toBe(false);
  });
});

describe('per-frame limit policy (pure)', () => {
  it('uses the base budget when no frame time is known', () => {
    const cfg = meteredCommitConfig(false);
    const limits = frameUploadLimits(cfg);
    expect(limits.budgetMs).toBe(DEFAULT_FRAME_BUDGET_MS);
    expect(limits.maxNodes).toBe(cfg.maxNodesPerFrame);
    expect(limits.maxBytes).toBe(cfg.maxBytesPerFrame);
  });

  it('shrinks the time budget under frame pressure, never below the floor', () => {
    const cfg = meteredCommitConfig(false);
    const easy = frameUploadLimits(cfg, 8); // under a 16.7ms target: no shrink
    expect(easy.budgetMs).toBe(cfg.baseBudgetMs);
    const hard = frameUploadLimits(cfg, 100); // well over target: shrink
    expect(hard.budgetMs).toBeLessThan(cfg.baseBudgetMs);
    expect(hard.budgetMs).toBeGreaterThanOrEqual(MIN_FRAME_BUDGET_MS);
  });

  it('mobile keeps a tighter budget than desktop', () => {
    const mobile = meteredCommitConfig(true);
    const desktop = meteredCommitConfig(false);
    expect(mobile.baseBudgetMs).toBe(MOBILE_FRAME_BUDGET_MS);
    expect(desktop.baseBudgetMs).toBe(DEFAULT_FRAME_BUDGET_MS);
    expect(mobile.maxNodesPerFrame).toBeLessThanOrEqual(desktop.maxNodesPerFrame);
    expect(mobile.maxBytesPerFrame).toBeLessThan(desktop.maxBytesPerFrame);
  });
});
