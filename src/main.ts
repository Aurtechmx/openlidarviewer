import '@fontsource-variable/inter';
import './style.css';
import type { Viewer } from './render/Viewer';
import type { CameraPose } from './render/NavController';
import { Stage } from './ui/Stage';
import type { Sample } from './ui/Stage';
import { DropZone } from './ui/DropZone';
import { Inspector } from './ui/Inspector';
import { ToolDock } from './ui/toolDock';
import { NavBar } from './ui/NavBar';
import { ProjectCard } from './ui/ProjectCard';
import { MeasurePanel } from './ui/MeasurePanel';
import { AnnotationPanel } from './ui/AnnotationPanel';
import { HelpOverlay } from './ui/HelpOverlay';
import { bindShortcuts } from './ui/shortcuts';
import { LoadCancelledError } from './io/loadFile';
import { describeLoadError } from './io/loadErrors';
import { LocalFileSource } from './io/LocalFileSource';
import { deviceCaps } from './render/deviceProfile';
import { parseEmbedConfig } from './ui/embedConfig';
// `startEmbedBridge` is only wired in `?embed=1` mode.
// Lazy-loaded so the bridge code never enters the bundle for the typical
// non-iframe page load (the dominant traffic pattern).
import { encodeShareState, decodeShareState } from './io/shareState';
import type { ShareState } from './io/shareState';
import { formatProgress } from './io/loadProgress';
import { formatTelemetry } from './io/loadTelemetry';
import { buildBenchmarkResult, formatBenchmarkResult } from './io/benchmark';
// The diagnostics runtime (DebugOverlay + streamingBenchmark + the
// instrumented range source) loads only when `?debug=1` or `?benchmark=1`
// is set — see `loadDiagnostics()` below. The types stay reachable for the
// variable annotations.
import type { StreamingBenchmark } from './render/streaming/streamingBenchmark';
import type { DebugOverlay, StreamingDebugStats } from './ui/DebugOverlay';
import { estimateDecodedBytes, estimateGpuBytes } from './render/streaming/streamingBudget';
import { isZUpFormat } from './io/sniffFormat';
// `exportCloud` is dynamically imported via `loadExporters` in the onExport
// callback — the PLY/OBJ/XYZ/CSV encoders stay in their own chunk and never
// weigh on the initial payload of a session that never exports.
import { serializeSession, parseSession } from './io/session';
import { loadPrefs, savePrefs } from './prefs';
import { ModuleRegistry } from './analysis/ModuleApi';
import type { AnalysisRow } from './analysis/ModuleApi';
import { healthCheck } from './analysis/modules/healthCheck';
import { scanReport } from './analysis/modules/scanReport';
import { availableModes, defaultMode } from './render/colorModes';
import type { ColorMode } from './render/colorModes';
import type { PointCloud } from './model/PointCloud';
// `detectCopc` is a tiny leaf — kept static so `handleFile` can branch on it
// synchronously. The rest of the COPC + streaming subsystem is dynamically
// imported (in `openStreamingCopc` and `handleRemoteCopc`), so it lands in a
// lazy chunk fetched only when a COPC scan is actually opened.
import { detectCopc } from './io/copc/copcDetect';
import {
  RangeReadError,
  sanitizeUrlForDisplay,
  validateRemoteCopcUrl,
} from './io/range/RangeSource';
import type { RangeSource } from './io/range/RangeSource';
import type { CopcWorkerClient } from './io/copc/worker/copcWorkerClient';
import { StreamingPanel } from './ui/StreamingPanel';
import type { StreamingQuality } from './render/streaming/streamingBudget';
// The COPC/streaming `import()` split points live in `lazyChunks.ts` — a
// module excluded from the live-build source-transform so Vite can still see the
// dynamic-import specifiers and emit the chunks (see lazyChunks.ts).
import {
  loadStreamingPointCloud,
  loadCopcWorkerClient,
  loadStreamingColors,
  loadLocalFileRangeSource,
  loadHttpRangeSource,
  loadEpt,
  loadExporters,
  loadExportStudio,
  loadReportEngine,
  loadDebugOverlay,
  loadStreamingBenchmark,
  loadInstrumentedRangeSource,
  loadViewer,
} from './lazyChunks';

// A pointer to the open-source repository for anyone who opens the console on
// the live site. The deployed bundle is compact-transformed; the readable source — and
// the full documentation — live on GitHub.
console.log(
  `%cOpenLiDARViewer%c v${__APP_VERSION__} — open source under the MIT license.\n` +
    `View the source and docs on GitHub: https://github.com/aurtechmx/openlidarviewer`,
  'font-weight:600;color:#22dcff',
  'color:#9aa3ad',
);

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('OpenLiDARViewer: #app mount point not found');

/** The embed configuration parsed from the URL — the documented embed API. */
const embedConfig = parseEmbedConfig(window.location.search);
/** True in embed mode (`?embed=1`) — strips the top bar, enables the bridge. */
const embed = embedConfig.embed;
/** True when the dock and panels are hidden — embed mode or `?ui=minimal`. */
const bareMode = embed || embedConfig.uiMinimal;
const urlParams = new URLSearchParams(window.location.search);
/** `?debug=1` (or just `?debug`) shows the performance overlay and telemetry. */
const debug = urlParams.has('debug');
/** `?benchmark=1` emits a structured benchmark result for each file load. */
const benchmark = urlParams.has('benchmark');

const SAMPLES: Sample[] = [
  { id: 'survey', label: 'Drone survey', detail: '.las — georeferenced', url: 'samples/tiny.las', name: 'sample-survey.las' },
  { id: 'scan', label: 'Phone scan', detail: '.ply — local coordinates', url: 'samples/tiny.ply', name: 'sample-scan.ply' },
];

const stage = new Stage(app, {
  embed,
  samples: SAMPLES,
  onSample: loadFromUrl,
  onOpenFile: (file) => void handleFile(file),
  // Surface any swallowed rejection in the toast so a chunk-load failure
  // (or any other unexpected throw) doesn't fail silently.
  onOpenUrl: (url) => {
    handleRemoteUrl(url).catch((err) => {
      dropZone.setError(err instanceof Error ? err.message : 'Failed to open the URL.');
    });
  },
});
/**
 * The Viewer is lazy-imported so three.js stays out of the initial shell.
 * `viewer` is treated as non-null throughout the rest of main.ts; every
 * scan-open path awaits `viewerLoaded` before touching it, and UI handlers
 * that *could* fire pre-init are operating against an empty state where the
 * calls are no-ops anyway.
 *
 * The cast through `unknown` is the documented escape hatch — TypeScript
 * cannot see the runtime guarantee that `viewerLoaded` resolves before
 * any user-driven scan-open, but it does.
 */
let viewer: Viewer = null as unknown as Viewer;
const viewerLoaded: Promise<Viewer> = (async () => {
  const { Viewer: ViewerCtor } = await loadViewer();
  viewer = new ViewerCtor(stage.canvas);
  return viewer;
})();

/** True on phone-width viewports — drives the touch hint and point budget. */
function isPhone(): boolean {
  return window.matchMedia('(max-width: 767px)').matches;
}

/** `navigator.deviceMemory` in GB, when the browser reports it. */
function deviceMemoryGB(): number | undefined {
  const m = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof m === 'number' && m > 0 ? m : undefined;
}

/**
 * The device's capability tier and safe render budget — computed once at
 * startup. A weak device loads fewer points and gets degraded rendering
 * defaults, so a large survey never crashes the GPU.
 */
const deviceCapsValue = deviceCaps({
  deviceMemoryGB: deviceMemoryGB(),
  hardwareConcurrency: navigator.hardwareConcurrency,
  isMobile: isPhone(),
});

const registry = new ModuleRegistry();
registry.register(healthCheck);
registry.register(scanReport);

/** Viewer id of the cloud the Inspector currently controls (the most recent). */
let activeId: string | null = null;
/** Saved camera viewpoints for the current scan. */
let savedViews: { name: string; pose: CameraPose }[] = [];
let viewCounter = 0;
/** True while a file load is in flight — one load at a time (see `handleFile`). */
let loading = false;

/** The active colour mode — tracked so a share link can record it. */
let currentColorMode: ColorMode | undefined;

/** True once the renderer backend has finished initialising. */
let viewerReady = false;
/** The `?debug=1` / `?benchmark=1` performance overlay, when one is shown. */
let debugOverlay: DebugOverlay | null = null;

/** The COPC decode worker client — created lazily on the first COPC open. */
let copcDecoder: CopcWorkerClient | null = null;
/** The active streaming quality preset. */
let streamingQuality: StreamingQuality = 'balanced';
/** Interval handle for the streaming-status poll, while a COPC is open. */
let streamingStatusTimer: number | undefined;
/** Active streaming benchmark collector — non-null only under `?benchmark=1`. */
let streamingBenchmark: StreamingBenchmark | null = null;
/** Latched once the coarse view first finishes loading, per streaming session. */
let coarseStableFired = false;

