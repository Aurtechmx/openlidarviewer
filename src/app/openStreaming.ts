/**
 * openStreaming.ts — the remote / streaming open pipeline lifted out of main.ts.
 *
 * Two functions live here: {@link openStreamingCopc}, which opens a COPC scan
 * from any range-readable source (a local file or a remote HTTP URL) through the
 * streaming pipeline, and {@link handleRemoteEpt}, which opens a remote EPT
 * dataset by its `ept.json` URL. Both read the metadata / hierarchy, attach the
 * streaming cloud to the viewer, and reveal the streaming chrome; the format
 * difference stops at attach — the scheduler / renderer / picking path never
 * sees it.
 *
 * The genuinely pure decisions the pipeline makes are extracted as free
 * functions so they are Node-testable without a Viewer, the network or the DOM:
 * {@link isEptUrl} (the COPC-vs-EPT routing predicate the shell's URL router
 * dispatches on), {@link isAbortError} (the user-cancel classifier both remote
 * handlers surface through) and {@link linkAbortSignals} (composing an outer
 * Cancel with a load's own controller). Everything else is imperative view
 * orchestration, driven through a structural {@link OpenStreamingDeps} of
 * accessor functions closing over the shell's services and its mutable
 * streaming-session state rather than the Viewer class — the same seam
 * `openScan` and `sessionIo` use. The heavy runtime actions (the lazy COPC /
 * EPT / diagnostics chunks) are passed in so this module stays free of the boot
 * graph. `main.ts` keeps thin `openStreamingCopc` / `handleRemoteEpt` delegates
 * that bind its running state to these deps. Part of the v0.6 decomposition
 * (see `docs/architecture/architecture-map.md`).
 */

import { LoadCancelledError } from '../io/loadFile';
import { describeLoadError } from '../io/loadErrors';
import { increment as recordUsage } from '../diagnostics/usageCounters';
import { remoteCopcName, remoteEptName } from './remoteSourceNaming';

import type { RangeSource } from '../io/range/RangeSource';
import { sanitizeUrlForDisplay } from '../io/range/RangeSource';
import type { StreamingQuality } from '../render/streaming/streamingBudget';
import type { StreamingBenchmark } from '../render/streaming/streamingBenchmark';
import type { CopcWorkerClient } from '../io/copc/worker/copcWorkerClient';
import type { EptLaszipWorkerClient } from '../io/ept/worker/eptLaszipWorkerClient';
import type { CrsInfo, CrsLinearUnit } from '../io/crs';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { Viewer } from '../render/Viewer';
import type { Inspector } from '../ui/Inspector';
import type { Stage } from '../ui/Stage';
import type { DropZone } from '../ui/DropZone';
import type { StreamingPanel } from '../ui/StreamingPanel';
import type { ClassLegendPanel } from '../ui/ClassLegendPanel';
import type { InspectorCardRefreshers } from './inspectorCardRefreshers';
import type { CrsCoordinator } from './crsCoordinator';
import type { ViewBookmarksService } from './viewBookmarks';
import type {
  loadStreamingPointCloud,
  loadCopcWorkerClient,
  loadStreamingColors,
  loadEptLaszipWorkerClient,
  loadEpt,
} from '../lazyChunks';

// ─────────────────────────────────────────────────────────────────────────────
// Pure decisions the extraction exposes — decidable without a Viewer, the
// network or the DOM, so `tests/openStreaming.test.ts` pins each one directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `url` is an EPT entry point (an `ept.json`), so the shell's URL
 * router hands it to {@link handleRemoteEpt} instead of the COPC path. The check
 * is URL-pattern only — fast, no network, no schema fetch — mirroring
 * `detectEptUrl` in `eptDetect.ts` so the routing decision is synchronous and
 * does not depend on the EPT lazy chunk loading. A malformed URL that `new URL`
 * cannot parse still gets a raw-string test, so it routes deterministically
 * rather than throwing.
 */
export function isEptUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(?:^|\/)ept\.json$/i.test(u.pathname);
  } catch {
    return /(?:^|\/)ept\.json(?:\?|#|$)/i.test(url);
  }
}

