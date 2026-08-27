/**
 * heavyLasExecutor.ts — the heavy half of the out-of-core LAS bridge.
 *
 * Everything that pulls the out-of-core cluster into the bundle lives here:
 * the storage preflight, the worker build, the OPFS reopen, `OlvTileSource`,
 * the tile decoder and the streaming attach. It is held behind
 * `lazyChunks.loadHeavyLasExecutor`, so a session that opens a small LAS, a LAZ,
 * or nothing at all never loads any of this weight. The eager decision half
 * (`openLocalHeavyLas.ts`) delegates here only after the plan has already said
 * an uncompressed LAS routes out of core.
 *
 * The browser-only seams (the OPFS root, the storage estimate reader, the index
 * worker) are an injectable {@link HeavyLasExecutorEnv} with a live default, so
 * the whole build-reopen-attach path runs in Node against a fake OPFS and an
 * in-process build. Only the worker message transport is not exercised there.
 */
import {
  storagePreflight,
  storagePreflightRefusal,
  readStorageEstimate,
} from '../io/heavy/storagePreflight';
import { openTileStore, tileBytesReader } from '../io/heavy/tileStoreBuilder';
import { opfsSpillStore, type OpfsDirHandle } from '../io/heavy/opfsSpillStore';
import { OlvTileSource } from '../io/heavy/OlvTileSource';
import { TileChunkDecoder } from '../io/heavy/tileChunkDecoder';
import { revealStreamingScanChrome } from '../ui/streamingScanReveal';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocPhase } from '../io/heavy/localOocBuild';
import { LoadCancelledError } from '../io/loadFile';
import type {
  HeavyLasBridgeDeps,
  HeavyLasExecutorEnv,
  HeavyOpenResult,
  LasHeaderFacts,
} from './heavyLasTypes';

/** Peak staging memory the bucketing pass may hold before spilling to OPFS. */
const BUILD_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

const PHASE_LABELS: Record<LocalOocPhase, string> = {
  indexing: 'Indexing for streaming…',
  finishing: 'Finishing the index…',
};

/** A filesystem-safe store name derived from the file, stable for one file. */
function heavyStoreName(file: File): string {
  const base = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `ooc-${base}-${file.size}`;
}

/**
 * Build the tile store, reopen it from OPFS, and attach it as a streaming scan.
 * Called only when the decision half has confirmed the plan routes this file out
 * of core. Every failure path returns a non-`attached` status the caller reads
 * as "fall back to the whole-file loader", so this can never leave a blank scene.
 */
export async function executeHeavyLasBuild(
  file: File,
  signal: AbortSignal,
  facts: LasHeaderFacts,
  deps: HeavyLasBridgeDeps,
  env: Partial<HeavyLasExecutorEnv> = {},
): Promise<HeavyOpenResult> {
  const getOpfsRoot = env.getOpfsRoot ?? defaultGetOpfsRoot;
  const readStorage = env.readStorage ?? readStorageEstimate;
  const runIndex = env.runIndex ?? ((request) => new LocalOocIndexerClient().run(request));

  const root = await getOpfsRoot();
  if (root === null) return { status: 'unavailable', reason: 'no OPFS root' };

  // The disk guard. Sized from the declared point count and the record schema,
  // it refuses BEFORE any byte is written when the tile cache would not fit —
  // the fail-closed answer when storage cannot even be read.
  const verdict = await storagePreflight(
    { pointCount: facts.declaredPointCount, schema: facts.schema },
    readStorage,
  );
  if (!verdict.proceed) {
    const error = storagePreflightRefusal(verdict, file.name);
    if (error) return { status: 'refused', error };
    return { status: 'unavailable', reason: 'preflight refused without a message' };
  }

  try {
    deps.setPhase(PHASE_LABELS.indexing);
    const built = await runIndex({
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

/** The live OPFS root, or null where the platform has no OPFS. */
async function defaultGetOpfsRoot(): Promise<OpfsDirHandle | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return null;
  }
  try {
    return (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
  } catch {
    return null;
  }
}