/**
 * The lazily-loaded diagnostics runtime — the `?debug=1` overlay, the
 * streaming benchmark collector, and the instrumented range source. Loaded
 * once on first need (the URL flag setup or the first benchmarked scan
 * open) and cached for the rest of the session.
 */
interface DiagnosticsRuntime {
  DebugOverlay: typeof import('./ui/DebugOverlay').DebugOverlay;
  StreamingBenchmark: typeof import('./render/streaming/streamingBenchmark').StreamingBenchmark;
  formatStreamingBenchmark: typeof import('./render/streaming/streamingBenchmark').formatStreamingBenchmark;
  InstrumentedRangeSource: typeof import('./io/range/InstrumentedRangeSource').InstrumentedRangeSource;
}
let diagnostics: DiagnosticsRuntime | null = null;
let diagnosticsPending: Promise<DiagnosticsRuntime> | null = null;
function loadDiagnostics(): Promise<DiagnosticsRuntime> {
  if (diagnostics) return Promise.resolve(diagnostics);
  if (diagnosticsPending) return diagnosticsPending;
  diagnosticsPending = (async () => {
    const [overlayMod, benchMod, instrMod] = await Promise.all([
      loadDebugOverlay(),
      loadStreamingBenchmark(),
      loadInstrumentedRangeSource(),
    ]);
    diagnostics = {
      DebugOverlay: overlayMod.DebugOverlay,
      StreamingBenchmark: benchMod.StreamingBenchmark,
      formatStreamingBenchmark: benchMod.formatStreamingBenchmark,
      InstrumentedRangeSource: instrMod.InstrumentedRangeSource,
    };
    diagnosticsPending = null;
    return diagnostics;
  })();
  return diagnosticsPending;
}

/**
 * A viewer state decoded from a `#s=` share link, applied once the next scan
 * loads. A share link carries no scan data — the recipient opens the scan and
 * the saved view is restored on top.
 */
let pendingShareState: ShareState | null = (() => {
  const hash = window.location.hash;
  return hash.startsWith('#s=') ? decodeShareState(hash.slice(3)) : null;
})();

const inspector = new Inspector({
  onColorMode: (mode) => {
    currentColorMode = mode;
    if (activeId) viewer.setColorMode(activeId, mode);
  },
  onPointSize: (size) => {
    viewer.setPointSize(size);
    persistPrefs();
  },
  onToggleVisible: (id, visible) => viewer.setCloudVisible(id, visible),
  onRemove: (id) => removeCloud(id),
  onExport: (format) => {
    const cloud = activeId ? viewer.getCloud(activeId) : undefined;
    if (!cloud) return;
    // The exporter is a lazy chunk; fetched on first export of the session.
    void loadExporters().then(({ exportCloud }) => {
      downloadText(`${baseName(cloud.name)}.${format}`, exportCloud(cloud, format));
    });
  },
  onExportImage: (mode) => {
    // The Visual Export Studio ships in its own lazy chunk (`loadExportStudio`),
    // pulled in by viewer.exportImage on the first invocation. The download
    // triggers off the returned Blob; an unsupported-on-this-cloud rejection
    // surfaces as a visible alert.
    const sourceName = activeId
      ? viewer.getCloud(activeId)?.name
      : viewer.streamingCloud?.name;
    const base = sourceName ? baseName(sourceName) : 'openlidarviewer';
    // surface a precise per-mode progress string while the lazy
    // Studio chunk loads and the export renders.
    const modeLabel: Record<string, string> = {
      'orthographic-rgb': 'orthographic RGB',
      'height-map': 'height map',
      intensity: 'intensity map',
      classification: 'classification map',
      depth: 'depth map',
      normal: 'normal map',
      contour: 'contour map',
    };
    const label = modeLabel[mode] ?? mode;
    dropZone.setProgress(`Exporting ${label}…`);
    viewer
      .exportImage(mode, {})
      .then((result) => {
        downloadBlob(`${base}-${mode}.png`, result.blob);
        dropZone.setProgress(null);
      })
      .catch((err: unknown) => {
        dropZone.setProgress(null);
        // The orchestrator's explicit reason ("Classification export is
        // unavailable — this cloud has no classification channel.") is the
        // most actionable thing we can show, so it goes both to the console
        // (for debugging) and to a non-blocking alert (so the user knows
        // something happened and why). Replaces the alert with a
        // toast surfaced inside the Studio panel.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[image-export]', err);
        // Defer the alert one tick so it doesn't block the failing render's
        // own stack unwinding (which could otherwise lock the page in some
        // browsers when the alert is fired synchronously during a render).
        setTimeout(() => window.alert(`Image export failed: ${msg}`), 0);
      });
  },
  onExportReport: (templateId) => {
    // generate a PDF report from the live scan state +
    // annotations + measurements. The whole `src/report/` module + pdf-lib
    // (~150 KB) lives behind `loadReportEngine()`; first click downloads
    // both. The report covers what the scan-report card already does on
    // PNG exports, but as a multi-page PDF with the full Inspector context.
    // surface a precise progress string while the lazy module
    // loads and the PDF renders.
    dropZone.setProgress('Generating report…');
    generateReportPdf(templateId)
      .then(() => dropZone.setProgress(null))
      .catch((err: unknown) => {
        dropZone.setProgress(null);
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[report]', err);
        setTimeout(() => window.alert(`Report generation failed: ${msg}`), 0);
      });
  },
  onSaveView: () => saveCurrentView(),
  onApplyView: (index) => applyView(index),
  onRenameView: (index, name) => {
    const view = savedViews[index];
    if (view) {
      view.name = name;
      inspector.setViews(savedViews.map((v) => v.name));
    }
  },
  onDeleteView: (index) => {
    savedViews.splice(index, 1);
    inspector.setViews(savedViews.map((v) => v.name));
  },
  onEdlToggle: (on) => {
    viewer.setEdlEnabled(on);
    persistPrefs();
  },
  onEdlStrength: (strength) => {
    viewer.setEdlStrength(strength);
    persistPrefs();
  },
  onPointSizeMode: (mode) => {
    viewer.setPointSizeMode(mode);
    persistPrefs();
  },
  onAntialiasing: (on) => {
    viewer.setAntialiasing(on);
    persistPrefs();
  },
});

const helpOverlay = new HelpOverlay();

const dock = new ToolDock({
  onFrameAll: () => viewer.frameAll(),
  onSnapshot: () => void saveSnapshot(),
  onShare: () => void copyShareLink(),
  onMeasureToggle: () => viewer.setMeasureMode(!viewer.measureMode),
  onInspectToggle: () => viewer.setInspectMode(!viewer.inspectMode),
  onProbeToggle: () => viewer.setProbeMode(!viewer.probeMode),
  onAnnotateToggle: () => viewer.setAnnotateMode(!viewer.annotateMode),
  onHelp: () => helpOverlay.open(),
  onClose: () => closeScan(),
});

// Game-style navigation: mode switcher, speed slider, controls HUD.
const navBar = new NavBar({
  onMode: (mode) => viewer.setMode(mode),
  onSpeed: (multiplier) => viewer.setNavSpeed(multiplier),
});

const projectCard = new ProjectCard();

// The streaming-COPC panel — phase, live status, and streaming controls.
const streamingPanel = new StreamingPanel({
  onColorMode: (mode) => viewer.setStreamingColorMode(mode),
  onQuality: (quality) => {
    streamingQuality = quality;
    viewer.setStreamingQuality(quality, isPhone());
  },
  onPauseToggle: (paused) => {
    if (paused) viewer.pauseStreaming();
    else viewer.resumeStreaming();
  },
  onClearCache: () => viewer.clearStreamingCache(),
  onSaveView: () => saveCurrentView(),
  onApplyView: (index) => applyView(index),
  onDeleteView: (index) => deleteView(index),
});

// The Measurements panel lists placed measurements; the controller drives it.
const measurePanel = new MeasurePanel({
  onDelete: (id) => viewer.measure.removeMeasurement(id),
  onRename: (id, name) => viewer.measure.renameMeasurement(id, name),
  onExport: () => exportSession(),
  onImport: (file) => void importSession(file),
});
// The Annotations panel lists placed annotations; the controller drives it.
const annotationPanel = new AnnotationPanel({
  onActivate: (id) => viewer.jumpToAnnotation(id),
  onEdit: (id, x, y) => viewer.annotate.beginEdit(id, x, y),
  onDelete: (id) => viewer.annotate.remove(id),
  onClearAll: () => viewer.annotate.clear(),
  onHover: (id) => viewer.annotate.hover(id),
});