/**
 * True when `err` is a user-initiated abort, in any of the shapes a cancel can
 * surface as on the remote-open path:
 *
 *  - the platform's DOMException named `AbortError` (a fetch aborted directly by
 *    the linked signal), or
 *  - `RangeReadError` with code `'aborted'` — `HttpRangeSource` wraps the
 *    platform abort in its typed error before it reaches us.
 *
 * The Stage URL-field Cancel aborts the linked signal while a fetch or range
 * probe is in flight; neither rejection is our `LoadCancelledError`, so cancel
 * handling must recognise all three shapes.
 *
 * An internal request timeout is NOT one of them: the COPC transport surfaces it
 * as `RangeReadError` code `'timeout'` and the EPT transport as `EptTimeoutError`
 * (`code: 'timeout'`), and both stay VISIBLE failures rather than silent
 * cancellations. The explicit `'timeout'` guard below keeps that true even if a
 * timeout ever reached here carrying an abort-ish name.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.code === 'timeout') return false;
  if (e.name === 'AbortError') return true;
  return e.name === 'RangeReadError' && e.code === 'aborted';
}

/**
 * Wire an optional outer abort signal (the Stage URL field's Cancel button) into
 * a load's own AbortController (the progress toast's Cancel) so EITHER cancel
 * aborts the in-flight fetches. Returns a cleanup that detaches the listener —
 * call it on every exit path so a long-lived outer signal can't accumulate
 * listeners across loads. (Mirrors the private `composeSignals` discipline
 * inside `HttpRangeSource`.)
 */
