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
import { loadFile } from './io/loadFile';
import { exportCloud } from './io/exporters';
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

const stage = new Stage(app, { embed, samples: SAMPLES, onSample: loadFromUrl });
const viewer = new Viewer(stage.canvas);

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

const projectCard = new ProjectCard();

const dropZone = new DropZone(document.body, (file) => void handleFile(file));
stage.overlay.append(dropZone.toast);

// The nav bar is core interaction — shown in embed mode too. Hidden until a
// scan is loaded.
navBar.element.classList.add('olv-hidden');
stage.overlay.append(navBar.element, navBar.prompt);

if (!embed) {
  stage.overlay.append(inspector.element);
  stage.overlay.append(dock.dock);
  stage.overlay.append(dock.backend);
  stage.overlay.append(projectCard.element);
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

/** Load a dropped or sampled File: parse, render, and populate the Inspector. */
async function handleFile(file: File): Promise<void> {
  dropZone.setProgress(`Reading ${file.name}…`);
  try {
    const result = await loadFile(file, (text) => dropZone.setProgress(text));
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

    navBar.element.classList.remove('olv-hidden');
    navBar.setMode('orbit');
    navBar.flashHelp();

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

/** Remove a cloud from the scene and the Inspector. */
function removeCloud(id: string): void {
  viewer.removeCloud(id);
  inspector.removeCloud(id);
  if (activeId === id) activeId = null;
  if (viewer.clouds().length === 0) {
    inspector.clear();
    stage.showEmptyState();
    navBar.element.classList.add('olv-hidden');
    projectCard.hide();
    savedViews = [];
  }
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