// Every listener-binding that synchronously dereferences `viewer.*` must
// wait until the lazy-loaded Viewer chunk has resolved. The handlers
// themselves are fine to define eagerly (they only fire on user input,
// which comes long after the Viewer is up); only the binding calls need
// to be deferred.
void viewerLoaded.then(() => {
  viewer.setNavListeners({
    onModeChange: (mode) => navBar.setMode(mode),
    onPointerLockChange: (locked) => navBar.setLocked(locked),
    onToggleHelp: () => navBar.toggleHelp(),
  });
  viewer.setMeasureListeners({
    onModeChange: (active) => {
      dock.setMeasureActive(active);
      // Hide the "click to look around" prompt — a picking tool owns the clicks.
      navBar.setMeasuring(viewer.measureMode || viewer.inspectMode || viewer.annotateMode);
      // The summary card and the tool hint share the top-centre slot.
      if (active) projectCard.hide();
      refreshMeasurePanel();
    },
  });
  viewer.setInspectListeners({
    onModeChange: (active) => {
      dock.setInspectActive(active);
      navBar.setMeasuring(viewer.measureMode || viewer.inspectMode || viewer.annotateMode);
      if (active) projectCard.hide();
    },
  });
  viewer.setProbeListeners({
    onModeChange: (active) => {
      dock.setProbeActive(active);
      // The probe keeps navigation live, so the "look around" prompt stays.
      if (active) projectCard.hide();
    },
  });
  viewer.setAnnotateListeners({
    onModeChange: (active) => {
      dock.setAnnotateActive(active);
      navBar.setMeasuring(viewer.measureMode || viewer.inspectMode || viewer.annotateMode);
      if (active) projectCard.hide();
      refreshAnnotationPanel();
    },
  });
  viewer.measure.setOnChange(refreshMeasurePanel);
  // Persist the unit choice whenever it changes.
  viewer.measure.setOnUnitChange(persistPrefs);
  viewer.annotate.setOnChange(refreshAnnotationPanel);

  // Apply any preferences saved in a previous session, once the GPU backend
  // has initialised (so a saved EDL choice overrides the backend's default
  // gate).
  void viewer.ready.then(() => {
    viewerReady = true;
    // Degraded defaults for a weak device come first; a saved user
    // preference, applied immediately after, still wins.
    applyDeviceDefaults();
    applyPrefs();
    // Pre-warm the lazy load chunks once the GPU backend is ready.
    // First-file-drop is the most painful "did the app freeze?" moment;
    // this moves the ~200–500 ms chunk fetch + parse off the critical path
    // so a user who opens the app and immediately drops a file sees the
    // parser run instantly. Idle-callback so the prewarm doesn't compete
    // with the renderer's first frames; falls back to setTimeout on
    // browsers without rIC.
    schedulePrewarm();
  });
});

const dropZone = new DropZone(document.body, (file) => void handleFile(file));
stage.overlay.append(dropZone.toast);

// The nav bar is core interaction — shown in embed mode too. Hidden until a
// scan is loaded. The touch hint rides alongside it (phones only via CSS).
navBar.element.classList.add('olv-hidden');
stage.overlay.append(navBar.element, navBar.prompt, navBar.touchHint);

// Overlay wiring synchronously reads `viewer.measureElements`,
// `viewer.inspectElements`, etc. — defer the whole block until the lazy
// Viewer chunk has resolved. The DOM elements the user can interact with
// before this resolves (start screen empty state, sample buttons, URL
// field, drop zone) are all owned by Stage / DropZone and don't depend on
// the Viewer.
void viewerLoaded.then(() => {
  if (!bareMode) {
    // The tool overlays go in first so the panels paint above them.
    stage.overlay.append(viewer.measureElements.overlay);
    stage.overlay.append(viewer.measureElements.hint);
    stage.overlay.append(viewer.inspectElements.overlay);
    stage.overlay.append(viewer.inspectElements.hint);
    stage.overlay.append(viewer.annotateElements.overlay);
    stage.overlay.append(viewer.annotateElements.hint);
    stage.overlay.append(inspector.element);
    stage.overlay.append(streamingPanel.element);
    // The measurement and annotation panels share a stacked left-side column.
    const leftPanels = document.createElement('div');
    leftPanels.className = 'olv-left-panels';
    leftPanels.append(measurePanel.element, annotationPanel.element);
    stage.overlay.append(leftPanels);
    stage.overlay.append(dock.dock);
    stage.overlay.append(dock.backend);
    stage.overlay.append(projectCard.element);
    // The point-info card sits above the panels so its Copy button is reachable.
    stage.overlay.append(viewer.inspectElements.card);
    // The annotation editor card floats above everything while it is open.
    stage.overlay.append(viewer.annotateElements.editor);
    // The live-probe readout follows the cursor above the panels.
    stage.overlay.append(viewer.probeElements.readout);
    // The phone-only "Scan Info" launcher for the Inspector bottom sheet.
    stage.overlay.append(inspector.sheetToggle);
    // The help overlay is a modal — appended last so it sits above everything.
    stage.overlay.append(helpOverlay.element);

    // Global keyboard shortcuts — single-key tool access, suppressed while
    // typing. Only wired for the full app, never the minimal embed view.
    // A tool shortcut needs a loaded scan and is inert behind the help modal.
    const toolsReady = (): boolean => hasScan() && !helpOverlay.isOpen;
    bindShortcuts({
      onAnnotate: () => {
        if (toolsReady()) viewer.setAnnotateMode(!viewer.annotateMode);
      },
      onMeasure: () => {
        if (toolsReady()) viewer.setMeasureMode(!viewer.measureMode);
      },
      onInspect: () => {
        if (toolsReady()) viewer.setInspectMode(!viewer.inspectMode);
      },
      onSaveView: () => {
        if (toolsReady()) saveCurrentView();
      },
      onDeleteSelection: () => {
        const id = viewer.annotate.selectedId;
        if (id && !helpOverlay.isOpen) viewer.annotate.remove(id);
      },
      onToggleHelp: () => helpOverlay.toggle(),
      onUndo: () => {
        if (!helpOverlay.isOpen) viewer.annotate.undo();
      },
      onRedo: () => {
        if (!helpOverlay.isOpen) viewer.annotate.redo();
      },
    });
  } else {
    // Bare mode (embed / ?ui=minimal): the dock and panels are hidden, but
    // ?measurements=1 / ?annotations=1 can each surface one tool's layer.
    const panels: HTMLElement[] = [];
    if (embedConfig.forceMeasurements) {
      stage.overlay.append(viewer.measureElements.overlay, viewer.measureElements.hint);
      panels.push(measurePanel.element);
    }
    if (embedConfig.forceAnnotations) {
      stage.overlay.append(
        viewer.annotateElements.overlay,
        viewer.annotateElements.hint,
        viewer.annotateElements.editor,
      );
      panels.push(annotationPanel.element);
    }
    if (panels.length > 0) {
      const leftPanels = document.createElement('div');
      leftPanels.className = 'olv-left-panels';
      leftPanels.append(...panels);
      stage.overlay.append(leftPanels);
    }
  }
});

// the cross-frame control bridge is now lazy-loaded.
// `?embed=1` is a minority of traffic; non-embed loads should not pay
// the ~5 KB embed-bridge cost.
async function startEmbedBridgeLazy(): Promise<typeof import('./ui/embedBridge').startEmbedBridge> {
  const m = await import('./ui/embedBridge');
  return m.startEmbedBridge;
}

if (embed) {
  void startEmbedBridgeLazy().then((startEmbedBridge) => startEmbedBridge({
    onLoadFile: (buffer, fileName) => void handleFile(new File([buffer], fileName)),
    onJumpCamera: (camera) => viewer.applyCameraState(camera),
    onToggleLayer: (id, visible) => viewer.setCloudVisible(id, visible),
    onFocusAnnotation: (id) => viewer.jumpToAnnotation(id),
  }));
}

// `?autoload=sample:<id>` — open a built-in sample on startup (embed demos).
if (embedConfig.autoloadSample) {
  const sample = SAMPLES.find((s) => s.id === embedConfig.autoloadSample);
  if (sample) void loadFromUrl(sample.url, sample.name);
}

// `?copc=<url>` — open a remote COPC scan on startup. A hosted COPC file is
// thus a shareable, bookmarkable deep link — the format's core use case. The
// streaming pipeline reads it progressively over HTTP range requests.
const copcUrlParam = urlParams.get('copc');
if (copcUrlParam) void handleRemoteUrl(copcUrlParam);

