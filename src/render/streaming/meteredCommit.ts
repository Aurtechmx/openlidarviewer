/**
 * meteredCommit.ts
 *
 * The opt-in metered-commit driver for the streaming path. The queue itself
 * (gpuUploadQueue.ts) already decides WHEN and WHETHER a decoded node commits;
 * this module decides the two things around it that the queue leaves to the
 * caller: whether a queue exists at all this session, and what per-frame limits
 * to spend when one does. Both stay pure so the policy is unit-testable in Node
 * without a GPU, the same way `GpuUploadQueue` and `RenderActivityGate` are.
 *
 * Two modes, chosen once per session from the `streamingCommitMode` dev flag:
 *
 *  - `immediate` (default): no queue is built. The scheduler is handed empty
 *    options, so `_commitDecoded` takes the historical direct path and a decoded
 *    node becomes resident in the same turn it finished decoding. This is
 *    byte-for-byte the pre-flag behaviour, which is why it stays the default
 *    until browser measurement supports flipping it.
 *  - `metered`: a `GpuUploadQueue` is built and handed to the scheduler. A
 *    decoded node waits in `decoded` (in memory, not drawn) and only becomes
 *    resident when `pump()` commits it, spreading a burst of decodes across
 *    several frames instead of building every mesh in one hitchy one.
 *
 * The correctness rules the metered path must keep live in the pieces it reuses,
 * not here: picking and measurement read the renderer's resident meshes, and a
 * mesh is added only from the scheduler's commit closure, so a queued-but-
 * uncommitted node is never pickable (see `isPickableNodeState`). Cancellation,
 * close/reset draining, staleness, and one-terminal-outcome-per-node all belong
 * to `GpuUploadQueue`; this driver only forwards `clear`/`cancel` to it.
 */

import {
  GpuUploadQueue,
  adaptiveUploadBudgetMs,
  DEFAULT_FRAME_BUDGET_MS,
  MOBILE_FRAME_BUDGET_MS,
  type UploadLimits,
  type UploadProcessResult,
} from '../gpuUploadQueue';
import type { SchedulerOptions } from './StreamingScheduler';
import type { NodeState } from './StreamingNode';
import type { StreamingBenchmark } from './streamingBenchmark';
import type { StreamingCommitMode } from '../../perf/devFlags';

export type { StreamingCommitMode };

/** The dataset id the driver keys its single queue on (one queue per session). */
export const METERED_DATASET_ID = 'streaming';

/**
 * A streaming node contributes to picking and measurement only once it is
 * committed, i.e. `resident`. `decoded` is the metered path's in-memory-but-
 * not-drawn state, and a click must never land on a node the user cannot see.
 * The Viewer's pick loop already enforces this structurally (it walks resident
 * meshes, and a mesh exists only after the commit closure ran), so this
 * predicate is the same rule written down where a test can pin it.
 */
export function isPickableNodeState(state: NodeState): boolean {
  return state === 'resident';
}

/**
 * The per-frame commit limits, before this frame's pressure is folded in. All
 * three are soft (the queue lets one item per pass overshoot so it always makes
 * progress); the point of bounding them is to cap what the NEXT frame has to
 * absorb, not to stall the queue.
 */
export interface MeteredCommitConfig {
  /** Base upload time budget per frame, ms. Shrinks under frame pressure. */
  readonly baseBudgetMs: number;
  /** Node commits per frame. Bounds mesh builds on the main thread. */
  readonly maxNodesPerFrame: number;
  /** GPU bytes committed per frame. Bounds what the next render must upload. */
  readonly maxBytesPerFrame: number;
  /** Backpressure ceiling for pending GPU bytes held in the queue. */
  readonly maxPendingBytes: number;
}

const MIB = 1024 * 1024;

/**
 * Desktop / mobile commit tunables. Mobile keeps a tighter time and byte budget
 * because its frame headroom is smaller; the node cap stays low on both so a
 * single frame never fans out into a dozen mesh builds. Deliberately not tied
 * to `streamingBudgets` point counts: those size residency, these size the
 * per-frame upload pipe, and conflating them is how a byte budget ends up
 * expressed in points.
 */
export function meteredCommitConfig(isMobile: boolean): MeteredCommitConfig {
  return isMobile
    ? { baseBudgetMs: MOBILE_FRAME_BUDGET_MS, maxNodesPerFrame: 2, maxBytesPerFrame: 3 * MIB, maxPendingBytes: 24 * MIB }
    : { baseBudgetMs: DEFAULT_FRAME_BUDGET_MS, maxNodesPerFrame: 4, maxBytesPerFrame: 8 * MIB, maxPendingBytes: 64 * MIB };
}

/**
 * This frame's upload limits. When a real frame time is known, the base budget
 * shrinks proportionally to how far the last frame ran over target, so a queue
 * drain never deepens a stall it is meant to smooth. Node and byte caps are
 * frame-independent. Pure.
 */
