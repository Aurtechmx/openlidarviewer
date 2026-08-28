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
import { opfsSpillStore, removeOpfsStore, type OpfsDirHandle } from '../io/heavy/opfsSpillStore';
import { OlvTileSource, PreviewCloudSource } from '../io/heavy/OlvTileSource';
import { buildPreviewSample } from '../io/heavy/previewSampler';
import { TileChunkDecoder } from '../io/heavy/tileChunkDecoder';
import { revealStreamingScanChrome } from '../ui/streamingScanReveal';
import {
  activateCommittedStreamingCloud,
  enterStreamingInspectorMode,
  resetClassificationUi,
  type OpenStreamingDeps,
  type StreamingReportInput,
} from './openStreaming';
import type { StreamingSource } from '../render/streaming/StreamingSource';
import { LocalOocIndexerClient } from '../io/heavy/worker/localOocIndexerWorkerClient';
import type { LocalOocPhase } from '../io/heavy/localOocBuild';
import { readLazChunkTable } from '../io/heavy/lazChunkTable';
import { LocalFileRangeSource } from '../io/range/LocalFileRangeSource';
import type { RangeSource } from '../io/range/RangeSource';
import { LoadError } from '../io/loadErrors';
import { LoadCancelledError } from '../io/loadFile';
import type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
  HeavyOpenResult,
  LasHeaderFacts,
} from './heavyLasTypes';

/** Peak staging memory the bucketing pass may hold before spilling to OPFS. */
const BUILD_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

const PHASE_LABELS: Record<LocalOocPhase, string> = {
  indexing: 'Indexing for streaming…',
  finishing: 'Finishing the index…',
};

/**
 * The status shown WHILE the preview sample is up. It has to say two things at
 * once: what is on screen is a sample, and the full index is still building — so
 * the user cannot mistake a spread of the cloud for the finished scan.
 */
const PREVIEW_PHASE_LABEL = 'Preview sample, building the full index…';

/**
 * The refusal sentence for a heavy LAZ the chunked out-of-core path cannot
 * randomly decode. It names the true cause — no usable chunk table — and points
 * at COPC/EPT, the same convert advice every heavy refusal ends with, so the
 * user learns why the file will not open rather than watching the tab run out of
 * memory on a whole-file decode. Carried on a `refused` result, so
 * {@link describeHeavyRefusal} surfaces it verbatim.
 */
function describeUnchunkableLaz(fileName: string, reason: string): string {
  return (
    `${fileName} is a LAZ too large to open in one piece, and it has no usable chunk table ` +
    `for random access (${reason}), so it cannot be streamed out of core. ` +
    'Convert it to COPC or EPT (with PDAL or untwine) and open that instead, which streams ' +
    'from the file and writes no local cache.'
  );
}

/** A filesystem-safe store name derived from the file, stable for one file. */
function heavyStoreName(file: File): string {
  const base = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `ooc-${base}-${file.size}`;
}

/**
 * Build the tile store, reopen it from OPFS, and attach it as a streaming scan.
 * Called only when the decision half has confirmed the plan routes this file out
 * of core, so every failure path here is a CONFIRMED-heavy failure: it returns a
 * non-`attached`, `heavy: true` status the caller reads as "refuse, do not fall
 * back", because the whole-file loader would face the same too-large allocation.
 * `cancelled` is the one non-heavy tag: the user stopped the open on purpose.
 */