// The developer performance overlay — surfaced only by `?debug=1` or
// `?benchmark=1`. It polls the viewer for live frame stats on a throttled
// cadence; the load path feeds it telemetry and any benchmark result.
if (debug || benchmark) {
  // The diagnostics chunk is fetched only when one of the flags is set —
  // it never weighs on a normal-session bundle.
  void loadDiagnostics().then((d) => {
    debugOverlay = new d.DebugOverlay(() => ({
      backend: viewerReady ? viewer.activeBackend() : null,
      stats: viewerReady ? viewer.frameStats() : null,
      streaming: streamingDebugSample(),
    }));
    stage.overlay.append(debugOverlay.element);
    debugOverlay.start();
  });
}

/** Sample live COPC streaming counters for the debug overlay, or null. */
function streamingDebugSample(): StreamingDebugStats | null {
  // Returns null before the lazy Viewer chunk has resolved — the debug
  // overlay polls on a timer from the moment it starts, which can fire
  // before `viewer` is non-null.
  if (!viewerReady) return null;
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
  if (streamingBenchmark) {
    sample.thrashEvents = streamingBenchmark.thrashEvents;
    const tier = streamingBenchmark.tierCounters();
    sample.nodesReady = tier.nodesReady;
    sample.nodesEvicted = tier.nodesEvicted;
    const recent = streamingBenchmark.recentSchedulerTickStats(60);
    if (recent.count > 0) {
      sample.schedulerRecent = {
        count: recent.count,
        p50: recent.p50,
        p95: recent.p95,
        max: recent.max,
      };
    }
  }
  return sample;
}

/** Run every registered validation module and flatten the rows. */
function runModules(cloud: PointCloud): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  for (const module of registry.list()) rows.push(...module.run(cloud).rows);
  return rows;
}

/** The file name without its extension. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * pre-warm the Studio chunk after a cloud finishes loading. The
 * fetch + parse happens in the background while the user is exploring the
 * scene, so the first Image-export click immediately runs the export
 * instead of waiting on the chunk. Idempotent — the dynamic import is
 * cached after the first call, so re-firing is free.
 */
let _studioPrewarmed = false;
async function prewarmExportStudio(): Promise<void> {
  if (_studioPrewarmed) return;
  _studioPrewarmed = true;
  try {
    await loadExportStudio();
  } catch {
    // Pre-warm is best-effort; an actual export click will retry the import
    // and surface the error there if it persists.
    _studioPrewarmed = false;
  }
}

/**
 * pre-warm the heaviest LOAD chunks on app idle so the first
 * file-drop runs the parser without waiting ~200-500 ms for the lazy
 * `loadLas` + `loadStreamingPointCloud` + `loadCopcWorkerClient` chunks
 * to download and parse. The chunks ARE the COPC streaming pipeline plus
 * the static LAS/LAZ reader — together they cover ~85% of the formats
 * users open. Other format loaders (PCD, PTX, PTS, GLTF) stay strictly
 * lazy because their on-disk frequency is low.
 *
 * Scheduling: `requestIdleCallback` so the warm doesn't compete with the
 * renderer's first frames; falls back to a 1.5 s `setTimeout` on browsers
 * that don't support rIC (Safari < 17). Idempotent — each load chunk's
 * dynamic import is cached, so re-firing is free.
 */
let _loadersPrewarmed = false;
function schedulePrewarm(): void {
  if (_loadersPrewarmed) return;
  const fire = (): void => {
    if (_loadersPrewarmed) return;
    _loadersPrewarmed = true;
    void loadStreamingPointCloud().catch(() => { _loadersPrewarmed = false; });
    void loadCopcWorkerClient().catch(() => { /* swallow — actual COPC open retries */ });
    // Static LAS/LAZ loader sits in its own chunk too — pre-warm it for
    // the "drop a non-COPC LAZ file" path which is the other common case.
    void import('./io/loadLas').catch(() => { /* swallow */ });
  };
  type RIC = (cb: () => void, opts?: { timeout?: number }) => number;
  const rIC = (window as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
  if (typeof rIC === 'function') {
    rIC(fire, { timeout: 2000 });
  } else {
    setTimeout(fire, 1500);
  }
}

/**
 * Assemble + render a PDF report from the live state.
 * Lazy-loads the report engine (which pulls pdf-lib) on first call.
 * Returns a Promise so the caller can surface errors via toast/alert.
 *
 * Pulls the active streaming OR static cloud's metadata, the current
 * annotations + measurements + unit system, and assembles a
 * `ReportInputs`. Visuals + technical notes are queued for a UI-coupled
 * follow-up (the user will pre-render image exports + type notes via a
 * follow-on Studio-panel dialog). The engineering-
 * inspection template renders cleanly without visuals.
 */
async function generateReportPdf(templateId: string): Promise<void> {
  // the report flow needs the Viewer state; ensure it's loaded.
  await viewerLoaded;
  const report = await loadReportEngine();
  const streamingCloud = viewer.streamingCloud;
  const staticCloud = activeId ? viewer.getCloud(activeId) : undefined;
  if (!streamingCloud && !staticCloud) {
    throw new Error('Load a scan first.');
  }

  // Build the MetadataInputs the composer + dataset-summary section need.
  let metadata: import('./report').MetadataInputs;
  let exportFileStem: string;
  if (streamingCloud) {
    const b = streamingCloud.localBounds();
    const w = b[3] - b[0], d = b[4] - b[1], h = b[5] - b[2];
    const density = w > 0 && d > 0
      ? streamingCloud.sourcePointCount / (w * d)
      : NaN;
    const crs = streamingCloud.crs();
    const modes = streamingCloud.availableColorModes();
    metadata = {
      fileName: streamingCloud.name,
      format: streamingCloud.kind === 'ept' ? 'EPT' : 'COPC',
      sourcePointCount: streamingCloud.sourcePointCount,
      width: w, depth: d, height: h, density,
      hasRgb: modes.includes('rgb'),
      hasIntensity: modes.includes('intensity'),
      hasClassification: modes.includes('classification'),
      ...(crs ? { crsName: crs.name, crsUnit: crs.linearUnit } : {}),
    };
    exportFileStem = baseName(streamingCloud.name);
  } else if (staticCloud) {
    const b = staticCloud.bounds();
    const w = b.max[0] - b.min[0], d = b.max[1] - b.min[1], h = b.max[2] - b.min[2];
    const density = w > 0 && d > 0 ? staticCloud.pointCount / (w * d) : NaN;
    const crs = staticCloud.metadata?.crs;
    metadata = {
      fileName: staticCloud.name,
      format: staticCloud.sourceFormat.toUpperCase(),
      sourcePointCount: staticCloud.pointCount,
      width: w, depth: d, height: h, density,
      hasRgb: !!staticCloud.colors,
      hasIntensity: !!staticCloud.intensity,
      hasClassification: !!staticCloud.classification,
      ...(crs ? { crsName: crs.name, crsUnit: crs.linearUnit } : {}),
    };
    exportFileStem = baseName(staticCloud.name);
  } else {
    throw new Error('Load a scan first.');
  }

  const inputs = report.composeReportInputs({
    templateId: templateId as import('./report').ReportTemplateId,
    title: 'Scan Report',
    subtitle: undefined,
    metadata,
    visuals: [],          // user-pre-rendered Studio exports
    annotations: viewer.annotate.getAnnotations(),
    measurements: viewer.measure.getMeasurements(),
    unitSystem: viewer.measure.unitSystem,
  });

  const result = await report.generateReport(inputs);
  downloadBlob(`${exportFileStem}-report.pdf`, result.blob);
}

/** Trigger a client-side download of text content. */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  downloadBlob(filename, blob);
}

/**
 * Trigger a client-side download of a `Blob`. Used by the Visual Export
 * Studio for PNG downloads where the exporter has already produced a Blob.
 */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Read the current viewer settings and persist them for the next session. */
function persistPrefs(): void {
  savePrefs({
    pointSize: viewer.pointSize,
    edlEnabled: viewer.edlEnabled,
    edlStrength: viewer.edlStrength,
    pointSizeMode: viewer.pointSizeMode,
    antialiasing: viewer.antialiasing,
    unitSystem: viewer.measure.unitSystem,
  });
}

/**
 * Apply preferences saved in a previous session. Each key is applied only when
 * it was stored, so anything absent keeps the viewer's own default — including
 * the backend-dependent EDL default.
 */
/**
 * Apply degraded rendering defaults on a low-capability device — Eye Dome
 * Lighting and antialiasing off — so a weak GPU stays interactive. Runs before
 * `applyPrefs`, so an explicit saved preference still takes precedence.
 */
function applyDeviceDefaults(): void {
  if (deviceCapsValue.tier === 'low') {
    viewer.setEdlEnabled(false);
    viewer.setAntialiasing(false);
  }
}

