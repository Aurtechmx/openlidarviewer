/**
 * openLocalHeavyLas.ts — route an over-ceiling local LAS through the out-of-core
 * build instead of the whole-file loader.
 *
 * The whole-file loader reads a dropped LAS into one ArrayBuffer before it
 * strides it down. For an uncompressed LAS large enough to trip the memory
 * ceiling that single allocation IS the thing that fails, and the out-of-core
 * cluster exists precisely to avoid it: a sliced reader never holds more than a
 * batch, an indexer settles the points into an OPFS tile store, and
 * `OlvTileSource` streams that store through the same scheduler COPC, EPT and 3D
 * Tiles use. Every piece was built and tested; nothing called them. This is the
 * caller.
 *
 * THE SHAPE. Read only the header first (a small ranged read, never the file):
 * from the declared point count and the record schema, run the same
 * {@link planLoad} the loader runs and act on its `buildThenStream` verdict. If
 * the plan does not route out of core, this is not our file. If it does, run the
 * storage preflight — the disk guard that refuses before a byte is written when
 * the tile cache would not fit — then dispatch the index to a worker, reopen the
 * promoted store from OPFS, and hand an `OlvTileSource` to the streaming attach.
 *
 * FAIL SAFE, ALWAYS. This wires into the live file-open path, so it must never
 * make a working open worse. Every way the out-of-core path can decline — the
 * plan says no, OPFS or workers are absent, the preflight refuses, the build or
 * the attach throws before the commit — returns a status the caller reads as
 * "fall back to the whole-file loader" (or, for a refusal, surfaces the
 * preflight's own named message). A crash or a blank scene where the file used
 * to open is the one outcome this function exists to prevent.
 *
 * BROWSER SEAMS ARE INJECTED. The capability probe, the OPFS root, the storage
 * estimate reader and the index runner are an {@link HeavyLasBridgeEnv} with a
 * live default, so the whole decision-and-dispatch runs in Node against a fake
 * OPFS and an in-process build. Only the worker message transport is not
 * exercised there; it is a thin layer over the same `buildLocalOocStore`.
 */
import type { RangeSource } from '../io/range/RangeSource';
import { LocalFileRangeSource } from '../io/range/LocalFileRangeSource';
import { parseLasHeader, pointFormatHasRgb } from '../io/lasHeader';
import { decodeContext } from '../io/lasDecodeShared';
import { tileSchemaForHeader } from '../io/heavy/tileRecord';
import { sniffFormat } from '../io/sniffFormat';
import { planLoad, type PointAttributes } from '../io/loadPlan';
import type { TileSchema } from '../io/heavy/tileRecord';
import {
  storagePreflight,
  storagePreflightRefusal,
  readStorageEstimate,
  type StorageEstimateReader,
} from '../io/heavy/storagePreflight';
import { openTileStore, tileBytesReader } from '../io/heavy/tileStoreBuilder';
import { opfsSpillStore, type OpfsDirHandle } from '../io/heavy/opfsSpillStore';
import { OlvTileSource } from '../io/heavy/OlvTileSource';
import { TileChunkDecoder } from '../io/heavy/tileChunkDecoder';
import {
  revealStreamingScanChrome,
  type RevealDock,
  type RevealInspector,
  type RevealNavBar,
} from '../ui/streamingScanReveal';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocIndexRequest } from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocBuildResult, LocalOocPhase } from '../io/heavy/localOocBuild';
import { LoadCancelledError } from '../io/loadFile';
import type { LoadError } from '../io/loadErrors';
import type { Viewer } from '../render/Viewer';

/** How many header bytes to peek. The LAS public header is 375 bytes; this is
 *  generous slack, and always far smaller than a file that routes out of core. */
const HEADER_PEEK_BYTES = 64 * 1024;

/** Peak staging memory the bucketing pass may hold before spilling to OPFS. */
const BUILD_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

/** The collaborators the bridge writes through once a build has produced a store. */
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
}

/** The browser-only seams, injected so the whole path runs in Node. */
export interface HeavyLasBridgeEnv {
  /** True when OPFS and Web Workers are both available. */
  capable(): boolean;
  /** A ranged reader over the file for the header peek. */
  openRange(file: File): RangeSource;
  /** The OPFS root the worker promoted its store into, or null when absent. */
  getOpfsRoot(): Promise<OpfsDirHandle | null>;
  /** Reads `navigator.storage.estimate()` for the preflight. */
  readStorage: StorageEstimateReader;
  /** Runs the index build (a worker in the browser). */
  runIndex(request: LocalOocIndexRequest): Promise<LocalOocBuildResult>;
}

