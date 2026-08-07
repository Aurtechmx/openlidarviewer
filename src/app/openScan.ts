/**
 * openScan.ts — the open/load pipeline lifted out of main.ts.
 *
 * `openScan` is the SINGLE router every file entering the app passes through
 * (drop zone, Open picker, Measurements Import, sampled catalog loads). It
 * splits three ways: an `.olvsession` is a saved analysis, not a scan, so it
 * routes to the session loader; a COPC file takes the streaming pipeline; every
 * other format takes the static loader, then the whole post-load orchestration
 * runs — attach the cloud, reveal the dock / nav, and populate the Inspector.
 *
 * The two genuinely pure decisions the pipeline makes are extracted as
 * {@link layerChipCount} and {@link shouldResetSavedWork} so they are
 * Node-testable without a Viewer or the DOM. Everything else is imperative view
 * orchestration, driven through a structural {@link OpenScanDeps} of accessor
 * functions closing over the shell's services rather than the Viewer class —
 * the same seam `sessionIo` and the render hosts use. `main.ts` keeps a thin
 * `handleFile` delegate that binds its running state to these deps. Part of the
 * v0.6 decomposition (see `docs/architecture/architecture-map.md`).
 */

import { isSessionFile } from '../io/sessionFile';
import { scanFactsFromStatic } from './sessionIo';
import { detectCopc } from '../io/copc/copcDetect';
import { formatProgress } from '../io/loadProgress';
import { describeLoadError } from '../io/loadErrors';
import { formatTelemetry } from '../io/loadTelemetry';
import { buildBenchmarkResult, formatBenchmarkResult } from '../io/benchmark';
import { LoadCancelledError } from '../io/loadFile';
import { availableModes } from '../render/colorModes';
import { recommendColorMode } from '../render/colorModeRecommend';
import { increment as recordUsage } from '../diagnostics/usageCounters';

import type { LoadResult, LoadCallbacks, LoadOptions } from '../io/loadFile';
import type { ColorMode } from '../render/colorModes';
import type { PointCloud } from '../model/PointCloud';
import type { ShareState } from '../io/shareState';
import type { ClassScope } from '../render/class/classScope';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { Viewer } from '../render/Viewer';
import type { Inspector } from '../ui/Inspector';
import type { ToolDock } from '../ui/toolDock';
import type { NavBar } from '../ui/NavBar';
import type { DebugOverlay } from '../ui/DebugOverlay';
import type { DropZone } from '../ui/DropZone';
import type { Stage } from '../ui/Stage';
import type { ScanService } from './ScanService';
import type { LayerService } from './LayerService';
import type { LayerIdentityService } from './layerIdentityService';
import type { InspectorCardRefreshers } from './inspectorCardRefreshers';
import type { CrsCoordinator } from './crsCoordinator';
import type { ViewBookmarksService } from './viewBookmarks';

/**
 * The Layers chip names the FILE, so it shows the file total (the same count
 * DETAIL renders as "loaded / total"), not the strided display subset — kept
 * consistent with the Scan Report's file-scale Point Count. Use the header /
 * source total only when it is present AND larger than the display cloud (a
 * budget-capped load); otherwise the display count already is the file count.
 */
export function layerChipCount(
  originalPointCount: number | undefined,
  displayPointCount: number,
): number {
  return originalPointCount && originalPointCount > displayPointCount
    ? originalPointCount
    : displayPointCount;
}

/**
 * A fresh project resets saved work; an additive open keeps the layer that is
 * still on screen. True only when this is the first (or only) loaded cloud —
 * `tests/additiveOpenKeepsWork.test.ts` pins the additive side of this.
 */
export function shouldResetSavedWork(loadedCloudCount: number): boolean {
  return loadedCloudCount <= 1;
}

/**
 * The running-app seam `openScan` writes through. Accessors are functions, not
 * snapshots, so the lazily-bound Viewer and the mutable load flags are read at
 * call time — exactly as the inline version read the shell's module-level
 * `let`s. The two heavy runtime actions (the static source load, the COPC
 * stream open) are passed in so this module stays free of the loader / boot
 * graph and the decision logic above can be tested without them.
 */
