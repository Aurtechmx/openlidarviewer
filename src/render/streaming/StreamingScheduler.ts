/**
 * StreamingScheduler.ts
 *
 * The view-dependent COPC streaming scheduler. Each `update` it culls the
 * octree against the camera frustum, scores the visible nodes coarse-first,
 * selects the set that fits the point budget, enqueues the missing nodes,
 * evicts the surplus, and dispatches a bounded number of decodes.
 *
 * Deliberately three.js-free: it takes a plain view-projection matrix and
 * camera position (the Viewer extracts those), and decodes through the
 * `ChunkDecoder` interface — so the whole scheduler is unit-tested in Node
 * with a synthetic COPC and a fake decoder.
 */

import type { Box6, VoxelKey } from '../../io/copc/copcTypes';
import type { ChunkDecoder, DecodedChunk } from '../../io/copc/copcChunkDecode';
import type { StreamingSource } from './StreamingSource';
import type { StreamingNode } from './StreamingNode';
import {
  frustumPlanesFromViewProjection,
  boxInFrustum,
  nodeScore,
  depthCapForVelocity,
} from './streamingScore';
import { selectWithinBudget } from './streamingBudget';
import type { StreamingBudgets, ScoredCandidate } from './streamingBudget';
import { CompressedChunkCache } from './StreamingCache';

/** Renderer-facing callbacks the scheduler drives. */
export interface SchedulerCallbacks {
  /** A node decoded and is ready to upload to the GPU. */
  onNodeReady(node: StreamingNode, decoded: DecodedChunk): void;
  /** A node left the working set — drop its GPU mesh. */
  onNodeEvicted(node: StreamingNode): void;
  /** Node counts changed — a hint to refresh streaming UI. */
  onChange?(): void;
  /**
   * One scheduling pass finished — `ms` is the wall time of that pass. Used
   * by the streaming benchmark to build a tick-time histogram.
   */
  onTick?(ms: number): void;
}

/** The camera view for one scheduling pass, in local render space. */
export interface SchedulerView {
  /** Column-major view-projection matrix (16 numbers). */
  viewProjection: ArrayLike<number>;
  /** Camera position. */
  cameraPosition: [number, number, number];
}

/** Live scheduler counters for diagnostics. */
export interface SchedulerStats {
  /** Nodes inside the frustum at the last tick. */
  visible: number;
  queued: number;
  loading: number;
  /** Wall time of the most recent `update`, in milliseconds. */
  lastTickMs: number;
  /** Smoothed linear camera velocity, world units per second. */
  cameraVelocity: number;
  /** True when the camera has been "stable" long enough to fully refine. */
  isStable: boolean;
  /** Concurrent-decode budget applied this tick (≤ configured maxConcurrent). */
  effectiveMaxConcurrent: number;
  /**
   * Task 15 — pressure-adaptation depth reduction applied this tick.
   * 0 = no pressure, refining at full depth cap;
   * positive = depth cap reduced by this many levels under sustained pressure.
   */
  pressureDepthReduction: number;
  /**
   * Task 10 (v0.3.2) — number of full octree rescores since session start.
   * The stable-camera fast path reuses the last tick's wanted set when the
   * scheduling signature (frustum + camera position + depth cap + budget +
   * pressure reduction) is unchanged; this counter increments only when a
   * full rescore actually runs. A stable camera should see this counter
   * stay flat across many ticks, with at most one bump every
   * `FORCED_RESCORE_INTERVAL_TICKS` to flush any cached-state drift.
   */
  fullRescoreCount: number;
}

/** The deepest octree level the scheduler will descend to when still. */
const BASE_DEPTH_CAP = 18;

/**
 * Phase 3 Task 9 — camera-motion awareness. The scheduler watches a
 * smoothed linear-velocity signal; while the camera is moving "fast" it
 * favours coarser nodes (via `depthCapForVelocity`) and halves its
 * concurrent-decode budget so a flick-and-stop never queues up megabytes
 * of decode work for nodes that are no longer wanted. Settling back to
 * the stable regime is deferred by `STABLE_SETTLE_MS` to absorb a brief
 * pause inside a longer motion.
 */