/** The outcome of an out-of-core open attempt. */
export type HeavyOpenResult =
  /** A streaming source was attached — the file is open. */
  | { readonly status: 'attached'; readonly source: OlvTileSource; readonly decoder: TileChunkDecoder }
  /** The plan did not route this file out of core; the caller loads it whole. */
  | { readonly status: 'not-heavy' }
  /** OPFS or workers were unavailable; the caller loads the file whole. */
  | { readonly status: 'unavailable'; readonly reason: string }
  /** The storage preflight refused; the caller may surface the named message. */
  | { readonly status: 'refused'; readonly error: LoadError }
  /** The build or attach was cancelled before commit. */
  | { readonly status: 'cancelled' }
  /** The build or attach failed before commit; the caller loads the file whole. */
  | { readonly status: 'failed'; readonly error: unknown };

/** What the header peek established, all from a small ranged read. */
interface LasHeaderFacts {
  readonly declaredPointCount: number;
  readonly schema: TileSchema;
  readonly attributes: PointAttributes;
  readonly fileBytes: number;
}

const PHASE_LABELS: Record<LocalOocPhase, string> = {
  indexing: 'Indexing for streaming…',
  finishing: 'Finishing the index…',
};

/**
 * Peek the LAS header from a small ranged read. Returns null when the file is
 * not an uncompressed LAS or the header does not parse — both of which mean the
 * out-of-core path is not ours, not that anything is wrong.
 */
async function peekLasHeaderFacts(
  range: RangeSource,
  signal: AbortSignal | undefined,
): Promise<LasHeaderFacts | null> {
  let size: number;
  try {
    size = await range.size();
  } catch {
    return null;
  }
  if (!Number.isFinite(size) || size <= 0) return null;
  let head: ArrayBuffer;
  try {
    head = await range.readRange(0, Math.min(size, HEADER_PEEK_BYTES), signal);
  } catch {
    return null;
  }
  // Only an UNCOMPRESSED LAS routes here: the tile builder reads sliced LAS, and
  // a LAZ stays on the whole-file strided path until the chunked-LAZ builder is
  // wired. `sniffFormat` distinguishes the two before the header is trusted.
  if (sniffFormat(head, range.id()) !== 'las') return null;
  let header;
  try {
    header = parseLasHeader(head);
  } catch {
    return null;
  }
  const origin: [number, number, number] = [
    Math.floor(header.min[0]),
    Math.floor(header.min[1]),
    Math.floor(header.min[2]),
  ];
  const ctx = decodeContext(header, origin);
  const schema = tileSchemaForHeader(header.pointFormat, ctx);
  const attributes: PointAttributes = {
    hasColor: pointFormatHasRgb(header.pointFormat),
    hasIntensity: true,
    hasClassification: true,
    hasNormals: false,
    hasLasExtras: true,
  };
  return { declaredPointCount: header.pointCount, schema, attributes, fileBytes: size };
}

/** A filesystem-safe store name derived from the file, stable for one file. */
function heavyStoreName(file: File): string {
  const base = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `ooc-${base}-${file.size}`;
}

/**
 * Attempt to open `file` through the out-of-core build. See the module header
 * for the fail-safe contract: any non-`attached` result is the caller's cue to
 * fall back to the whole-file loader (or, for `refused`, to surface the message).
 */