export function linkAbortSignals(
  outer: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!outer) return () => {};
  if (outer.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = (): void => controller.abort();
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

/**
 * The streaming Scan Report's input — the structural cloud shape
 * `runStreamingModules` reads. Kept identical to the shell's own parameter type
 * so the COPC source (a `StreamingPointCloud`) and the EPT path's hand-built
 * report cloud both satisfy it, and `lastStreamingReportCloud` round-trips.
 */
export type StreamingReportInput = {
  readonly kind: 'copc' | 'ept';
  readonly name: string;
  readonly sourcePointCount: number;
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
  readonly metadata?: {
    readonly header?: {
      min: readonly [number, number, number];
      max: readonly [number, number, number];
      pointDataRecordFormat?: number;
    };
    readonly info?: { spacing?: number };
    readonly captureSensor?: string;
    readonly sourceSoftware?: string;
  };
  readonly crs?: () => { readonly linearUnit?: CrsLinearUnit; readonly linearUnitToMetres?: number; readonly verticalUnitToMetres?: number } | null;
  readonly maxDepth?: () => number;
  readonly octree?: { nodes: () => readonly unknown[] };
};

/**
 * The running-app seam the streaming opens write through. Accessors are
 * functions, not snapshots, so the lazily-bound Viewer, the mutable load flag
 * and the streaming-session state (`streamingBenchmark`, the decode workers, the
 * quality preset) are read at call time — exactly as the inline versions read
 * the shell's module-level `let`s. That session state is shared with code that
 * stays in the shell (`closeStreaming`, the status poll, the render-loop
 * sample), so it moves behind get/set accessors rather than into this module.
 * The heavy runtime actions (the lazy COPC / EPT / diagnostics chunks) are
 * passed in so this module stays free of the loader / boot graph.
 */
export interface OpenStreamingDeps {
  // ── Lazy runtime chunks (each an `import()` split point in lazyChunks.ts) ──
  loadStreamingPointCloud: typeof loadStreamingPointCloud;
  loadCopcWorkerClient: typeof loadCopcWorkerClient;
  loadStreamingColors: typeof loadStreamingColors;
  loadEptLaszipWorkerClient: typeof loadEptLaszipWorkerClient;
  loadEpt: typeof loadEpt;
  /** The `?benchmark=1` / `?debug=1` diagnostics runtime — only the two members these opens construct. */
  loadDiagnostics: () => Promise<{
    StreamingBenchmark: new () => StreamingBenchmark;
    InstrumentedRangeSource: new (inner: RangeSource, onBytes: (bytes: number) => void) => RangeSource;
  }>;

  /** Resolves once the lazily-loaded Viewer chunk is in place — awaited before any `getViewer()`. */
  readonly viewerReady: Promise<unknown>;
  /** The live Viewer (a late-bound `let` in the shell). */
  getViewer: () => Viewer;

  // ── One-load-at-a-time guard (the shell's `loading` flag) ──
  isLoading: () => boolean;
  setLoading: (loading: boolean) => void;

  // ── Streaming-session state shared with the shell — read/written at call
  //    time through accessors so both sides see one value ──
  getStreamingBenchmark: () => StreamingBenchmark | null;
  setStreamingBenchmark: (benchmark: StreamingBenchmark | null) => void;
  setCoarseStableFired: (fired: boolean) => void;
  getCopcDecoder: () => CopcWorkerClient | null;
  setCopcDecoder: (decoder: CopcWorkerClient) => void;
  getEptLaszipDecoder: () => EptLaszipWorkerClient | null;
  setEptLaszipDecoder: (decoder: EptLaszipWorkerClient) => void;
  getStreamingQuality: () => StreamingQuality;
  setLastStreamingReportCloud: (cloud: StreamingReportInput) => void;

  // ── URL flags ──
  readonly debug: boolean;
  readonly benchmark: boolean;

  // ── Toast + drop-zone status surface ──
  showToast: (message: string) => void;
  dropZone: Pick<DropZone, 'setError' | 'setOpening' | 'setCancelHandler' | 'setProgress'>;

  // ── View collaborators ──
  stage: Pick<Stage, 'hideEmptyState'>;
  inspector: Inspector;
  streamingPanel: Pick<StreamingPanel, 'setPhase' | 'show' | 'setColorModes' | 'setQuality' | 'setSummary'>;
  classLegendPanel: Pick<ClassLegendPanel, 'setClasses' | 'hide' | 'getVisibility'>;
  inspectorCards: Pick<
    InspectorCardRefreshers,
    'refreshProvenanceFromStreaming' | 'refreshDatasetIntelligenceFromStreamingCloud'
  >;
  crsCoordinator: Pick<CrsCoordinator, 'refreshCrsForStreamingCloud'>;
  bookmarks: Pick<ViewBookmarksService, 'clear'>;

  /** Phone-class device — tighter streaming budget + touch hints. */
  isPhone: () => boolean;

  // ── Session lifecycle helpers that stay in the shell ──
  /** Tear down any open streaming scan (a failed open tidies up; a replacement supersedes). */
  closeStreaming: () => void;
  /** Free the open static layers — a streaming scan is exclusive. */
  clearOpenStaticLayers: () => void;
  /** Start the ~4 Hz streaming-status poll that drives the panel. */
  startStreamingStatusPolling: () => void;
  /** Reveal the scan-dependent chrome (dock, inspector, nav bar, `olv-has-scan`) for a streaming cloud. */
  revealStreamingChrome: () => void;
  /** Reveal the Analyse panel for the streaming scan. */
  revealAnalysePanel: (name: string, settled?: boolean) => void;
  /** Pre-warm the lazy Visual Export Studio chunk. */
  prewarmExportStudio: () => void;
  /** Fire the streaming + format chunk pre-warm for a URL open. */
  prewarmForUrl: (url: string) => void;
  /** Repopulate the saved-views list after a fresh streaming open. */
  refreshViewsUI: () => void;
  /** Hide the reclassify UI for the new streaming scan. */
  hideReclassifyUi: () => void;
  /** Clear any prior scan's inspector copy/JSON class-scope stamp. */
  syncInspectClassScope: () => void;
  /** Run the streaming analysis modules for the Scan Report. */
  runStreamingModules: (cloud: StreamingReportInput, classFilterActive?: boolean) => AnalysisRow[];
}

/**
 * Open a COPC scan from any range-readable source — a local file or a remote
 * HTTP URL — through the streaming pipeline: read the metadata and hierarchy,
 * attach the streaming cloud to the viewer, and show the streaming panel.
 * Point data then streams in progressively, driven by the camera.
 */
export async function openStreamingCopc(
  range: RangeSource,
  displayName: string,
  signal: AbortSignal,
  deps: OpenStreamingDeps,
): Promise<void> {
  // Race the lazy COPC + streaming chunks against `viewer.ready` so a
  // user who opens a scan during the first ~half-second of page load
  // (a common demo path) doesn't see chunk-fetch and GPU init run
  // serially. By the time `viewer.ready` resolves the chunks are
  // usually cached too — `await chunksPromise` below typically
  // resolves immediately. On a cold start, the parallelism saves
  // roughly the smaller of the two latencies (often 100-300 ms).
  const chunksPromise = Promise.all([
    deps.loadStreamingPointCloud(),
    deps.loadCopcWorkerClient(),
    deps.loadStreamingColors(),
  ]);

  // Show the streaming panel as soon as we know we're on the COPC branch —
  // before `await viewer.ready`, which on cold WebGPU runners can sit for
  // 10–18 s compiling shaders. The panel reads "Loading metadata…" while
  // the viewer warms up, so the user gets immediate confirmation that the
  // file was recognised as COPC instead of staring at the empty state.
  deps.streamingPanel.setPhase('Loading metadata…');
  deps.streamingPanel.show();

  const viewer = deps.getViewer();
  await viewer.ready;
  // Inspector stays visible during streaming — it carries the sections
  // that work uniformly against either source type (Scan report,
  // Provenance, Coordinate system, Image export, Report PDF). The
  // static-only sections are hidden via `setStreamingMode(true)` when
  // the streaming cloud finishes attaching; until then the Inspector
  // shows its empty placeholders, which is fine.
  deps.inspector.element.classList.remove('olv-hidden');
  deps.dropZone.setProgress('Reading COPC hierarchy…');

  // The streaming benchmark collector is created when either `?benchmark=1`
  // (which adds a session report on close) or `?debug=1` (which surfaces the
  // live thrash / scheduler-histogram readout in the overlay) is set. Off by
  // default — no overhead in normal sessions. The diagnostics chunk loads
  // lazily on first need; cached afterwards.
  if (deps.benchmark || deps.debug) {
    const d = await deps.loadDiagnostics();
    deps.setStreamingBenchmark(new d.StreamingBenchmark());
    deps.setCoarseStableFired(false);
    range = new d.InstrumentedRangeSource(range, (n) => {
      deps.getStreamingBenchmark()?.recordNetworkBytes(n);
    });
  }

  // Await the hoisted chunk fetches; if `viewer.ready` was the slow
  // path (cold WebGPU init) this is a no-op.
  const [{ StreamingPointCloud }, { CopcWorkerClient }, streamingColors] =
    await chunksPromise;

  const cloud = await StreamingPointCloud.open(range, displayName, signal);
  if (signal.aborted) throw new LoadCancelledError();

  let copcDecoder = deps.getCopcDecoder();
  if (!copcDecoder) {
    copcDecoder = new CopcWorkerClient();
    deps.setCopcDecoder(copcDecoder);
  }
  // Wire the per-chunk decode timing hook only when a benchmark is collecting;
  // clearing it on close keeps a non-benchmark session free of any callback.
  copcDecoder.onDecodeMs = deps.getStreamingBenchmark()
    ? (ms) => deps.getStreamingBenchmark()?.recordDecodeMs(ms)
    : undefined;

  deps.stage.hideEmptyState();
  // Local-first counter — categorical only ('copc' or 'ept'); never the URL.
  recordUsage('scan-open', cloud.kind === 'ept' ? 'ept' : 'copc');
  // Provenance fingerprint for streaming clouds — fed with the cloud's
  // declared point count + extent so the classifier has signal even though
  // the resident set is small. Wrapped because a malformed cloud shape
  // shouldn't break the rest of the streaming load (CRS, attach, color
  // modes, navBar reveal).
  try { deps.inspectorCards.refreshProvenanceFromStreaming(cloud); }
  catch (err) { if (deps.debug) console.warn('[provenance] refreshProvenanceFromStreaming threw', err); }
  // CRS for streaming clouds — same merge rule as the static path.
  try {
    deps.crsCoordinator.refreshCrsForStreamingCloud(cloud as unknown as {
      readonly name: string;
      readonly kind: 'copc' | 'ept';
      crs(): CrsInfo | undefined;
    });
  } catch (err) {
    if (deps.debug) console.warn('[crs] refreshCrsForStreamingCloud threw', err);
  }
  // A streaming scan is exclusive — clear open static layers at the last
  // moment, after the source opened above and just before its replacement
  // attaches, so a failed open left the current scene intact. The abort check
  // at the open still guards this; nothing yields between it and here.
  deps.clearOpenStaticLayers();
  await viewer.attachStreamingCloud(
    cloud,
    copcDecoder,
    deps.getStreamingQuality(),
    deps.isPhone(),
    deps.getStreamingBenchmark(),
  );
  // attachStreamingCloud takes no signal; if the user cancelled while it ran,
  // drop the fresh cloud so a cancel adds nothing rather than half-attaching.
  if (signal.aborted) { deps.closeStreaming(); throw new LoadCancelledError(); }
  viewer.setMode('orbit');
  viewer.frameAll();

  deps.streamingPanel.setColorModes(
    streamingColors.availableStreamingModes(cloud.metadata),
    streamingColors.defaultStreamingMode(cloud.metadata),
  );
  deps.streamingPanel.setQuality(deps.getStreamingQuality());
  deps.streamingPanel.setPhase('Streaming coarse geometry…');
  // Classification legend (v0.4.1) — reset to empty for the new streaming scan.
  // The legend is seeded + revealed lazily by `viewer.onStreamingNodeClasses`
  // as nodes carrying classification become resident, and refines as deeper
  // nodes stream in. A streaming source without a classification channel simply
  // never seeds the legend, so it stays hidden.
  deps.classLegendPanel.setClasses(new Map());
  deps.classLegendPanel.hide();
  deps.hideReclassifyUi();
  // Clear any prior filtered scan's inspector copy/JSON scope stamp.
  deps.syncInspectClassScope();
  // Visual Export Studio — a streaming COPC cloud is now attached;
  // the image-export buttons in the Inspector can light up. The streaming
  // path doesn't go through `inspector.addCloud`, so the gate has to flip
  // here too. Pre-warm the Studio chunk for the same reason as above.
  deps.inspector.setImageExportEnabled(true);
  // Per-mode gating — streaming COPC / EPT rarely carry normals or
  // classification; disable the corresponding buttons at the source.
  deps.inspector.setImageExportAvailability(viewer.availableImageExportModes());
  // Switch the Inspector into streaming layout — hides Layers / Color by
  // / Point size / Rendering / Export (their streaming-equivalents are
  // in the StreamingPanel) and pins the panel to the lower-right so
  // both panels coexist on desktop.
  deps.inspector.setStreamingMode(true);
  try { deps.inspector.setDetail(cloud.sourcePointCount, cloud.sourcePointCount); }
  catch (err) { if (deps.debug) console.warn('[inspector] setDetail (streaming) threw', err); }
  deps.setLastStreamingReportCloud(cloud);
  try { deps.inspector.setReport(deps.runStreamingModules(cloud, deps.classLegendPanel.getVisibility().isFiltered())); }
  catch (err) { if (deps.debug) console.warn('[inspector] setReport (streaming) threw', err); }
  try {
    deps.inspectorCards.refreshDatasetIntelligenceFromStreamingCloud(cloud);
  } catch (err) {
    if (deps.debug) console.warn('[inspector] dataset intel (streaming) threw', err);
  }
  deps.prewarmExportStudio();

  // The metadata-driven scan summary, and a fresh saved-views list.
  const header = cloud.metadata.header;
  deps.revealAnalysePanel(cloud.name, false); // streaming COPC also gets the terrain tools
  deps.streamingPanel.setSummary({
    fileName: cloud.name,
    pointFormat: header.pointDataRecordFormat,
    sourcePoints: cloud.sourcePointCount,
    width: header.max[0] - header.min[0],
    depth: header.max[1] - header.min[1],
    height: header.max[2] - header.min[2],
    spacing: cloud.metadata.info.spacing,
    octreeDepth: cloud.maxDepth(),
    nodeCount: cloud.octree.nodes().length,
    // explicit format tag so the Scan Intelligence panel renders
    // "COPC LAZ · PDRF N" for COPC and "EPT · binary · N attrs" for EPT.
    format: 'copc',
    // Carry the CRS so the spacing row states its unit honestly (metre / foot→m
    // / source units / geographic) instead of unconditionally labelling "m".
    crs: cloud.crs(),
  });
  deps.bookmarks.clear();
  deps.refreshViewsUI();

  deps.revealStreamingChrome();

  deps.startStreamingStatusPolling();
  deps.dropZone.setProgress(null);
}

/**
 * open a remote EPT dataset by its `ept.json` URL. Mirrors the
 * `handleRemoteCopc` flow:
 *   1. Validate the URL.
 *   2. Fetch + parse + validate `ept.json` (typed failure paths surface
 *      as user-readable error messages, same as COPC's malformed-file
 *      path).
 *   3. Open an `EptStreamingPointCloud` against an HTTP-backed transport.
 *   4. Hand it to the same `viewer.attachStreamingCloud` the COPC flow
 *      uses — the scheduler / renderer / picking path don't see the
 *      format difference.
 */
export async function handleRemoteEpt(
  url: string,
  signal: AbortSignal | undefined,
  deps: OpenStreamingDeps,
): Promise<void> {
  if (deps.isLoading()) {
    deps.showToast('Already loading — cancel the current load first.');
    return;
  }
  // Claim the flag SYNCHRONOUSLY. Every await below yields to the event
  // loop, and a second open started in that window used to pass the
  // `loading` guard too (TOCTOU). The `finally` below is the only reset.
  deps.setLoading(true);
  const controller = new AbortController();
  // Compose the Stage URL-field Cancel (outer signal) with the progress
  // toast's Cancel (this controller): either abort cancels the load.
  const unlinkAbort = linkAbortSignals(signal, controller);
  // Fire the streaming + EPT chunk pre-warm immediately. Each dynamic
  // import is one HTTP fetch + parse; running them in parallel with
  // the manifest GET below cuts cold-start by 200–700 ms.
  deps.prewarmForUrl(url);
  // Declared outside the try so the catch can use the module's error
  // classifier when the module loaded, and a plain classifier when the
  // chunk fetch itself was the failure.
  let eptUrlMod: Awaited<ReturnType<OpenStreamingDeps['loadEpt']>> | null = null;
  try {
    // URL validation is pure — run it before awaiting the lazy Viewer so a
    // malformed URL always surfaces an error toast, even if the Viewer chunk
    // hasn't loaded yet or the GPU backend can't initialise.
    eptUrlMod = await deps.loadEpt();
    const check = eptUrlMod.validateRemoteEptUrl(url);
    if (!check.ok) {
      deps.dropZone.setError(`${check.reason} Enter the full https://…/ept.json URL.`);
      return;
    }
    // Every remote request below uses the validator's RETURNED url, not the raw
    // input. `validateRemoteEptUrl` -> `validateRemoteCopcUrl` runs the shared
    // host-safety gate (`isBlockedHost` rejects loopback, private, link-local and
    // metadata hosts), so the fetched url is the one that passed the SSRF barrier
    // rather than an unchecked user string.
    const safeUrl = check.url;
    // The actual streaming open touches viewer state — defer until the lazy
    // Viewer chunk is up.
    await deps.viewerReady;
    const viewer = deps.getViewer();
    // Blue blinking "Opening …" first, consistent with the COPC + device paths;
    // the manifest read + node streaming supersede it with staged progress.
    deps.dropZone.setOpening(`Opening ${remoteCopcName(url)}…`);
    deps.dropZone.setCancelHandler(() => controller.abort());
    const { parseEptMetadata, EptStreamingPointCloud, EptChunkDecoder, EptTimeoutError } = eptUrlMod;

    // Fetch the manifest. We use plain `fetch` rather than the HttpRangeSource:
    // ept.json is a small JSON document, not a range-served binary. It gets the
    // same per-request TIMEOUT as the hardened hierarchy/tile transport (20 s),
    // so a stalled manifest aborts instead of hanging until the user cancels;
    // the timeout is composed with the outer load-cancel signal. Single attempt
    // (no retry) — a failed manifest surfaces an error and the user re-opens.
    const MANIFEST_TIMEOUT_MS = 20_000;
    const manifestTimeout = new AbortController();
    const manifestTimer = setTimeout(() => manifestTimeout.abort(), MANIFEST_TIMEOUT_MS);
    const onOuterAbort = () => manifestTimeout.abort();
    controller.signal.addEventListener('abort', onOuterAbort, { once: true });
    let manifestResponse: Response;
    try {
      // `redirect: 'error'`: the host was validated against the SSRF block-list,
      // but a 3xx could send the fetch to a private address the validator never
      // saw (it does not resolve DNS or follow hops). Refuse redirects so a
      // validated public URL cannot be bounced somewhere internal.
      manifestResponse = await fetch(safeUrl, { signal: manifestTimeout.signal, redirect: 'error' });
    } catch (err) {
      // manifestTimeout is aborted by the 20 s timer OR, composed, by the outer
      // load-cancel. Only the timer firing with no user cancel is a timeout:
      // surface it as the typed EptTimeoutError (code 'timeout') so isAbortError
      // does not read it as a cancel and describeRemoteEptError renders it as a
      // timeout rather than a silent stop. A real user cancel rethrows unchanged.
      if (isAbortError(err) && !controller.signal.aborted) {
        // Sanitize the URL for the message: a signed EPT URL (?sig=…, SAS token)
        // must not reach err.message, which the debug path logs to console.error.
        // The hierarchy/tile/retry transport paths already do this; the manifest
        // timeout was the one seam that still used the raw URL.
        throw new EptTimeoutError(
          `EPT manifest request timed out after ${MANIFEST_TIMEOUT_MS} ms for ${sanitizeUrlForDisplay(url)}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(manifestTimer);
      controller.signal.removeEventListener('abort', onOuterAbort);
    }
    if (!manifestResponse.ok) {
      throw new Error(
        `EPT manifest fetch failed (${manifestResponse.status} ${manifestResponse.statusText}).`,
      );
    }
    const manifestText = await manifestResponse.text();
    const detection = parseEptMetadata(manifestText);
    if (!detection.isEpt) {
      throw new Error(`Not a valid EPT manifest — ${detection.reason}`);
    }

    await viewer.ready;
    deps.streamingPanel.setPhase('Building hierarchy…');
    deps.streamingPanel.show();
    // Inspector stays visible during streaming — same rationale as the
    // COPC path. Streaming-only sections drop out via setStreamingMode
    // once the cloud finishes attaching.
    deps.inspector.element.classList.remove('olv-hidden');

    // Compute the dataset base URL by stripping the ept.json filename;
    // the source uses it to build hierarchy + tile URLs.
    const baseUrl = safeUrl.replace(/ept\.json(?:\?.*)?(?:#.*)?$/i, '');
    // The base URL drops the manifest's query, so re-attach the auth query
    // (e.g. an Azure SAS / CDN `?token=…`) to every derived hierarchy + tile
    // request — otherwise a signed dataset validates, loads ept.json, then
    // 401/403s on the first hierarchy fetch. (A per-object presigned signature
    // bound to ept.json alone still can't authorise the hierarchy — that stays
    // an honest hierarchy-fetch error.)
    const eptSearch = eptUrlMod.eptUrlSearch(safeUrl);

    // hardened EPT transport: retry-with-backoff (3 retries),
    // per-attempt timeout (20 s), abort discipline composed with the outer
    // load-cancel signal. Mirrors the discipline `HttpRangeSource` brings
    // to the COPC path. Typed error messages flow through to
    // `describeRemoteEptError` for the user-facing classifier.
    const transport = eptUrlMod.createEptTransport();

    const cloud = await EptStreamingPointCloud.open(
      detection.metadata,
      baseUrl,
      remoteEptName(url),
      transport,
      controller.signal,
      eptSearch,
    );
    if (controller.signal.aborted) throw new LoadCancelledError();

    deps.stage.hideEmptyState();

    // Laszip tiles are CPU-heavy (laz-perf decompress + coordinate transform);
    // decode them off the main thread in a dedicated worker, created lazily and
    // reused for the session like the COPC decode worker. The binary path stays
    // in-process (microsecond decodes) so it never pays the worker round-trip.
    if (cloud.dataType === 'laszip' && !deps.getEptLaszipDecoder()) {
      const { EptLaszipWorkerClient } = await deps.loadEptLaszipWorkerClient();
      deps.setEptLaszipDecoder(new EptLaszipWorkerClient());
    }
    const decoder = new EptChunkDecoder(
      cloud,
      cloud.dataType === 'laszip' ? deps.getEptLaszipDecoder() : null,
    );
    // A streaming scan is exclusive — replace any prior streaming/static scene
    // at the last moment, after the EPT source opened and the decoder is ready,
    // so a failed or cancelled step above left the current scene intact.
    if (controller.signal.aborted) throw new LoadCancelledError();
    if (viewer.hasStreamingCloud) deps.closeStreaming();
    deps.clearOpenStaticLayers();
    await viewer.attachStreamingCloud(
      cloud,
      decoder,
      deps.getStreamingQuality(),
      deps.isPhone(),
      null,
    );
    // attachStreamingCloud takes no signal; if the user cancelled while it ran,
    // drop the fresh cloud so a cancel adds nothing rather than half-attaching.
    if (controller.signal.aborted) { deps.closeStreaming(); throw new LoadCancelledError(); }
    viewer.setMode('orbit');
    viewer.frameAll();

    deps.streamingPanel.setColorModes(
      // The interface returns a readonly array; the panel accepts a mutable
      // ColorMode[], so we materialise a copy.
      [...cloud.availableColorModes()],
      cloud.defaultColorMode(),
    );
    deps.streamingPanel.setQuality(deps.getStreamingQuality());
    deps.streamingPanel.setPhase('Streaming coarse geometry…');
    deps.inspector.setImageExportEnabled(true);
    // Per-mode gating — EPT streams almost never carry normals.
    deps.inspector.setImageExportAvailability(viewer.availableImageExportModes());
    // Same streaming-mode layout the COPC path uses — hide Inspector's
    // static-cloud sections and populate the streaming Scan Report.
    deps.inspector.setStreamingMode(true);
    try { deps.inspector.setDetail(cloud.sourcePointCount, cloud.sourcePointCount); }
    catch (err) { if (deps.debug) console.warn('[inspector] setDetail (streaming) threw', err); }
    try {
      // Shape-adapt the EPT cloud's metadata for the streaming-report
      // synthesizer. EPT's bounds live on `detection.metadata.bounds`;
      // EPT has no first-class spacing/maxDepth fields (the writer's
      // `span` is the points-per-tile analogue), so those rows are
      // omitted on EPT streams.
      const b = detection.metadata.bounds.conforming;
      const eptReportCloud = {
        kind: 'ept' as const,
        name: cloud.name,
        sourcePointCount: cloud.sourcePointCount,
        metadata: {
          header: { min: [b[0], b[1], b[2]] as [number, number, number], max: [b[3], b[4], b[5]] as [number, number, number] },
        },
      };
      deps.setLastStreamingReportCloud(eptReportCloud);
      deps.inspector.setReport(
        deps.runStreamingModules(eptReportCloud, deps.classLegendPanel.getVisibility().isFiltered()),
      );
    } catch (err) { if (deps.debug) console.warn('[inspector] setReport (streaming) threw', err); }
    deps.prewarmExportStudio();

    // The metadata-driven scan summary — same shape the COPC path fills,
    // adapted for EPT's metadata layout.
    const b = detection.metadata.bounds.conforming;
    const schemaSummary = `${detection.metadata.dataType} · ${detection.metadata.schema.length} attrs`;
    deps.revealAnalysePanel(cloud.name, false); // streaming EPT also gets the terrain tools
    deps.streamingPanel.setSummary({
      fileName: cloud.name,
      pointFormat: -1,                 // EPT has no LAS PDRF; sentinel
      sourcePoints: cloud.sourcePointCount,
      width: b[3] - b[0],
      depth: b[4] - b[1],
      height: b[5] - b[2],
      spacing: detection.metadata.span,
      octreeDepth: cloud.maxDepth(),
      nodeCount: cloud.octree.nodes().length,
      format: 'ept',
      schemaSummary,
      // EPT's resolution row is a node budget (crs-independent), but carry the
      // CRS anyway for shape parity with the COPC path.
      crs: cloud.crs(),
    });

    // Was: body class + navBar only, which left the dock hidden — so an EPT
    // scan loaded with no measure, inspect, probe, annotate or close.
    deps.revealStreamingChrome();
    deps.startStreamingStatusPolling();
    deps.dropZone.setCancelHandler(null);
    deps.dropZone.setProgress(null);
  } catch (err) {
    deps.dropZone.setCancelHandler(null);
    // A user-initiated cancel surfaces two ways: our own LoadCancelledError,
    // or a DOMException named `AbortError` when the Stage URL-field Cancel
    // aborts the linked signal mid-fetch. Both mean "the user changed their
    // mind" — neither is an error to report or count.
    if (err instanceof LoadCancelledError || isAbortError(err)) {
      deps.dropZone.setProgress(null);
    } else {
      if (deps.debug) console.error('OpenLiDARViewer — remote EPT error', err);
      recordUsage('error', 'load');
      // classified error messages, matching the COPC
      // remote-UX polish. `describeRemoteEptError` distinguishes CORS,
      // 404, 5xx, hierarchy vs. tile fetch, and transport failures.
      // Fall back to the generic classifier when the EPT chunk itself
      // failed to load (so `eptUrlMod` never arrived).
      deps.dropZone.setError(
        eptUrlMod ? eptUrlMod.describeRemoteEptError(err, url) : describeLoadError(err),
      );
      deps.closeStreaming();
    }
  } finally {
    unlinkAbort();
    deps.setLoading(false);
  }
}
