/**
 * streamingAttach.ts — assembling the live streaming session behind a host.
 *
 * `attachStreamingCloud` used to build the whole streaming subsystem inline in
 * the Viewer: it lazily loaded the render engine, constructed the
 * `StreamingRenderer` with the Viewer *itself* as host, wired the scheduler's
 * node-ready / node-evicted / tick callbacks (folding in the benchmark
 * recorders and the two display-only host hooks), and picked the commit path.
 * That block is the one part of the streaming cluster with a real boundary and
 * no three.js of its own — it decides *what to construct and how to wire it*,
 * not how to paint. This module owns that decision; `Viewer` keeps a thin
 * `attachStreamingCloud` that binds its own state to {@link StreamingHost} and
 * still owns the irreducibly view-bound remainder (camera / nav / EDL / orbit
 * setup in `_configureForStreaming`, the heartbeat, and the measure-datum and
 * orbit-clamp recompute on detach).
 *
 * The host is declared structurally — the renderer's mesh host plus the two
 * late-binding node hooks — so nothing here imports `Viewer`, and the session
 * builder plus its callback wiring are constructible from a plain object in a
 * unit test. Part of the v0.6 decomposition (see
 * `docs/architecture/architecture-map.md`).
 */

import type { StreamingScheduler, SchedulerCallbacks } from './StreamingScheduler';
import type {
  StreamingRenderer,
  StreamingRendererHost,
} from './StreamingRenderer';
import type { StreamingSource } from './StreamingSource';
import type { StreamingNode } from './StreamingNode';
import type { StreamingBenchmark } from './streamingBenchmark';
import type { StreamingQuality } from './streamingBudget';
import { streamingBudgets, firstAdmissionMaxPoints, capPntsConcurrency } from './streamingBudget';
import { makeStreamingCommit, type StreamingCommit } from './meteredCommit';
import { PntsChunkDecoder } from '../../io/tiles3d/pntsDecode';
import type { ChunkDecoder, DecodedChunk } from '../../io/copc/copcChunkDecode';
import { renderLocalPositions } from '../../model/pointFrames';
import { loadStreamingRenderer, loadStreamingScheduler } from '../../lazyChunks';
import { readDevFlags } from '../../perf/devFlags';

/**
 * `navigator.deviceMemory` in GiB, or undefined when the browser does not
 * expose it (Safari, Firefox). A coarse, spec-rounded hint — used only to lower
 * the first-admission ceiling on low-memory devices, never to raise it.
 */
function deviceMemoryGiB(): number | undefined {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof mem === 'number' && mem > 0 ? mem : undefined;
}

/**
 * The live streaming subsystem — present only while a COPC OR EPT cloud is
 * open. Widens the `cloud` type to the format-agnostic `StreamingSource` (the
 * same one the scheduler/renderer consume), so both COPC and EPT route through
 * the exact same session shape. Owned here, held by `Viewer._streaming`.
 */
export interface StreamingSession {
  cloud: StreamingSource;
  scheduler: StreamingScheduler;
  renderer: StreamingRenderer;
  /**
   * The chunk decoder driving this session. Retained so the full-cloud grade
   * can re-decode a breadth-first octree sample through the SAME decoder the
   * scheduler uses, without standing up a second worker pool.
   */
  decoder: ChunkDecoder;
  /** The streaming benchmark, when one is collecting — null in normal sessions. */
  benchmark: StreamingBenchmark | null;
  commit: StreamingCommit; // the commit driver: immediate = inert, metered = upload-queue pump
}

/**
 * What the session builder reads from the Viewer. Accessors are functions (the
 * two node hooks) or a live reference (the renderer's mesh host), never a
 * snapshot, so the scheduler callbacks always see the CURRENT hook — the
 * property the previous inline closures had by reading `this.onStreaming*` at
 * callback time, since the host may set those hooks after attach.
 */
export interface StreamingHost {
  /** The mesh/dissolve host the {@link StreamingRenderer} drives (the Viewer). */
  rendererHost: StreamingRendererHost;
  /**
   * The display-only per-node classification hook, read fresh on every
   * node-ready so a late `undefined`/reassignment takes effect. Fires the
   * classification legend's late-node fold.
   */
  streamingNodeClassesHook(): ((classes: Uint8Array) => void) | undefined;
  /**
   * The geometry-level per-node hook, read fresh on every node-ready — lets the
   * host re-route the scan type as a sparse early cloud fills in.
   */
  streamingNodeReadyHook(): (() => void) | undefined;
}

/**
 * Whether a fresh session enables the node dissolve. Desktop / mid+ profiles
 * fade in; mobile and the low-tier preset skip it to preserve frame-budget
 * headroom (hard add/remove). Pure so the gating is unit-tested without a GPU.
 */
/**
 * The stickiness bonus a resident, non-refining node keeps: fifteen percent of
 * its score. Large enough to absorb the boundary noise that makes regions pulse,
 * far too small to hold a slot against a genuinely closer or cheaper node.
 */
const RESIDENT_STICKY_MARGIN = 0.15;

export function shouldFadeIn(isMobile: boolean, quality: StreamingQuality): boolean {
  return !isMobile && quality !== 'low';
}

/**
 * Wire the scheduler's node lifecycle callbacks. Each `onNodeReady` paints the
 * node through the renderer, then fans the decoded chunk out to the two
 * display-only host hooks — each guarded so a legend refresh or a scan re-route
 * can never break the streaming pipeline — and records the benchmark's
 * first-paint / node-ready / decoded-byte volume when a benchmark is
 * collecting. `onTick` exists only while a benchmark is present, matching the
 * scheduler's optional-callback contract. Pure over its deps so the guard and
 * benchmark bookkeeping are Node-testable with fakes.
 */