export async function openLocalHeavyLas(
  file: File,
  signal: AbortSignal,
  deps: HeavyLasBridgeDeps,
  env: HeavyLasBridgeEnv = defaultHeavyLasEnv(),
): Promise<HeavyOpenResult> {
  // Capability probe first, before any read: without OPFS and workers the
  // out-of-core path cannot run, and the whole-file loader is the answer. In a
  // Node/JSDOM harness neither exists, so this returns immediately and the live
  // open path behaves exactly as it did before this module.
  if (!env.capable()) return { status: 'unavailable', reason: 'OPFS or Web Workers unavailable' };

  const facts = await peekLasHeaderFacts(env.openRange(file), signal);
  if (facts === null) return { status: 'not-heavy' };

  // The same plan the whole-file loader computes, acted on before a point is
  // decoded. `buildThenStream` is set only for an uncompressed LAS whose
  // whole-file estimate exceeds the memory ceiling.
  const plan = planLoad({
    sourceCount: facts.declaredPointCount,
    fileBytes: facts.fileBytes,
    budget: deps.renderBudget,
    isMobile: deps.isPhone(),
    deviceMemoryGB: deps.deviceMemoryGB(),
    attributes: facts.attributes,
    format: 'las',
  });
  if (!plan.buildThenStream) return { status: 'not-heavy' };

  const root = await env.getOpfsRoot();
  if (root === null) return { status: 'unavailable', reason: 'no OPFS root' };

  // The disk guard. Sized from the declared point count and the record schema,
  // it refuses BEFORE any byte is written when the tile cache would not fit —
  // the fail-closed answer when storage cannot even be read.
  const verdict = await storagePreflight(
    { pointCount: facts.declaredPointCount, schema: facts.schema },
    env.readStorage,
  );
  if (!verdict.proceed) {
    const error = storagePreflightRefusal(verdict, file.name);
    // `storagePreflightRefusal` returns undefined only when the verdict
    // proceeds, which this branch has excluded; the guard keeps the type honest.
    if (error) return { status: 'refused', error };
    return { status: 'unavailable', reason: 'preflight refused without a message' };
  }

  // Build the store in a worker, then reopen it from OPFS and attach.
  try {
    deps.setPhase(PHASE_LABELS.indexing);
    const built = await env.runIndex({
      file,
      storeName: heavyStoreName(file),
      memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
      onPhase: (phase) => deps.setPhase(PHASE_LABELS[phase]),
      signal,
    });
    if (signal.aborted) return { status: 'cancelled' };

    const dir = await root.getDirectoryHandle(built.storeName);
    const spill = opfsSpillStore(dir);
    const reader = openTileStore(built.manifestJson, built.hierarchy);
    const source = new OlvTileSource({
      id: `ooc-${built.storeName}`,
      name: file.name,
      store: reader,
      tiles: tileBytesReader(spill),
      close: () => spill.close(),
    });
    const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);

    await attachHeavyStream(source, decoder, deps, signal);
    return { status: 'attached', source, decoder };
  } catch (err) {
    if (err instanceof LoadCancelledError || (err as { name?: string })?.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    if (deps.debug) console.warn('[heavy-las] out-of-core open failed; falling back', err);
    return { status: 'failed', error: err };
  }
}

/**
 * Attach a built tile source through the shared streaming path, then reveal the
 * scan chrome COPC, EPT and 3D Tiles all reveal (PR #648's helper), so an
 * out-of-core scan opens with the same dock, nav bar and inspector a streamed
 * scan does rather than a bare cloud with no UI.
 */
async function attachHeavyStream(
  source: OlvTileSource,
  decoder: TileChunkDecoder,
  deps: HeavyLasBridgeDeps,
  signal: AbortSignal,
): Promise<void> {
  await deps.viewerReady;
  const viewer = deps.getViewer();
  await viewer.ready;
  if (signal.aborted) throw new LoadCancelledError();
  // `attachStreamingCloud` is transactional: it builds the new session first and
  // aborts before its commit if `signal` fired, so a cancel here keeps whatever
  // scene the user already had rather than blanking the viewer.
  await viewer.attachStreamingCloud(source, decoder, 'balanced', deps.isPhone(), null, signal);
  deps.stage.hideEmptyState();
  viewer.setMode('orbit');
  viewer.frameAll();
  revealStreamingScanChrome({
    dock: deps.dock,
    inspector: deps.inspector,
    navBar: deps.navBar,
    backend: viewer.activeBackend(),
    body: deps.body,
  });
}

/** The live environment: real OPFS, a real worker, the real storage estimate. */
export function defaultHeavyLasEnv(): HeavyLasBridgeEnv {
  return {
    capable() {
      return (
        typeof Worker !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        typeof navigator.storage?.getDirectory === 'function'
      );
    },
    openRange(file) {
      return new LocalFileRangeSource(file);
    },
    async getOpfsRoot() {
      if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
        return null;
      }
      try {
        return (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
      } catch {
        return null;
      }
    },
    readStorage: readStorageEstimate,
    runIndex(request) {
      return new LocalOocIndexerClient().run(request);
    },
  };
}