const VELOCITY_FAST_THRESHOLD = 10;
const STABLE_SETTLE_MS = 250;
const FAST_CONCURRENCY_FACTOR = 0.5;
/** EWMA time constant (seconds) — velocity sample weight halves at ~τ ms. */
const VELOCITY_EWMA_TAU_S = 0.2;

/**
 * How long a node that just left the wanted-set is kept resident before
 * eviction. Short enough that memory stays bounded, long enough to absorb
 * the camera-flick load → evict → reload cycle that wastes a re-download.
 */
const DEFAULT_EVICT_DEFER_MS = 2_000;

/**
 * Resident-point budget multiplier at which deferred-eviction nodes are
 * dropped *immediately* regardless of hysteresis — memory pressure wins.
 */
const DEFAULT_MEMORY_PRESSURE_RATIO = 1.5;

/**
 * Task 15 — pressure adaptation. When the resident point count stays above
 * `PRESSURE_HIGH_RATIO × pointBudget` for at least `PRESSURE_HIGH_HOLD_MS`,
 * the scheduler lowers its target refinement by `PRESSURE_DEPTH_REDUCTION`
 * levels. When it falls below `PRESSURE_LOW_RATIO × pointBudget` for at
 * least `PRESSURE_LOW_HOLD_MS`, the reduction is released. The hysteresis
 * band between the two ratios prevents oscillation around the threshold.
 */
const PRESSURE_HIGH_RATIO = 0.9;
const PRESSURE_HIGH_HOLD_MS = 1_000;
const PRESSURE_LOW_RATIO = 0.7;
const PRESSURE_LOW_HOLD_MS = 2_000;
const PRESSURE_DEPTH_REDUCTION = 1;

/**
 * Task 10 (v0.3.2) — stable-camera fast path.
 *
 * The scheduling signature is the tuple `(viewProjection, cameraPosition,
 * depthCap, pointBudget, pressureDepthReduction)`. When every component is
 * bit-equal to the prior tick's, the rescore loop and the sort are skipped
 * and the cached `_lastWanted` set is reused — the heaviest per-tick work
 * vanishes the moment the camera settles, which is most of the time in a
 * working inspection session. The eviction state machine still runs each
 * tick because it depends on wall-clock time, not on the signature.
 *
 * A periodic forced rescore (`FORCED_RESCORE_INTERVAL_TICKS`) re-walks the
 * octree even when the signature is stable, so any drift from external
 * mutation (a newly discovered child page, a newly resident node coming
 * online from a prior decode) is reflected. The interval is generous —
 * once a second at 60 fps — because the eviction machinery already covers
 * the per-tick reactive paths.
 */
const FORCED_RESCORE_INTERVAL_TICKS = 60;

/** Per-scheduler tunables — defaulted, injected for unit tests. */
export interface SchedulerOptions {
  /** Hysteresis window for eviction, ms. */
  evictDeferMs?: number;
  /** Total / budget threshold above which deferred nodes are evicted now. */
  memoryPressureRatio?: number;
  /** Monotonic clock, injected for deterministic tests. */
  now?: () => number;
}

/** Compact key for an ancestor-protection set — `${depth}/${x}/${y}/${z}`. */
function voxelKeyString(k: VoxelKey): string {
  return `${k.depth}/${k.x}/${k.y}/${k.z}`;
}

/**
 * The compact key of a voxel's parent, or `null` for the root. Children at
 * depth d collapse to their parent at depth d-1 by right-shifting each axis
 * coordinate — the COPC hierarchy is a regular octree.
 */
function parentKeyString(k: VoxelKey): string | null {
  if (k.depth === 0) return null;
  return `${k.depth - 1}/${k.x >> 1}/${k.y >> 1}/${k.z >> 1}`;
}

/**
 * Build the set of *ancestor* keys of every resident node. A node whose own
 * key appears in this set is a parent of at least one resident node, and
 * Task 8 protects it from eviction until its descendants leave too.
 */
