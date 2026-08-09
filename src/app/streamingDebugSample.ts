/**
 * streamingDebugSample.ts — build the streaming section of the debug overlay's
 * per-frame snapshot, lifted out of the composition root.
 *
 * A pure read: it reads the live streaming cloud / scheduler (and the optional
 * benchmark) and returns a plain {@link StreamingDebugStats}, or null before the
 * lazy Viewer chunk has resolved or when no streaming source is mounted. No
 * mutation, no DOM — the overlay owns rendering.
 */

import type { StreamingDebugStats } from '../ui/DebugOverlay';
import type { Viewer } from '../render/Viewer';
import type { StreamingBenchmark } from '../render/streaming/streamingBenchmark';
import { estimateDecodedBytes, estimateGpuBytes } from '../render/streaming/streamingBudget';

export interface StreamingDebugDeps {
  /** True once the lazy Viewer chunk has resolved (the overlay polls before that). */
  isViewerReady(): boolean;
  /** The live viewer — only read when {@link isViewerReady} is true. */
  getViewer(): Viewer;
  /** The active streaming benchmark, or null when not collecting. */
  getBenchmark(): StreamingBenchmark | null;
}

/** Snapshot the streaming counters for the debug overlay, or null when unavailable. */
export function sampleStreamingDebug(deps: StreamingDebugDeps): StreamingDebugStats | null {
  if (!deps.isViewerReady()) return null;
  const viewer = deps.getViewer();
  const cloud = viewer.streamingCloud;
  const scheduler = viewer.streamingScheduler;
  if (!cloud || !scheduler) return null;
  const counts = cloud.counts();
  const stats = scheduler.stats();
  const cs = scheduler.cacheStats();
  const sample: StreamingDebugStats = {
    knownNodes: counts.known,
    visibleNodes: stats.visible,
    queuedNodes: stats.queued,
    loadingNodes: stats.loading,
    residentNodes: counts.resident,
    displayedPoints: cloud.residentPointCount,
    sourcePoints: cloud.sourcePointCount,
    cacheBytes: cs.byteSize,
    decodedBytes: estimateDecodedBytes(cloud.residentPointCount),
    gpuBytes: estimateGpuBytes(cloud.residentPointCount),
    schedulerMs: stats.lastTickMs,
    cacheHits: cs.hits,
    cacheMisses: cs.misses,
    cacheEvictions: cs.evictions,
  };
  const benchmark = deps.getBenchmark();
  if (benchmark) {
    sample.thrashEvents = benchmark.thrashEvents;
    const tier = benchmark.tierCounters();
    sample.nodesReady = tier.nodesReady;
    sample.nodesEvicted = tier.nodesEvicted;
    const recent = benchmark.recentSchedulerTickStats(60);
    if (recent.count > 0) {
      sample.schedulerRecent = { count: recent.count, p50: recent.p50, p95: recent.p95, max: recent.max };
    }
    // Metered-commit backlog. Absent in the default immediate mode, where no
    // upload queue runs and the driver never records a pass — so the overlay
    // shows this line only once metering is actually committing.
    const up = benchmark.uploadCounters();
    if (up.committedPerFrame.count > 0 || up.pendingNodes > 0) {
      sample.commitPending = up.pendingNodes;
      sample.commitPendingBytes = up.pendingBytes;
      sample.nodesCommitted = up.nodesCommitted;
    }
  }
  return sample;
}