export async function executeHeavyLasBuild(
  file: File,
  signal: AbortSignal,
  facts: LasHeaderFacts,
  deps: HeavyLasBridgeDeps,
  env: Partial<HeavyLasBridgeEnv> = {},
): Promise<HeavyOpenResult> {
  const getOpfsRoot = env.getOpfsRoot ?? defaultGetOpfsRoot;
  const readStorage = env.readStorage ?? readStorageEstimate;
  const runIndex = env.runIndex ?? ((request) => new LocalOocIndexerClient().run(request));
  const openRange = env.openRange ?? ((f: File): RangeSource => new LocalFileRangeSource(f));

  // For a heavy LAZ, decide chunkability from a bounded chunk-table read BEFORE
  // any heavy work. The out-of-core LAZ builder decodes one window of chunks at a
  // time from the chunk table, so a LAZ without a usable table (a pointwise
  // pre-2011 compressor, an interrupted writer) cannot be randomly decoded. The
  // file is already confirmed too large for one ArrayBuffer, so it must FAIL
  // CLOSED here rather than fall through to the whole-file loader that would OOM
  // on a multi-gigabyte sequential decode. The read is bounded by the point-data
  // offset, so it never pulls more than the header/VLR region, and it runs in
  // this lazily-loaded chunk so the LAZ chunk-table code stays out of the eager
  // shell. LAS never reaches this branch.
  if (facts.format === 'laz') {
    const table = await readLazChunkTable(openRange(file), signal, facts.offsetToPointData);
    if (!table.supported) {
      return {
        status: 'refused',
        heavy: true,
        error: new LoadError('memory-constraint', describeUnchunkableLaz(file.name, table.reason)),
      };
    }
  }

  const root = await getOpfsRoot();
  if (root === null) return { status: 'unavailable', heavy: true, reason: 'no OPFS root' };

  // The disk guard. Sized from the declared point count and the record schema,
  // it refuses BEFORE any byte is written when the tile cache would not fit, or
  // when storage cannot even be read. The file is already confirmed heavy, so
  // this refusal reaches the user rather than falling through to a whole-file
  // load that would hit the same ceiling.
  const verdict = await storagePreflight(
    { pointCount: facts.declaredPointCount, schema: facts.schema },
    readStorage,
  );
  if (!verdict.proceed) {
    const error = storagePreflightRefusal(verdict, file.name);
    if (error) return { status: 'refused', heavy: true, error };
    return { status: 'unavailable', heavy: true, reason: 'preflight refused without a message' };
  }

  // PREVIEW FIRST. Before the long index build, put a bounded, stratified
  // sample on screen through the SAME streaming attach the real source uses, so
  // a multi-gigabyte file is not a blank wait. Best effort: any sampling fault
  // means no preview, never a failed open. The sample is honest — it reports its
  // own point count and its octree is incomplete — and it is attached WITHOUT
  // the committed-scan reveal, so nothing presents it as a finished scan. If the
  // build then completes, `attachStreamingCloud` replaces (and disposes) it.
  let previewAttached = false;
  try {
    const sample = await buildPreviewSample(openRange(file), facts, { signal });
    if (sample && !signal.aborted) {
      const previewSource = new PreviewCloudSource({
        id: `preview-${heavyStoreName(file)}`,
        name: file.name,
        sample,
      });
      const previewDecoder = new TileChunkDecoder(sample.schema, sample.recordBytes);
      await attachStreamingScan(previewSource, previewDecoder, deps, signal);
      deps.setPhase(PREVIEW_PHASE_LABEL);
      previewAttached = true;
    }
  } catch (err) {
    if (signal.aborted || isCancel(err)) {
      teardownPreview(previewAttached, deps);
      return { status: 'cancelled' };
    }
    if (deps.debug) console.warn('[heavy-las] preview sample skipped', err);
  }

  try {
    // While a preview is on screen the phase must keep saying it is a sample and
    // the full index is still building, so the user never reads the preview as
    // the finished cloud. Without a preview it is the plain build phase.
    const phaseFor = (phase: LocalOocPhase): string =>
      previewAttached ? PREVIEW_PHASE_LABEL : PHASE_LABELS[phase];
    deps.setPhase(phaseFor('indexing'));
    const built = await runIndex({
      file,
      storeName: heavyStoreName(file),
      kind: facts.format,
      memoryBudgetBytes: BUILD_MEMORY_BUDGET_BYTES,
      onPhase: (phase) => deps.setPhase(phaseFor(phase)),
      signal,
    });
    if (signal.aborted) {
      teardownPreview(previewAttached, deps);
      return { status: 'cancelled' };
    }

    const dir = await root.getDirectoryHandle(built.storeName);
    const spill = opfsSpillStore(dir);
    const reader = openTileStore(built.manifestJson, built.hierarchy);
    const source = new OlvTileSource({
      id: `ooc-${built.storeName}`,
      name: file.name,
      store: reader,
      tiles: tileBytesReader(spill),
      // The out-of-core store is TEMPORARY for this release: nothing reuses it
      // on a later open, so a persisted `ooc-<name>-<size>` directory is pure
      // cost. On close, release the open tile handles FIRST (so a close racing
      // a read unlocks before anything is deleted), THEN remove the store. The
      // removal is fired without letting a rejection escape the close — a store
      // the browser cannot delete because a read still holds it is left stale
      // and rebuilt on the next open, which is the honest fallback. Persistent
      // cross-session reuse via a source fingerprint is the future direction.
      close: async () => {
        await spill.close();
        try {
          await removeOpfsStore(root, built.storeName);
        } catch (err) {
          if (deps.debug) console.warn('[heavy-las] out-of-core store removal failed', err);
        }
      },
    });
    const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);

    await attachHeavyStream(source, decoder, deps, signal);
    return { status: 'attached', source, decoder };
  } catch (err) {
    // A cancel or a build fault must not leave the preview stranded on screen
    // labelled "building the full index" when nothing is building any more.
    teardownPreview(previewAttached, deps);
    if (signal.aborted || isCancel(err)) {
      return { status: 'cancelled' };
    }
    if (deps.debug) console.warn('[heavy-las] out-of-core open failed; refusing', err);
    return { status: 'failed', heavy: true, error: err };
  }
}