export function buildSchedulerCallbacks(deps: {
  renderer: Pick<StreamingRenderer, 'onNodeReady' | 'onNodeEvicted'>;
  benchmark: StreamingBenchmark | null;
  nodeClassesHook(): ((classes: Uint8Array) => void) | undefined;
  nodeReadyHook(): (() => void) | undefined;
}): SchedulerCallbacks {
  const { renderer, benchmark, nodeClassesHook, nodeReadyHook } = deps;
  return {
    onNodeReady: (node: StreamingNode, decoded: DecodedChunk): void => {
      renderer.onNodeReady(node, decoded);
      // DISPLAY-ONLY class legend hook — hand the host the node's decoded
      // per-point classification so the legend can fold its histogram in. The
      // channel is optional on a DecodedChunk, and a node from a format that
      // carries none is skipped: folding zeros in would build a histogram
      // claiming every point is "never classified". Pure read; never touches
      // the GPU mask.
      const classesHook = nodeClassesHook();
      if (classesHook && decoded.classification) {
        try {
          classesHook(decoded.classification);
        } catch {
          /* a legend refresh must never break the streaming pipeline */
        }
      }
      // Geometry-level node-ready hook — lets the host re-route the scan type
      // as the cloud fills in. Guarded so a host throw can't break streaming.
      const readyHook = nodeReadyHook();
      if (readyHook) {
        try {
          readyHook();
        } catch {
          /* a re-route must never break the streaming pipeline */
        }
      }
      if (benchmark) {
        benchmark.recordFirstPaint();
        benchmark.recordNodeReady(node.record.id);
        // Position bytes are a stable proxy for "decoded points" volume.
        benchmark.recordDecodedBytes(renderLocalPositions(decoded).byteLength);
      }
    },
    onNodeEvicted: (node: StreamingNode): void => {
      renderer.onNodeEvicted(node);
      benchmark?.recordNodeEvicted(node.record.id);
    },
    onTick: benchmark ? (ms: number): void => benchmark.recordSchedulerTick(ms) : undefined,
  };
}

/**
 * Build (but do not mount) a streaming session for `cloud`: lazily load the
 * render engine, construct the renderer against the host's mesh surface, wire
 * the scheduler with {@link buildSchedulerCallbacks}, and pick the commit path.
 *
 * Async: the streaming render engine is a lazily-imported chunk, fetched on the
 * first COPC/EPT open so it never weighs on the initial bundle. The caller
 * (`Viewer.attachStreamingCloud`) detaches the prior session only AFTER this
 * resolves, so a throw in the lazy load or a constructor leaves the current
 * scan on screen instead of a blank scene.
 */
export async function buildStreamingSession(
  host: StreamingHost,
  cloud: StreamingSource,
  decoder: ChunkDecoder,
  quality: StreamingQuality,
  isMobile: boolean,
  benchmark: StreamingBenchmark | null,
): Promise<StreamingSession> {
  const [{ StreamingRenderer }, { StreamingScheduler }] = await Promise.all([
    loadStreamingRenderer(),
    loadStreamingScheduler(),
  ]);
  const fadeIn = shouldFadeIn(isMobile, quality);
  // the default colour mode comes from the source itself, not from a
  // COPC-specific helper. Both `StreamingPointCloud` (COPC) and
  // `EptStreamingPointCloud` implement `defaultColorMode()` so the Viewer never
  // peeks at format-specific metadata shapes.
  const renderer = new StreamingRenderer(
    host.rendererHost,
    cloud,
    cloud.defaultColorMode(),
    { fadeIn },
  );
  // The commit driver picks the scheduler's commit path (see meteredCommit.ts).
  const commit = makeStreamingCommit(readDevFlags().streamingCommitMode, isMobile, benchmark);
  // A PNTS source admits nodes on a fixed point estimate a real tile can far
  // exceed, so its concurrent decodes are held below the shared budget until a
  // real preflight exists. COPC and EPT carry true per-node counts and keep the
  // shared budget. See `capPntsConcurrency`.
  const budgets =
    decoder instanceof PntsChunkDecoder
      ? capPntsConcurrency(streamingBudgets(quality, isMobile), isMobile)
      : streamingBudgets(quality, isMobile);
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    buildSchedulerCallbacks({
      renderer,
      benchmark,
      nodeClassesHook: () => host.streamingNodeClassesHook(),
      nodeReadyHook: () => host.streamingNodeReadyHook(),
    }),
    budgets,
    {
      ...commit.schedulerOptions(),
      // Opt-in resident stickiness. The flag lives here, with the other host
      // flag reads, so the scheduler stays free of lookups; 0 keeps the plain
      // greedy fill that ships today.
      stickyMargin: readDevFlags().residentStickiness ? RESIDENT_STICKY_MARGIN : 0,
      // Device-aware first-admission ceiling: a phone or a low-memory machine
      // gets a smaller "admit any size while empty" limit than a desktop.
      firstAdmissionMaxPoints: firstAdmissionMaxPoints(isMobile, deviceMemoryGiB()),
    },
  );
  return { cloud, scheduler, renderer, decoder, benchmark, commit };
}

/**
 * Tear down a streaming session's live resources: stop the scheduler, dispose
 * the renderer's GPU meshes, then release the source's underlying reader (COPC
 * file handle / range source). `close()` is async and may reject if the reader
 * is already gone; detach is synchronous and best-effort, so fire it and
 * swallow the rejection rather than block teardown.
 */
export function disposeStreamingSession(session: StreamingSession): void {
  session.scheduler.stop();
  session.renderer.dispose();
  void session.cloud.close?.().catch(() => {});
}