function applyPrefs(): void {
  const p = loadPrefs();
  if (p.pointSize !== undefined) viewer.setPointSize(p.pointSize);
  if (p.edlEnabled !== undefined) viewer.setEdlEnabled(p.edlEnabled);
  if (p.edlStrength !== undefined) viewer.setEdlStrength(p.edlStrength);
  if (p.pointSizeMode !== undefined) viewer.setPointSizeMode(p.pointSizeMode);
  if (p.antialiasing !== undefined) viewer.setAntialiasing(p.antialiasing);
  if (p.unitSystem !== undefined) viewer.measure.setUnitSystem(p.unitSystem);
}

/** Refresh the Measurements panel's contents and visibility. */
function refreshMeasurePanel(): void {
  measurePanel.update(viewer.measure.getSummaries());
  const hasMeasurements = viewer.measure.getMeasurements().length > 0;
  measurePanel.setVisible(viewer.measureMode || hasMeasurements);
}

/** Refresh the Annotations panel's contents and visibility. */
function refreshAnnotationPanel(): void {
  annotationPanel.update(viewer.annotate.getSummaries());
  const hasAnnotations = viewer.annotate.getAnnotations().length > 0;
  annotationPanel.setVisible(viewer.annotateMode || hasAnnotations);
}

/** Whether a scan is currently loaded — gates the tool keyboard shortcuts. */
function hasScan(): boolean {
  return viewer.clouds().length > 0 || viewer.hasStreamingCloud;
}

/** Capture the current camera viewpoint as a named saved view. */
function saveCurrentView(): void {
  savedViews.push({ name: `View ${++viewCounter}`, pose: viewer.getCameraPose() });
  refreshViewsUI();
}

/** Push the saved-view names to whichever panel is currently shown. */
function refreshViewsUI(): void {
  const names = savedViews.map((v) => v.name);
  if (viewer.hasStreamingCloud) streamingPanel.setViews(names);
  else inspector.setViews(names);
}

/** Glide the camera to a saved view. */
function applyView(index: number): void {
  const view = savedViews[index];
  if (view) viewer.applyCameraPose(view.pose);
}

/** Delete a saved view and refresh the list. */
function deleteView(index: number): void {
  savedViews.splice(index, 1);
  refreshViewsUI();
}

/**
 * Copy a link that reproduces the current view — camera, colour mode, point
 * sizing, and the selected annotation — to the clipboard. No scan data is
 * encoded; the recipient opens the same scan and the view is restored on top.
 */