export interface OpenScanDeps {
  /** Resolves once the lazily-loaded Viewer chunk is in place — awaited before any `getViewer()`. */
  readonly viewerReady: Promise<unknown>;
  /** The live Viewer (a late-bound `let` in the shell). */
  getViewer: () => Viewer;
  /** Route an `.olvsession` to the session loader (the shell's `importSession`). */
  importSession: (file: File) => Promise<void>;
  /** True while a load is in flight — the one-load-at-a-time guard. */
  isLoading: () => boolean;
  /** Claim / release the load flag. Claimed synchronously; released in `finally`. */
  setLoading: (loading: boolean) => void;
  /** Fire a toast, optionally with one action button. */
  showToast: (
    message: string,
    action?: { readonly label: string; readonly onClick: () => void },
  ) => void;
  /** The drop-zone status surface. */
  dropZone: Pick<
    DropZone,
    'setOpening' | 'setCancelHandler' | 'setProgress' | 'setPreload' | 'setError'
  >;
  /** Open a local COPC file through the streaming pipeline (wraps the range source + `openStreamingCopc`). */
  openLocalCopc: (file: File, signal: AbortSignal) => Promise<void>;
  /** Load a dropped / opened file through the static loader (wraps `new LocalFileSource(file).load(...)`). */
  loadLocalSource: (
    file: File,
    callbacks: LoadCallbacks,
    options: LoadOptions,
  ) => Promise<LoadResult>;
  /** The device's safe render budget (`deviceCapsValue.renderBudget`). */
  readonly renderBudget: number;
  /** Phone-class device — tighter budget + touch hints. */
  isPhone: () => boolean;
  /** Reported device memory in GB, or undefined when the browser withholds it. */
  deviceMemoryGB: () => number | undefined;
  /** Hide the empty-state placeholder once a scan renders. */
  stage: Pick<Stage, 'hideEmptyState'>;
  /** Tear down any open streaming scan (a static load replaces it; a failed streaming open tidies up). */
  closeStreaming: () => void;
  /** Active-scan selection + lookup. */
  scans: Pick<ScanService, 'setActive' | 'activeId'>;
  /**
   * The session's layer-identity owner. On load, the freshly attached cloud is
   * bound to a stable, name-independent id from its SOURCE facts; the work
   * stores are wired so new measurements/annotations record which layer they
   * belong to once more than one is open.
   */
  layerIdentity: Pick<LayerIdentityService, 'bindOnLoad' | 'ensureStoresWired'>;
  /** The Inspector panel. */
  inspector: Inspector;
  /** Provenance / dataset-intelligence card refreshers. */
  inspectorCards: Pick<
    InspectorCardRefreshers,
    'refreshProvenance' | 'refreshDatasetIntelligenceFromStaticCloud'
  >;
  /** CRS detection for the freshly loaded static cloud. */
  crsCoordinator: Pick<CrsCoordinator, 'refreshCrsForStaticCloud'>;
  /** The tool dock. */
  dock: ToolDock;
  /** The navigation bar. */
  navBar: NavBar;
  /** Saved-view store — cleared only on a fresh project. */
  bookmarks: Pick<ViewBookmarksService, 'clear'>;
  /** CRS-mismatch flag refresh across layers. */
  layerService: Pick<LayerService, 'refreshCrsFlags'>;
  /** Record the per-layer visibility intent for a freshly attached cloud. */
  setLayerVisible: (id: string, visible: boolean) => void;
  /** Retain the source File so the Export panel can offer a full-resolution re-decode. */
  rememberSourceFile: (id: string, file: File) => void;
  /** Retain whether the display cloud was reduced from the source. */
  rememberReduced: (id: string, reduced: boolean) => void;
  /** Re-render the annotations panel from the viewer's store. */
  refreshAnnotationPanel: () => void;
  /** Record the active colour mode chosen for this load (the shell's `currentColorMode`). */
  setCurrentColorMode: (mode: ColorMode) => void;
  /** Lazily import the display-profile card applier. */
  loadApplyDisplayProfile: () => Promise<{
    applyDisplayProfile: (cloud: PointCloud, target: Inspector) => void;
  }>;
  /** Run the analysis modules over a cloud for the Scan Report. */
  runModules: (cloud: PointCloud, scope?: ClassScope) => AnalysisRow[];
  /** Derive the active class scope for the report. */
  currentClassScope: (cloud: PointCloud) => ClassScope;
  /** Pre-warm the lazy Visual Export Studio chunk. */
  prewarmExportStudio: () => void;
  /** A share link's pending view state, if this page opened via one. */
  getPendingShareState: () => ShareState | null;
  /** Consume the pending share state so it applies at most once. */
  clearPendingShareState: () => void;
  /** Restore a shared view onto the freshly loaded scan. */
  applyShareState: (state: ShareState, cloud: PointCloud) => void;
  /** Embedded / minimal-UI mode — suppresses the project + instant-answer cards. */
  readonly bareMode: boolean;
  /** Show the post-load project summary card. */
  showProjectCard: (cloud: PointCloud, originalPointCount: number) => void;
  /** Reveal the Analyse panel for the loaded scan. */
  revealAnalysePanel: (name: string) => void;
  /** Surface the instant analysis-on-drop entry point. */
  showInstantAnswer: (name: string) => void;
  /** Repopulate the classification legend from the cloud's per-point class buffer. */
  refreshClassLegend: (classification?: ArrayLike<number>) => void;
  /** `?debug=1` — console diagnostics + overlay telemetry. */
  readonly debug: boolean;
  /** `?benchmark=1` — emit a benchmark result on load. */
  readonly benchmark: boolean;
  /** The developer diagnostics overlay, or null when it hasn't loaded. */
  getDebugOverlay: () => Pick<DebugOverlay, 'setTelemetry' | 'setBenchmark'> | null;
}

