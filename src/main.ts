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
import { loadFile, MOBILE_POINT_BUDGET } from './io/loadFile';
import { isZUpFormat } from './io/sniffFormat';
import { exportCloud } from './io/exporters';
import { serializeSession, parseSession } from './render/measure/serialization';
import { ModuleRegistry } from './analysis/ModuleApi';
import type { AnalysisRow } from './analysis/ModuleApi';
import { healthCheck } from './analysis/modules/healthCheck';
import { scanReport } from './analysis/modules/scanReport';
import { availableModes, defaultMode } from './render/colorModes';
import type { PointCloud } from './model/PointCloud';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('OpenLiDARViewer: #app mount point not found');

const embed = new URLSearchParams(window.location.search).has('embed');

const SAMPLES: Sample[] = [
  { label: 'Drone survey', detail: '.las — georeferenced', url: 'samples/tiny.las', name: 'sample-survey.las' },
  { label: 'Phone scan', detail: '.ply — local coordinates', url: 'samples/tiny.ply', name: 'sample-scan.ply' },
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

const registry = new ModuleRegistry();
registry.register(healthCheck);
registry.register(scanReport);

/** Viewer id of the cloud the Inspector currently controls (the most recent). */
let activeId: string | null = null;
/** Saved camera viewpoints for the current scan. */
let savedViews: { name: string; pose: CameraPose }[] = [];
let viewCounter = 0;

const inspector = new Inspector({
  onColorMode: (mode) => {
    if (activeId) viewer.setColorMode(activeId, mode);
  },
  onPointSize: (size) => viewer.setPointSize(size),
  onToggleVisible: (id, visible) => viewer.setCloudVisible(id, visible),
  onRemove: (id) => removeCloud(id),
  onExport: (format) => {
    const cloud = activeId ? viewer.getCloud(activeId) : undefined;
    if (!cloud) return;
    downloadText(`${baseName(cloud.name)}.${format}`, exportCloud(cloud, format));
  },
  onSaveView: () => {
    savedViews.push({ name: `View ${++viewCounter}`, pose: viewer.getCameraPose() });
    inspector.setViews(savedViews.map((v) => v.name));
  },
  onApplyView: (index) => {
    const view = savedViews[index];
    if (view) viewer.applyCameraPose(view.pose);
  },
  onDeleteView: (index) => {
    savedViews.splice(index, 1);
    inspector.setViews(savedViews.map((v) => v.name));
  },
});

const dock = new ToolDock({
  onFrameAll: () => viewer.frameAll(),
  onSnapshot: () => void saveSnapshot(),
  onMeasureToggle: () => viewer.setMeasureMode(!viewer.measureMode),
  onInspectToggle: () => viewer.setInspectMode(!viewer.inspectMode),
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
    navBar.setMeasuring(viewer.measureMode || viewer.inspectMode);
    // The summary card and the tool hint share the top-centre slot.
    if (active) projectCard.hide();
    refreshMeasurePanel();
  },
});
viewer.setInspectListeners({
  onModeChange: (active) => {
    dock.setInspectActive(active);
    navBar.setMeasuring(viewer.measureMode || viewer.inspectMode);
    if (active) projectCard.hide();
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

const dropZone = new DropZone(document.body, (file) => void handleFile(file));
stage.overlay.append(dropZone.toast);

// The nav bar is core interaction — shown in embed mode too. Hidden until a
// scan is loaded. The touch hint rides alongside it (phones only via CSS).
navBar.element.classList.add('olv-hidden');
stage.overlay.append(navBar.element, navBar.prompt, navBar.touchHint);

if (!embed) {
  // The tool overlays go in first so the panels paint above them.
  stage.overlay.append(viewer.measureElements.overlay);
  stage.overlay.append(viewer.measureElements.hint);
  stage.overlay.append(viewer.inspectElements.overlay);
  stage.overlay.append(viewer.inspectElements.hint);
  stage.overlay.append(inspector.element);
  stage.overlay.append(measurePanel.element);
  stage.overlay.append(dock.dock);
  stage.overlay.append(dock.backend);
  stage.overlay.append(projectCard.element);
  // The point-info card sits above the panels so its Copy button is reachable.
  stage.overlay.append(viewer.inspectElements.card);
  // The phone-only "Scan Info" launcher for the Inspector bottom sheet.
  stage.overlay.append(inspector.sheetToggle);
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

/** Refresh the Measurements panel's contents and visibility. */
function refreshMeasurePanel(): void {
  measurePanel.update(viewer.measure.getSummaries());
  const hasMeasurements = viewer.measure.getMeasurements().length > 0;
  measurePanel.setVisible(viewer.measureMode || hasMeasurements);
}

/** Export the measurement session — measurements and saved views — as JSON. */
function exportSession(): void {
  const cloud = activeId ? viewer.getCloud(activeId) : undefined;
  const upAxis: 'y' | 'z' = cloud && isZUpFormat(cloud.sourceFormat) ? 'z' : 'y';
  const json = serializeSession({
    upAxis,
    origin: cloud ? cloud.origin : [0, 0, 0],
    unitSystem: viewer.measure.unitSystem,
    views: savedViews.map((v) => v.pose),
    measurements: viewer.measure.getMeasurements(),
  });
  downloadText('openlidarviewer-session.json', json);
}

/** Import a measurement session: restore its measurements and saved views. */
async function importSession(file: File): Promise<void> {
  try {
    const session = parseSession(await file.text());
    viewer.measure.loadMeasurements(session.measurements);
    savedViews = session.views.map((pose, i) => ({ name: `View ${i + 1}`, pose }));
    viewCounter = savedViews.length;
    inspector.setViews(savedViews.map((v) => v.name));
    refreshMeasurePanel();
  } catch (err) {
    dropZone.setError(err instanceof Error ? err.message : 'Could not import the session');
  }
}

/** Load a dropped or sampled File: parse, render, and populate the Inspector. */
async function handleFile(file: File): Promise<void> {
  dropZone.setProgress(`Reading ${file.name}…`);
  try {
    // Phones get a tighter point budget — limited GPU memory and fill-rate.
    const budget = isPhone() ? MOBILE_POINT_BUDGET : undefined;
    const result = await loadFile(file, (text) => dropZone.setProgress(text), budget);
    await viewer.ready;

    stage.hideEmptyState();
    const id = viewer.addCloud(result.cloud);
    activeId = id;

    // A freshly opened scan starts in the orbit overview, then glides in.
    viewer.setMode('orbit');
    viewer.frameAll();

    const mode = defaultMode(result.cloud);
    viewer.setColorMode(id, mode);

    // A new scan resets the saved viewpoints.
    savedViews = [];
    viewCounter = 0;

    inspector.addCloud(id, result.cloud.name, result.cloud.pointCount);
    inspector.setColorModes(availableModes(result.cloud), mode);
    inspector.setDetail(result.cloud.pointCount, result.originalPointCount);
    inspector.setReport(runModules(result.cloud));
    inspector.setViews([]);
    dock.setBackend(viewer.activeBackend());
    dock.setMeasureEnabled(true);
    dock.setInspectEnabled(true);
    dock.setCloseEnabled(true);

    navBar.element.classList.remove('olv-hidden');
    navBar.setMode('orbit');
    navBar.flashHelp();

    // Reveals the phone-only Scan Info launcher (CSS keyed off this class).
    document.body.classList.add('olv-has-scan');
    // Phones get a touch-gesture hint in place of the keyboard HUD.
    if (isPhone()) navBar.flashTouchHint();

    if (!embed) showProjectCard(result.cloud, result.originalPointCount);

    dropZone.setProgress(null);
  } catch (err) {
    dropZone.setError(err instanceof Error ? err.message : 'Failed to load the file');
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
  refreshMeasurePanel();
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

/** Save the current view as a PNG — entirely client-side. */
async function saveSnapshot(): Promise<void> {
  try {
    const blob = await viewer.snapshot();
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