async function copyShareLink(): Promise<void> {
  const state: ShareState = {
    camera: viewer.getCameraState(),
    pointSize: viewer.pointSize,
    pointSizeMode: viewer.pointSizeMode,
  };
  if (currentColorMode) state.colorMode = currentColorMode;
  const selected = viewer.annotate.selectedId;
  if (selected) state.selectedAnnotation = selected;

  const encoded = encodeShareState(state);
  const link = `${window.location.origin}${window.location.pathname}#s=${encoded}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    // Clipboard unavailable (e.g. an insecure context) — leave the state in
    // the address bar so the user can still copy the link from there.
    window.location.hash = `s=${encoded}`;
  }
}

/** Restore a decoded share-link state onto the freshly loaded scan. */
function applyShareState(state: ShareState, cloud: PointCloud): void {
  if (state.pointSize !== undefined) viewer.setPointSize(state.pointSize);
  if (state.pointSizeMode === 'adaptive' || state.pointSizeMode === 'fixed') {
    viewer.setPointSizeMode(state.pointSizeMode);
  }
  if (state.colorMode && activeId) {
    const modes = availableModes(cloud);
    if (modes.includes(state.colorMode as ColorMode)) {
      currentColorMode = state.colorMode as ColorMode;
      viewer.setColorMode(activeId, currentColorMode);
      inspector.setColorModes(modes, currentColorMode);
    }
  }
  // The camera tween runs last, so it wins over the load-time framing.
  if (state.camera) viewer.applyCameraState(state.camera);
  // `select` is a safe no-op when the annotation is not in this scan.
  if (state.selectedAnnotation) viewer.annotate.select(state.selectedAnnotation);
}

/**
 * Export the inspection session — measurements, annotations and saved views —
 * as JSON. The whole inspection state round-trips, so a review can be closed
 * and reopened without loss.
 */
function exportSession(): void {
  const cloud = activeId ? viewer.getCloud(activeId) : undefined;
  const upAxis: 'y' | 'z' = cloud && isZUpFormat(cloud.sourceFormat) ? 'z' : 'y';

  // populate the v3 fields so the .olvsession captures
  // the full working state, not just the inspection annotations. The
  // optional fields are only emitted when there's something meaningful
  // to write — a session exported with no scan loaded won't pollute
  // the file with bogus render defaults.
  const streamingCloud = viewer.streamingCloud;
  const exportFileName = streamingCloud?.name
    ?? (cloud ? cloud.name : null);

  let scanSummary: import('./io/session').SessionScanSummary | undefined;
  if (streamingCloud) {
    const b = streamingCloud.localBounds();
    const crs = streamingCloud.crs();
    scanSummary = {
      fileName: streamingCloud.name,
      sourcePoints: streamingCloud.sourcePointCount,
      width: b[3] - b[0],
      depth: b[4] - b[1],
      height: b[5] - b[2],
      ...(crs ? { crs: crs.name, crsUnit: crs.linearUnit } : {}),
    };
  } else if (cloud) {
    const b = cloud.bounds();
    scanSummary = {
      fileName: cloud.name,
      sourcePoints: cloud.pointCount,
      width: b.max[0] - b.min[0],
      depth: b.max[1] - b.min[1],
      height: b.max[2] - b.min[2],
      ...(cloud.metadata?.crs
        ? { crs: cloud.metadata.crs.name, crsUnit: cloud.metadata.crs.linearUnit }
        : {}),
    };
  }

  const json = serializeSession({
    upAxis,
    origin: cloud ? cloud.origin : [0, 0, 0],
    unitSystem: viewer.measure.unitSystem,
    views: savedViews.map((v) => ({ name: v.name, camera: v.pose })),
    measurements: viewer.measure.getMeasurements(),
    annotations: viewer.annotate.getAnnotations(),
    // v3 additions — present only when there's a cloud loaded.
    camera: cloud || streamingCloud ? viewer.getCameraState() : undefined,
    render: {
      pointSize: viewer.pointSize,
      edlEnabled: viewer.edlEnabled,
      edlStrength: viewer.edlStrength,
      pointSizeMode: viewer.pointSizeMode,
      antialiasing: viewer.antialiasing,
    },
    colorMode: viewer.activeColorMode(),
    scanSummary,
  });
  // `.olvsession` is the new canonical extension; the file is
  // still JSON internally (Mac/Linux's Open With dialog associates the
  // double-click flow). Filename derived from the active scan name when
  // possible so a folder of exports doesn't collide.
  const stem = exportFileName ? baseName(exportFileName) : 'openlidarviewer';
  downloadText(`${stem}.olvsession`, json);
}

/** Import an inspection session: restore measurements, annotations and views. */
async function importSession(file: File): Promise<void> {
  try {
    const session = parseSession(await file.text());
    viewer.measure.loadMeasurements(session.measurements);
    viewer.annotate.loadAnnotations(session.annotations);
    savedViews = session.views.map((v) => ({ name: v.name, pose: v.camera }));
    viewCounter = savedViews.length;
    inspector.setViews(savedViews.map((v) => v.name));
    refreshMeasurePanel();
    refreshAnnotationPanel();

    // apply the v3 optional fields when present. Each
    // one is independently guarded so a partial v3 file (e.g. one with
    // a camera but no render settings) restores what's there without
    // assuming the rest. A v1 / v2 file has none of these — fall through
    // to the existing behaviour.
    if (session.render) {
      viewer.setPointSize(session.render.pointSize);
      viewer.setPointSizeMode(session.render.pointSizeMode);
      viewer.setEdlEnabled(session.render.edlEnabled);
      viewer.setEdlStrength(session.render.edlStrength);
      viewer.setAntialiasing(session.render.antialiasing);
      inspector.syncRendering({
        pointSize: viewer.pointSize,
        edlEnabled: viewer.edlEnabled,
        edlStrength: viewer.edlStrength,
        pointSizeMode: viewer.pointSizeMode,
        antialiasing: viewer.antialiasing,
      });
    }
    if (session.colorMode) {
      // Apply to every static cloud; the streaming subsystem too.
      for (const id of viewer.clouds()) viewer.setColorMode(id, session.colorMode);
      viewer.setStreamingColorMode(session.colorMode);
    }
    if (session.camera) {
      // Fly the live camera to the saved viewpoint — the session capture's
      // "where I was looking when I saved" guarantee.
      viewer.applyCameraState(session.camera);
    }
  } catch (err) {
    dropZone.setError(err instanceof Error ? err.message : 'Could not import the session');
  }
}

/** Load a dropped or sampled File: parse, render, and populate the Inspector. */
async function handleFile(file: File): Promise<void> {
  // One load at a time. The shared parse worker decodes a single file; a
  // second load started mid-flight would hijack the first one's worker. The
  // in-progress load carries a Cancel control if the user wants to switch.
  if (loading) return;
  // ensure the lazy-loaded Viewer is ready before touching it.
  await viewerLoaded;
  loading = true;
  const controller = new AbortController();
  dropZone.setProgress(`Reading ${file.name}…`);
  dropZone.setCancelHandler(() => controller.abort());
  try {
    // COPC files take the streaming pipeline, not the static loader. The
    // range-source module is part of the lazy COPC chunk.
    const headSlice = await file.slice(0, 4096).arrayBuffer();
    if (detectCopc(headSlice).isCopc) {
      const { LocalFileRangeSource } = await loadLocalFileRangeSource();
      await openStreamingCopc(
        new LocalFileRangeSource(file),
        file.name,
        controller.signal,
      );
      return;
    }
    // A static load replaces any open streaming scan.
    if (viewer.hasStreamingCloud) closeStreaming();

    // Phones get a tighter point budget — limited GPU memory and fill-rate.
    // The dropped file is wrapped in a LocalFileSource — the source
    // abstraction; v0.3 streaming sources slot in beside it.
    const source = new LocalFileSource(file);
    const result = await source.load(
      {
        onProgress: (u) => dropZone.setProgress(formatProgress(u), u.fraction),
        onPreload: (lines) => dropZone.setPreload(lines),
      },
      {
        // The point budget is the device's safe render budget — full on a
        // capable machine, reduced on a weak one to keep the GPU stable.
        budget: deviceCapsValue.renderBudget,
        isMobile: isPhone(),
        deviceMemoryGB: deviceMemoryGB(),
        signal: controller.signal,
      },
    );
    await viewer.ready;

    dropZone.setProgress(formatProgress({ stage: 'uploading' }));
    stage.hideEmptyState();
    const uploadStartedAt = performance.now();
    const id = viewer.addCloud(result.cloud);
    const gpuUploadMs = performance.now() - uploadStartedAt;
    activeId = id;

    dropZone.setProgress(formatProgress({ stage: 'rendering' }));
    const renderStartedAt = performance.now();
    // A freshly opened scan starts in the orbit overview, then glides in.
    viewer.setMode('orbit');
    viewer.frameAll();
    const firstRenderMs = performance.now() - renderStartedAt;

    const mode = defaultMode(result.cloud);
    currentColorMode = mode;
    viewer.setColorMode(id, mode);

    // A new scan resets the saved viewpoints and annotations.
    savedViews = [];
    viewCounter = 0;
    viewer.annotate.clear();
    refreshAnnotationPanel();

    inspector.addCloud(id, result.cloud.name, result.cloud.pointCount);
    inspector.setColorModes(availableModes(result.cloud), mode);
    inspector.setDetail(result.cloud.pointCount, result.originalPointCount);
    inspector.setReport(runModules(result.cloud));
    inspector.setViews([]);
    // Visual Export Studio — a scan is now loaded; turn on the image-
    // export buttons so the user can capture it. Pre-warm the lazy Studio
    // chunk in the background so the first export click feels instant
    // instead of waiting on the ~7 KB gzip fetch + parse. Pure fire-and-
    // forget; we don't await the result.
    inspector.setImageExportEnabled(true);
    void prewarmExportStudio();

    // A share link, if one opened this page, restores its view onto this scan.
    if (pendingShareState) {
      applyShareState(pendingShareState, result.cloud);
      pendingShareState = null;
    }

    // The render-quality controls reflect the viewer's state — EDL defaults
    // depend on the GPU backend, known only once `viewer.ready` resolved.
    inspector.syncRendering({
      pointSize: viewer.pointSize,
      edlEnabled: viewer.edlEnabled,
      edlStrength: viewer.edlStrength,
      pointSizeMode: viewer.pointSizeMode,
      antialiasing: viewer.antialiasing,
    });
    dock.setBackend(viewer.activeBackend());
    dock.setMeasureEnabled(true);
    dock.setInspectEnabled(true);
    dock.setProbeEnabled(true);
    dock.setAnnotateEnabled(true);
    dock.setCloseEnabled(true);

    navBar.element.classList.remove('olv-hidden');
    navBar.setMode('orbit');
    navBar.flashHelp();

    // Reveals the phone-only Scan Info launcher (CSS keyed off this class).
    document.body.classList.add('olv-has-scan');
    // Phones get a touch-gesture hint in place of the keyboard HUD.
    if (isPhone()) navBar.flashTouchHint();

    if (!bareMode) showProjectCard(result.cloud, result.originalPointCount);

    // Developer diagnostics — the merged telemetry feeds the debug console
    // block, the performance overlay, and (under ?benchmark=1) a benchmark.
    if ((debug || benchmark) && result.telemetry) {
      const telemetry = { ...result.telemetry, gpuUploadMs, firstRenderMs };
      if (debug) {
        console.log(
          '%cOpenLiDARViewer — load telemetry',
          'font-weight:600;color:#22dcff',
          '\n' + formatTelemetry(telemetry),
        );
      }
      debugOverlay?.setTelemetry(telemetry);
      if (benchmark) {
        const text = formatBenchmarkResult(
          buildBenchmarkResult(
            result.cloud.name,
            result.cloud.sourceFormat,
            result.cloud.pointCount,
            telemetry,
          ),
        );
        console.log(
          '%cOpenLiDARViewer — benchmark',
          'font-weight:600;color:#22dcff',
          '\n' + text,
        );
        debugOverlay?.setBenchmark('benchmark\n' + text);
      }
    }
    dropZone.setCancelHandler(null);
    dropZone.setProgress(null);
  } catch (err) {
    dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError) {
      // A cancelled load is a quiet no-op — no error toast, nothing was added.
      dropZone.setProgress(null);
    } else {
      // The toast shows a clear, categorised message; the raw error still
      // reaches the console for developers under ?debug=1.
      if (debug) console.error('OpenLiDARViewer — load error', err);
      dropZone.setError(describeLoadError(err));
      // A streaming open that failed mid-flight leaves no scan — tidy up.
      closeStreaming();
    }
  } finally {
    loading = false;
  }
}

/**
 * Open a COPC scan from any range-readable source — a local file or a remote
 * HTTP URL — through the streaming pipeline: read the metadata and hierarchy,
 * attach the streaming cloud to the viewer, and show the streaming panel.
 * Point data then streams in progressively, driven by the camera.
 */
async function openStreamingCopc(
  range: RangeSource,
  displayName: string,
  signal: AbortSignal,
): Promise<void> {
  await viewer.ready;
  streamingPanel.setPhase('Loading metadata…');
  streamingPanel.show();
  inspector.element.classList.add('olv-hidden');
  dropZone.setProgress('Reading COPC hierarchy…');

  // The streaming benchmark collector is created when either `?benchmark=1`
  // (which adds a session report on close) or `?debug=1` (which surfaces the
  // live thrash / scheduler-histogram readout in the overlay) is set. Off by
  // default — no overhead in normal sessions. The diagnostics chunk loads
  // lazily on first need; cached afterwards.
  if (benchmark || debug) {
    const d = await loadDiagnostics();
    streamingBenchmark = new d.StreamingBenchmark();
    coarseStableFired = false;
    range = new d.InstrumentedRangeSource(range, (n) => {
      streamingBenchmark?.recordNetworkBytes(n);
    });
  }

  // The COPC + streaming subsystem is a lazy chunk — fetched only here, the
  // moment a COPC scan is opened, so it never weighs on the initial payload.
  // The `import()` split points live in `lazyChunks.ts` (see that file).
  const [{ StreamingPointCloud }, { CopcWorkerClient }, streamingColors] =
    await Promise.all([
      loadStreamingPointCloud(),
      loadCopcWorkerClient(),
      loadStreamingColors(),
    ]);

  const cloud = await StreamingPointCloud.open(range, displayName, signal);
  if (signal.aborted) throw new LoadCancelledError();

  if (!copcDecoder) copcDecoder = new CopcWorkerClient();
  // Wire the per-chunk decode timing hook only when a benchmark is collecting;
  // clearing it on close keeps a non-benchmark session free of any callback.
  copcDecoder.onDecodeMs = streamingBenchmark
    ? (ms) => streamingBenchmark?.recordDecodeMs(ms)
    : undefined;

  // A streaming scan is exclusive — clear any open static layers first.
  for (const id of viewer.clouds()) {
    viewer.removeCloud(id);
    inspector.removeCloud(id);
  }
  stage.hideEmptyState();
  await viewer.attachStreamingCloud(
    cloud,
    copcDecoder,
    streamingQuality,
    isPhone(),
    streamingBenchmark,
  );
  viewer.setMode('orbit');
  viewer.frameAll();

  streamingPanel.setColorModes(
    streamingColors.availableStreamingModes(cloud.metadata),
    streamingColors.defaultStreamingMode(cloud.metadata),
  );
  streamingPanel.setQuality(streamingQuality);
  streamingPanel.setPhase('Streaming coarse geometry…');
  // Visual Export Studio — a streaming COPC cloud is now attached;
  // the image-export buttons in the Inspector can light up. The streaming
  // path doesn't go through `inspector.addCloud`, so the gate has to flip
  // here too. Pre-warm the Studio chunk for the same reason as above.
  inspector.setImageExportEnabled(true);
  void prewarmExportStudio();

  // The metadata-driven scan summary, and a fresh saved-views list.
  const header = cloud.metadata.header;
  streamingPanel.setSummary({
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
  });
  savedViews = [];
  viewCounter = 0;
  refreshViewsUI();

  // Measure, annotate, inspect, probe and close all work on a streaming scan:
  // each resident COPC node keeps its full decoded per-point attributes.
  dock.setMeasureEnabled(true);
  dock.setAnnotateEnabled(true);
  dock.setInspectEnabled(true);
  dock.setProbeEnabled(true);
  dock.setCloseEnabled(true);
  dock.setBackend(viewer.activeBackend());
  navBar.element.classList.remove('olv-hidden');
  navBar.setMode('orbit');
  navBar.flashHelp();
  document.body.classList.add('olv-has-scan');

  startStreamingStatusPolling();
  dropZone.setProgress(null);
}

/**
 * the remote-URL router. Dispatches to the EPT handler when the
 * URL is an `ept.json` entry-point, otherwise routes to COPC. This is the
 * single seam every URL-loading code path goes through (the dropzone's
 * onOpenUrl callback, the `?copc=` query-param bootstrap, the embed-bridge
 * url-open message). Keeps format dispatch in one place so adding 3D
 * Tiles support in a future format here is a one-line addition.
 */
async function handleRemoteUrl(url: string): Promise<void> {
  // EPT detection is URL-pattern only — fast, no network, no schema fetch.
  // The check is inlined here (mirroring `detectEptUrl` in `eptDetect.ts`)
  // so the routing decision is synchronous and doesn't depend on the EPT
  // lazy chunk loading — a malformed URL still surfaces an error toast even
  // when the EPT or Viewer chunks aren't reachable.
  let isEpt = false;
  try {
    const u = new URL(url);
    isEpt = /(?:^|\/)ept\.json$/i.test(u.pathname);
  } catch {
    isEpt = /(?:^|\/)ept\.json(?:\?|#|$)/i.test(url);
  }
  if (isEpt) return handleRemoteEpt(url);
  return handleRemoteCopc(url);
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
async function handleRemoteEpt(url: string): Promise<void> {
  if (loading) return;
  // URL validation is pure — run it before awaiting the lazy Viewer so a
  // malformed URL always surfaces an error toast, even if the Viewer chunk
  // hasn't loaded yet or the GPU backend can't initialise.
  const eptUrlMod = await loadEpt();
  const check = eptUrlMod.validateRemoteEptUrl(url);
  if (!check.ok) {
    dropZone.setError(`${check.reason} Enter the full https://…/ept.json URL.`);
    return;
  }
  // The actual streaming open touches viewer state — defer until the lazy
  // Viewer chunk is up.
  await viewerLoaded;
  loading = true;
  const controller = new AbortController();
  dropZone.setProgress(`Reading EPT manifest from ${shortUrl(url)}…`);
  dropZone.setCancelHandler(() => controller.abort());
  try {
    const { parseEptMetadata, EptStreamingPointCloud, EptChunkDecoder } = eptUrlMod;

    // Fetch the manifest. We use plain `fetch` rather than the
    // HttpRangeSource: ept.json is a small JSON document, not a range-
    // served binary. The same retry / cancellation discipline still
    // applies via the abort controller.
    const manifestResponse = await fetch(url, { signal: controller.signal });
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

    if (viewer.hasStreamingCloud) closeStreaming();
    await viewer.ready;
    streamingPanel.setPhase('Building hierarchy…');
    streamingPanel.show();
    inspector.element.classList.add('olv-hidden');

    // Compute the dataset base URL by stripping the ept.json filename;
    // the source uses it to build hierarchy + tile URLs.
    const baseUrl = url.replace(/ept\.json(?:\?.*)?(?:#.*)?$/i, '');

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
    );
    if (controller.signal.aborted) throw new LoadCancelledError();

    // A streaming scan is exclusive — clear any open static layers first.
    for (const id of viewer.clouds()) {
      viewer.removeCloud(id);
      inspector.removeCloud(id);
    }
    stage.hideEmptyState();

    const decoder = new EptChunkDecoder(cloud);
    await viewer.attachStreamingCloud(
      cloud,
      decoder,
      streamingQuality,
      isPhone(),
      null,
    );
    viewer.setMode('orbit');
    viewer.frameAll();

    streamingPanel.setColorModes(
      // The interface returns a readonly array; the panel accepts a mutable
      // ColorMode[], so we materialise a copy.
      [...cloud.availableColorModes()],
      cloud.defaultColorMode(),
    );
    streamingPanel.setQuality(streamingQuality);
    streamingPanel.setPhase('Streaming coarse geometry…');
    inspector.setImageExportEnabled(true);
    void prewarmExportStudio();

    // The metadata-driven scan summary — same shape the COPC path fills,
    // adapted for EPT's metadata layout.
    const b = detection.metadata.bounds.conforming;
    const schemaSummary = `${detection.metadata.dataType} · ${detection.metadata.schema.length} attrs`;
    streamingPanel.setSummary({
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
    });

    document.body.classList.add('olv-has-scan');
    navBar.element.classList.remove('olv-hidden');
    navBar.setMode('orbit');
    startStreamingStatusPolling();
    dropZone.setCancelHandler(null);
    dropZone.setProgress(null);
  } catch (err) {
    dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError) {
      dropZone.setProgress(null);
    } else {
      if (debug) console.error('OpenLiDARViewer — remote EPT error', err);
      // classified error messages, matching the COPC
      // remote-UX polish. `describeRemoteEptError` distinguishes CORS,
      // 404, 5xx, hierarchy vs. tile fetch, and transport failures.
      dropZone.setError(eptUrlMod.describeRemoteEptError(err, url));
      closeStreaming();
    }
  } finally {
    loading = false;
  }
}