export function frameUploadLimits(cfg: MeteredCommitConfig, frameMs?: number): UploadLimits {
  const budgetMs =
    frameMs !== undefined && frameMs > 0
      ? adaptiveUploadBudgetMs(cfg.baseBudgetMs, frameMs)
      : cfg.baseBudgetMs;
  return { budgetMs, maxBytes: cfg.maxBytesPerFrame, maxNodes: cfg.maxNodesPerFrame };
}

/** A snapshot of the driver's live metrics, for telemetry and the debug overlay. */
export interface MeteredCommitMetrics {
  readonly mode: StreamingCommitMode;
  /** Nodes waiting to commit right now. Always 0 in immediate mode. */
  readonly pendingNodes: number;
  /** Estimated GPU bytes waiting to commit right now. */
  readonly pendingBytes: number;
  /** Nodes committed by the most recent `pump`. */
  readonly committedThisFrame: number;
  /** GPU bytes committed by the most recent `pump`. */
  readonly committedBytesThisFrame: number;
  /** Nodes committed across the whole session. */
  readonly committedTotal: number;
  /** GPU bytes committed across the whole session. */
  readonly committedBytesTotal: number;
  /** Deepest backlog seen at the start of any pump this session. */
  readonly peakPendingNodes: number;
  /** What ended the last pass, or `idle` before the first metered pump. */
  readonly lastStoppedBy: UploadProcessResult['stoppedBy'] | 'idle';
}

/**
 * The session's commit driver. Owns the queue in metered mode, or nothing in
 * immediate mode; either way the Viewer holds one of these and drives it the
 * same, so the render loop carries no mode branch.
 */
export interface StreamingCommit {
  readonly mode: StreamingCommitMode;
  /** The queue, or undefined in immediate mode. Exposed for tests and telemetry. */
  readonly queue: GpuUploadQueue | undefined;
  /** Options for the scheduler: the queue + dataset id when metered, `{}` when immediate. */
  schedulerOptions(): SchedulerOptions;
  /** Commit a bounded set this frame. No-op returning null in immediate mode. */
  pump(frameMs?: number): UploadProcessResult | null;
  /** Live metrics snapshot. */
  metrics(): MeteredCommitMetrics;
  /** Drop every pending commit (dataset close / reset). Returns the count dropped. */
  clear(): number;
  /** Drop pending commits for this session's dataset. Returns the count dropped. */
  cancel(): number;
}

/**
 * Build the driver for `mode`. In immediate mode the returned object is inert:
 * `schedulerOptions()` is `{}`, `pump()` returns null, and the metrics read
 * zero, so wiring it in changes nothing the scheduler or render loop does.
 */
export function makeStreamingCommit(
  mode: StreamingCommitMode,
  isMobile: boolean,
  benchmark: StreamingBenchmark | null = null,
): StreamingCommit {
  if (mode !== 'metered') {
    return {
      mode: 'immediate',
      queue: undefined,
      schedulerOptions: () => ({}),
      pump: () => null,
      metrics: () => ({
        mode: 'immediate',
        pendingNodes: 0,
        pendingBytes: 0,
        committedThisFrame: 0,
        committedBytesThisFrame: 0,
        committedTotal: 0,
        committedBytesTotal: 0,
        peakPendingNodes: 0,
        lastStoppedBy: 'idle',
      }),
      clear: () => 0,
      cancel: () => 0,
    };
  }

  const cfg = meteredCommitConfig(isMobile);
  const queue = new GpuUploadQueue({ maxPendingBytes: cfg.maxPendingBytes });
  let committedTotal = 0;
  let committedBytesTotal = 0;
  let committedThisFrame = 0;
  let committedBytesThisFrame = 0;
  let peakPendingNodes = 0;
  let lastStoppedBy: MeteredCommitMetrics['lastStoppedBy'] = 'idle';

  return {
    mode: 'metered',
    queue,
    schedulerOptions: () => ({ uploadQueue: queue, datasetId: METERED_DATASET_ID }),
    pump(frameMs?: number): UploadProcessResult {
      // Backlog is deepest right as a burst of decodes lands, so the peak is
      // read before the pass drains it.
      const backlog = queue.pendingCount;
      if (backlog > peakPendingNodes) peakPendingNodes = backlog;
      const res = queue.process(frameUploadLimits(cfg, frameMs));
      committedThisFrame = res.uploaded;
      committedBytesThisFrame = res.uploadedBytes;
      committedTotal += res.uploaded;
      committedBytesTotal += res.uploadedBytes;
      lastStoppedBy = res.stoppedBy;
      benchmark?.recordCommitPass({
        pendingNodes: queue.pendingCount,
        pendingBytes: queue.pendingBytes,
        committed: res.uploaded,
      });
      return res;
    },
    metrics: () => ({
      mode: 'metered',
      pendingNodes: queue.pendingCount,
      pendingBytes: queue.pendingBytes,
      committedThisFrame,
      committedBytesThisFrame,
      committedTotal,
      committedBytesTotal,
      peakPendingNodes,
      lastStoppedBy,
    }),
    clear: () => queue.clear(),
    cancel: () => queue.cancelDataset(METERED_DATASET_ID),
  };
}
