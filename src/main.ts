import '@fontsource-variable/inter';
import './style.css';
import { Viewer } from './render/Viewer';
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
import { startEmbedBridge } from './ui/embedBridge';
import { encodeShareState, decodeShareState } from './io/shareState';
import type { ShareState } from './io/shareState';
import { formatProgress } from './io/loadProgress';
import { formatTelemetry } from './io/loadTelemetry';
import { buildBenchmarkResult, formatBenchmarkResult } from './io/benchmark';
import { DebugOverlay } from './ui/DebugOverlay';
import { isZUpFormat } from './io/sniffFormat';
import { exportCloud } from './io/exporters';
import { serializeSession, parseSession } from './io/session';
import { loadPrefs, savePrefs } from './prefs';
import { ModuleRegistry } from './analysis/ModuleApi';
import type { AnalysisRow } from './analysis/ModuleApi';
import { healthCheck } from './analysis/modules/healthCheck';
import { scanReport } from './analysis/modules/scanReport';
import { availableModes, defaultMode } from './render/colorModes';
import type { ColorMode } from './render/colorModes';
import type { PointCloud } from './model/PointCloud';

// A pointer to the open-source repository for anyone who opens the console on
// the live site. The deployed bundle is obfuscated; the readable source — and
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
});
const viewer = new Viewer(stage.canvas);

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
    downloadText(`${baseName(cloud.name)}.${format}`, exportCloud(cloud, format));
  },
  onSaveView: () => saveCurrentView(),
  onApplyView: (index) => {
    const view = savedViews[index];
    if (view) viewer.applyCameraPose(view.pose);
  },
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

const projectCard = new ProjectCard();

// The Measurements panel lists placed measurements; the controller drives it.
const measurePanel = new MeasurePanel({
  onDelete: (id) => viewer.measure.removeMeasurement(id),
  onRename: (id, name) => viewer.measure.renameMeasurement(id, name),
  onExport: () => exportSession(),
  onImport: (file) => void importSession(file),
});
viewer.measure.setOnChange(refreshMeasurePanel);
// Persist the unit choice whenever it changes.
viewer.measure.setOnUnitChange(persistPrefs);

// The Annotations panel lists placed annotations; the controller drives it.
const annotationPanel = new AnnotationPanel({
  onActivate: (id) => viewer.jumpToAnnotation(id),
  onEdit: (id, x, y) => viewer.annotate.beginEdit(id, x, y),
  onDelete: (id) => viewer.annotate.remove(id),
  onClearAll: () => viewer.annotate.clear(),
  onHover: (id) => viewer.annotate.hover(id),
});
viewer.annotate.setOnChange(refreshAnnotationPanel);

// Apply any preferences saved in a previous session, once the GPU backend has
// initialised (so a saved EDL choice overrides the backend's default gate).
void viewer.ready.then(() => {
  viewerReady = true;
  // Degraded defaults for a weak device come first; a saved user preference,
  // applied immediately after, still wins.
  applyDeviceDefaults();
  applyPrefs();
});

const dropZone = new DropZone(document.body, (file) => void handleFile(file));
stage.overlay.append(dropZone.toast);

// The nav bar is core interaction — shown in embed mode too. Hidden until a
// scan is loaded. The touch hint rides alongside it (phones only via CSS).
navBar.element.classList.add('olv-hidden');
stage.overlay.append(navBar.element, navBar.prompt, navBar.touchHint);

if (!bareMode) {
  // The tool overlays go in first so the panels paint above them.
  stage.overlay.append(viewer.measureElements.overlay);
  stage.overlay.append(viewer.measureElements.hint);
  stage.overlay.append(viewer.inspectElements.overlay);
  stage.overlay.append(viewer.inspectElements.hint);
  stage.overlay.append(viewer.annotateElements.overlay);
  stage.overlay.append(viewer.annotateElements.hint);
  stage.overlay.append(inspector.element);
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

// The cross-frame control bridge — active only in embed mode.
if (embed) {
  startEmbedBridge({
    onLoadFile: (buffer, fileName) => void handleFile(new File([buffer], fileName)),
    onJumpCamera: (camera) => viewer.applyCameraState(camera),
    onToggleLayer: (id, visible) => viewer.setCloudVisible(id, visible),
    onFocusAnnotation: (id) => viewer.jumpToAnnotation(id),
  });
}

// `?autoload=sample:<id>` — open a built-in sample on startup (embed demos).
if (embedConfig.autoloadSample) {
  const sample = SAMPLES.find((s) => s.id === embedConfig.autoloadSample);
  if (sample) void loadFromUrl(sample.url, sample.name);
}

// The developer performance overlay — surfaced only by `?debug=1` or
// `?benchmark=1`. It polls the viewer for live frame stats on a throttled
// cadence; the load path feeds it telemetry and any benchmark result.
if (debug || benchmark) {
  debugOverlay = new DebugOverlay(() => ({
    backend: viewerReady ? viewer.activeBackend() : null,
    stats: viewerReady ? viewer.frameStats() : null,
  }));
  stage.overlay.append(debugOverlay.element);
  debugOverlay.start();
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

/** Trigger a client-side download of text content. */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
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
  return viewer.clouds().length > 0;
}

/** Capture the current camera viewpoint as a named saved view. */
function saveCurrentView(): void {
  savedViews.push({ name: `View ${++viewCounter}`, pose: viewer.getCameraPose() });
  inspector.setViews(savedViews.map((v) => v.name));
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
  const json = serializeSession({
    upAxis,
    origin: cloud ? cloud.origin : [0, 0, 0],
    unitSystem: viewer.measure.unitSystem,
    views: savedViews.map((v) => ({ name: v.name, camera: v.pose })),
    measurements: viewer.measure.getMeasurements(),
    annotations: viewer.annotate.getAnnotations(),
  });
  downloadText('openlidarviewer-session.json', json);
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
  loading = true;
  const controller = new AbortController();
  dropZone.setProgress(`Reading ${file.name}…`);
  dropZone.setCancelHandler(() => controller.abort());
  try {
    // Phones get a tighter point budget — limited GPU memory and fill-rate.
    // The dropped file is wrapped in a LocalFileSource — the v0.2.9 source
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
    }
  } finally {
    loading = false;
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