/** Display name for a remote EPT scan — the parent directory of ept.json. */
function remoteEptName(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/ept\.json$/i, '');
    const last = path.slice(path.lastIndexOf('/') + 1);
    return last ? `${decodeURIComponent(last)} (EPT)` : 'remote.ept';
  } catch {
    return 'remote.ept';
  }
}

/**
 * Open a remote COPC scan over HTTP range requests. The host must allow
 * cross-origin requests and serve byte ranges — `HttpRangeSource.probe()`
 * checks both up front, so a misconfigured host fails fast with a precise
 * reason rather than a stalled load.
 */
async function handleRemoteCopc(url: string): Promise<void> {
  if (loading) return;
  // URL validation is pure — run it before awaiting the lazy Viewer so a
  // malformed URL always surfaces an error toast, even if the Viewer chunk
  // hasn't loaded yet or the GPU backend can't initialise.
  const check = validateRemoteCopcUrl(url);
  if (!check.ok) {
    dropZone.setError(`${check.reason} Enter an http:// or https:// URL to a COPC (.copc.laz) file.`);
    return;
  }
  // The actual streaming open touches viewer state — defer until the lazy
  // Viewer chunk is up.
  await viewerLoaded;
  loading = true;
  const controller = new AbortController();
  dropZone.setProgress(`Connecting to ${shortUrl(url)}…`);
  dropZone.setCancelHandler(() => controller.abort());
  try {
    // The remote range source is part of the lazy COPC chunk.
    const { HttpRangeSource } = await loadHttpRangeSource();
    const range = new HttpRangeSource(url);
    // A HEAD probe for range support runs before the streaming UI appears, so
    // a host that cannot stream reports a precise reason instead of stalling.
    await range.probe(controller.signal);
    if (controller.signal.aborted) throw new LoadCancelledError();
    if (viewer.hasStreamingCloud) closeStreaming();
    await openStreamingCopc(range, remoteCopcName(url), controller.signal);
    dropZone.setCancelHandler(null);
    dropZone.setProgress(null);
  } catch (err) {
    dropZone.setCancelHandler(null);
    if (err instanceof LoadCancelledError) {
      dropZone.setProgress(null);
    } else {
      if (debug) console.error('OpenLiDARViewer — remote COPC error', err);
      dropZone.setError(describeRemoteCopcError(err, url));
      // A remote open that failed mid-flight leaves no scan — tidy up.
      closeStreaming();
    }
  } finally {
    loading = false;
  }
}