function buildAncestorProtection(nodes: readonly StreamingNode[]): Set<string> {
  const set = new Set<string>();
  for (const n of nodes) {
    let { x, y, z } = n.record.key;
    const depth = n.record.key.depth;
    for (let d = depth - 1; d >= 0; d--) {
      x >>= 1;
      y >>= 1;
      z >>= 1;
      set.add(`${d}/${x}/${y}/${z}`);
    }
  }
  return set;
}

/**
 * Task 12 — sibling-retention bonus. Collect the parent-keys of every node in
 * the wanted-set: a deferred eviction whose node shares a parent with one of
 * these "still-wanted" siblings gets one extra window of grace, on the bet
 * that a flicker-orbit pulling one sibling will likely pull the others next.
 */
function buildWantedParentKeys(
  wanted: ReadonlySet<string>,
  cloud: StreamingSource,
): Set<string> {
  const set = new Set<string>();
  for (const id of wanted) {
    const node = cloud.octree.store.get(id);
    if (!node) continue;
    const pk = parentKeyString(node.record.key);
    if (pk !== null) set.add(pk);
  }
  return set;
}

/** Centre of a Box6 — used as a node's worldspace position proxy. */
function boxCentre(b: Box6): [number, number, number] {
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

/**
 * The view-dependent streaming scheduler. Operates against the format-agnostic
 * {@link StreamingSource} interface — today's COPC implementation
 * ({@link StreamingPointCloud}) and tomorrow's EPT implementation both plug in
 * without any change to this class.
 */
export class StreamingScheduler {
  private readonly _cloud: StreamingSource;
  private readonly _decoder: ChunkDecoder;
  private readonly _callbacks: SchedulerCallbacks;
  private readonly _localBounds = new Map<string, Box6>();
  private readonly _queue: StreamingNode[] = [];
  private readonly _inFlight = new Map<string, AbortController>();
  private readonly _cache: CompressedChunkCache;

  private _pointBudget: number;
  private _maxConcurrent: number;
  private _lastCameraPos: [number, number, number] | null = null;
  private _tick = 0;
  private _paused = false;
  private _lastTickMs = 0;
  private _lastVisible = 0;

  /** Hysteresis state — node id → wall-clock deadline (ms) past which it may evict. */
  private readonly _deferredEvictAt = new Map<string, number>();
  private readonly _evictDeferMs: number;
  private readonly _memoryPressureRatio: number;
  private readonly _now: () => number;

  /** Smoothed linear camera velocity, world units per second. */
  private _velocitySmoothed = 0;
  /** Wall time of the previous `update` — for dt during smoothing. */
  private _lastUpdateTs: number | null = null;
  /** First wall time the velocity dropped below the fast threshold, or null. */
  private _stableSinceTs: number | null = null;
  /** Concurrent-decode budget applied at the last `update`. */
  private _effectiveMaxConcurrent: number;

  // Task 15 — pressure-adaptation state machine.
  /** First wall time the resident/budget ratio crossed `PRESSURE_HIGH_RATIO`. */
  private _pressureHighSinceTs: number | null = null;
  /** First wall time the ratio dropped below `PRESSURE_LOW_RATIO`. */
  private _pressureLowSinceTs: number | null = null;
  /** Active depth-cap reduction (0 when not under pressure). */
  private _pressureDepthReduction = 0;

  // Task 10 (v0.3.2) — stable-camera fast-path cache.
  /**
   * Camera position captured at the previous full rescore. Distinct from
   * `_lastCameraPos`, which is overwritten by the velocity tracker earlier
   * in `update()` and so cannot serve as a signature input by the time the
   * fast-path branch runs.
   */
  private _lastSigCameraPos: [number, number, number] | null = null;
  /** ViewProjection captured at the previous full rescore (16 numbers). */
  private _lastVP: Float64Array | null = null;
  /** Signature components captured at the previous full rescore. */
  private _lastSigDepthCap = -1;
  private _lastSigBudget = -1;
  private _lastSigPressureReduction = -1;
  /** Last full rescore's wanted set (reused while the signature stays equal). */
  private _lastWanted: ReadonlySet<string> | null = null;
  /** Last full rescore's scored list (same lifecycle as `_lastWanted`). */
  private _lastScored: { node: StreamingNode; candidate: ScoredCandidate }[] | null = null;
  /** Tick index of the last full rescore — drives the periodic forced rescore. */
  private _lastFullRescoreTick = -FORCED_RESCORE_INTERVAL_TICKS;
  /** Cumulative full-rescore count exposed via {@link SchedulerStats}. */
  private _fullRescoreCount = 0;

  constructor(
    cloud: StreamingSource,
    decoder: ChunkDecoder,
    callbacks: SchedulerCallbacks,
    budgets: StreamingBudgets,
    options: SchedulerOptions = {},
  ) {
    this._cloud = cloud;
    this._decoder = decoder;
    this._callbacks = callbacks;
    this._pointBudget = budgets.pointBudget;
    this._maxConcurrent = budgets.maxConcurrentDecodes;
    this._effectiveMaxConcurrent = budgets.maxConcurrentDecodes;
    this._cache = new CompressedChunkCache(budgets.chunkCacheBytes);
    this._evictDeferMs = options.evictDeferMs ?? DEFAULT_EVICT_DEFER_MS;
    this._memoryPressureRatio =
      options.memoryPressureRatio ?? DEFAULT_MEMORY_PRESSURE_RATIO;
    this._now = options.now ?? nowMs;
    // Precompute each node's bounds in local render space (world − origin).
    const [rx, ry, rz] = cloud.renderOrigin;
    for (const node of cloud.octree.nodes()) {
      const b = node.record.bounds;
      this._localBounds.set(node.record.id, [
        b[0] - rx,
        b[1] - ry,
        b[2] - rz,
        b[3] - rx,
        b[4] - ry,
        b[5] - rz,
      ]);
    }
  }

  /** Apply new point and concurrency budgets (a quality-preset change). */
  setBudgets(
    budgets: Pick<StreamingBudgets, 'pointBudget' | 'maxConcurrentDecodes'>,
  ): void {
    this._pointBudget = budgets.pointBudget;
    this._maxConcurrent = budgets.maxConcurrentDecodes;
    // A budget change invalidates `_lastWanted` even if every other input
    // is bit-equal — the signature check picks this up via `_lastSigBudget`
    // anyway, but invalidating here makes the intent explicit and protects
    // against future signature-component additions that might skip the
    // budget field.
    this._lastWanted = null;
    this._lastScored = null;
  }

  /** Drop every cached compressed chunk. */
  clearCache(): void {
    this._cache.clear();
  }

  /** Compressed-chunk cache usage — for the streaming panel and diagnostics. */
  cacheStats(): {
    byteSize: number;
    count: number;
    maxBytes: number;
    hits: number;
    misses: number;
    evictions: number;
  } {
    return {
      byteSize: this._cache.byteSize,
      count: this._cache.count,
      maxBytes: this._cache.maxBytes,
      hits: this._cache.hits,
      misses: this._cache.misses,
      evictions: this._cache.evictions,
    };
  }

  /** Pause streaming — no new work is scheduled or dispatched. */
  pause(): void {
    this._paused = true;
  }

  /** Resume streaming. */
  resume(): void {
    this._paused = false;
  }

  /** Whether streaming is currently paused. */
  get paused(): boolean {
    return this._paused;
  }

  /** Live counters for the diagnostics overlay. */
  stats(): SchedulerStats {
    let queued = 0;
    for (const node of this._cloud.octree.nodes()) {
      if (node.state === 'queued') queued++;
    }
    return {
      visible: this._lastVisible,
      queued,
      loading: this._inFlight.size,
      lastTickMs: this._lastTickMs,
      cameraVelocity: this._velocitySmoothed,
      isStable: this._isStable(this._now()),
      effectiveMaxConcurrent: this._effectiveMaxConcurrent,
      pressureDepthReduction: this._pressureDepthReduction,
      fullRescoreCount: this._fullRescoreCount,
    };
  }

  /** Whether the camera has settled long enough for full-detail refinement. */
  private _isStable(nowTs: number): boolean {
    return (
      this._velocitySmoothed <= VELOCITY_FAST_THRESHOLD &&
      this._stableSinceTs !== null &&
      nowTs - this._stableSinceTs >= STABLE_SETTLE_MS
    );
  }

  /** A node's local-space bounds. */
  localBoundsOf(id: string): Box6 | undefined {
    return this._localBounds.get(id);
  }

  /**
   * Run one scheduling pass: cull, score, select within budget, evict the
   * surplus, enqueue the missing, and dispatch decodes.
   */
  update(view: SchedulerView): void {
    if (this._paused) return;
    const startedAt = nowMs();
    this._tick++;

    // Phase 3 Task 9 — smoothed camera-motion awareness. The raw position
    // delta over wall-clock dt gives a velocity in world units per second
    // (time-independent of tick cadence). An EWMA absorbs frame-to-frame
    // jitter, then drives both `depthCapForVelocity` (already coarse-first
    // under motion) and the concurrent-decode budget.
    const wallNow = this._now();
    const dtSec =
      this._lastUpdateTs !== null
        ? Math.max(0.001, (wallNow - this._lastUpdateTs) / 1000)
        : 0.1;
    this._lastUpdateTs = wallNow;
    const rawVelocity = this._lastCameraPos
      ? distance(view.cameraPosition, this._lastCameraPos) / dtSec
      : 0;
    const alpha = Math.min(1, dtSec / VELOCITY_EWMA_TAU_S);
    this._velocitySmoothed =
      this._velocitySmoothed * (1 - alpha) + rawVelocity * alpha;
    this._lastCameraPos = [...view.cameraPosition];

    // Hysteresis on the "stable" transition — we only resume full-detail
    // refinement after staying below the threshold for the settle window.
    if (this._velocitySmoothed <= VELOCITY_FAST_THRESHOLD) {
      if (this._stableSinceTs === null) this._stableSinceTs = wallNow;
    } else {
      this._stableSinceTs = null;
    }
    const stable = this._isStable(wallNow);
    this._effectiveMaxConcurrent = stable
      ? this._maxConcurrent
      : Math.max(1, Math.floor(this._maxConcurrent * FAST_CONCURRENCY_FACTOR));

    // Task 15 — pressure adaptation. Sample the resident/budget ratio and
    // run the high → low → high hysteresis state machine. Holding past the
    // 90 % threshold for ≥ 1 s lowers target depth by one; falling below
    // 70 % for ≥ 2 s restores it. The band between the two ratios is the
    // anti-oscillation zone — neither edge fires.
    const ratio =
      this._pointBudget > 0
        ? this._cloud.octree.store.residentPointCount / this._pointBudget
        : 0;
    if (ratio > PRESSURE_HIGH_RATIO) {
      if (this._pressureHighSinceTs === null) this._pressureHighSinceTs = wallNow;
      this._pressureLowSinceTs = null;
      if (
        this._pressureDepthReduction === 0 &&
        wallNow - this._pressureHighSinceTs >= PRESSURE_HIGH_HOLD_MS
      ) {
        this._pressureDepthReduction = PRESSURE_DEPTH_REDUCTION;
      }
    } else if (ratio < PRESSURE_LOW_RATIO) {
      if (this._pressureLowSinceTs === null) this._pressureLowSinceTs = wallNow;
      this._pressureHighSinceTs = null;
      if (
        this._pressureDepthReduction > 0 &&
        wallNow - this._pressureLowSinceTs >= PRESSURE_LOW_HOLD_MS
      ) {
        this._pressureDepthReduction = 0;
      }
    } else {
      // In the hysteresis band — neither edge advances. Keep current state
      // and pause both timers so a brief excursion past a threshold has to
      // re-arm from scratch on its next entry.
      this._pressureHighSinceTs = null;
      this._pressureLowSinceTs = null;
    }

    const depthCap = depthCapForVelocity(
      BASE_DEPTH_CAP - this._pressureDepthReduction,
      this._velocitySmoothed,
    );
    const store = this._cloud.octree.store;

    // A node queued last tick is reconsidered fresh — reset it to unloaded.
    // (Cheap pass; runs every tick regardless of fast-path.)
    for (const node of this._cloud.octree.nodes()) {
      if (node.state === 'queued') store.setState(node, 'unloaded');
    }

    // Task 10 (v0.3.2) — stable-camera fast path. If the scheduling
    // signature is bit-identical to last tick's AND the periodic forced
    // rescore isn't due, reuse the cached `_lastScored` and `_lastWanted`.
    // The eviction, enqueue, and dispatch paths below still run because
    // they depend on wall time and node-state mutations that are
    // independent of the signature.
    const sigMatches =
      this._lastVP !== null &&
      this._lastSigCameraPos !== null &&
      this._lastWanted !== null &&
      this._lastScored !== null &&
      vpMatches(this._lastVP, view.viewProjection) &&
      view.cameraPosition[0] === this._lastSigCameraPos[0] &&
      view.cameraPosition[1] === this._lastSigCameraPos[1] &&
      view.cameraPosition[2] === this._lastSigCameraPos[2] &&
      depthCap === this._lastSigDepthCap &&
      this._pointBudget === this._lastSigBudget &&
      this._pressureDepthReduction === this._lastSigPressureReduction;
    const forceRescore =
      this._tick - this._lastFullRescoreTick >= FORCED_RESCORE_INTERVAL_TICKS;

    let scored: { node: StreamingNode; candidate: ScoredCandidate }[];
    let wanted: ReadonlySet<string>;

    if (sigMatches && !forceRescore) {
      // Fast path — every input to scoring is bit-equal to last tick.
      scored = this._lastScored as { node: StreamingNode; candidate: ScoredCandidate }[];
      wanted = this._lastWanted as ReadonlySet<string>;
    } else {
      const planes = frustumPlanesFromViewProjection(view.viewProjection);
      // Score every visible node.
      const freshScored: { node: StreamingNode; candidate: ScoredCandidate }[] = [];
      for (const node of this._cloud.octree.nodes()) {
        const box = this._localBounds.get(node.record.id);
        let score = 0;
        if (box && boxInFrustum(box, planes)) {
          score = nodeScore({
            bounds: box,
            depth: node.record.key.depth,
            cameraPos: view.cameraPosition,
            depthCap,
          });
        }
        node.score = score;
        if (score > 0) {
          node.lastUsedTick = this._tick;
          freshScored.push({
            node,
            candidate: { id: node.record.id, pointCount: node.record.pointCount, score },
          });
        }
      }
      this._lastVisible = freshScored.length;
      freshScored.sort((a, b) => b.candidate.score - a.candidate.score);
      const freshWanted = selectWithinBudget(
        freshScored.map((s) => s.candidate),
        this._pointBudget,
      );
      scored = freshScored;
      wanted = freshWanted;

      // Cache the inputs and outputs for the next tick's fast-path check.
      if (this._lastVP === null) this._lastVP = new Float64Array(16);
      copyVp(view.viewProjection, this._lastVP);
      this._lastSigCameraPos = [
        view.cameraPosition[0],
        view.cameraPosition[1],
        view.cameraPosition[2],
      ];
      this._lastSigDepthCap = depthCap;
      this._lastSigBudget = this._pointBudget;
      this._lastSigPressureReduction = this._pressureDepthReduction;
      this._lastScored = freshScored;
      this._lastWanted = freshWanted;
      this._lastFullRescoreTick = this._tick;
      this._fullRescoreCount += 1;
    }

    // Hysteresis-aware eviction (Phase 3 Task 8). A resident node that left
    // the wanted-set is kept for `_evictDeferMs` before its mesh is dropped:
    // a quick camera flick or oscillating frustum no longer thrashes nodes
    // through the load → evict → reload cycle, and the compressed-chunk
    // cache keeps the data warm in case the camera returns. We reuse
    // `wallNow` here so every eviction-clock decision within a single tick
    // shares one consistent timestamp.
    const nowTs = wallNow;
    const residents = store.resident();
    const protection = buildAncestorProtection(residents);
    // Task 12 — sibling-retention bonus. Children of a wanted parent get a
    // retention bonus over orphan deferred nodes.
    const wantedParentKeys = buildWantedParentKeys(wanted, this._cloud);

    for (const node of residents) {
      const id = node.record.id;
      if (wanted.has(id)) {
        // Wanted again — clear any pending eviction so it stays resident.
        this._deferredEvictAt.delete(id);
      } else if (!this._deferredEvictAt.has(id)) {
        // Newly unwanted — start the hysteresis countdown.
        this._deferredEvictAt.set(id, nowTs + this._evictDeferMs);
      }
    }

    // Task 12 — hierarchy-aware lapsed eviction. Walk every deferred entry:
    //   1. drop dead / no-longer-resident entries from the map;
    //   2. parent-protection — children must evict before their parents;
    //   3. sibling-retention — a node whose sibling is still wanted gets
    //      one more window of grace;
    //   4. collect the remaining lapsed nodes, sort by (depth desc, distance
    //      desc) so deepest-and-furthest evicts first, then drop in order.
    const lapsed: { node: StreamingNode; depth: number; distance: number }[] = [];
    for (const id of [...this._deferredEvictAt.keys()]) {
      const deadline = this._deferredEvictAt.get(id);
      if (deadline === undefined || nowTs < deadline) continue;
      const node = store.get(id);
      if (!node || node.state !== 'resident') {
        this._deferredEvictAt.delete(id);
        continue;
      }
      if (protection.has(voxelKeyString(node.record.key))) {
        // Parent of a resident — reschedule one window. The child eviction
        // on a later tick frees the parent for eviction *then*.
        this._deferredEvictAt.set(id, nowTs + this._evictDeferMs);
        continue;
      }
      const parentKey = parentKeyString(node.record.key);
      if (parentKey !== null && wantedParentKeys.has(parentKey)) {
        // Sibling still wanted — keep it warm for one more window.
        this._deferredEvictAt.set(id, nowTs + this._evictDeferMs);
        continue;
      }
      const box = this._localBounds.get(id);
      const centre = box ? boxCentre(box) : ([0, 0, 0] as [number, number, number]);
      const dist = distance(centre, view.cameraPosition);
      lapsed.push({ node, depth: node.record.key.depth, distance: dist });
    }
    // Deepest first; within a depth, furthest first.
    lapsed.sort((a, b) =>
      b.depth - a.depth || b.distance - a.distance,
    );
    for (const { node } of lapsed) {
      // Cache hysteresis (Task 13): bump the compressed chunk so a quick
      // camera return finds it warm.
      this._cache.touch(node.record.id);
      this._callbacks.onNodeEvicted(node);
      store.setState(node, 'unloaded');
      this._deferredEvictAt.delete(node.record.id);
    }

    // Memory-pressure override: when retained nodes push the resident point
    // count well past the budget, drop deferred nodes immediately — oldest
    // deadline first, non-protected before protected.
    if (
      store.residentPointCount >
      this._pointBudget * this._memoryPressureRatio
    ) {
      const pending = [...this._deferredEvictAt.entries()].sort(
        (a, b) => a[1] - b[1],
      );
      const evictByProtection = (protectedOnly: boolean): void => {
        for (const [id] of pending) {
          if (store.residentPointCount <= this._pointBudget) return;
          const node = store.get(id);
          if (!node || node.state !== 'resident') {
            this._deferredEvictAt.delete(id);
            continue;
          }
          const isProtected = protection.has(voxelKeyString(node.record.key));
          if (isProtected !== protectedOnly) continue;
          // Task 13 cache hysteresis — keep the chunk warm post-eviction.
          this._cache.touch(id);
          this._callbacks.onNodeEvicted(node);
          store.setState(node, 'unloaded');
          this._deferredEvictAt.delete(id);
        }
      };
      evictByProtection(false); // non-protected first
      evictByProtection(true); // then protected if still over budget
    }

    // Cancel in-flight decodes for nodes that left the working set — but
    // keep them in-flight if they are still within the hysteresis window
    // (a quick camera flick can want them back before they finish).
    for (const [id, controller] of this._inFlight) {
      if (!wanted.has(id) && !this._deferredEvictAt.has(id)) {
        controller.abort();
      }
    }

    // Enqueue wanted nodes that are not already resident or loading.
    this._queue.length = 0;
    for (const { node } of scored) {
      if (
        wanted.has(node.record.id) &&
        node.state !== 'resident' &&
        node.state !== 'loading'
      ) {
        store.setState(node, 'queued');
        this._queue.push(node);
      }
    }

    this._dispatch();
    this._lastTickMs = nowMs() - startedAt;
    this._callbacks.onTick?.(this._lastTickMs);
    this._callbacks.onChange?.();
  }

  /** The current point budget — used by the streaming benchmark for the refined-stable threshold. */
  get pointBudget(): number {
    return this._pointBudget;
  }

  /** Cancel every queued and in-flight decode — used on close. */
  stop(): void {
    for (const controller of this._inFlight.values()) controller.abort();
    this._inFlight.clear();
    this._queue.length = 0;
    this._deferredEvictAt.clear();
    // Task 10 (v0.3.2): a stopped scheduler must not resume into a cached
    // fast path — the wanted set and scored array are no longer valid once
    // queues are cleared. Drop them so the next `update` does a fresh full
    // rescore.
    this._lastWanted = null;
    this._lastScored = null;
  }

  /**
   * Dispatch decodes until the concurrency limit is reached. Under fast
   * camera motion the effective limit drops (Phase 3 Task 9), so streaming
   * never queues up megabytes of decode work for nodes that are no longer
   * wanted by the next frame.
   */
  private _dispatch(): void {
    while (
      this._inFlight.size < this._effectiveMaxConcurrent &&
      this._queue.length > 0
    ) {
      const node = this._queue.shift();
      if (!node || node.state !== 'queued') continue;
      this._startDecode(node);
    }
  }

  /** Read and decode one node's chunk, then hand the result to the renderer. */
  private _startDecode(node: StreamingNode): void {
    const id = node.record.id;
    const controller = new AbortController();
    this._inFlight.set(id, controller);
    const store = this._cloud.octree.store;
    store.setState(node, 'loading');

    const meta = this._cloud.decodeMeta(node.record);
    this._readChunk(node, controller.signal)
      .then((chunk) => this._decoder.decode(chunk, meta, controller.signal))
      .then((decoded) => {
        this._inFlight.delete(id);
        if (controller.signal.aborted) {
          store.setState(node, 'unloaded');
        } else {
          store.setState(node, 'resident', decoded.pointCount);
          this._callbacks.onNodeReady(node, decoded);
        }
        this._dispatch();
        this._callbacks.onChange?.();
      })
      .catch((err: unknown) => {
        this._inFlight.delete(id);
        if (controller.signal.aborted) {
          store.setState(node, 'unloaded');
        } else {
          store.setError(node, err instanceof Error ? err.message : String(err));
        }
        this._dispatch();
        this._callbacks.onChange?.();
      });
  }

  /**
   * Read a node's compressed chunk — from the cache when present, otherwise
   * from the file (caching the result). The returned buffer is always a fresh
   * copy, safe to transfer to the decode worker without neutering the cache.
   */
  private async _readChunk(
    node: StreamingNode,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const id = node.record.id;
    const cached = this._cache.get(id);
    if (cached) return cached.slice(0);
    const fresh = await this._cloud.readNodeChunk(node.record, signal);
    this._cache.put(id, fresh);
    return fresh.slice(0);
  }
}

/** Euclidean distance between two points. */
function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A monotonic millisecond clock, available on both the main thread and Node. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Task 10 (v0.3.2) — bit-equality check on a 4×4 view-projection matrix.
 * The caller's matrix may be a `Float32Array`, a `Float64Array`, or a plain
 * `ArrayLike<number>` (Three.js's `Matrix4.elements` is typed as the broad
 * shape). Iterates the 16 entries; returns true only on exact equality.
 */
function vpMatches(cached: Float64Array, incoming: ArrayLike<number>): boolean {
  if (incoming.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (cached[i] !== incoming[i]) return false;
  }
  return true;
}

/** Task 10 (v0.3.2) — copy 16 numbers from the live VP into the cached array. */
function copyVp(src: ArrayLike<number>, dst: Float64Array): void {
  for (let i = 0; i < 16; i++) dst[i] = src[i];
}
