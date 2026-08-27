/**
 * heavyLasTypes.ts — the shared shapes across the out-of-core LAS bridge.
 *
 * The bridge is split into a light decision half (`openLocalHeavyLas.ts`, in the
 * eager shell) and a heavy execution half (`heavyLasExecutor.ts`, behind a
 * dynamic import). Both refer to the same deps, env and result shapes, so those
 * live here where a type-only import pulls no runtime weight into either chunk:
 * every value referenced below is imported with `import type` and erased at
 * build time, so nothing in this module reaches the eager bundle.
 */
import type { RangeSource } from '../io/range/RangeSource';
import type { TileSchema } from '../io/heavy/tileRecord';
import type { PointAttributes } from '../io/loadPlan';
import type { OpfsDirHandle } from '../io/heavy/opfsSpillStore';
import type { StorageEstimateReader } from '../io/heavy/storagePreflight';
import type {
  LocalOocIndexRequest,
} from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocBuildResult } from '../io/heavy/localOocBuild';
import type { OlvTileSource } from '../io/heavy/OlvTileSource';
import type { TileChunkDecoder } from '../io/heavy/tileChunkDecoder';
import type {
  RevealDock,
  RevealInspector,
  RevealNavBar,
} from '../ui/streamingScanReveal';
import type { LoadError } from '../io/loadErrors';
import type { Viewer } from '../render/Viewer';
import type { OpenStreamingDeps } from './openStreaming';

/** The collaborators the bridge writes through once a build produces a store. */
export interface HeavyLasBridgeDeps {
  /** Resolves once the lazily-loaded Viewer chunk is in place. */
  readonly viewerReady: Promise<unknown>;
  getViewer(): Viewer;
  isPhone(): boolean;
  /** The device's safe render budget — the plan's point budget. */
  readonly renderBudget: number;
  deviceMemoryGB(): number | undefined;
  /** The scan-dependent chrome the streaming reveal turns on. */
  readonly dock: RevealDock;
  readonly inspector: RevealInspector;
  readonly navBar: RevealNavBar;
  readonly stage: { hideEmptyState(): void };
  /** `document.body` in the app; any element with a class list in a test. */
  readonly body: { classList: { add(token: string): void } };
  /** A basic phase string for the drop-zone / streaming panel. */
  setPhase(phase: string): void;
  readonly debug: boolean;
  /**
   * The streaming surfaces a committed scan reveals — the same
   * {@link OpenStreamingDeps} the COPC, EPT and 3D Tiles opens write through.
   * The executor routes the out-of-core reveal through their shared helpers
   * (`activateCommittedStreamingCloud`, `resetClassificationUi`,
   * `enterStreamingInspectorMode`) rather than a fourth hand-copied block, so a
   * built tile store opens with the streaming panel, the streaming Inspector
   * layout, image export, the Analyse rail and the streaming Scan Report, not
   * just the dock and inspector `revealStreamingScanChrome` turns on.
   */
  readonly streaming: OpenStreamingDeps;
}

/** The light seams the decision half needs — no out-of-core weight. */
export interface HeavyLasDecisionEnv {
  /** True when OPFS and Web Workers are both available. */
  capable(): boolean;
  /** A ranged reader over the file for the header peek. */
  openRange(file: File): RangeSource;
}

/** The heavy seams the execution half needs. */
export interface HeavyLasExecutorEnv {
  /** The OPFS root the worker promoted its store into, or null when absent. */
  getOpfsRoot(): Promise<OpfsDirHandle | null>;
  /** Reads `navigator.storage.estimate()` for the preflight. */
  readStorage: StorageEstimateReader;
  /** Runs the index build (a worker in the browser). */
  runIndex(request: LocalOocIndexRequest): Promise<LocalOocBuildResult>;
}

/** The full injectable env; a test provides all of it, production none. */
export type HeavyLasBridgeEnv = HeavyLasDecisionEnv & HeavyLasExecutorEnv;

/** What the header peek established, all from a small ranged read. */
export interface LasHeaderFacts {
  readonly declaredPointCount: number;
  readonly schema: TileSchema;
  readonly attributes: PointAttributes;
  readonly fileBytes: number;
}

/**
 * The outcome of an out-of-core open attempt.
 *
 * The `heavy` flag on `unavailable`, `refused` and `failed` is the fail-closed
 * discriminator the router reads. It records whether the file was CONFIRMED
 * heavy (the header peek parsed and {@link planLoad} set `buildThenStream`)
 * before the out-of-core path could not complete. `heavy: true` means the
 * whole-file loader would face the very allocation that made the file heavy, so
 * the caller must REFUSE rather than fall through. `heavy: false` means the file
 * was never routed out of core and the whole-file loader is the correct answer,
 * so the caller falls through as before. This is why heaviness is decided
 * independently of capability: an `unavailable` result alone cannot say whether
 * a fall-through is safe; the flag can.
 */
export type HeavyOpenResult =
  /** A streaming source was attached — the file is open. */
  | { readonly status: 'attached'; readonly source: OlvTileSource; readonly decoder: TileChunkDecoder }
  /** The plan did not route this file out of core; the caller loads it whole. */
  | { readonly status: 'not-heavy' }
  /** OPFS or workers were unavailable. Fall through only when `heavy` is false. */
  | { readonly status: 'unavailable'; readonly heavy: boolean; readonly reason: string }
  /** The storage preflight refused. Fall through only when `heavy` is false. */
  | { readonly status: 'refused'; readonly heavy: boolean; readonly error: LoadError }
  /** The build or attach was cancelled before commit. */
  | { readonly status: 'cancelled' }
  /** The build or attach failed before commit. Fall through only when `heavy` is false. */
  | { readonly status: 'failed'; readonly heavy: boolean; readonly error: unknown };