/** A short, readable form of a URL — its host — for progress and error text. */
function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The display name for a remote COPC scan — the file name from its URL path. */
function remoteCopcName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.slice(path.lastIndexOf('/') + 1);
    return last ? decodeURIComponent(last) : 'remote.copc.laz';
  } catch {
    return 'remote.copc.laz';
  }
}

/**
 * Turn a remote-COPC failure into a clear, honest message. `HttpRangeSource`
 * already classifies range-read failures (an unreachable or CORS-blocked host,
 * a host with no range support, a host that ignored the range); a non-range
 * error from the pipeline most often means the URL is reachable but the file
 * behind it is not a valid COPC.
 */
function describeRemoteCopcError(err: unknown, url: string): string {
  const safeUrl = sanitizeUrlForDisplay(url);
  if (err instanceof RangeReadError) {
    if (err.code === 'range-unsupported') {
      return `${err.message} Host the file where the server serves HTTP range requests — most static hosts and object stores do.`;
    }
    if (err.code === 'transport') {
      return `${err.message} The host must also allow cross-origin (CORS) requests.`;
    }
    if (err.code === 'timeout') {
      return `${err.message} The server may be slow or unreachable — try again, or pick a faster host.`;
    }
    if (err.code === 'content-mismatch') {
      return `${err.message} This usually means a proxy or CDN ignored the byte-range request.`;
    }
    if (err.code === 'server-error') {
      return `${err.message} The host returned a server-side error — wait a moment and try again.`;
    }
    return err.message;
  }
  const detail = err instanceof Error ? err.message : 'unknown error';
  return `${shortUrl(safeUrl)} was reached, but it could not be read as a COPC scan — ${detail}.`;
}

/** Close a streaming scan: stop polling, detach, restore the static panel. */
function closeStreaming(): void {
  // Finalize the benchmark (if any) before tearing the session down — we
  // want the final cache snapshot and peak resident counters to be observed.
  // The post-session report is logged only under `?benchmark=1`; `?debug=1`
  // alone uses the collector solely for the live overlay readout.
  if (streamingBenchmark) {
    const result = streamingBenchmark.finalize();
    // The diagnostics runtime is already loaded at this point (the same
    // session that created the benchmark above also loaded the formatter).
    if (benchmark && diagnostics) {
      const text = diagnostics.formatStreamingBenchmark(result);
      console.log(
        '%cOpenLiDARViewer — streaming benchmark',
        'font-weight:600;color:#22dcff',
        '\n' + text,
      );
      debugOverlay?.setBenchmark('streaming benchmark\n' + text);
    }
    streamingBenchmark = null;
    coarseStableFired = false;
  }
  if (copcDecoder) copcDecoder.onDecodeMs = undefined;
  stopStreamingStatusPolling();
  viewer.detachStreamingCloud();
  streamingPanel.hide();
  inspector.element.classList.remove('olv-hidden');
}

/** Poll the streaming state ~4 Hz so the panel reflects progress. */
function startStreamingStatusPolling(): void {
  stopStreamingStatusPolling();
  streamingStatusTimer = window.setInterval(() => {
    const cloud = viewer.streamingCloud;
    const scheduler = viewer.streamingScheduler;
    if (!cloud || !scheduler) return;
    const counts = cloud.counts();
    streamingPanel.setStatus({
      loadedNodes: counts.resident,
      knownNodes: counts.known,
      displayedPoints: cloud.residentPointCount,
      sourcePoints: cloud.sourcePointCount,
      cacheBytes: scheduler.cacheStats().byteSize,
    });
    if (counts.resident === 0) {
      streamingPanel.setPhase('Streaming coarse geometry…');
    } else if (counts.loading > 0 || counts.queued > 0) {
      streamingPanel.setPhase('Refining visible detail…');
    } else {
      streamingPanel.setPhase('Streaming ready');
    }

    // Benchmark sampling — only when collecting. The 250 ms cadence catches
    // scheduler-tick samples through the onTick hook, not here; this loop is
    // for state-snapshot metrics (resident counts, cache outcomes, peaks).
    if (streamingBenchmark) {
      const cacheStats = scheduler.cacheStats();
      streamingBenchmark.recordCacheSnapshot({
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        evictions: cacheStats.evictions,
      });
      streamingBenchmark.recordResident(
        cloud.residentPointCount,
        scheduler.pointBudget,
      );
      streamingBenchmark.recordResidentBytes(estimateGpuBytes(cloud.residentPointCount));
      // Coarse stable: the first poll at which the scheduler has settled with
      // at least one resident node — nothing queued, nothing loading.
      if (
        !coarseStableFired &&
        counts.resident > 0 &&
        counts.loading === 0 &&
        counts.queued === 0
      ) {
        streamingBenchmark.recordCoarseStable();
        coarseStableFired = true;
      }
    }
  }, 250);
}

/** Stop the streaming-status poll. */
function stopStreamingStatusPolling(): void {
  if (streamingStatusTimer !== undefined) {
    window.clearInterval(streamingStatusTimer);
    streamingStatusTimer = undefined;
  }
}

/** Reveal the "Project ready" summary card for a freshly opened scan. */
function showProjectCard(cloud: PointCloud, totalCount: number): void {
  const b = cloud.bounds();
  projectCard.show({
    name: cloud.name,
    format: cloud.sourceFormat,
    shownCount: cloud.pointCount,
    totalCount,
    width: b.max[0] - b.min[0],
    depth: b.max[1] - b.min[1],
    height: b.max[2] - b.min[2],
    hasRgb: cloud.colors !== undefined,
    hasIntensity: cloud.intensity !== undefined,
    hasClassification: cloud.classification !== undefined,
  });
}

/** Fetch a built-in sample (a local static file — no upload) and load it. */
async function loadFromUrl(url: string, name: string): Promise<void> {
  // ensure the lazy-loaded Viewer is ready before touching it.
  await viewerLoaded;
  dropZone.setProgress(`Loading ${name}…`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load sample: ${name}`);
    const blob = await response.blob();
    await handleFile(new File([blob], name));
  } catch (err) {
    dropZone.setError(err instanceof Error ? err.message : 'Failed to load the sample');
  }
}

/**
 * Tear the session down to the empty state. Shared by removing the last cloud
 * and by the Close action: clears tools, measurements, saved views, and the
 * panels, then shows the empty state so another scan can be loaded.
 */
function resetToEmptyState(): void {
  viewer.setMeasureMode(false);
  viewer.setInspectMode(false);
  viewer.clearMeasurements();
  dock.setMeasureEnabled(false);
  dock.setInspectEnabled(false);
  dock.setProbeEnabled(false);
  dock.setAnnotateEnabled(false);
  dock.setCloseEnabled(false);
  inspector.clear();
  // Visual Export Studio — no scan loaded, no source to render. The
  // buttons go back to disabled with their "load a scan first" hint so the
  // user can't fire an export against nothing.
  inspector.setImageExportEnabled(false);
  stage.showEmptyState();
  navBar.element.classList.add('olv-hidden');
  navBar.hideTouchHint();
  projectCard.hide();
  // Hides the phone-only Scan Info launcher; the sheet is closed by clear().
  document.body.classList.remove('olv-has-scan');
  activeId = null;
  savedViews = [];
  viewCounter = 0;
  viewer.annotate.clear();
  refreshMeasurePanel();
  refreshAnnotationPanel();
}

/** Remove a cloud from the scene and the Inspector. */
function removeCloud(id: string): void {
  viewer.removeCloud(id);
  inspector.removeCloud(id);
  if (activeId === id) activeId = null;
  if (viewer.clouds().length === 0) resetToEmptyState();
}

/**
 * Close the current scan: remove every loaded cloud and return to the empty
 * state, ready for another scan to be dropped, opened, or sampled.
 */
function closeScan(): void {
  if (viewer.hasStreamingCloud) closeStreaming();
  for (const id of viewer.clouds()) {
    viewer.removeCloud(id);
    inspector.removeCloud(id);
  }
  resetToEmptyState();
}

/**
 * Save the current view as a PNG — entirely client-side. Any placed
 * measurements and annotations are burned into the image, so the snapshot is
 * usable as inspection evidence; a clean scan with neither simply exports the
 * bare render.
 */
async function saveSnapshot(): Promise<void> {
  try {
    const blob = await viewer.snapshot({
      annotations: viewer.annotate.getAnnotations().length > 0,
      measurements: viewer.measure.getMeasurements().length > 0,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'openlidarviewer.png';
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    dropZone.setError('Could not save the view');
  }
}