/** Load a dropped or sampled File: parse, render, and populate the Inspector. */
export async function openScan(file: File, deps: OpenScanDeps): Promise<void> {
  // SINGLE ROUTER for every file that enters the app (drop zone, Open picker,
  // Measurements Import). It splits three ways: an `.olvsession` is a saved
  // analysis (→ the one session loader), a COPC file streams, everything else
  // takes the static loader. The one-load-at-a-time guard below now covers ALL
  // three — including the session reroute, which used to run AHEAD of it.
  //
  // One load at a time. The shared parse worker decodes a single file; a second
  // load started mid-flight would hijack the first one's worker. The session
  // reroute sits under this guard too: an embed `load-file` is wrapped as a File
  // whose NAME the host controls (main.ts), so a `x.olvsession` name could
  // otherwise reach the session loader unthrottled and stack repeated restores.
  if (deps.isLoading()) {
    deps.showToast('Already loading — cancel the current load first.');
    return;
  }
  // Claim the flag SYNCHRONOUSLY — the `await`s below yield to the event loop,
  // and a second drop in that window used to pass the `loading` guard too
  // (TOCTOU). Every return path from here on releases it.
  deps.setLoading(true);
  // An `.olvsession` is a saved analysis, not a scan: route it to the one
  // session loader (never the cloud worker) and release the flag in its own
  // finally — the session path has no cancel / progress affordance, so it does
  // not share the cloud path's dropzone setup below.
  if (isSessionFile(file.name)) {
    try {
      await deps.importSession(file);
    } finally {
      deps.setLoading(false);
    }
    return;
  }
  const controller = new AbortController();
  // Blue blinking "Opening …" — the prominent first feedback, matching the
  // catalog status vocabulary so device and public-dataset loads read the same.
  // The load's staged progress (decoding / uploading / rendering) supersedes it.
  deps.dropZone.setOpening(`Opening ${file.name}…`);
  deps.dropZone.setCancelHandler(() => controller.abort());
  try {
    // ensure the lazy-loaded Viewer is ready before touching it.
    await deps.viewerReady;
    const viewer = deps.getViewer();
    // COPC files take the streaming pipeline, not the static loader. The
    // range-source module is part of the lazy COPC chunk.
    const headSlice = await file.slice(0, 4096).arrayBuffer();
    if (detectCopc(headSlice).isCopc) {
      await deps.openLocalCopc(file, controller.signal);
      return;
    }
    // Phones get a tighter point budget — limited GPU memory and fill-rate.
    // The dropped file is wrapped in a LocalFileSource — the source
    // abstraction; v0.3 streaming sources slot in beside it.
    const result = await deps.loadLocalSource(
      file,
      {
        onProgress: (u) => deps.dropZone.setProgress(formatProgress(u), u.fraction),
        onPreload: (lines) => deps.dropZone.setPreload(lines),
      },
      {
        // The point budget is the device's safe render budget — full on a
        // capable machine, reduced on a weak one to keep the GPU stable.
        budget: deps.renderBudget,
        isMobile: deps.isPhone(),
        deviceMemoryGB: deps.deviceMemoryGB(),
        signal: controller.signal,
      },
    );
    await viewer.ready;

    // NB: static layers are ADDITIVE — dropping/opening a second scan keeps the
    // first as a separate layer (the LAYERS panel lists each with its own ✕ to
    // free it). We deliberately do NOT clear prior static clouds here: an
    // earlier "free the previous scan on re-open" optimisation mistook the
    // retained layer for a leak and silently broke multi-scan loading. GPU for
    // multiple layers is intended; the user releases a layer via its ✕, which
    // routes through removeCloud() and frees the same buffers. (Streaming opens
    // remain exclusive and still call clearOpenStaticLayers below.)

    deps.dropZone.setProgress(formatProgress({ stage: 'uploading' }));
    deps.stage.hideEmptyState();
    // A static load replaces any open streaming scan — but only now that the
    // file parsed. A failed or cancelled parse above must leave the current
    // scene intact rather than clearing it for a scan that never arrived.
    if (controller.signal.aborted) throw new LoadCancelledError();
    if (viewer.hasStreamingCloud) deps.closeStreaming();
    const uploadStartedAt = performance.now();
    const id = viewer.addCloud(result.cloud);
    const gpuUploadMs = performance.now() - uploadStartedAt;
    deps.scans.setActive(id);
    // Bind this cloud to a stable, name-independent identity from its SOURCE
    // facts (declared count + tolerant extents + CRS), so ownership survives a
    // rename, a duplicate filename, and a reopen at a different stride; then wire
    // the work stores — once — so new measurements/annotations record their
    // owning layer as soon as a second layer joins. Additive: a single-layer
    // scene keeps its exact byte shape, because the provider returns no owner.
    deps.layerIdentity.bindOnLoad(id, scanFactsFromStatic(result.cloud), result.cloud.name);
    deps.layerIdentity.ensureStoresWired(
      [viewer.measure, viewer.annotate],
      () => deps.scans.activeId,
      () => viewer.clouds().length,
    );
    // A freshly opened scan has no terrain analysis yet — drop any prior grid so
    // the Coverage colour chip starts disabled until this scan is analysed.
    viewer.setCoverageGrid(null);
    deps.inspector.setCoverageAvailable(false);
    // Retain the source file + whether the display cloud was reduced, so the
    // Export panel can offer a full-resolution re-decode.
    deps.rememberSourceFile(id, file);
    deps.rememberReduced(id, result.downsampled);
    // Local-first counter — categorical source format only; never the file name.
    try { recordUsage('scan-open', result.cloud.sourceFormat); }
    catch (err) { if (deps.debug) console.warn('[usage] recordUsage threw', err); }
    // Provenance fingerprint — pure metadata classification, surfaced in
    // the Inspector's "Provenance" section. Wrapped because a malformed
    // input shape would have aborted the rest of the post-load setup
    // (including the navBar reveal further down).
    try { deps.inspectorCards.refreshProvenance(result.cloud); }
    catch (err) { if (deps.debug) console.warn('[provenance] refreshProvenance threw', err); }
    // CRS — detected from the loaded cloud's metadata, merged with any
    // persisted user override. Wrapped because a malformed cloud
    // shape shouldn't break the rest of the load.
    try { deps.crsCoordinator.refreshCrsForStaticCloud(result.cloud); }
    catch (err) { if (deps.debug) console.warn('[crs] refreshCrsForStaticCloud threw', err); }

    deps.dropZone.setProgress(formatProgress({ stage: 'rendering' }));
    const renderStartedAt = performance.now();
    // A freshly opened scan starts in the orbit overview, then glides in.
    viewer.setMode('orbit');
    viewer.frameAll();
    const firstRenderMs = performance.now() - renderStartedAt;

    // Colour the fresh scan by the mode its attributes best support (RGB →
    // classification → intensity → elevation), gated so it never picks a mode
    // the cloud can't render. The rail syncs off `mode` below, so this single
    // seam keeps the render and the COLOR BY chips in step.
    const mode = recommendColorMode(result.cloud).mode;
    deps.setCurrentColorMode(mode);
    viewer.setColorMode(id, mode);

    // ── CRITICAL UI REVEAL — runs BEFORE any inspector / module setup ────
    // The dock backend indicator + NavBar (Orbit/Walk/Fly mode switcher
    // + speed slider) must reveal even if a downstream inspector call
    // throws. Without this ordering, a failure in `runModules` or
    // `inspector.setReport` left the user with a rendered scan they
    // couldn't navigate around, and the backend indicator stuck at
    // "initialising…". Critical reveal first, decorations second.
    deps.dock.setBackend(viewer.activeBackend());
    // v0.3.6 design-audit fix: reveal the dock at attach. It stays hidden
    // through the empty state so eight dimmed tools don't clutter the
    // primary CTA on mobile.
    deps.dock.setEmpty(false);
    deps.inspector.setEmpty(false);
    deps.dock.setMeasureEnabled(true);
    deps.dock.setInspectEnabled(true);
    deps.dock.setProbeEnabled(true);
    deps.dock.setAnnotateEnabled(true);
    deps.dock.setCloseEnabled(true);
    deps.navBar.element.classList.remove('olv-hidden');
    deps.navBar.setMode('orbit');
    deps.navBar.flashHelp();
    document.body.classList.add('olv-has-scan');
    if (deps.isPhone()) deps.navBar.flashTouchHint();

    // Only a fresh project resets saved work; an additive open keeps the layer
    // that is still on screen. tests/additiveOpenKeepsWork.test.ts pins this.
    if (shouldResetSavedWork(viewer.clouds().length)) { deps.bookmarks.clear(); viewer.annotate.clear(); }
    deps.refreshAnnotationPanel();

    // ── Inspector setup — wrapped in defensive try/catches so a single
    //    failing analysis module or inspector call can't abort the rest.
    //    Each isolated block restores its own slice; the navigation
    //    above remains usable even if every block below fails.
    try {
      // The Layers chip names the FILE, so it shows the file total (the same
      // count DETAIL renders as "loaded / total"), not the strided display
      // subset — consistent with the Scan Report's file-scale Point Count.
      const layerCount = layerChipCount(result.originalPointCount, result.cloud.pointCount);
      deps.inspector.addCloud(id, result.cloud.name, layerCount, result.cloud.metadata?.crs?.name ?? null);
      deps.setLayerVisible(id, true);
      deps.layerService.refreshCrsFlags();
      deps.inspector.setColorModes(availableModes(result.cloud), mode);
      deps.inspector.setDetail(result.cloud.pointCount, result.originalPointCount);
      deps.inspector.setElevationExtent(viewer.elevationExtent());
      deps.inspector.setIntensityExtent(viewer.intensityExtent());
      deps.inspectorCards.refreshDatasetIntelligenceFromStaticCloud(result.cloud);
      // v0.5.7 capability-driven card: derive the display profile from the
      // loaded scan and surface the declared-by-the-file provenance (E57 olv:
      // block, headline) + hide the CRS section for local-frame scans. Loaded
      // lazily (via lazyChunks) so displayProfile + scanCapability stay out of
      // the eager startup shell / index bundle budget. Additive; a no-op on the
      // geo path.
      {
        const profileCloud = result.cloud;
        const targetId = id;
        void deps.loadApplyDisplayProfile()
          .then(({ applyDisplayProfile }) => {
            if (deps.scans.activeId !== targetId) return; // scan changed while we waited
            applyDisplayProfile(profileCloud, deps.inspector);
          })
          // The card is additive and no-op on absence; a chunk-load or
          // derivation failure must not surface as an unhandled rejection (the
          // enclosing try/catch is synchronous and won't catch this promise).
          .catch((err) => {
            if (deps.debug) console.warn('[inspector] display-profile card threw', err);
          });
      }
    } catch (err) {
      if (deps.debug) console.warn('[inspector] cloud + details setup threw', err);
    }
    // Scan Report — deferred off the attach path (v0.5.3). The health-check
    // module walks EVERY point several times (duplicate-point set, median/MAD
    // sorts, outlier + finite scans): ~3 s of the attach long-task on a
    // multi-million-point cloud, blocking first paint and first input after
    // "rendering…" clears. Run it when the main thread goes idle instead —
    // the report card fills in a beat later, navigation is live immediately.
    // The cloud-id guard drops the stale result if the user swapped scans
    // before idle arrived (the memoised module re-runs cheaply on re-open).
    {
      const reportForId = id;
      const fillReport = (): void => {
        if (deps.scans.activeId !== reportForId) return; // scan changed while we waited
        try {
          deps.inspector.setReport(deps.runModules(result.cloud, deps.currentClassScope(result.cloud)));
        } catch (err) {
          if (deps.debug) console.warn('[inspector] runModules + setReport threw', err);
        }
      };
      type RIC = (cb: () => void, opts?: { timeout?: number }) => number;
      const rIC = (window as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
      if (typeof rIC === 'function') rIC(fillReport, { timeout: 1500 });
      else setTimeout(fillReport, 200);
    }
    try {
      deps.inspector.setViews([]);
    } catch (err) {
      if (deps.debug) console.warn('[inspector] setViews threw', err);
    }
    // Visual Export Studio — a scan is now loaded; turn on the image-
    // export buttons so the user can capture it. Pre-warm the lazy Studio
    // chunk in the background so the first export click feels instant
    // instead of waiting on the ~7 KB gzip fetch + parse. Pure fire-and-
    // forget; we don't await the result.
    try {
      deps.inspector.setImageExportEnabled(true);
      // Per-mode gating — disable buttons whose mode the loaded cloud can't
      // satisfy (Normal map on a LAZ, etc.) so the user sees the constraint
      // before clicking rather than as a post-click error toast.
      deps.inspector.setImageExportAvailability(viewer.availableImageExportModes());
    } catch (err) {
      if (deps.debug) console.warn('[inspector] setImageExportEnabled threw', err);
    }
    deps.prewarmExportStudio();

    // A share link, if one opened this page, restores its view onto this scan.
    const pending = deps.getPendingShareState();
    if (pending) {
      try {
        deps.applyShareState(pending, result.cloud);
      } catch (err) {
        if (deps.debug) console.warn('[share] applyShareState threw', err);
      }
      deps.clearPendingShareState();
    }

    // The render-quality controls reflect the viewer's state — EDL defaults
    // depend on the GPU backend, known only once `viewer.ready` resolved.
    try {
      deps.inspector.syncRendering({
        pointSize: viewer.pointSize,
        edlEnabled: viewer.edlEnabled,
        edlStrength: viewer.edlStrength,
        pointSizeMode: viewer.pointSizeMode,
        antialiasing: viewer.antialiasing,
        twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
    splatMode: viewer.splatMode,
      });
    } catch (err) {
      if (deps.debug) console.warn('[inspector] syncRendering threw', err);
    }

    if (!deps.bareMode) deps.showProjectCard(result.cloud, result.originalPointCount);

    // Reveal the Analyse panel now there's a scan to analyse. v0.4.0.
    deps.revealAnalysePanel(result.cloud.name);

    // Instant analysis-on-drop — surface the most relevant analysis one click
    // away (terrain / volume / floor plan / before-after), nothing uploaded.
    // Skipped in bare/embedded mode, which has no panels to drive.
    if (!deps.bareMode) deps.showInstantAnswer(result.cloud.name);

    // Classification legend (v0.4.1) — populate from the cloud's per-point
    // class buffer when present, then show. A scan with no classification
    // channel renders the panel's empty state. DISPLAY-ONLY; the all-visible
    // default mask is applied so nothing is hidden on load.
    try {
      deps.refreshClassLegend(result.cloud.classification);
    } catch (err) {
      if (deps.debug) console.warn('[class-legend] refresh threw', err);
    }

    // Developer diagnostics — the merged telemetry feeds the debug console
    // block, the performance overlay, and (under ?benchmark=1) a benchmark.
    if ((deps.debug || deps.benchmark) && result.telemetry) {
      const telemetry = { ...result.telemetry, gpuUploadMs, firstRenderMs };
      if (deps.debug) {
        console.log(
          '%cOpenLiDARViewer — load telemetry',
          'font-weight:600;color:#22dcff',
          '\n' + formatTelemetry(telemetry),
        );
      }
      deps.getDebugOverlay()?.setTelemetry(telemetry);
      if (deps.benchmark) {
        const text = formatBenchmarkResult(
          buildBenchmarkResult(
            result.cloud.name,
            result.cloud.sourceFormat,
            result.cloud.pointCount,
            telemetry,
            // Surface the header-declared point count when the source had
            // one, so the benchmark output disambiguates "4M of 100M (4 %)"
            // from "4M of 4M (100 %)" — a budget-capped load shouldn't
            // read identically to a full one.
            result.cloud.declaredPointCount,
          ),
        );
        console.log(
          '%cOpenLiDARViewer — benchmark',
          'font-weight:600;color:#22dcff',
          '\n' + text,
        );
        deps.getDebugOverlay()?.setBenchmark('benchmark\n' + text);
      }
    }
    deps.dropZone.setCancelHandler(null);
    deps.dropZone.setProgress(null);
  } catch (err) {
    deps.dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError) {
      // A cancelled load is a quiet no-op — no error toast, nothing was added.
      deps.dropZone.setProgress(null);
    } else {
      // The toast shows a clear, categorised message; the raw error still
      // reaches the console for developers under ?debug=1.
      if (deps.debug) console.error('OpenLiDARViewer — load error', err);
      deps.dropZone.setError(describeLoadError(err));
      // A streaming open that failed mid-flight leaves no scan — tidy up.
      deps.closeStreaming();
    }
  } finally {
    deps.setLoading(false);
  }
}