/**
 * Whether a thrown error is a cancellation on its own terms. A user cancel
 * surfaces as a {@link LoadCancelledError} or a DOM `AbortError`. An aborted read
 * can also surface as a `RangeReadError`, which is ambiguous (a genuine read
 * failure raises the same type), so that case is decided by the `signal.aborted`
 * check at the call site rather than here, and is not folded in.
 */
function isCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return err instanceof LoadCancelledError || name === 'AbortError';
}

/**
 * Detach a still-attached preview scan. Called on every non-`attached` exit
 * after a preview went up: a successful full attach already replaced and
 * disposed it through `attachStreamingCloud`, but a cancel or a fault never
 * reaches that swap, so the preview would otherwise stay on screen. Detaching
 * disposes the (in-memory) preview session; a viewer with no preview is a no-op.
 */
function teardownPreview(previewAttached: boolean, deps: HeavyLasBridgeDeps): void {
  if (!previewAttached) return;
  try {
    deps.getViewer().detachStreamingCloud();
  } catch (err) {
    if (deps.debug) console.warn('[heavy-las] preview teardown failed', err);
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
  await attachStreamingScan(source, decoder, deps, signal);
  revealHeavyStreamingSurfaces(source, deps.streaming);
}

/**
 * Attach a streaming source and reveal the scan CHROME (dock, nav bar,
 * inspector), stopping short of the committed-scan reveal. Shared by the full
 * out-of-core open and the preview: the preview needs the cloud on screen and
 * the chrome to orbit it, but NOT `revealHeavyStreamingSurfaces`, which
 * publishes the scan report, provenance, CRS and the Analyse rail as a finished
 * scan — a claim a sample must not make. The full open calls this and then adds
 * that reveal.
 *
 * `attachStreamingCloud` is transactional: it builds the new session first and
 * aborts before its commit if `signal` fired, and on a streaming→streaming swap
 * it detaches and disposes the previous cloud only after the replacement is
 * built. So attaching the real source over the preview replaces it with no leak,
 * and a cancel mid-build keeps whatever scene was already up.
 */
async function attachStreamingScan(
  source: StreamingSource,
  decoder: TileChunkDecoder,
  deps: HeavyLasBridgeDeps,
  signal: AbortSignal,
): Promise<void> {
  await deps.viewerReady;
  const viewer = deps.getViewer();
  await viewer.ready;
  if (signal.aborted) throw new LoadCancelledError();
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

/**
 * Reveal the streaming surfaces a committed out-of-core scan supports, the same
 * ones COPC, EPT and 3D Tiles reveal after their commit, routed through their
 * shared helpers so a fourth format is a call, not a transcription (PR #648's
 * `openTilesetLayer` reveal is the model for judging each call on its merits).
 *
 * KEEP, because an `OlvTileSource` genuinely supports them:
 *  - the streaming panel (`show`, `setColorModes`, `setQuality`, `setPhase`):
 *    the colour modes come from the tile store's own schema — rgb only when the
 *    source LAS carried it, plus intensity / elevation / classification, which
 *    every tile record holds by layout — not from the format.
 *  - `resetClassificationUi`: classification IS a real channel here, so this is
 *    the empty-and-waiting COPC reset (the legend seeds lazily as classified
 *    nodes become resident), NOT the inapplicable-hidden tileset case.
 *  - the streaming Inspector / Export layout and the image-export gate
 *    (`enterStreamingInspectorMode`), off the live viewer's availability.
 *  - `inspector.setDetail` and the streaming Scan Report with the REAL total:
 *    the store states its tile total, so both show a measured count rather than
 *    the tileset's "not stated by the source".
 *  - `activateCommittedStreamingCloud` (usage, provenance, CRS), the Analyse
 *    rail, the export pre-warm, a fresh saved-views list, the status poll.
 *
 * SKIP, because the source cannot honestly fill them:
 *  - `setSourceUrl`: the store is built from a LOCAL file with no publisher to
 *    credit (COPC guards the same call behind `http-range`).
 *  - `setSummary`: the panel's format vocabulary is `copc | ept | 3dtiles`, none
 *    of which names a decoded out-of-core LAS store; mislabelling it is worse
 *    than omitting the row, and the real point total still reaches the user
 *    through the Scan Report and the Inspector detail row.
 */
function revealHeavyStreamingSurfaces(source: OlvTileSource, s: OpenStreamingDeps): void {
  // Publish the committed scan's usage, provenance and CRS — never before the
  // commit — exactly as the COPC / EPT / tileset opens do.
  activateCommittedStreamingCloud(source, s);

  const viewer = s.getViewer();
  s.streamingPanel.setColorModes([...source.availableColorModes()], source.defaultColorMode());
  s.streamingPanel.setQuality(s.getStreamingQuality());
  s.streamingPanel.setPhase('Streaming coarse geometry…');
  resetClassificationUi(s);
  enterStreamingInspectorMode(s, viewer.availableImageExportModes());

  try {
    s.inspector.setDetail(source.sourcePointCount, source.sourcePointCount);
  } catch (err) {
    if (s.debug) console.warn('[inspector] setDetail (heavy) threw', err);
  }
  const reportCloud: StreamingReportInput = {
    kind: source.kind,
    name: source.name,
    sourcePointCount: source.sourcePointCount,
    maxDepth: () => source.maxDepth(),
    octree: { nodes: () => source.octree.nodes() },
    crs: () => source.crs(),
  };
  s.setLastStreamingReportCloud(reportCloud);
  try {
    s.inspector.setReport(
      s.runStreamingModules(reportCloud, s.classLegendPanel.getVisibility().isFiltered()),
    );
  } catch (err) {
    if (s.debug) console.warn('[inspector] setReport (heavy) threw', err);
  }

  s.prewarmExportStudio();
  s.revealAnalysePanel(source.name, false);
  s.streamingPanel.show();

  try {
    s.bookmarks.clear();
    s.refreshViewsUI();
  } catch (err) {
    if (s.debug) console.warn('[views] saved-views refresh (heavy) threw', err);
  }
  s.startStreamingStatusPolling();
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
