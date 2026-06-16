// Self-hosted type pairing — Manrope (grotesk labels) + JetBrains Mono (tabular
// figures). Latin subsets only, served same-origin so nothing leaves the device.
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './style.css';
import type { Viewer } from './render/Viewer';
import type { CameraPose } from './render/NavController';
import { Stage } from './ui/Stage';
import type { Sample } from './ui/Stage';
import { DropZone } from './ui/DropZone';
import { Inspector } from './ui/Inspector';
import { ThemeToggle } from './ui/ThemeToggle';
import { ToolDock } from './ui/toolDock';
import { NavBar } from './ui/NavBar';
import { ProjectCard } from './ui/ProjectCard';
import { el } from './ui/dom';
import {
  applyTheme,
  readPersistedTheme,
  writePersistedTheme,
  THEME_LABEL,
  THEME_ORDER,
  type ThemeName,
} from './ui/themes';
import { CommandPalette } from './ui/CommandPalette';
import { ShortcutSheet } from './ui/ShortcutSheet';
import { TourOverlay } from './ui/onboarding/TourOverlay';
import { TourSession } from './ui/onboarding/tourSteps';
import { findDuplicateIds, type Action } from './ui/actionRegistry';
import { WorkflowController, WORKFLOW_RECORDER_ENABLED } from './ui/WorkflowController';
import { WorkflowConfigPanel } from './ui/WorkflowConfigPanel';
import { RecommendedViewChip } from './ui/RecommendedViewChip';
import { recommendCameraPreset, flatnessFromBounds } from './render/camera/recommendView';
import type { WorkflowEvent } from './render/workflow/workflowRecorder';
import { matchesShortcut } from './render/workflow/workflowConfig';
import {
  CAMERA_PRESET_KEY,
  CAMERA_PRESET_LABEL,
  CAMERA_PRESET_ORDER,
} from './render/camera/cameraPresets';
import { LassoVolumeTool } from './ui/LassoVolumeTool';
import { MeasurePanel } from './ui/MeasurePanel';
import { aggregate as aggregateMeasurements } from './render/measure/measurementChains';
import { ICON_LASSO } from './render/measure/measureIcons';
// Workflow presets (v0.4.5) — pure table + matcher; applied through the
// Viewer's existing setters in the Inspector callback below.
import {
  getTerrainWorkflowPreset,
  matchTerrainWorkflowPreset,
} from './render/terrainWorkflowPresets';
import { AnnotationPanel } from './ui/AnnotationPanel';
import { AnalysePanel } from './ui/AnalysePanel';
import { ClassLegendPanel } from './ui/ClassLegendPanel';
import { countClasses } from './render/class/classHistogram';
import { deriveClassificationAsync } from './render/class/deriveClassificationAsync';
import { fullScope, scopeFrom, scopeStamp, notScopedSentinel, type ClassScope } from './render/class/classScope';
import { classificationLabel } from './render/pointInfo';
import { ObjectPanel } from './ui/ObjectPanel';
import { MobileSheet } from './ui/MobileSheet';
import { classifyScanShape } from './terrain/scanShape';
import type { SpaceKind } from './terrain/scanShape';
import {
  planScanRoute,
  settleOneShotSpent,
  settleTargetDepth,
  type ScanTypeOverride,
} from './terrain/scanRoute';
import { objectMetrics, type ObjectMetrics } from './terrain/objectMetrics';
import { spaceMetrics, type SpaceMetrics } from './terrain/spaceMetrics';
import { TERRAIN_METRIC_VERSION } from './terrain/datasetIntelligence';
import { ExportPanel } from './ui/ExportPanel';
import { composeClassScopeBannerOntoBlob } from './export/ScanReportRenderer';
import { decodeFull } from './convert/decodeFull';
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
import {
  availableModes,
  defaultMode,
  colorblindSafeClasses,
} from './render/colorModes';
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
  loadBatchConverter,
  loadSpaceReportPdf,
  loadFloorPlan,
  loadPngWorldFile,
  loadPlanetaryComputerCatalog,
  loadRgbAutoNormalize,
  loadEmbedBridge,
  loadLasLoader,
} from './lazyChunks';
// Local-first usage counter. Categorical event counts only; stays in
// localStorage; never transmitted. The `?notelemetry=1` URL flag suppresses
// every `increment()` call structurally.
import {
  increment as recordUsage,
  isSuppressed as usageIsSuppressed,
} from './diagnostics/usageCounters';
import {
  classify as classifyProvenance,
  fingerprintFor as provenanceFor,
  type CaptureType,
} from './diagnostics/provenance';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from './diagnostics/provenanceSignals';
// CatalogPanel renders the empty-state "verified public LiDAR" picker.
// The picker carries a curated dropdown of direct EPT URLs (each probed
// at build time) and routes the selected URL into the existing streaming
// pipeline via handleRemoteUrl(). No catalog query, no geocoder, no
// bbox-vs-COPC mismatch — the previous TNM Products API path was
// removed in v0.3.6 because TNM doesn't surface COPC URLs anywhere.
import { CatalogPanel } from './ui/CatalogPanel';
// CRS detection + override — feeds the Inspector's Coordinate System
// section. Static clouds carry `metadata.crs` (CrsInfo from src/io/crs);
// streaming clouds expose `.crs()` returning the same shape.
import type { CrsInfo } from './io/crs';
import { CrsService } from './geo/CrsService';
import { createInspectorCardRefreshers } from './app/inspectorCardRefreshers';
import { createCrsCoordinator } from './app/crsCoordinator';
import { createTerrainAnalysisRunner } from './app/terrainAnalysisRunner';

/**
 * The centralised CRS service. Owns the active scan's resolved CRS
 * plus pub/sub for consumers. Direct subscribers today: the lasso
 * volume gate (`crsService.validation()`) and the inspector
 * (`crsService.subscribe(...)`, wired right after the Inspector is
 * constructed). The InspectTool's coordinate context still goes
 * through a separate push because it needs the cloud `origin`
 * alongside the CRS — that pair has no other natural home.
 */
const crsService = new CrsService();
import {
  keyForDataset as crsKeyForDataset,
  setOverride as setCrsOverrideForDataset,
} from './geo/CrsOverrideStore';

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

// v0.3.9 theme system — apply the user's persisted choice as early as
// possible so first paint matches their preference. Done BEFORE any
// component mounts so the empty-state hero, dropzone, and toolDock
// all render under the right palette.
let currentTheme: ThemeName = readPersistedTheme();
applyTheme(document.body, currentTheme);

// v0.4.3 — the theme control is now a single shape-morphing button in the
// top-right header (ThemeToggle.ts). It's constructed after the Stage so it
// can mount into the top bar; `setTheme` keeps it in sync when the theme is
// changed from anywhere else (command palette, workflow replay).
let themeToggle: ThemeToggle | null = null;

function setTheme(name: ThemeName): void {
  if (name === currentTheme) {
    // Even on a no-op palette change, keep the header button's icon in
    // sync — the call may come from an external surface that set its own
    // state independently.
    themeToggle?.setTheme(name);
    return;
  }
  currentTheme = name;
  applyTheme(document.body, name);
  writePersistedTheme(name);
  themeToggle?.setTheme(name);
}

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
/**
 * `?test=1` opens `window.__OLV_TEST_API__` — a programmatic seam for
 * Playwright. v0.3.10 trust-pass — the canvas → raycast → measurement
 * commit path is flaky in headless CI (WebGL 2 fallback, no real
 * picking precision), which is why `measure.spec.ts` has had a
 * `test.fixme` annotation for several releases. The seam exposes a
 * minimal API that bypasses the raycast and pushes a world-space
 * point directly into `MeasureController.addPoint`. Gated on a URL
 * flag so production traffic never sees the API surface; the e2e
 * runner sets the flag in its baseURL.
 */
const testApi = urlParams.has('test');

// The Quick demos surface only the public streaming demo — a real
// ~1.8 GB COPC from Entwine's public data bucket (range-served +
// CORS-open). The viewer only fetches the resident set the camera needs,
// typically tens of MB before first frame, so this is the lowest-friction
// way for a new visitor to see streaming in action without uploading or
// hosting anything.
//
// The previous "Tiny demo LAS" and "Tiny demo PLY" entries were removed —
// at ~18 and ~10 points respectively they opened as nearly-empty
// black-canvas projects that first-time users mistook for a broken viewer
// rather than a deliberate "single-pixel fixture" surface. They survive
// in `samples/tiny.{las,ply}` for automated tests but are no longer
// surfaced as user-facing entry points.
const SAMPLES: Sample[] = [
  {
    id: 'stream',
    label: 'Public streaming demo',
    detail: '1.8 GB COPC · streamed',
    url: 'https://s3.amazonaws.com/data.entwine.io/millsite.copc.laz',
    name: 'millsite.copc.laz',
    // Approximate on-disk size — feeds Stage's cellular-data + mobile-
    // memory confirmation gates. The streaming pipeline only fetches
    // visible tiles in practice, but the gate uses the worst-case full-
    // file size because the user can't know how many tiles they'll
    // ultimately request.
    sizeBytes: 1_800_000_000,
  },
];

/**
 * Public-LiDAR picker for the empty-state. The picker is a curated
 * dropdown of direct EPT URLs — every entry is probed at build time and
 * the URL handed back to handleRemoteUrl() on click. The previous
 * bbox-query path against USGS TNM Products was removed because TNM
 * does not surface COPC URLs in its public inventory.
 */
const catalogPanel = new CatalogPanel({
  suppressed: usageIsSuppressed(),
  onPickUrl: (url: string) => {
    // The picker maps to a single categorical event suffix in the
    // local-first usage counter. The URL itself never leaves the device.
    recordUsage('scan-open', 'curated:usgs-ept');
    handleRemoteUrl(url).catch((err) => {
      dropZone.setError(
        err instanceof Error ? err.message : 'Failed to open the dataset.',
      );
    });
  },
  // Pre-warm the streaming chunks when the user changes the dropdown
  // selection. By the time they click Open the EPT / COPC chunks are
  // usually already cached — cuts ~200–800 ms off perceived first-paint
  // because the chunk download hides behind think-time.
  onPickIntent: (url: string) => prewarmForUrl(url),
  // v0.3.6 PC STAC integration. When the user picks a result from the
  // Planetary Computer "Search by location" panel, store the item's
  // EPSG in the CRS override store before dispatching the URL. This
  // short-circuits the LAS VLR probe — the streaming pipeline asks the
  // override store first and never spends ~500-700 ms decoding the
  // header for CRS metadata it already has.
  onPickPcItem: (item) => {
    recordUsage('scan-open', 'pc-stac');
    if (item.epsg) {
      try {
        // The dataset key is derived from the URL/name the streaming
        // pipeline will use. We mirror the same `keyForDataset` so the
        // override resolves on the first lookup.
        const datasetKey = crsKeyForDataset(item.id);
        setCrsOverrideForDataset(datasetKey, {
          epsg: item.epsg,
          kind: 'projected',
        });
      } catch (err) {
        if (debug) console.warn('[crs] PC EPSG short-circuit failed', err);
      }
    }
    // SAS-sign the raw blob URL before handing it to the streaming pipeline.
    // Without this step the Azure Blob host returns HTTP 409 on the first
    // range request — Planetary Computer assets require a short-lived
    // SAS token appended to the URL. The signing API is public, CORS-
    // enabled, and the resulting URL is valid for ~1 hour.
    void (async () => {
      try {
        const mod = await loadPlanetaryComputerCatalog();
        const signed = await mod.signAssetUrl(item.assetUrl);
        await handleRemoteUrl(signed);
      } catch (err) {
        const raw = err instanceof Error ? err.message : 'Failed to open the PC tile.';
        // Distinguish signing failure from streaming failure so the user
        // sees the right message ("PC unavailable" vs "this file is bad").
        const message = raw.includes('SAS')
          ? `Couldn't authorise the Planetary Computer asset (${raw}). The host may be temporarily unavailable.`
          : raw;
        dropZone.setError(message);
      }
    })();
  },
});

const stage = new Stage(app, {
  embed,
  samples: SAMPLES,
  onSample: loadFromUrl,
  onOpenFile: (file) => void handleFile(file),
  // Return the promise so Stage's inline error handler can show a
  // contextual, plain-English message under the URL input + offer a Retry
  // banner. The dropZone error toast still fires as a backup channel
  // because it remains visible after the empty state hides.
  // The Stage's Cancel-button signal is threaded through so its abort
  // actually reaches the in-flight fetches (Fix: it used to be dropped).
  onOpenUrl: (url, signal) => handleRemoteUrl(url, signal).catch((err) => {
    const message = err instanceof Error ? err.message : 'Failed to open the URL.';
    dropZone.setError(message);
    // Re-throw so Stage's inline branch sees the error too.
    throw err instanceof Error ? err : new Error(message);
  }),
  catalogPanel: catalogPanel.root,
  onBatchConvert: () => void openBatchConverter(),
});

// v0.4.3 — the header theme toggle. A single shape-morphing button that
// cycles Dark → Light → High-contrast → Dark, mounted into the top bar's
// right cluster (just left of the GitHub link). Its onChange routes through
// the same `setTheme` the old Inspector chip rail used, so `applyTheme` +
// persistence are unchanged. Skipped in embed mode, where the top bar — and
// therefore the mount slot — doesn't exist.
themeToggle = new ThemeToggle({
  initial: currentTheme,
  onChange: (name) => setTheme(name),
});
stage.mountThemeToggle(themeToggle.element);

/**
 * Lazily build (once) and open the batch format converter. Its chunk carries
 * the conversion engine + proj4, so it only downloads when the user asks for
 * it — never on initial load.
 */
let batchConverter: { open: () => void } | null = null;
async function openBatchConverter(): Promise<void> {
  if (!batchConverter) {
    const { BatchConverter } = await loadBatchConverter();
    batchConverter = new BatchConverter(document.body);
  }
  batchConverter.open();
}
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

// ── Lasso volume tool — 3D volumetric pick via freehand draw ────────────
//
// Press `L` to arm the tool. Draw a freehand shape over the canvas;
// every 3D point inside the projected shape is selected (volumetric —
// all depths along the camera ray are captured). On pointer-up, the
// pipeline computes cut / fill / footprint and surfaces it in a quick
// toast. Press `L` again or `Escape` to disarm.
/**
 * The most recent lasso volume result, retained so the toast's "Save"
 * button can promote it into the Measurements list. Cleared when the
 * user dismisses the highlight (Esc / Clear) or starts a fresh lasso.
 */
let pendingLassoSave: {
  polygon: ReadonlyArray<[number, number, number]>;
  volume: import('./render/measure/types').VolumeRecord;
  selectedCount: number;
} | null = null;

const lassoVolumeTool = new LassoVolumeTool(stage.canvas, {
  onCommit: (lasso) => {
    if (!viewer) return;
    const out = viewer.computeLassoVolume(lasso, 0.05);
    if (out === null) {
      pendingLassoSave = null;
      showLassoToast('Lasso volume — no points selected. Draw around a denser region.');
      return;
    }
    // Highlight the selected points so the user has visible proof of
    // life. Auto-disarm the tool — single-shot pattern returns the
    // user to navigation/orbit immediately, which is what non-
    // technical users expect after seeing a result. They can re-arm
    // by clicking the Lasso button or pressing L again.
    viewer.setSelectionHighlight(out.selectionByCloudId);
    lassoVolumeTool.disable();
    viewer.setLassoMode(false);
    syncLassoButton();
    const fillM3 = out.result.fill.toFixed(2);
    const cutM3 = out.result.cut.toFixed(2);
    const netM3 = out.result.net.toFixed(2);
    const areaM2 = out.result.footprintArea.toFixed(1);
    // Stage the result for the toast's Save button. The polygon3D
    // is the convex-hull footprint at the integration reference
    // plane — saving promotes it to a regular Volume measurement.
    pendingLassoSave =
      out.polygon3D.length >= 3
        ? {
            polygon: out.polygon3D,
            volume: deriveVolumeRecord(out.result, out.referenceZ),
            selectedCount: out.selectedCount,
          }
        : null;
    const budgetCaption = out.budget.downsample
      ? ` · sampled ${(out.budget.coverageFraction * 100).toFixed(0)}%`
      : '';
    // CRS gate — when the scan is geographic or unknown, displaying a
    // cubic-metre headline would be misleading. Replace the metrics
    // line with the caveat, and refuse to surface a Save button (the
    // user has to project / confirm a CRS first). When the CRS is
    // safe-explicit-local, the metrics are still meaningful in source
    // units; surface a softer "units assumed metres" line below them.
    const crsVerdict = crsService.validation();
    if (!crsVerdict.canDisplayMetric) {
      showLassoToast(
        `Volume can't be claimed in this CRS — ${crsVerdict.reason} ${crsVerdict.suggestion}`,
      );
      pendingLassoSave = null;
      return;
    }
    const crsCaveat =
      crsVerdict.validity === 'safe-explicit-local'
        ? ' · units assumed metres'
        : '';
    showLassoToast(
      `Volume · fill ${fillM3} m³ · cut ${cutM3} m³ · net ${netM3} m³ · ` +
        `footprint ${areaM2} m² · ${out.selectedCount.toLocaleString()} points${budgetCaption}${crsCaveat}.`,
      pendingLassoSave && crsVerdict.canSaveMeasurement
        ? { label: 'Save to session', onClick: saveLassoVolumeIfPending }
        : undefined,
    );
  },
  onCancel: () => {
    viewer?.clearSelectionHighlight();
    lassoVolumeTool.disable();
    viewer?.setLassoMode(false);
    syncLassoButton();
    pendingLassoSave = null;
    showLassoToast('Lasso cancelled — back to navigation.');
  },
});

/**
 * Promote the most recent lasso volume into the Measurements list as
 * a regular Volume measurement. No-op when nothing is pending.
 *
 * The id of the created measurement is captured so the toast can
 * confirm the save and the workflow recorder (if armed) can log it
 * with the measurement id.
 */
function saveLassoVolumeIfPending(): void {
  if (!viewer || !pendingLassoSave) return;
  // Re-check CRS at save time. If the user opened the CRS override
  // panel between the lasso commit and clicking Save and switched to
  // geographic / unknown, the original toast's gate would no longer
  // hold — block the save and tell them why.
  const crsVerdict = crsService.validation();
  if (!crsVerdict.canSaveMeasurement) {
    pendingLassoSave = null;
    showLassoToast(
      `Can't save volume — ${crsVerdict.reason} ${crsVerdict.suggestion}`,
    );
    return;
  }
  const payload = pendingLassoSave;
  const id = viewer.measure.addLassoVolumeMeasurement({
    polygon: payload.polygon.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
    volume: payload.volume,
  });
  pendingLassoSave = null;
  if (id) {
    showLassoToast('Saved to Measurements list.');
  } else {
    showLassoToast('Lasso volume could not be saved — try drawing the shape again.');
  }
}

/**
 * Translate a `VolumeResult` (from the lasso math) into the persisted
 * `VolumeRecord` shape used by Volume measurements. The two carry
 * almost identical fields; the record drops the sample-walk telemetry
 * and adds the confidence band derived from `pointsInPolygon`.
 */
function deriveVolumeRecord(
  result: import('./render/measure/volume').VolumeResult,
  referenceZ: number,
): import('./render/measure/types').VolumeRecord {
  const inPoly = result.pointsInPolygon;
  const confidence: 'high' | 'medium' | 'low' =
    inPoly >= 1000 ? 'high' : inPoly >= 100 ? 'medium' : 'low';
  return {
    fill: result.fill,
    cut: result.cut,
    net: result.net,
    referenceZ,
    footprintArea: result.footprintArea,
    pointsInPolygon: result.pointsInPolygon,
    density: result.density,
    confidence,
  };
}

// ── Lasso volume button in the measure dock ──────────────────────────────
// Placed at the end of the measure-kind row, paired with Volume. The
// button is a second input method for Volume — not a separate
// measurement kind. The tooltip explicitly tells users how to exit
// (Esc) and the auto-disarm-on-commit returns them to navigation
// immediately so re-orbiting after a measurement requires zero extra
// clicks. Persistence into the Measurements list + PDF reports is the
// next focused cut.
let lassoButton: HTMLButtonElement | null = null;
function syncLassoButton(): void {
  if (!lassoButton) return;
  lassoButton.classList.toggle('olv-mkind-active', lassoVolumeTool.enabled);
}
viewerLoaded.then((v) => {
  lassoButton = v.measure.addAuxKindButton(
    'Lasso volume',
    'Lasso Volume — draw a freeform shape on the canvas to measure volume of every 3D point inside.\n' +
      '• Click again or press Esc to exit and return to navigation.\n' +
      '• Click "Save to session" on the result toast to keep it.',
    () => {
      if (lassoVolumeTool.enabled) {
        lassoVolumeTool.disable();
        v.setLassoMode(false);
        v.clearSelectionHighlight();
        showLassoToast('Lasso off — back to navigation.');
      } else {
        lassoVolumeTool.enable();
        v.setLassoMode(true);
        showLassoToast(
          'Lasso armed — draw a shape on the canvas. Press Esc to cancel and return to navigation.',
        );
      }
      syncLassoButton();
    },
    // Gestalt proximity: Lasso renders directly AFTER the Volume
    // button in the kind row, so the eye reads it as a sibling
    // input method for the Volume kind rather than a 10th
    // measurement kind.
    'volume',
    ICON_LASSO,
    'Lasso · freeform volume',
  );
});

// ── Universal Esc → return to free navigation ─────────────────────────────
// Catches any tool the user has left armed and returns the canvas to
// pure orbit/pan/zoom. Picks up after the Stage / NavController have
// had their chance — those are scoped to specific element handlers,
// this fallback ensures Esc always reads as "exit the active tool"
// regardless of where focus is.
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  // Never hijack key events from form inputs.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

  // Polygon-completion keyboard shortcuts — Enter commits the
  // in-progress polygon (area/volume/polyline/profile), Backspace
  // pops the most recent vertex. Both only fire while measure mode
  // is armed, so they don't conflict with anything else.
  if (viewer?.measureMode) {
    if (e.key === 'Enter') {
      viewer.measure.finishCurrent();
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace') {
      viewer.measure.undoLastPoint();
      e.preventDefault();
      return;
    }
  }

  if (e.key !== 'Escape') return;
  let handled = false;
  if (lassoVolumeTool.enabled) {
    lassoVolumeTool.disable();
    viewer?.setLassoMode(false);
    viewer?.clearSelectionHighlight();
    syncLassoButton();
    handled = true;
  }
  if (viewer?.measureMode) {
    viewer.setMeasureMode(false);
    handled = true;
  }
  if (handled) {
    showLassoToast('Back to navigation.');
  }
});

window.addEventListener('keydown', (e) => {
  // Another bare-key handler (e.g. `bindShortcuts`) already consumed this
  // keystroke — never double-fire on the same key press.
  if (e.defaultPrevented) return;
  if (e.key === 'l' || e.key === 'L') {
    // Don't hijack key events from form inputs.
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    if (lassoVolumeTool.enabled) {
      lassoVolumeTool.disable();
      viewer?.setLassoMode(false);
      showLassoToast('Lasso volume off.');
    } else {
      lassoVolumeTool.enable();
      viewer?.setLassoMode(true);
      showLassoToast('Lasso volume armed — draw a shape on the canvas.');
    }
  }

  // v0.3.9 Smart camera presets: T / O / P each fire a tuned
  // pose via Viewer.setCameraPreset(). Modifier-key combos are
  // skipped so we don't fight Cmd-T (new tab) etc.
  //
  // 'I' is deliberately NOT bound here. Bare 'I' belongs to the
  // Inspect tool (`bindShortcuts` → onInspect — what the HelpOverlay and
  // tool dock advertise); binding Iso to the same key made both fire on
  // one keystroke in v0.4.3. The Iso preset stays reachable via the
  // NavBar view chips and the command palette.
  if (
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === 't' || e.key === 'T' ||
      e.key === 'o' || e.key === 'O' ||
      e.key === 'p' || e.key === 'P')
  ) {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    const k = e.key.toLowerCase();
    const preset = k === 't' ? 'top' : k === 'o' ? 'oblique' : 'planar';
    const fired = viewer?.setCameraPreset(preset);
    // Mark the keystroke consumed so any later bare-key handler
    // (`bindShortcuts`) sees `defaultPrevented` and stays quiet.
    e.preventDefault();
    if (fired) {
      showLassoToast(
        `Camera · ${preset[0].toUpperCase() + preset.slice(1)} view.`,
      );
    }
  }
});

let _lassoToastEl: HTMLElement | null = null;
let _lassoToastTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Render the lasso toast. When `action` is provided, the toast shows
 * a button that fires the callback (and hides the toast). The toast
 * auto-dismisses after 8 s for an action toast, 6 s for an info
 * toast — actions need a little longer to read and click.
 */
function showLassoToast(
  message: string,
  action?: { readonly label: string; readonly onClick: () => void },
): void {
  if (_lassoToastTimer !== null) clearTimeout(_lassoToastTimer);
  if (_lassoToastEl === null) {
    _lassoToastEl = document.createElement('div');
    _lassoToastEl.className = 'olv-lasso-toast';
    // Announce toast text to assistive tech — these toasts are the only
    // feedback channel for several flows (tool hints, rejected opens).
    _lassoToastEl.setAttribute('role', 'status');
    _lassoToastEl.setAttribute('aria-live', 'polite');
    document.body.append(_lassoToastEl);
  }
  // Rebuild contents from scratch each call so an info toast cleanly
  // replaces a previous action toast (no stale Save button stuck
  // around).
  _lassoToastEl.replaceChildren();
  const messageEl = document.createElement('span');
  messageEl.className = 'olv-lasso-toast-msg';
  messageEl.textContent = message;
  _lassoToastEl.append(messageEl);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'olv-lasso-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      btn.blur();
      action.onClick();
    });
    _lassoToastEl.append(btn);
  }
  _lassoToastEl.classList.add('olv-visible');
  _lassoToastTimer = setTimeout(
    () => {
      _lassoToastEl?.classList.remove('olv-visible');
    },
    action ? 8000 : 6000,
  );
}

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
    // Workflow rail (v0.4.5): a colour-mode change can enter/leave a preset.
    syncInspectorVisuals();
  },
  onHeightPercentileTrim: (trim) => {
    viewer.setHeightPercentileTrim(trim);
    syncInspectorVisuals();
  },
  onPointSize: (size) => {
    viewer.setPointSize(size);
    syncInspectorVisuals();
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
      // Thread the active class-scope stamp so a filtered export carries the
      // "showing N of M classes" banner; empty when nothing is hidden.
      .exportImage(mode, {}, currentClassScopeStamp())
      .then(async (result) => {
        // Georeferenced ortho path (v0.4.5, workplan C4): when the exporter
        // returned world-file data (true top-down ortho frame + known world
        // origin + CRS WKT), the download is one ZIP — PNG + `.pgw` + `.prj`
        // — that QGIS/ArcGIS place directly. Every other export keeps the
        // existing bare-PNG download and filename. Packaging failures fall
        // back to the bare PNG rather than sinking an export that already
        // rendered fine.
        if (result.worldFile) {
          try {
            const { buildStudioPngPackage } = await loadPngWorldFile();
            const wf = result.worldFile;
            const pkg = buildStudioPngPackage({
              basename: `${base}-${mode}`,
              png: new Uint8Array(await result.blob.arrayBuffer()),
              extent: wf.extent,
              widthPx: wf.widthPx,
              heightPx: wf.heightPx,
              worldOrigin: wf.worldOrigin,
              wkt: wf.wkt,
            });
            if (pkg) {
              downloadBlob(
                pkg.filename,
                new Blob([pkg.zip as BlobPart], { type: 'application/zip' }),
              );
              recordUsage('export', mode);
              dropZone.setProgress(null);
              return;
            }
          } catch (err) {
            console.warn('[image-export] world-file packaging failed — shipping bare PNG:', err);
          }
        }
        downloadBlob(`${base}-${mode}.png`, result.blob);
        recordUsage('export', mode);
        dropZone.setProgress(null);
      })
      .catch((err: unknown) => {
        recordUsage('error', 'export');
        dropZone.setProgress(null);
        // The orchestrator's explicit reason ("Classification export is
        // unavailable — this cloud has no classification channel.") is the
        // most actionable thing we can show, so it goes both to the console
        // (for debugging) and to a non-blocking alert (so the user knows
        // something happened and why). Replaces the alert with a
        // Surface the failure through the shared toast UI rather than a
        // modal alert — blocking the page on a generation failure is a UX
        // regression we no longer accept.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[image-export]', err);
        dropZone.setError(`Image export failed: ${msg}`);
      });
  },
  onExportReport: (templateId) => {
    // Generate a PDF report from the live scan state + annotations +
    // measurements. The whole `src/report/` module + pdf-lib (~150 KB)
    // lives behind `loadReportEngine()`; first click downloads both. The
    // report covers what the scan-report card already does on PNG
    // exports, but as a multi-page PDF with the full Inspector context.
    // The progress toast surfaces while the lazy module loads and the PDF
    // renders; failures route through the same toast UI as every other
    // export.
    dropZone.setProgress('Generating report…');
    generateReportPdf(templateId)
      .then(() => {
        recordUsage('report', templateId);
        dropZone.setProgress(null);
      })
      .catch((err: unknown) => {
        recordUsage('error', 'report');
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[report]', err);
        dropZone.setError(`Report generation failed: ${msg}`);
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
    syncInspectorVisuals();
    persistPrefs();
  },
  onAntialiasing: (on) => {
    viewer.setAntialiasing(on);
    persistPrefs();
  },
  onTwoFingerTwist: (on) => {
    viewer.setTwoFingerTwistEnabled(on);
    syncInspectorRendering();
    persistPrefs();
  },
  // Visuals Studio — Visuals Studio.
  onRgbAppearancePreset: (id) => {
    if (isRgbAppearancePresetId(id)) {
      viewer.applyRgbAppearancePreset(id);
      // Auto-switch may have flipped the active cloud into RGB mode;
      // re-sync the colour-mode chip so it reflects reality.
      syncColorModeForActive();
      syncInspectorVisuals();
      persistPrefs();
    }
  },
  onEdlPreset: (id) => {
    viewer.setEdlPreset(id);
    syncInspectorVisuals();
    syncInspectorRendering();
    persistPrefs();
  },
  onSkyPreset: (id) => {
    if (isSkyPresetId(id)) {
      viewer.setSky(id);
      syncInspectorVisuals();
      persistPrefs();
    }
  },
  onWhiteBalance: (temperature, tint) => {
    const current = viewer.rgbAppearance;
    viewer.setRgbAppearance({ ...current, temperature, tint });
    syncColorModeForActive();
    syncInspectorVisuals();
    persistPrefs();
  },
  onAutoBalance: () => {
    // Auto-normalize against the active cloud's RGB. No-op when the
    // active cloud has no RGB. Lazy-import keeps the analyser out of
    // the startup chunk.
    const id = activeId;
    if (!id) return;
    const cloud = viewer.getCloud(id);
    if (!cloud || !cloud.colors) return;
    void loadRgbAutoNormalize().then(({ rgbAutoNormalize }) => {
      const suggestion = rgbAutoNormalize({ colorsU8: cloud.colors! });
      if (!suggestion) return;
      viewer.setRgbAppearance(suggestion.settings);
      syncInspectorVisuals();
      persistPrefs();
    });
  },
  onSplatMode: (id) => {
    viewer.setSplatMode(id);
    syncInspectorRendering();
    persistPrefs();
  },
  // Workflow presets (v0.4.5) — fan one pure bundle out through the
  // EXISTING setters, then re-sync every Inspector surface the bundle
  // touched. No new rendering machinery: the preset module is a table.
  onTerrainWorkflowPreset: (id) => {
    const p = getTerrainWorkflowPreset(id);
    viewer.setEdlPreset(p.edlPresetId);
    viewer.setPointSize(p.pointSize);
    viewer.setPointSizeMode(p.pointSizeMode);
    viewer.setSky(p.sky);
    viewer.setHeightPercentileTrim(p.heightPercentileTrim);
    // Colour mode is per-cloud and channel-gated: a cloud without the
    // channel throws from colorForMode — skip it (keeping its current
    // colours) rather than failing the rest of the bundle, and only
    // record `currentColorMode` once the guarded set actually applied
    // so the chip rail stays honest on channel-less clouds. Streaming
    // clouds recolour through their own seam.
    if (activeId) {
      try {
        viewer.setColorMode(activeId, p.colorMode);
        currentColorMode = p.colorMode;
      } catch (err) {
        console.warn(`[workflow-preset] colour mode ${p.colorMode} skipped:`, err);
      }
    }
    try {
      viewer.setStreamingColorMode(p.colorMode);
    } catch (err) {
      console.warn(`[workflow-preset] streaming colour mode skipped:`, err);
    }
    syncColorModeForActive();
    syncInspectorVisuals();
    syncInspectorRendering();
    persistPrefs();
  },
});

// v0.4.3 — the header theme toggle was constructed with the persisted
// theme as its initial state, so the correct icon is already lit on first
// paint; no extra sync call is needed here.

// v0.3.9 — the inspector's CRS section now subscribes to the central
// CrsService. When a scan loads, the service broadcasts the resolved
// CRS and the inspector renders the override panel + label; when the
// scan closes, the service broadcasts `null` and the inspector
// restores its placeholder. This retires the duplicated push from
// `refreshCrsForStaticCloud` / `closeScan` — there's now exactly one
// write path for the CRS section, and `CrsService.current()` is the
// single source of truth.
crsService.subscribe((resolved) => {
  if (resolved) inspector.setCrs(resolved);
  else inspector.clearCrs();
});

// Inspector load-time card refreshers (Provenance + Dataset Intelligence) and
// the CRS coordinator (resolve + per-scan refresh + override handling) are
// extracted into `src/app/`. They read the lazy `viewer` and the `activeId`
// selection through getters so no top-level `viewer.*` dereference is
// introduced here — `viewer` is null until its chunk resolves.
const inspectorCards = createInspectorCardRefreshers(inspector);
const crsCoordinator = createCrsCoordinator({
  crsService,
  getViewer: () => viewer,
  isViewerReady: () => viewerReady,
  getActiveId: () => activeId,
  debug,
});

// v0.3.9 — workflow recorder. The host owns the controller so it can
// capture from every action handler in one place and dispatch back
// through the same handlers on replay.
//
// v0.4.5 — feature-flagged OFF (see WORKFLOW_RECORDER_ENABLED in
// WorkflowController.ts for the product rationale). The controller is
// still constructed so the unconditional `capture()` calls in the
// action handlers below stay valid no-ops, but the badge is only
// mounted — and the shortcut / palette entries only registered —
// when the flag is on.
const workflowController = new WorkflowController();
const workflowConfigPanel = new WorkflowConfigPanel();
if (WORKFLOW_RECORDER_ENABLED) {
  stage.overlay.append(workflowController.badge);
  stage.overlay.append(workflowConfigPanel.element);
  // Edits in the settings popup take effect immediately and persist.
  workflowConfigPanel.onChange((cfg) => {
    workflowController.setConfig(cfg);
    persistPrefs();
  });
}

/** Save a finished workflow and confirm (or report a cancelled picker). */
async function saveWorkflowWithToast(
  workflow: import('./render/workflow/workflowRecorder').Workflow,
): Promise<void> {
  const name = await workflowController.save(workflow);
  if (name === null) {
    showLassoToast('Workflow · save cancelled.');
    return;
  }
  showLassoToast('Workflow saved. Replay needs the same scan open on the other end.');
}

/** Start (with the configured countdown) the right toast. */
function startWorkflowRecording(): void {
  const startedNow = workflowController.requestStartRecording();
  if (startedNow) {
    showLassoToast('Workflow · recording started. Use the badge to stop.');
  } else if (workflowController.config.countdownSeconds > 0) {
    const secs = workflowController.config.countdownSeconds;
    showLassoToast(`Workflow · recording starts in ${secs}s…`);
  }
}

/** Toggle the recorder: idle → start, recording → stop + save. */
function toggleWorkflowRecord(): void {
  if (workflowController.state === 'recording') {
    const workflow = workflowController.stopRecording();
    if (workflow) void saveWorkflowWithToast(workflow);
    else showLassoToast('Workflow · nothing recorded yet.');
  } else {
    startWorkflowRecording();
  }
}

// v0.3.9 — command palette (Cmd-K / Ctrl-K). The host owns the
// registry so every action stays close to the handler that powers
// the corresponding tool dock / Inspector / keyboard surface — no
// duplicate truth.
const commandPalette = new CommandPalette();
stage.overlay.append(commandPalette.element);

// A dismissible "recommended view" chip surfaced after a scan loads.
const recommendedViewChip = new RecommendedViewChip();
stage.overlay.append(recommendedViewChip.element);

// v0.3.9 — keyboard shortcut sheet (open via `?`). Reads the same
// action registry as the palette so adding a new action makes it
// discoverable in both surfaces without a second touch.
const shortcutSheet = new ShortcutSheet();
stage.overlay.append(shortcutSheet.element);

// v0.3.9 — onboarding tour. Mounts the overlay immediately so the
// SVG / card DOM exists; auto-starts on the first session per
// browser. "Replay tour" is added to the command palette below.
const tourSession = new TourSession();
const tourOverlay = new TourOverlay(tourSession);
tourOverlay.mount();
// Kick off the tour after the next animation frame so the layout has
// settled — otherwise the spotlight bounding boxes can be measured
// against a still-positioning page and land off-target.
if (!tourSession.hasSeen()) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => tourSession.start());
  });
}

/**
 * Replay-time dispatcher — routes a recorded event back through the
 * same handlers the user originally hit. Defined as a top-level
 * helper so the workflow controller and the command palette
 * "Replay workflow" action can share it.
 */
function dispatchWorkflowEvent(event: WorkflowEvent): void {
  switch (event.type) {
    case 'camera-preset':
      viewer.setCameraPreset(event.name as 'top' | 'iso' | 'oblique' | 'planar');
      break;
    case 'frame-all':
      viewer.frameAll();
      break;
    case 'theme':
      if (event.name === 'dark' || event.name === 'light' || event.name === 'high-contrast') {
        // setTheme keeps the header toggle's icon in sync.
        setTheme(event.name);
      }
      break;
    case 'tool': {
      const desired = event.on;
      if (event.tool === 'measure' && viewer.measureMode !== desired) {
        viewer.setMeasureMode(desired);
      } else if (event.tool === 'inspect' && viewer.inspectMode !== desired) {
        viewer.setInspectMode(desired);
      } else if (event.tool === 'annotate' && viewer.annotateMode !== desired) {
        viewer.setAnnotateMode(desired);
      }
      break;
    }
  }
}

/**
 * Derive a heuristic classification for the active cloud when it has none.
 * Runs the unsupervised classifier OFF the main thread (with a safe fallback),
 * applies the codes, colours the cloud by class, rebuilds the legend, and
 * reports the result with the honest "derived, not survey-grade" caveat.
 */
let classifyRunning = false;
async function runDeriveClassification(): Promise<void> {
  if (classifyRunning) return;
  if (!activeId) {
    showLassoToast('Classify · open a scan first.');
    return;
  }
  const cloud = viewer.getCloud(activeId);
  if (!cloud) {
    showLassoToast('Classify · this works on a loaded (non-streaming) scan.');
    return;
  }
  if (cloud.classification && !cloud.classificationIsDerived) {
    showLassoToast('Classify · this scan already carries a classification.');
    return;
  }
  classifyRunning = true;
  showLassoToast('Classify · deriving ground / vegetation / building…');
  try {
    const id = activeId;
    const result = await deriveClassificationAsync(
      cloud.positions,
      cloud.pointCount,
      {},
      undefined,
      undefined,
      // Live phase in the toast so a multi-second derive reads as progress,
      // not a hang. (Off-thread, so the UI repaints between phases.)
      (phase) => showLassoToast(`Classify · ${phase}…`),
    );
    if (id !== activeId || viewer.getCloud(id) !== cloud) return; // scan changed
    viewer.applyDerivedClassification(id, result.codes);
    classLegendPanel.setClasses(countClasses(result.codes));
    classLegendPanel.setDerivedProvenance(true);
    classLegendPanel.show();
    // Honest one-line breakdown of the top classes derived.
    const total = cloud.pointCount || 1;
    const top = Object.entries(result.counts)
      .map(([code, n]) => ({ code: Number(code), n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((e) => `${classificationLabel(e.code)} ${Math.round((e.n / total) * 100)}%`)
      .join(' · ');
    showLassoToast(`Classify · derived (heuristic, not survey-grade): ${top}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/abort/i.test(msg)) showLassoToast(`Classify · failed: ${msg}`);
  } finally {
    classifyRunning = false;
  }
}

function buildActionRegistry(): Action[] {
  const actions: Action[] = [];

  // Camera presets — same handlers as the T / O / P keys.
  for (const name of CAMERA_PRESET_ORDER) {
    const label = CAMERA_PRESET_LABEL[name];
    actions.push({
      id: `camera.${name}`,
      title: `${label} view`,
      section: 'Camera',
      // Iso's advertised 'I' chip is suppressed: bare 'I' is the Inspect
      // tool shortcut (see the keydown handler above) — Iso is palette /
      // NavBar only. Advertising a key that doesn't fire would be worse.
      keys: name === 'iso' ? undefined : CAMERA_PRESET_KEY[name],
      hint: `Frame the scan with the ${label.toLowerCase()} preset.`,
      keywords: ['view', 'pose', 'orbit'],
      run: () => {
        const fired = viewer.setCameraPreset(name);
        if (fired) {
          workflowController.capture({ type: 'camera-preset', name });
          showLassoToast(`Camera · ${label} view.`);
        }
      },
    });
  }
  // Reset / Frame All — exposed alongside the named presets.
  actions.push({
    id: 'camera.frame-all',
    title: 'Frame all',
    section: 'Camera',
    hint: 'Fit the camera to every visible cloud.',
    keywords: ['fit', 'reset', 'center', 'centre'],
    run: () => {
      viewer.frameAll();
      workflowController.capture({ type: 'frame-all' });
    },
  });

  // Theme — same handler as the header theme toggle. `setTheme` keeps the
  // toggle's icon in sync.
  for (const name of THEME_ORDER) {
    actions.push({
      id: `theme.${name}`,
      title: `${THEME_LABEL[name]} theme`,
      section: 'Theme',
      hint: 'Switch the palette of the whole interface.',
      keywords: ['appearance', 'colours', 'colors', 'accessibility'],
      run: () => {
        setTheme(name);
        workflowController.capture({ type: 'theme', name });
      },
    });
  }

  // Tool dock — Measure, Inspect, Annotate, Lasso volume.
  actions.push(
    {
      id: 'tool.measure',
      title: 'Measure',
      section: 'Tools',
      hint: 'Activate the measurement toolbar.',
      keywords: ['distance', 'area', 'volume'],
      run: () => {
        const next = !viewer.measureMode;
        viewer.setMeasureMode(next);
        workflowController.capture({ type: 'tool', tool: 'measure', on: next });
      },
    },
    {
      id: 'tool.inspect',
      title: 'Inspect point',
      section: 'Tools',
      hint: 'Read attributes of any point under the cursor.',
      keywords: ['point info', 'attributes'],
      run: () => {
        const next = !viewer.inspectMode;
        viewer.setInspectMode(next);
        workflowController.capture({ type: 'tool', tool: 'inspect', on: next });
      },
    },
    {
      id: 'tool.annotate',
      title: 'Annotate',
      section: 'Tools',
      hint: 'Drop notes, info, warnings, or issues on points.',
      keywords: ['note', 'comment', 'mark'],
      run: () => {
        const next = !viewer.annotateMode;
        viewer.setAnnotateMode(next);
        workflowController.capture({ type: 'tool', tool: 'annotate', on: next });
      },
    },
    {
      id: 'tool.classify',
      title: 'Classify (derive)',
      section: 'Tools',
      hint: 'Derive a ground / vegetation / building classification for an unclassified scan (heuristic).',
      keywords: ['classification', 'ground', 'vegetation', 'building', 'segment', 'auto'],
      run: () => {
        void runDeriveClassification();
      },
    },
    {
      id: 'tool.lasso-volume',
      title: 'Lasso volume',
      section: 'Tools',
      keys: 'L',
      hint: 'Draw a freeform shape to measure a 3D volume.',
      keywords: ['select', 'shape', 'cut', 'fill'],
      run: () => {
        if (lassoVolumeTool.enabled) {
          lassoVolumeTool.disable();
          viewer.clearSelectionHighlight();
          showLassoToast('Lasso off — back to navigation.');
        } else {
          lassoVolumeTool.enable();
          showLassoToast('Lasso armed — draw a shape on the canvas.');
        }
        syncLassoButton();
      },
    },
  );

  // Workflow recorder — Start / Stop+Save / Open a file.
  //
  // v0.4.5 — gated behind WORKFLOW_RECORDER_ENABLED (currently false; see
  // WorkflowController.ts for the product rationale). The entries must be
  // ABSENT from the registry when the flag is off — not merely inert — so
  // the command palette and the shortcut sheet (both of which render
  // straight from this registry) show nothing for the feature.
  if (WORKFLOW_RECORDER_ENABLED) {
    actions.push(
      {
        id: 'workflow.start',
        title: 'Start recording workflow',
        section: 'Workflow',
        keys: 'Cmd-Shift-U',
        // v0.3.10 — `.olvworkflow` files capture camera
        // moves and tool actions ONLY (no scan data, no measurements). To
        // replay one the recipient needs the same scan file already open
        // locally. Without that disclosure users will share a workflow,
        // the recipient opens it, nothing happens, and trust is lost the
        // way it was with the pre-v0.3.10 "Share" button. The hint below
        // sets that expectation at recording start, the stop-save title
        // makes the file format explicit, and the save toast confirms
        // both what was saved and what the recipient needs to use it.
        hint:
          'Records camera moves and tool actions only — to replay later you ' +
          '(or the recipient) need the same scan open.',
        keywords: ['record', 'macro', 'demo'],
        run: () => startWorkflowRecording(),
      },
      {
        id: 'workflow.stop-save',
        title: 'Stop and save workflow (.olvworkflow)',
        section: 'Workflow',
        hint:
          'Saves a replay of camera moves and tool actions — replay needs ' +
          'the same scan loaded on the other end.',
        keywords: ['export', 'finish', 'save'],
        run: () => {
          const workflow = workflowController.stopRecording();
          if (workflow) {
            void workflowController.save(workflow);
            showLassoToast(
              'Workflow saved. Replay needs the same scan open on the other end.',
            );
          } else {
            showLassoToast('Workflow · nothing recorded yet.');
          }
        },
      },
      {
        id: 'workflow.load-replay',
        title: 'Replay a workflow file…',
        section: 'Workflow',
        hint: 'Pick a .olvworkflow file and play it back.',
        keywords: ['load', 'import', 'open', 'macro'],
        run: () => {
          const input = el('input', { className: 'olv-hidden' });
          input.type = 'file';
          input.accept = '.olvworkflow,application/json';
          input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            void (async () => {
              try {
                const workflow = await workflowController.loadFromFile(file);
                workflowController.replay(workflow, dispatchWorkflowEvent);
                showLassoToast(
                  `Workflow · playing ${workflow.events.length} event${workflow.events.length === 1 ? '' : 's'}.`,
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'unknown error';
                showLassoToast(`Workflow · couldn't load file: ${msg}`);
              }
            })();
          });
          document.body.append(input);
          input.click();
        },
      },
      {
        id: 'workflow.settings',
        title: 'Workflow recorder settings…',
        section: 'Workflow',
        hint: 'Format, save location, shortcut, replay speed, capture scope.',
        keywords: ['config', 'options', 'preferences', 'shortcut', 'speed'],
        run: () => workflowConfigPanel.open(),
      },
    );
  }

  // v0.3.9 — Onboarding tour replay. Surfaces the tour from the
  // command palette so users who skipped or dismissed can re-trigger
  // it from one keystroke (Cmd-K → "tour").
  actions.push({
    id: 'tour.replay',
    title: 'Replay onboarding tour',
    section: 'Help',
    hint: 'Walks through the main tools — about 30 seconds.',
    keywords: ['onboarding', 'tour', 'help', 'tutorial', 'guide', 'walkthrough'],
    run: () => {
      tourSession.reset();
      tourSession.start();
    },
  });

  // v0.3.9 — Keyboard shortcut sheet. Surfaces the sheet from the
  // palette and lists its own binding (`?`) so users who discovered
  // the palette via Cmd-K can find the sheet from the same surface.
  actions.push({
    id: 'help.shortcuts',
    title: 'Show keyboard shortcuts',
    section: 'Help',
    keys: '?',
    hint: 'Every action and key, grouped by section.',
    keywords: ['shortcuts', 'keys', 'bindings', 'help', 'cheat', 'sheet'],
    run: () => shortcutSheet.open(),
  });

  return actions;
}

const ACTION_REGISTRY = buildActionRegistry();
const duplicateActionIds = findDuplicateIds(ACTION_REGISTRY);
if (duplicateActionIds.length > 0) {
  // Throw at boot rather than silently surfacing two rows with the
  // same id — duplicates almost always mean a copy-paste bug.
  throw new Error(
    `Command palette: duplicate action ids: ${duplicateActionIds.join(', ')}`,
  );
}
commandPalette.setActions(ACTION_REGISTRY);
shortcutSheet.setActions(ACTION_REGISTRY);

// Cmd-K / Ctrl-K toggles the palette. Esc inside the palette closes
// it (handled internally), so the universal Esc handler below
// doesn't need to know about the palette.
window.addEventListener('keydown', (e) => {
  const isToggle = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
  if (!isToggle) return;
  e.preventDefault();
  commandPalette.toggle();
});

// `?` toggles the keyboard shortcut sheet. Skipped when the user is
// typing in any input / textarea / contenteditable so a `?` in a
// rename field doesn't open the sheet. Esc inside the sheet closes
// it (handled internally).
window.addEventListener('keydown', (e) => {
  if (e.key !== '?') return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
  // Don't fight a chord — only the bare `?` (Shift+/ on most layouts).
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  shortcutSheet.toggle();
});

// Cmd-Shift-U / Ctrl-Shift-U toggles workflow recording. When idle,
// start a recording; when recording, stop and immediately download
// the workflow file. Replay is reachable via the command palette.
//
// Why U? The original Cmd/Ctrl-Shift-R collided with the browser's
// hard-refresh — recording a workflow reloaded the page. Surveying
// Cmd/Ctrl-Shift-<letter> across Chrome / Firefox / Safari / Edge,
// nearly every letter is taken: A (tab search), B (bookmarks bar),
// C (inspect element), D (bookmark tabs), G (find previous),
// H (home/history), I/J/K (devtools), M (responsive/profile),
// N (incognito — reserved), O (bookmark manager), P (private window),
// R (hard refresh), S (screenshot), T (reopen tab — reserved),
// V (paste-match-style), W (close window — reserved, cannot be
// intercepted), Y (Firefox downloads), Z (our own redo). U is unbound
// in Chrome, Firefox and Safari; Edge's Ctrl-Shift-U (Read Aloud) is
// page-interceptable, so our preventDefault() wins. No in-app binding
// uses U, bare or modified. e.code === 'KeyU' keeps the chord
// layout-independent (Shift can change e.key on some layouts).
// v0.4.5 — the listener is only installed when WORKFLOW_RECORDER_ENABLED
// is true (it currently is not; see WorkflowController.ts). With the flag
// off the chord falls through untouched to the browser, exactly as if the
// feature never existed.
// The start/stop chord is user-configurable (default ⌘/Ctrl+Shift+U) via the
// recorder settings popup; the handler reads the live config each press, so a
// rebind takes effect with no re-binding. A text field with focus suppresses
// it (so capturing a new chord in the settings popup never also toggles).
if (WORKFLOW_RECORDER_ENABLED) {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    if (!matchesShortcut(e, workflowController.config.shortcut)) return;
    e.preventDefault();
    toggleWorkflowRecord();
  });
}

/** Helper: type-guard a string before passing to the typed Viewer setter. */
function isRgbAppearancePresetId(
  id: string,
): id is import('./render/rgbAppearance').RgbAppearancePresetId {
  return (
    id === 'natural' ||
    id === 'survey' ||
    id === 'rgb-inspection' ||
    id === 'high-contrast' ||
    id === 'drone-rgb' ||
    id === 'mobile-lidar' ||
    id === 'infrastructure' ||
    id === 'photoreal-rgb'
  );
}
function isSkyPresetId(
  id: string,
): id is import('./render/inspectionPresets').SkyPreset {
  return (
    id === 'deep' ||
    id === 'survey-blue' ||
    id === 'terrain-sand' ||
    id === 'foliage-teal' ||
    id === 'qa-cool' ||
    id === 'studio-dark' ||
    id === 'blueprint' ||
    id === 'survey-light' ||
    id === 'terrain' ||
    id === 'black'
  );
}

/**
 * Visuals Studio — push the Viewer's Visuals Studio state into the
 * Inspector chip rails + advanced sliders. Called whenever a callback
 * fires, on session restore, and on initial paint after a scan loads.
 */
function syncInspectorVisuals(): void {
  // Workflow rail (v0.4.5): re-derive which preset (if any) the CURRENT
  // knobs equal. Any hand-tweak of a preset-managed knob → 'custom'.
  const workflowPresetId =
    matchTerrainWorkflowPreset({
      colorMode: currentColorMode ?? null,
      edlPresetId: viewer.edlPresetId,
      pointSize: viewer.pointSize,
      pointSizeMode: viewer.pointSizeMode,
      skyPresetId: viewer.skyPresetId,
      heightPercentileTrim: viewer.heightPercentileTrim,
    }) ?? 'custom';
  inspector.syncVisuals({
    rgbAppearancePresetId: viewer.rgbAppearancePresetId,
    edlPresetId: viewer.edlPresetId,
    skyPresetId: viewer.skyPresetId,
    temperature: viewer.rgbAppearance.temperature ?? 0,
    tint: viewer.rgbAppearance.tint ?? 0,
    workflowPresetId,
  });
  // Advanced disclosure (Temperature, Tint, Auto-balance) only makes
  // sense on streaming COPC tiles — for local LAZ the RGB preset
  // chips already cover the use case and the sliders would mislead
  // users into expecting an effect that does not land.
  inspector.setAdvancedWbVisible(viewer.isStreamingActive());
}

const helpOverlay = new HelpOverlay();

const dock = new ToolDock({
  onFrameAll: () => viewer.frameAll(),
  onSnapshot: () => void saveSnapshot(),
  onShare: () => void copyShareLink(),
  onMeasureToggle: () => viewer.setMeasureMode(!viewer.measureMode),
  onInspectToggle: () => viewer.setInspectMode(!viewer.inspectMode),
  onProbeToggle: () => viewer.setProbeMode(!viewer.probeMode),
  onAnnotateToggle: () => viewer.setAnnotateMode(!viewer.annotateMode),
  onAnalyseToggle: () => {
    // Re-open (or hide) the terrain analysis panel. If an object scan had
    // demoted it behind the Object panel, opening Analyse takes over —
    // the "run terrain anyway" path, reachable from one obvious place.
    const show = !analysePanel.isVisible();
    // A manual Analyse toggle is a user override — stop auto-rerouting so a
    // late streaming node can't yank the panel away.
    scanRouteOverridden = true;
    analysePanel.setVisible(show);
    if (show) objectPanel.setVisible(false);
    dock.setAnalyseActive(show);
  },
  onHelp: () => helpOverlay.open(),
  onClose: () => closeScan(),
});
// Start the dock hidden — the empty state shows no scan-dependent tools.
// `setEmpty(false)` is called from every successful attach path.
dock.setEmpty(true);
// Same contract for the Inspector — hide its 13 collapsed sections + the
// always-visible Point Size / EDL controls until a scan actually attaches.
inspector.setEmpty(true);

// Game-style navigation: mode switcher, speed slider, controls HUD.
const navBar = new NavBar({
  onMode: (mode) => viewer.setMode(mode),
  onSpeed: (multiplier) => viewer.setNavSpeed(multiplier),
  onReset: () => viewer.frameAll(),
  onCameraPreset: (name) => {
    const fired = viewer.setCameraPreset(name);
    if (fired) {
      showLassoToast(
        `Camera · ${name[0].toUpperCase() + name.slice(1)} view.`,
      );
    }
  },
  onStandardView: (view) => {
    const fired = viewer.setStandardView(view);
    if (fired) {
      showLassoToast(`View · ${view[0].toUpperCase() + view.slice(1)}.`);
    }
  },
  onOrthographic: (on) => {
    viewer.setOrthographic(on);
    showLassoToast(on ? 'Orthographic (parallel) view on.' : 'Perspective view restored.');
  },
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
  onChainAggregate: (ids, dimension, operation) => {
    // Filter the controller's measurements to the panel-selected set
    // and aggregate via the pure-data module. The panel owns the
    // selection state; the controller owns the data + unit context.
    // The CRS unit factor (B2, v0.4.5) rides along so chain sums over a
    // foot-CRS scan come back in true metres like every other readout.
    const all = viewer.measure.getMeasurements();
    const wanted = new Set(ids);
    const selected = all.filter((m) => wanted.has(m.id));
    return aggregateMeasurements(
      selected,
      operation,
      dimension,
      [0, 0, 1],
      viewer.measure.unitToMetres,
    );
  },
  // v0.3.10 Profile-as-Deliverable — expose the controller's unit
  // system to the panel so the profile chart's axis labels (chainage,
  // elevation) read in the user's preferred units.
  getUnitSystem: () => viewer.measure.unitSystem,
  // v0.4.5 (B4) — CRS provenance for the profile PDF header, resolved at
  // export time so a late confirmation/override lands on the sheet. Local
  // and unknown frames return nulls and the PDF keeps its honest
  // "— (not georeferenced)" fallback.
  getProfileExportContext: () => {
    const cur = crsService.current();
    if (!cur || (cur.kind !== 'projected' && cur.kind !== 'geographic')) {
      return { crs: null, verticalDatum: null };
    }
    return {
      // "EPSG:NNNN — name" when the code is known; the resolved name alone
      // otherwise (it already falls back to the WKT name / EPSG label).
      crs: cur.epsg != null ? `EPSG:${cur.epsg} — ${cur.name}` : cur.name,
      verticalDatum: cur.verticalDatum ?? null,
    };
  },
  // B7/B8 (v0.4.5) — the panel's sampler controls re-sample through the
  // controller, which clamps the values, converts the metre corridor back to
  // render units, and emits a change so the panel re-renders with the values
  // that actually shaped the new chart.
  onProfileResample: (id, params) => {
    viewer.measure.resampleProfile(id, params);
  },
});

// B2 (v0.4.5) — feed the measure stack the SAME render-units → metres seam
// the terrain/space paths already read (`crsService.linearUnitToMetres`,
// see the terrain run + terrainAnalysisRunner). Render space keeps the
// scan's source units, so a foot-CRS scan must scale every measure readout
// once, at the controller boundary; the subscription keeps a late resolve
// or a user override in lockstep.
//
// Deferred behind viewerLoaded: `viewer` is null until the lazy chunk
// resolves, so a top-level dereference throws at startup — and
// CrsService.subscribe fires the listener synchronously on registration,
// which would hit the same null (swallowed, silently dropping the seed).
// Subscribing inside the .then is sufficient on its own: the immediate
// fire seeds the CURRENT factor, covering a CRS that resolved before the
// viewer chunk did, and every later resolve/override re-fires it.
void viewerLoaded.then(() => {
  crsService.subscribe((resolved) => {
    viewer.measure.setUnitToMetres(resolved?.linearUnitToMetres ?? 1);
  });
});
// The Annotations panel lists placed annotations; the controller drives it.
const annotationPanel = new AnnotationPanel({
  onActivate: (id) => viewer.jumpToAnnotation(id),
  onEdit: (id, x, y) => viewer.annotate.beginEdit(id, x, y),
  onDelete: (id) => viewer.annotate.remove(id),
  onClearAll: () => viewer.annotate.clear(),
  onHover: (id) => viewer.annotate.hover(id),
});

// The Analyse panel surfaces terrain readiness (ground confidence, DTM
// quality, contour readiness) and contour export. v0.4.0. The heavy
// pipeline is dynamic-imported on demand so it stays out of the initial
// bundle; the panel only runs when the user clicks "Run terrain analysis".
let lastCloudName = 'contours';
// The terrain-analysis orchestration (the async run path, the A-1
// stale-result token guard, the fingerprint cache, and the worker offload)
// lives in `src/app/terrainAnalysisRunner.ts`. The runner owns its own run
// state (run token, in-flight AbortController, cache-clear fn) and is wired
// up just below, once `analysePanel` exists. The panel callbacks reference
// `terrainRunner` lazily — they only fire on user input, long after the
// runner is constructed.
const analysePanel = new AnalysePanel({
  onRun: () => void terrainRunner.run(),
  onScanTypeChange: (override) => setScanTypeOverride(override),
  onSelectInterval: (m) => void terrainRunner.run(m),
  // Side-effect-free contour rebuild at the dialog's chosen FINAL interval, over
  // the SAME cached terrain core the runner uses — never mutates the panel.
  buildResultAtInterval: (m) => terrainRunner.buildResultAtInterval(m),
  // Same cached-core rebuild, generalised with the contour shape-style picker so
  // an export reflects the user's chosen interval AND line shape.
  buildResultForExport: (opts) => terrainRunner.buildResultForExport(opts),
  getExportBasename: () => lastCloudName,
  // Terrain Intelligence Report (v0.4.5): hand the report the Inspector
  // card's CURRENT Dataset Intelligence summary so the PDF's bucket labels
  // are the card's own strings (null when the card is empty — the report
  // then omits those rows rather than re-deriving them).
  getDatasetIntelligence: () => inspector.datasetIntelligence,
  // Confidence overlay (v0.4.5): the coverage tile's "Colour 3D by confidence"
  // link switches the loaded cloud to the colourblind-safe 'confidence' colour
  // mode — the same DTM-confidence grid the tile renders — and re-syncs the
  // Inspector's COLOR BY rail so the matching chip lights up. Guarded on a
  // grid existing (the link only renders after an analysis, but the scan may
  // have been closed since).
  onColorByConfidence: () => {
    if (!activeId || !viewer.hasCoverageGrid()) return;
    const cloud = viewer.getCloud(activeId);
    if (!cloud) return;
    currentColorMode = 'confidence';
    viewer.setColorMode(activeId, 'confidence');
    inspector.setColorModes(availableModes(cloud), 'confidence');
    syncInspectorVisuals();
  },
  getMapContext: () => {
    const cloud = activeId ? viewer.getCloud(activeId) : null;
    // Streamed COPC / EPT scans never enter `viewer.getCloud` — their
    // recentre offset lives on the streaming source (`renderOrigin`) and
    // their CRS on `crs()`. Fall back to those when no static cloud is
    // active, so a contour export from a streamed scan keeps its world
    // origin and EPSG stamp instead of silently degrading to local frame.
    const streaming = cloud ? null : viewer.streamingCloud;
    const origin = cloud?.origin ?? streaming?.renderOrigin;
    const cur = crsService.current();
    return {
      // All three axes: contour serialization shifts elevations by `z` so
      // exported contour levels read in real-world (e.g. orthometric) height
      // rather than the recentred local frame.
      worldOrigin: origin ? { x: origin[0], y: origin[1], z: origin[2] } : null,
      title: `${lastCloudName} — Contours`,
      sheet: 'letter',
      isGeographic: cur?.kind === 'geographic',
      wkt: cloud?.metadata?.crs?.wkt ?? streaming?.crs()?.wkt ?? null,
      // The resolved CRS's linear unit (same seam every other unit consumer
      // reads) so a foot-based CRS stamps DXF $INSUNITS = feet and the SVG
      // scale note says ft — and a local/unresolved frame stamps an honest
      // "unitless" rather than asserting metres. Undefined before a CRS
      // resolves ⇒ serializeContours keeps its standing metre default.
      linearUnit: cur?.linearUnit,
    };
  },
});

// Classification legend — one row per ASPRS class present in the scan, with a
// colour swatch (matching "colour by class"), a live "shown" point count, and a
// visibility checkbox. DISPLAY ONLY: a change applies the 256-entry mask to the
// GPU and re-renders the legend; it does NOT scope metrics/analysis. v0.4.1.
// The streaming cloud whose header report is currently shown, kept so a later
// class-filter toggle can re-stamp the not-class-scoped sentinel without
// re-deriving it from scratch. Null for static scans / the empty state.
let lastStreamingReportCloud: Parameters<typeof runStreamingModules>[0] | null = null;

const classLegendPanel = new ClassLegendPanel();
classLegendPanel.onChange((visibility) => {
  viewer.applyClassVisibility(visibility);
  // Re-run the scan report so its class-dependent figures (count, density,
  // coverage) and their honesty stamps update live with the filter. Guarded so
  // a metrics failure never blocks the GPU mask the user just toggled.
  try {
    refreshScopedReport();
  } catch (err) {
    if (debug) console.warn('[class-legend] scoped report refresh threw', err);
  }
});
classLegendPanel.onPaletteChange((on) => {
  // The colourblind toggle also re-themes the categorical status dots (Dataset
  // Intelligence tier dots + confidence chip) via a body class.
  document.body.classList.toggle('olv-cvd', on);
  // Persist the choice and recolour any classification view in place. Only the
  // classification colour pass reads the class palette, so other modes need no
  // refresh; the legend repaints its own swatches.
  persistPrefs();
  if (currentColorMode === 'classification') {
    if (activeId) viewer.setColorMode(activeId, 'classification');
    if (viewer.hasStreamingCloud) viewer.setStreamingColorMode('classification');
  }
});

/**
 * Re-render the Inspector's scan report under the current class filter. Routes
 * to the static module path (re-runs `runModules` with the derived scope) or
 * the streaming header path (re-stamps the not-class-scoped sentinel), matching
 * however the active scan was opened.
 */
function refreshScopedReport(): void {
  // Keep the point-inspector's copy / JSON scope stamp in lockstep with the
  // live filter — a point copied while filtering must carry the scope.
  syncInspectClassScope();
  if (viewer.isStreamingActive()) {
    const cloud = lastStreamingReportCloud;
    if (cloud) {
      inspector.setReport(
        runStreamingModules(cloud, classLegendPanel.getVisibility().isFiltered()),
      );
    }
    return;
  }
  const cloud = activeId ? viewer.getCloud(activeId) : null;
  if (cloud) inspector.setReport(runModules(cloud, currentClassScope(cloud)));
}
// Streaming node-ready: fold each newly-resident node's classification into the
// legend so a class first seen at depth appears as a new row. The legend keeps
// its current visibility (default visible, but left hidden if the user isolated
// a class), so a late arrival never silently re-reveals hidden points.
// Deferred: `viewer` is null until the lazy Viewer chunk resolves, so this hook
// must be attached inside viewerLoaded (a top-level `viewer.*` write throws at
// module load and breaks startup — caught by lint:main-deferral).
void viewerLoaded.then(() => {
  viewer.onStreamingNodeClasses = (classes) => {
    if (!classLegendPanel.hasClasses()) {
      // First node to carry classification on this streaming scan — seed + show.
      classLegendPanel.setClasses(countClasses(classes));
      if (classLegendPanel.hasClasses()) classLegendPanel.show();
    } else {
      classLegendPanel.mergeClasses(countClasses(classes));
    }
    // A late-arriving class can change the present-class total, so refresh the
    // inspector's scope stamp ("k of M classes") to keep M accurate.
    syncInspectClassScope();
  };
  // Re-evaluate the scan-type routing as the streaming cloud fills in. The
  // open-time `revealAnalysePanel` runs when only a sparse coarse level may be
  // resident, so a 360 house can read as terrain early; once enough geometry
  // has streamed in, re-classify and re-route (only if the verdict changes).
  // Debounced + growth-gated so a burst of node-ready events can't thrash.
  viewer.onStreamingNodeReady = () => {
    // A manual (non-auto) "Treat as" choice pins the routing exactly like the
    // "Run terrain anyway" override — a late streaming node must not flip it.
    if (scanRouteOverridden || scanTypeOverride !== 'auto') return;
    const resident = viewer.residentPointTotal();
    if (resident < lastRouteResident * SCAN_REROUTE_GROWTH) return;
    lastRouteResident = resident;
    if (scanRouteTimer != null) clearTimeout(scanRouteTimer);
    scanRouteTimer = setTimeout(() => {
      scanRouteTimer = null;
      applyScanRoute(false);
    }, 500);
  };
});

// The last non-terrain analysis the ObjectPanel rendered, captured so the panel's
// export buttons (Report PDF / Floor plan preview) can build their deliverable from the
// SAME positions + metrics + unit factor that produced the on-screen numbers —
// nothing recomputed differently, nothing fabricated. Null while terrain / empty.
interface SpaceExportContext {
  readonly positions: Float32Array;
  readonly space: SpaceMetrics;
  readonly object: ObjectMetrics | null;
  readonly spaceKind: 'interior' | 'object';
  readonly unitToMetres: number;
  readonly upAxis: SpaceMetrics['up'];
  readonly basename: string;
}
let lastSpaceExport: SpaceExportContext | null = null;

// The routing gather that fills `lastSpaceExport` is capped at 60 k points —
// plenty for classification + metrics, far too sparse for tracing 2–5 cm wall
// cells on a multi-room scan (the wall-height slice of a 60 k sample of a
// 400 m² interior leaves ~1 return per wall cell and the plan fragments).
// Floor-plan extraction therefore re-gathers at the terrain-analysis budget;
// the routing snapshot stays as the metrics source AND the fallback when the
// fresh gather fails (e.g. mid-stream).
const FLOORPLAN_GATHER_POINTS = 300_000;

/**
 * Floor-plan extraction DEFAULTS plumbed into both export paths (PDF report +
 * standalone SVG sheet) so the two NEVER diverge. These are the v0.4.6 knobs
 * the pipeline exposes — the adaptive wall-band toggle and the axis-snap
 * policy — pinned here at sane defaults:
 *   - `adaptiveBand: true` — re-centre the wall slice on the detected
 *     wall-evidence z-peak so countertop / industrial scans whose walls sit
 *     outside the standard 0.7–1.8 m band still slice correctly; the fixed
 *     band is kept when no clear peak is found (so normal rooms are unchanged).
 *   - `snapMode` left at the module default ('auto' — snap only on a genuinely
 *     bimodal ~90° direction histogram).
 * v0.4.7: the ObjectPanel now exposes a compact "Floor plan options" control
 * (Walls Auto/Square/As-is → snap auto/strong/off, plus an Adaptive-height
 * toggle). Both callers spread this defaults object FIRST and then the panel's
 * live `objectPanel.floorPlanOptions()` selection, so user choices win while
 * the defaults still seed an export taken before any interaction. Because both
 * paths spread the same panel object, the report PDF's embedded plan and the
 * standalone sheet stay extracted with identical settings by construction.
 */
const FLOORPLAN_OPTIONS = {
  adaptiveBand: true,
} as const;

/** Densest available positions for floor-plan extraction (fallback: ctx). */
function floorPlanPositions(ctx: SpaceExportContext): Float32Array {
  try {
    const dense = viewer.gatherTerrainPositions(FLOORPLAN_GATHER_POINTS);
    if (dense && dense.positions.length > ctx.positions.length) return dense.positions;
  } catch {
    /* best-effort — the routing snapshot below is always valid */
  }
  return ctx.positions;
}

/** Download bytes as a file (Blob → anchor click). */
function downloadFileBytes(filename: string, bytes: Uint8Array, mime: string): void {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Object-scan panel — shown instead of terrain analysis for compact 3-D scans
// (phone scans of objects / rooms). "Run anyway" reveals + runs the terrain
// pipeline if the shape detector misjudged the scan.
const objectPanel = new ObjectPanel({
  onRunTerrainAnyway: () => {
    // "Run terrain contours anyway" is the explicit, equivalent twin of the
    // "Treat as: Terrain" override — route both through the same path so the
    // control, the panels, and the streaming pin stay in sync.
    setScanTypeOverride('terrain');
  },
  onScanTypeChange: (override) => setScanTypeOverride(override),
  // Build + download the one-page Space / Object report (lazy pdf-lib). For an
  // interior scan, the density-derived floor-plan sketch is embedded too. The
  // small dedicated provenance is built inside buildSpaceReportPdf from these
  // exact inputs, so the PDF can never disagree with the panel.
  onExportReport: async () => {
    const ctx = lastSpaceExport;
    if (!ctx) return;
    const { buildSpaceReportPdf } = await loadSpaceReportPdf();
    let floorPlan = null;
    if (ctx.spaceKind === 'interior') {
      const { extractFloorPlan } = await loadFloorPlan();
      // Fresh dense gather: the 60 k routing snapshot is too sparse for wall
      // tracing (see FLOORPLAN_GATHER_POINTS).
      floorPlan = extractFloorPlan(floorPlanPositions(ctx), {
        upAxis: ctx.upAxis,
        unitToMetres: ctx.unitToMetres,
        maxSamples: FLOORPLAN_GATHER_POINTS,
        ...FLOORPLAN_OPTIONS,
        // User-tunable wall-snapping + adaptive-band selections from the panel
        // (defaults mirror FLOORPLAN_OPTIONS); spread last so they win.
        ...objectPanel.floorPlanOptions(),
      });
    }
    const bytes = await buildSpaceReportPdf({
      space: ctx.space,
      object: ctx.object,
      name: ctx.basename,
      softwareVersion: __APP_VERSION__,
      metricVersion: TERRAIN_METRIC_VERSION,
      generatedAt: new Date(),
      unitToMetres: ctx.unitToMetres,
      floorPlan,
      // The embedded plan's dimension line follows the live measurement unit
      // system, exactly like the standalone SVG sheet below.
      unitSystem: viewer.measure.unitSystem,
    });
    downloadFileBytes(`${ctx.basename}-space-report.pdf`, bytes, 'application/pdf');
  },
  // Build + download the interior-only floor plan as a standalone SVG sheet.
  // v0.4.5: real wall-extraction pipeline (wall-band slice → density mask →
  // vectorised walls), labelled with its honest basis by the renderer itself.
  // Dimension / scale-bar units follow the live measurement unit system.
  onExportFloorPlan: async () => {
    const ctx = lastSpaceExport;
    if (!ctx || ctx.spaceKind !== 'interior') return;
    const { extractFloorPlan, floorPlanSvg } = await loadFloorPlan();
    // Fresh dense gather: the 60 k routing snapshot is too sparse for wall
    // tracing (see FLOORPLAN_GATHER_POINTS).
    const plan = extractFloorPlan(floorPlanPositions(ctx), {
      upAxis: ctx.upAxis,
      unitToMetres: ctx.unitToMetres,
      maxSamples: FLOORPLAN_GATHER_POINTS,
      ...FLOORPLAN_OPTIONS,
      // User-tunable wall-snapping + adaptive-band selections from the panel
      // (defaults mirror FLOORPLAN_OPTIONS); spread last so they win.
      ...objectPanel.floorPlanOptions(),
    });
    const svg = floorPlanSvg(plan, { title: ctx.basename, unitSystem: viewer.measure.unitSystem });
    downloadFileBytes(`${ctx.basename}-floorplan.svg`, new TextEncoder().encode(svg), 'image/svg+xml');
    // Surface a one-glance confidence read in the panel. Computed here, inside
    // the already-loaded lazy floor-plan chunk, so the panel needs only the
    // plain struct (no heavy floor-plan code in its bundle).
    const { floorPlanConfidence } = await import('./terrain/space/floorplan/floorPlanConfidence');
    objectPanel.showFloorPlanSummary(floorPlanConfidence(plan));
  },
});

// Terrain-analysis runner — extracted into `src/app/`. Constructed here, after
// `analysePanel`, so the panel/object-panel callbacks above (which fire only on
// user input) can drive it. Reads the lazy `viewer` and the `activeId`
// selection through getters so no top-level `viewer.*` dereference is added.
const terrainRunner = createTerrainAnalysisRunner({
  getViewer: () => viewer,
  analysePanel,
  getActiveId: () => activeId,
  crsService,
  // When a terrain analysis lands, adopt its DTM-confidence grid on the Viewer
  // so the 3D "Coverage" colour mode (and its colourblind-safe "Confidence"
  // twin) can tint the cloud by trust, and enable the (until-now disabled)
  // gated colour chips. The grid the colour modes sample is exactly the
  // per-cell confidence the dashed-contour evidence uses.
  onResult: (result) => {
    const d = result.dtm;
    viewer.setCoverageGrid({
      confidence: d.confidence,
      coverage: d.coverage,
      cols: d.cols,
      rows: d.rows,
      cellSizeM: d.cellSizeM,
      originH1: d.originH1,
      originH2: d.originH2,
    });
    inspector.setCoverageAvailable(true);
    // Fold the run's real analysed-point count into the Dataset Intelligence
    // card — the same `dtm.analyzedPointCount` the terrain report's
    // "Analysed points" row prints, so card and PDF agree. The streaming
    // attach-time summary necessarily wrote `analyzedPointCount: 0` (nothing
    // analysed yet); without this the Details row reads "Analyzed Points 0"
    // forever on streamed scans. The refresher only acts when the last
    // summary came from the streaming path, and the runner's stale-result
    // guard means this never fires for a closed/replaced scan.
    inspectorCards.noteAnalyzedPointCount(result.dtm.analyzedPointCount);
  },
});

// Per-cloud source files + reduced flags, so the Export panel can re-decode a
// local file at full resolution (the viewer keeps only the display-reduced
// cloud for large scans). Streamed/remote scans have no entry here.
const sourceFileById = new Map<string, File>();
const reducedById = new Map<string, boolean>();

// In-project "Export / Convert" panel — converts the open cloud to LAS / XYZ
// / ASC with the same CRS options as the splash batch converter. The engine
// (proj4) is imported lazily on Export, so this panel adds nothing heavy.
const exportPanel = new ExportPanel({
  getCloud: () => (activeId ? viewer.getCloud(activeId) ?? null : null),
  hasFullSource: () => activeId != null && sourceFileById.has(activeId),
  isReduced: () => activeId != null && reducedById.get(activeId) === true,
  getFullCloud: async () => {
    const f = activeId ? sourceFileById.get(activeId) : null;
    if (!f) return null;
    return decodeFull(await f.arrayBuffer(), f.name);
  },
});

/** True when the resolved CRS is a real-world frame (projected / geographic). */
function crsIsKnown(resolved: ReturnType<typeof crsService.current>): boolean {
  return resolved != null && (resolved.kind === 'projected' || resolved.kind === 'geographic');
}

// Drive the Export panel's Coordinate-System auto-collapse from the CRS service:
// an ungeoreferenced (local / unknown) scan has no real-world CRS to keep /
// assign / reproject, so the step collapses to a one-line note. A georeferenced
// scan behaves exactly as before. Fires on every resolve / override change, plus
// once here to seed the initial (no-scan ⇒ collapsed) state.
crsService.subscribe((resolved) => {
  exportPanel.setCrsKnown(crsIsKnown(resolved));
});
exportPanel.setCrsKnown(crsIsKnown(crsService.current()));

// ── Scan-type routing state ─────────────────────────────────────────────────
// `revealAnalysePanel` runs once at open, when a streaming cloud may have only
// a sparse coarse level resident — a misread is likely. `applyScanRoute` is
// re-run as the cloud fills in (debounced, growth-gated) and only flips panels
// when the verdict actually changes, so it never thrashes. Once the user forces
// a panel ("Run terrain anyway" / Analyse toggle) `scanRouteOverridden` pins it.
let lastScanVerdict: SpaceKind | null = null;
let scanRouteOverridden = false;
let lastRouteResident = 0;
let scanRouteTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-route only after the resident cloud grows by this factor (cheap gate). */
const SCAN_REROUTE_GROWTH = 1.4;

// ── Manual scan-type override ────────────────────────────────────────────────
// The safety net for a misdetection: the user can FORCE the route via the
// "Treat as" control in either panel. A non-auto choice WINS over the detected
// verdict and pins the routing like `scanRouteOverridden` so a streaming
// re-evaluation can't flip it. Per-session, reset to 'auto' on every new scan.
let scanTypeOverride: ScanTypeOverride = 'auto';
// One-shot guard: re-evaluate the scan type once the streaming cloud has fully
// settled ("Streaming ready"), so a verdict decided on a sparse early frame is
// corrected on representative geometry. Reset per scan.
let streamingSettledRouted = false;
// Settled-evaluation bookkeeping for the re-arming one-shot (v0.4.5b fix —
// a REFUSED settled verdict no longer spends the one-shot, so it can retry):
// attempts feed the SETTLE_RETRY_CAP, the resident count gates re-attempts on
// actual geometry change (an idle stream re-reads the same frame — pointless),
// and `lastSettleUndecided` lets a failed gather retry on the very next poll
// (its failure is not a property of the geometry). All reset per scan.
let settleAttempts = 0;
let lastSettleResident = -1;
let lastSettleUndecided = false;
// True once a SETTLED auto-mode verdict soft-committed the "Treat as" control
// to the detected pill (static-load detection or the streaming settle
// one-shot — `plan.commitDetected`). Display-only state: routing still follows
// `scanTypeOverride`/detection exactly as before, it never pins anything, and
// it resets on every new scan and on any user click (a manual pick shows that
// pick; clicking Auto returns to the uncommitted Auto presentation while
// detection re-runs).
let scanDetectionCommitted = false;

/**
 * Apply a manual "Treat as" choice and re-route immediately on the current
 * geometry. A non-auto override wins (see `resolveScanRoute`) and stays pinned
 * until the user picks 'auto' (restore detection) or a new scan resets it.
 */
function setScanTypeOverride(override: ScanTypeOverride): void {
  scanTypeOverride = override;
  // Any user click clears the settled soft-commit: a manual pick shows that
  // pick, and clicking Auto means "re-detect" — the control returns to the
  // uncommitted Auto presentation until the next settled verdict (if any).
  scanDetectionCommitted = false;
  // Force-apply over the current geometry — `initial=true` bypasses the
  // verdict-change + override no-op guards so the choice takes effect at once.
  applyScanRoute(true);
}

/**
 * The disabled-with-reason map for the "Treat as" control, derived from the
 * DETECTED verdict: when detection says interior / compact object, the
 * Terrain segment is greyed out (running contours there is misleading) and
 * the explicit "Run terrain contours anyway" hatch stays the override.
 */
function treatAsDisabledFor(
  detected: SpaceKind | null,
): { terrain: string } | undefined {
  return detected === 'interior' || detected === 'object'
    ? {
        terrain:
          (detected === 'interior'
            ? 'This scan reads as an interior'
            : 'This scan reads as a compact object') +
          ' — terrain analysis would be misleading. ' +
          "Use 'Run terrain contours anyway' to override.",
      }
    : undefined;
}

/**
 * Classify the currently-loaded/streamed geometry and route to the Object /
 * Space panel (non-terrain) or the Analyse panel (terrain). Passes the
 * resident classification so the vegetation tiebreaker can fire (a classified
 * forest stays terrain even though its geometry mimics an interior).
 *
 * `initial` = the open-time call (always applies + resets the override). A
 * non-initial call is a streaming re-evaluation: it no-ops unless the verdict
 * changed, and is skipped once the user has overridden the routing.
 *
 * `settled` = this evaluation runs on settled geometry (static load, or the
 * streaming settle one-shot). A settled auto-mode verdict soft-commits the
 * "Treat as" control to the detected pill (`plan.commitDetected`) — display
 * only, routing semantics unchanged.
 *
 * Returns whether a SETTLED call spent the streaming settle one-shot
 * (`settleOneShotSpent`): true once the settled verdict LANDED (the planner
 * applied it or the soft-commit fired) — or once no commit can ever come
 * (pinned / manual override) — false when the verdict was REFUSED by the
 * routing guards or the frame was undecidable, so the "Streaming ready" poll
 * keeps the one-shot armed and retries on fuller geometry (bounded by
 * SETTLE_RETRY_CAP). Non-settled callers ignore the value.
 */
function applyScanRoute(initial: boolean, settled = false): boolean {
  // A non-auto manual override pins the routing exactly like `scanRouteOverridden`:
  // a streaming re-evaluation must never flip a deliberate user choice. The
  // one-shot is spent: a pinned/manual session never soft-commits.
  if (!initial && (scanRouteOverridden || scanTypeOverride !== 'auto')) return true;
  let shape: ReturnType<typeof classifyScanShape> | null = null;
  let gathered: ReturnType<typeof viewer.gatherTerrainPositions> = null;
  try {
    gathered = viewer.gatherTerrainPositions(60_000);
    if (gathered) {
      // Pass classification when index-aligned so the veg tiebreaker can fire,
      // and the loader's vertical-axis hint so z-up-by-spec formats (LAS/LAZ/
      // COPC/EPT/…) never run the up-axis guess at all — detection stays
      // active only for genuinely ambiguous frames (PLY/OBJ/glTF). v0.4.5.
      shape = classifyScanShape(gathered.positions, {
        classification: gathered.classification,
        verticalAxis: gathered.verticalAxisHint,
      });
    }
  } catch {
    /* classification is best-effort — fall back to showing terrain analysis */
    shape = null;
  }
  if (debug && shape) {
    // `?debug` only: dump the raw scan-shape signals so a misroute can be
    // diagnosed against real numbers instead of guessed at.
    console.info(
      `[scan-type] ${initial ? 'open' : 're-route'} verdict=${shape.nonTerrain ? shape.spaceKind : 'terrain'} ` +
        `up=${shape.up} aspect=${shape.aspect.toFixed(2)} overhang=${Math.round(shape.overhangFraction * 100)}% ` +
        `wall=${Math.round(shape.wallCoverage * 100)}% floor=${Math.round(shape.floorCoverage * 100)}% ` +
        `ceil=${Math.round(shape.ceilingCoverage * 100)}% topVeg=${Math.round(shape.topVegFraction * 100)}% ` +
        `sampled=${gathered?.positions ? gathered.positions.length / 3 : 0} resident=${viewer.residentPointTotal()}`,
    );
  }
  // The DETECTED verdict, then the full routing decision from the pure planner
  // (`planScanRoute`): 'auto' defers to detection, any other choice wins; when
  // detection has nothing to say a NON-AUTO override still routes by itself.
  // The planner also encodes the v0.4.5 guarantees: a streaming re-evaluation
  // never flips the session TO terrain (it only rescues interiors/objects
  // misread on a sparse frame), and `runTerrain` is true ONLY for the explicit
  // hatch / manual Terrain override — auto-detection never starts an analysis.
  const detected: SpaceKind | null = shape ? (shape.nonTerrain ? shape.spaceKind : 'terrain') : null;
  const plan = planScanRoute({
    detected,
    override: scanTypeOverride,
    initial,
    lastVerdict: lastScanVerdict,
    pinned: scanRouteOverridden,
    settled,
  });
  // A settled verdict soft-commits the "Treat as" pill to the detected type
  // (sticky for the rest of the scan's display updates; cleared on a new scan
  // or any user click). Independent of `plan.apply`: the settle one-shot
  // usually CONFIRMS the standing verdict — a routing no-op — but the control
  // must still move off Auto onto the now-settled pill.
  if (plan.commitDetected !== null) scanDetectionCommitted = true;
  // The settled one-shot's spend decision (see the doc comment above): spent
  // only when the verdict actually LANDED (applied or committed) or when no
  // commit can ever come (pinned / manual). A REFUSED verdict (e.g. a
  // ceiling-heavy early frame reading terrain against a standing interior
  // route — the no-flip guard rejects it without a commit) and an undecidable
  // frame both leave the one-shot ARMED for a later ready poll, bounded by
  // SETTLE_RETRY_CAP via the attempt counter.
  if (settled) lastSettleUndecided = detected === null;
  const oneShotSpent = settleOneShotSpent({
    detected,
    override: scanTypeOverride,
    pinned: scanRouteOverridden,
    applied: plan.apply,
    committed: plan.commitDetected !== null,
    attempts: settleAttempts,
  });
  if (!plan.apply) {
    if (plan.commitDetected !== null) {
      const committedDisabled = treatAsDisabledFor(detected);
      objectPanel.setScanType(scanTypeOverride, plan.commitDetected, committedDisabled, true);
      analysePanel.setScanType(scanTypeOverride, plan.commitDetected, committedDisabled, true);
    }
    return oneShotSpent;
  }
  const effective = plan.effective;
  lastScanVerdict = effective;

  const isNonTerrain = plan.showObjectPanel;
  if (isNonTerrain && shape && gathered) {
    const activeCloud = activeId ? viewer.getCloud(activeId) : null;
    // RGB presence: a STREAMING COPC/EPT carries its colours in the streamed
    // nodes, not the static `activeCloud.colors`, so checking the static buffer
    // reports "No" for a PDRF 7/8 colour scan. Ask the streaming cloud's own
    // colour capabilities (the same source the COLOUR rail uses), and only fall
    // back to the static buffer for a non-streaming cloud.
    const streamingCloud = viewer.streamingCloud;
    const hasRgb = streamingCloud
      ? streamingCloud.availableColorModes().includes('rgb')
      : !!(activeCloud && activeCloud.colors && activeCloud.colors.length > 0);
    // Compute REAL metrics for the EFFECTIVE type — when forced, the report
    // reflects what's actually there for that interpretation; nothing fabricated.
    // Feed the active scan's linear-unit-to-metres factor so a foot-based CRS
    // (or any non-metre source units) reports honest metre/feet dimensions —
    // the same factor the terrain core uses (see deriveCoreParams). Unknown ⇒ 1
    // (assume metres) — an honest default, never a fabricated scale.
    const unitToMetres = crsService.current()?.linearUnitToMetres ?? 1;
    const space = spaceMetrics(gathered.positions, {
      upAxis: shape.up,
      spaceKind: effective === 'interior' ? 'interior' : 'object',
      unitToMetres,
      hasRgb,
      sourcePointCount: gathered.totalPoints,
      // A still-streaming cloud is measured on its resident subset only — lead
      // the caveats with the stronger "Preliminary — partial stream" note.
      residentOnly: gathered.residentOnly,
    });
    const spaceKind: 'interior' | 'object' = effective === 'interior' ? 'interior' : 'object';
    // Same stride honesty as spaceMetrics above: the gather caps at 60 k, so
    // the spacing probe must be corrected against the SCAN's resident count or
    // the reported resolution describes the subsample (√(N/P) too coarse).
    const object =
      spaceKind === 'object'
        ? objectMetrics(gathered.positions, { sourcePointCount: gathered.totalPoints })
        : null;
    if (spaceKind === 'interior') {
      objectPanel.showSpace(space, shape);
    } else {
      objectPanel.showObject(object, space, shape);
    }
    // Cache the EXACT inputs behind the on-screen report so the panel's export
    // buttons (Report PDF / Floor plan preview) build from the same positions + metrics +
    // unit factor — copied so a later streaming buffer reuse can't corrupt it.
    lastSpaceExport = {
      positions: Float32Array.from(gathered.positions),
      space,
      object,
      spaceKind,
      unitToMetres,
      upAxis: shape.up,
      basename: lastCloudName || 'scan',
    };
  } else if (isNonTerrain) {
    // The user forced a non-terrain route but the geometry gather / classifier
    // failed right now (e.g. mid-stream). Keep the Space/Object panel ALIVE
    // with its honest empty state — which still carries the "Treat as" control
    // and the run-anyway hatch — instead of tearing it down. Never a dead panel.
    lastSpaceExport = null;
    if (effective === 'interior') objectPanel.showSpace(null, null);
    else objectPanel.showObject(null, null, null);
  } else {
    lastSpaceExport = null;
  }
  objectPanel.setVisible(plan.showObjectPanel);
  analysePanel.setVisible(plan.showAnalysePanel);
  dock.setAnalyseEnabled(true);
  dock.setAnalyseActive(plan.showAnalysePanel);
  // When DETECTION says the scan is an interior / compact object, the Terrain
  // segment of the "Treat as" control is disabled with the reason — running
  // contours on a room or an object is misleading, and the explicit
  // "Run terrain contours anyway" hatch remains the deliberate override. The
  // control itself never locks out the CURRENT override, so a previously
  // forced terrain choice stays visible and escapable (Auto/Object/Interior
  // remain one click away).
  const treatAsDisabled = treatAsDisabledFor(detected);
  // Keep BOTH panels' "Treat as" controls reflecting the current state, so the
  // user can switch direction from whichever panel is showing. The committed
  // flag (settled-verdict soft commit) only ever shows under auto mode — a
  // manual override displays the override pill regardless.
  const committed = scanTypeOverride === 'auto' && scanDetectionCommitted;
  objectPanel.setScanType(scanTypeOverride, effective, treatAsDisabled, committed);
  analysePanel.setScanType(scanTypeOverride, effective, treatAsDisabled, committed);
  // Forcing terrain is the explicit "run anyway": surface the Analyse panel
  // AND kick the pipeline, matching the old escape hatch. The panel must also
  // EXPAND out of its collapsed-chip state — it is built collapsed, and routing
  // the user to a chip that hides the busy state, the result, and the way back
  // is exactly the dead-panel bug this guards against. `plan.runTerrain` is
  // true ONLY for the manual 'terrain' override — a detected-terrain route
  // shows the collapsed panel but NEVER starts the analysis by itself.
  if (plan.runTerrain) {
    analysePanel.expand();
    void terrainRunner.run();
  }
  return oneShotSpent;
}

/**
 * Reveal the Analyse + Export panels and seed the export basename. Called
 * from every load path — static files AND streaming COPC/EPT — so the terrain
 * and format tools surface regardless of how the scan was opened. v0.4.0.
 *
 * Auto-detects the scan shape: any NON-TERRAIN scan — a compact 3-D object OR
 * an interior space (a room / 360 / multi-room house) — gets the space/object
 * analysis instead of terrain contours, and terrain is demoted behind a "run
 * anyway" affordance. Routing is on `nonTerrain`, not just the legacy `kind`,
 * and re-evaluates as a streaming cloud fills in (see `applyScanRoute`).
 */
// Set once the mobile bottom-sheet is wired (full app only). Lets the scan
// lifecycle (reveal / reset) re-evaluate whether the phone sheet should show,
// without main.ts holding a direct reference to the sheet instance.
let syncMobileSheet: (() => void) | null = null;

function revealAnalysePanel(name: string, settled = true): void {
  lastCloudName = baseName(name);
  exportPanel.setVisible(true);
  exportPanel.refresh();
  // Fresh scan → clear any prior override + verdict so the open-time route is
  // authoritative and streaming re-routes can fire again. The manual "Treat as"
  // override is per-session-per-scan: a new scan returns to auto-detection,
  // and any settled soft-commit from the previous scan is forgotten.
  scanRouteOverridden = false;
  scanTypeOverride = 'auto';
  streamingSettledRouted = false;
  settleAttempts = 0;
  lastSettleResident = -1;
  lastSettleUndecided = false;
  scanDetectionCommitted = false;
  lastScanVerdict = null;
  lastRouteResident = viewer.residentPointTotal();
  // `settled` = the geometry is fully loaded at open time (every static path).
  // Streaming callers pass false: their open-time verdict runs on a sparse
  // coarse frame, so the "Treat as" commit waits for the settle one-shot.
  applyScanRoute(true, settled);
  // A scan is now loaded — let the phone sheet show (no-op on desktop).
  syncMobileSheet?.();
}

/**
 * Populate + reveal (or empty-state) the classification legend for the active
 * scan. Pass the cloud's per-point classification buffer when present, or
 * `undefined` when the cloud carries no classification channel. DISPLAY-ONLY:
 * the legend's fresh state is all-visible, so the GPU mask is applied as a
 * no-op identity mask to keep the unfiltered experience unchanged. v0.4.1.
 */
function refreshClassLegend(classification?: ArrayLike<number>): void {
  if (classification && classification.length > 0) {
    classLegendPanel.setClasses(countClasses(toClassBuffer(classification)));
  } else {
    classLegendPanel.setClasses(new Map());
  }
  // Apply the (all-visible) mask so a previously-filtered scan can't leak its
  // hidden classes onto the freshly loaded one. No-op for the common case.
  viewer.applyClassVisibility(classLegendPanel.getVisibility());
  classLegendPanel.show();
  // Reset the inspector's copy/JSON scope stamp — the fresh legend is
  // all-visible, so this clears any stamp left by a prior filtered scan.
  syncInspectClassScope();
}

/** Narrow an ArrayLike classification source to a typed buffer for counting. */
function toClassBuffer(src: ArrayLike<number>): Uint8Array {
  if (src instanceof Uint8Array) return src;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

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
  // Selecting the Profile kind is a terrain cross-section workflow — get the
  // Analyse panel out of the way and bring the Measurements panel forward so
  // the profile chart has room and the focus is unambiguous.
  viewer.measure.setOnKindChange((kind) => {
    if (kind === 'profile') {
      analysePanel.setVisible(false);
      dock.setAnalyseActive(false);
      measurePanel.setVisible(true);
    }
  });
  // Persist the unit choice whenever it changes.
  viewer.measure.setOnUnitChange(persistPrefs);
  viewer.annotate.setOnChange(refreshAnnotationPanel);

  // Provenance override — when the user picks a capture type from the
  // dropdown in the Inspector's Provenance section, rebuild the
  // fingerprint for that explicit type. The signals row records that
  // it's a user override so the surfacing stays honest.
  inspector.setOnProvenanceOverride((type: CaptureType) => {
    inspector.setProvenance(provenanceFor(type));
  });
  // CRS override picker — persists to localStorage via CrsOverrideStore,
  // re-resolves against the active scan, and refreshes the Inspector
  // so the new label + warning state appear immediately.
  inspector.setOnCrsOverride(crsCoordinator.handleCrsOverride);

  // Apply any preferences saved in a previous session, once the GPU backend
  // has initialised (so a saved EDL choice overrides the backend's default
  // gate). A `.catch` is paired with `.then` so a GPU-init rejection — the
  // Viewer's `.ready` now propagates one instead of silently leaving the
  // canvas blank — doesn't surface as an unhandled-promise warning. The
  // Viewer itself has already logged the failure via `console.error`.
  void viewer.ready.then(() => {
    viewerReady = true;
    // Backend chip is created with placeholder text "initialising…" — replace
    // it the moment the renderer settles so the empty-state UI doesn't show
    // the placeholder forever. Per-load callers still re-set this to handle
    // the (extremely rare) backend swap mid-session.
    try { dock.setBackend(viewer.activeBackend()); }
    catch (err) { if (debug) console.warn('[dock] setBackend post-ready threw', err); }
    // Degraded defaults for a weak device come first; a saved user
    // preference, applied immediately after, still wins.
    applyDeviceDefaults();
    applyPrefs();
    // If the browser advertised WebGPU but the renderer settled on the
    // WebGL 2 fallback, surface a one-shot console note so a user who
    // expected WebGPU performance can see why their FPS is lower. The
    // dock backend label already shows the active backend, but a quiet
    // diagnostic helps when someone reports a perf surprise. Logged
    // once per session, never sent anywhere.
    if (
      viewer.activeBackend() === 'webgl2' &&
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      navigator.gpu !== undefined &&
      navigator.gpu !== null
    ) {
      recordUsage('error', 'webgpu-fallback');
      console.info(
        'OpenLiDARViewer: WebGPU was available but the renderer is using the WebGL 2 ' +
          'fallback (typically a driver/feature-gap or a one-off adapter failure). ' +
          'Try reloading the tab if you expected WebGPU performance.',
      );
    }
    // Pre-warm the lazy load chunks once the GPU backend is ready.
    // First-file-drop is the most painful "did the app freeze?" moment;
    // this moves the ~200–500 ms chunk fetch + parse off the critical path
    // so a user who opens the app and immediately drops a file sees the
    // parser run instantly. Idle-callback so the prewarm doesn't compete
    // with the renderer's first frames; falls back to setTimeout on
    // browsers without rIC.
    schedulePrewarm();
  }).catch(() => {
    // The GPU init failure has already been logged by the Viewer's own
    // `.catch`. Swallow here so the browser's unhandled-rejection
    // listener doesn't fire — the canvas is already blank, and a
    // duplicate error in the console doesn't add information.
  });
});

const dropZone = new DropZone(document.body, (file) => void handleFile(file));
stage.overlay.append(dropZone.toast);

// v0.3.10 trust-pass — install the Playwright seam under `?test=1`.
// The flag is gated so production traffic NEVER sees the surface; the
// e2e suite explicitly opens `/?test=1` to enable it. The API
// exposes the minimum needed to drive a measurement programmatically
// (set kind → arm → place points → finish / clear), bypassing the
// canvas raycast that headless CI can't reliably pretend at. The
// `measure.spec.ts` `test.fixme` documented exactly this need.
if (testApi) {
  void viewerLoaded.then((v) => {
    const placePoint = (x: number, y: number, z: number): void => {
      if (![x, y, z].every((c) => typeof c === 'number' && Number.isFinite(c))) {
        throw new Error(
          'placeMeasurementPoint: { x, y, z } must all be finite numbers',
        );
      }
      v.measure.addPoint([x, y, z]);
    };
    (window as unknown as { __OLV_TEST_API__: unknown }).__OLV_TEST_API__ = {
      version: '1',
      setMeasureMode: (on: boolean) => v.setMeasureMode(on),
      setMeasureKind: (kind: string) => {
        // The MeasureController validates the kind itself; we just pass
        // through. Invalid kinds throw a clear error at the controller
        // level so the test sees a precise failure.
        v.measure.setKind(kind as Parameters<typeof v.measure.setKind>[0]);
      },
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => {
        placePoint(p.x, p.y, p.z);
      },
      finishMeasurement: () => v.measure.finishCurrent(),
      clearMeasurements: () => v.clearMeasurements(),
      getMeasurementCount: () => v.measure.getMeasurements().length,
    };
    // Diagnostic so a stray production page with the flag still shows
    // up in the console — discourages anyone from depending on it
    // outside the e2e suite.
    console.warn(
      'OpenLiDARViewer: ?test=1 enabled — window.__OLV_TEST_API__ ' +
        'is mounted. This is for Playwright only; do not ship URLs ' +
        'with this flag to end users.',
    );
  });
}

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

/**
 * Keep the left panel column clear of the measure toolbar (v0.4.5 overlap
 * fix). The toolbar (`.olv-measure-bar`) is centred at the same `top: 56px`
 * band the `.olv-left-panels` column anchors to, and activating Measure
 * auto-opens the Measurements panel into that column — so the panel used to
 * paint over the toolbar's left half, hiding the first kind pills. The
 * toolbar's height is dynamic (kind pills wrap at narrow widths, the
 * Finish-polygon button comes and goes, hint text reflows), so a static CSS
 * offset can't be right at every width. Instead a ResizeObserver mirrors
 * the toolbar's REAL height into the `--olv-measure-bar-clear` custom property
 * the column's `top` is computed from; `olv-hidden` is `display: none`, so
 * the observer fires with a zero box when the toolbar hides and the column
 * snaps back up. No-ops (keeping the static layout) where ResizeObserver
 * is unavailable.
 */
function wireMeasureBarClearance(bar: HTMLElement, column: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  try {
    const ro = new ResizeObserver(() => {
      const h = bar.offsetHeight; // 0 while .olv-hidden (display: none)
      // 8px = the column's own --space-md gap, so toolbar → first panel
      // reads with the same rhythm as panel → panel.
      column.style.setProperty('--olv-measure-bar-clear', h > 0 ? `${h + 8}px` : '0px');
    });
    ro.observe(bar);
  } catch {
    /* Static layout fallback — only ancient engines, overlap is cosmetic. */
  }
}

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
    leftPanels.append(measurePanel.element, annotationPanel.element, objectPanel.element, classLegendPanel.element, analysePanel.element, exportPanel.element);
    stage.overlay.append(leftPanels);
    // Push the column below the measure toolbar whenever it is visible —
    // see wireMeasureBarClearance for why this is measured, not static CSS.
    wireMeasureBarClearance(viewer.measureElements.hint, leftPanels);
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
    // On phones it is superseded by the unified bottom sheet below (CSS hides
    // it under that breakpoint); on desktop it is unused (the Inspector is a
    // normal panel there). Kept appended so the desktop/no-sheet path is intact.
    stage.overlay.append(inspector.sheetToggle);

    // ── Phone bottom-sheet (design audit 1.3 follow-up) ───────────────────
    // Below the mobile breakpoint the floating panels don't fit side-by-side,
    // so one bottom sheet hosts them behind a View · Analyse · Layers tablist.
    // The sheet owns only the chrome; here we RE-PARENT the existing panel
    // elements into its slots on mobile and restore them to their desktop homes
    // on a wider viewport. Re-parenting a live node keeps its listeners, so no
    // panel is re-wired on a breakpoint flip. Desktop layout is untouched.
    const mobileSheet = new MobileSheet();
    stage.overlay.append(mobileSheet.element);

    const toMobileLayout = (): void => {
      mobileSheet.slot('view').append(inspector.element);
      mobileSheet.slot('analyse').append(analysePanel.element, objectPanel.element);
      mobileSheet
        .slot('layers')
        .append(
          classLegendPanel.element,
          measurePanel.element,
          annotationPanel.element,
          exportPanel.element,
        );
      // The now-empty left column would still capture touches over its band —
      // hide it. The Inspector's standalone "Scan Info" launcher is superseded.
      leftPanels.classList.add('olv-hidden');
      inspector.sheetToggle.classList.add('olv-hidden');
    };
    const toDesktopLayout = (): void => {
      leftPanels.classList.remove('olv-hidden');
      inspector.sheetToggle.classList.remove('olv-hidden');
      // Inspector returns to the overlay in its original slot (just before the
      // streaming panel); the left column is rebuilt in its original order.
      stage.overlay.insertBefore(inspector.element, streamingPanel.element);
      leftPanels.append(
        measurePanel.element,
        annotationPanel.element,
        objectPanel.element,
        classLegendPanel.element,
        analysePanel.element,
        exportPanel.element,
      );
    };

    const mobileMql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 767px)')
        : null;
    let mobileApplied = false;
    const applyMobileSheet = (): void => {
      const isMobile = mobileMql ? mobileMql.matches : false;
      if (isMobile !== mobileApplied) {
        if (isMobile) toMobileLayout();
        else toDesktopLayout();
        mobileApplied = isMobile;
      }
      // The sheet only shows on a phone WITH a scan loaded; otherwise the empty
      // slots would float a chrome bar over the empty state.
      mobileSheet.setVisible(isMobile && hasScan());
    };
    // Expose to the scan lifecycle so reveal / reset re-evaluate visibility.
    syncMobileSheet = applyMobileSheet;
    mobileMql?.addEventListener('change', applyMobileSheet);
    applyMobileSheet();

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
      // Same toolbar-overlap guard as the full app — the embed's
      // ?measurements=1 path shows the same centred toolbar over the
      // same left column.
      if (embedConfig.forceMeasurements) {
        wireMeasureBarClearance(viewer.measureElements.hint, leftPanels);
      }
    }
  }
});

// the cross-frame control bridge is now lazy-loaded.
// `?embed=1` is a minority of traffic; non-embed loads should not pay
// the ~5 KB embed-bridge cost.
async function startEmbedBridgeLazy(): Promise<typeof import('./ui/embedBridge').startEmbedBridge> {
  const m = await loadEmbedBridge();
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
      terrainCompute: readTerrainComputePath(),
    }));
    stage.overlay.append(debugOverlay.element);
    debugOverlay.start();
  });
}

/**
 * Read the MAIN-thread terrain engine's CPU/GPU equivalence-gate verdict for
 * the debug overlay, via the verification-only `window` hook the engine
 * registers when it loads. Returns null before any main-thread terrain run (or
 * when analysis ran in the worker, whose engine is not reachable from here).
 * Reads through the hook deliberately — a static import would pull the terrain
 * engine into the main bundle and break chunk isolation.
 */
function readTerrainComputePath(): { path: 'cpu' | 'gpu'; reason: string } | null {
  const hook = (
    window as unknown as {
      __olvTerrainRasterEngine?: { getComputePath?: () => { path: 'cpu' | 'gpu'; reason: string } };
    }
  ).__olvTerrainRasterEngine;
  try {
    const s = hook?.getComputePath?.();
    return s ? { path: s.path, reason: s.reason } : null;
  } catch {
    return null;
  }
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

/**
 * Run every registered validation module and flatten the rows. The optional
 * `scope` is threaded into each module so class-dependent figures honour the
 * visible-class subset; when omitted (or full) the output is byte-identical to
 * the unscoped path.
 */
function runModules(cloud: PointCloud, scope?: ClassScope): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  const options = scope ? { scope } : undefined;
  for (const module of registry.list()) rows.push(...module.run(cloud, undefined, options).rows);
  return rows;
}

/**
 * Derive the class scope for the active static cloud from the legend's
 * visibility and the classes actually present in the cloud. Returns `fullScope`
 * when there's no classification channel or nothing is filtered — so the
 * report renders exactly as it did before class scoping existed.
 */
function currentClassScope(cloud: PointCloud): ClassScope {
  const cls = cloud.classification;
  if (!cls || cls.length === 0 || !classLegendPanel.hasClasses()) return fullScope();
  const visibility = classLegendPanel.getVisibility();
  if (!visibility.isFiltered()) return fullScope();
  const present = [...countClasses(cls).keys()];
  return scopeFrom(visibility.visibleCodes(), present, classificationLabel);
}

/**
 * Derive the active class scope from the legend alone — works for both static
 * and streaming scans because it reads the legend's present-class roster
 * rather than a resident classification array (a streaming scan has none).
 * Returns `fullScope` when no classification channel exists or nothing is
 * filtered, so every export / copy path that consumes this stays
 * byte-identical to the pre-feature output when no class is hidden.
 */
function currentClassScopeFromLegend(): ClassScope {
  if (!classLegendPanel.hasClasses()) return fullScope();
  const visibility = classLegendPanel.getVisibility();
  if (!visibility.isFiltered()) return fullScope();
  const present = classLegendPanel.presentCodes();
  if (present.length === 0) return fullScope();
  return scopeFrom(visibility.visibleCodes(), present, classificationLabel);
}

/**
 * The current class-scope stamp string — `''` when the view is full /
 * unfiltered. Fed to the point-inspector (copy + JSON) and the export
 * surfaces so a copied / exported artifact made while filtering is
 * self-describing.
 */
function currentClassScopeStamp(): string {
  return scopeStamp(currentClassScopeFromLegend(), classificationLabel);
}

/**
 * Push the current class-scope stamp into the point-inspector. Called after
 * every legend change and on scan load / close so a point copied while a
 * filter is active carries the filter it was taken under (and an unfiltered
 * copy stays byte-identical to before).
 */
function syncInspectClassScope(): void {
  viewer.setInspectClassScopeStamp(currentClassScopeStamp());
}

/**
 * Synthesize a scan-report row set for a streaming cloud.
 *
 * The static `runModules()` path expects a fully-resident `PointCloud`
 * (Float32Array positions, classification arrays, etc.). For a streaming
 * COPC or EPT we only ever hold a thin resident shell, so the static
 * modules can't run as-is. We instead pull the equivalent facts directly
 * from the streaming source's header + COPC info / EPT schema, which
 * carry everything the report needs: total point count, source-declared
 * bounds, spacing, octree depth, and the LAS VLR sensor / software
 * strings the provenance classifier already feeds from.
 *
 * The output is intentionally the same `AnalysisRow` shape the static
 * report uses, so the Inspector's Scan-report section renders uniformly
 * and the PDF Report Engine can consume it without a separate code path.
 */
function runStreamingModules(cloud: {
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
  readonly maxDepth?: () => number;
  readonly octree?: { nodes: () => readonly unknown[] };
}, classFilterActive = false): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  const info = (label: string, value: string): AnalysisRow =>
    ({ label, value, status: 'info' });
  // Streaming density/spacing are derived from the file header's full-cloud
  // totals — there is no client-side per-class breakdown to scope them to. So
  // they stay full-cloud and, when a class filter is active, carry the honesty
  // sentinel that renders "full cloud (header) — not class-scoped" rather than
  // pretending the figure honours the filter.
  const headerMetric = (label: string, value: string): AnalysisRow => {
    const row = info(label, value);
    if (classFilterActive) row.scope = notScopedSentinel();
    return row;
  };

  rows.push(info('Source', cloud.kind === 'ept' ? 'EPT (Entwine Point Tile)' : 'COPC (Cloud Optimized Point Cloud)'));
  if (cloud.metadata?.header?.pointDataRecordFormat !== undefined) {
    rows.push(info('Point format', `PDRF ${cloud.metadata.header.pointDataRecordFormat}`));
  }
  rows.push(headerMetric('Source point count', cloud.sourcePointCount.toLocaleString('en-US')));

  // Bounds — prefer the header's source-coordinate min/max for accuracy.
  const header = cloud.metadata?.header;
  if (header) {
    const w = header.max[0] - header.min[0];
    const d = header.max[1] - header.min[1];
    const h = header.max[2] - header.min[2];
    rows.push(info('Width', `${w.toFixed(1)} m`));
    rows.push(info('Depth', `${d.toFixed(1)} m`));
    rows.push(info('Height', `${h.toFixed(1)} m`));
    const footprintArea = w * d;
    if (footprintArea > 0 && cloud.sourcePointCount > 0) {
      const density = cloud.sourcePointCount / footprintArea;
      rows.push(headerMetric('Density', `${density.toFixed(1)} pts/m²`));
      rows.push(headerMetric('Spacing', `${Math.sqrt(footprintArea / cloud.sourcePointCount).toFixed(2)} m`));
    }
  }

  // Streaming-specific: octree structure.
  if (cloud.metadata?.info?.spacing !== undefined) {
    rows.push(info('Octree root spacing', `${cloud.metadata.info.spacing.toFixed(2)} m`));
  }
  if (cloud.maxDepth) {
    try { rows.push(info('Octree depth', String(cloud.maxDepth()))); }
    catch { /* defensive — depth not always computable mid-load */ }
  }
  if (cloud.octree) {
    try { rows.push(info('Octree nodes', cloud.octree.nodes().length.toLocaleString('en-US'))); }
    catch { /* defensive */ }
  }

  // Provenance metadata mirrored from the LAS VLRs the COPC header
  // carries — same fields the static report shows.
  if (cloud.metadata?.captureSensor) {
    rows.push(info('Capture Sensor', cloud.metadata.captureSensor));
  }
  if (cloud.metadata?.sourceSoftware) {
    rows.push(info('Source Software', cloud.metadata.sourceSoftware));
  }

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
/**
 * Immediate pre-warm for a known-imminent open. Triggered when the
 * curated-dataset dropdown changes — the user has signalled intent,
 * we have think-time before the explicit Open click, so fire every
 * chunk that the streaming path will need behind the user's
 * decision-making instead of waiting for the click. URL-pattern
 * dispatch keeps the EPT-only and COPC-only chunks separated;
 * the chunks are idempotent, so re-firing on click is free.
 */
function prewarmForUrl(url: string): void {
  // Force the idle-time pre-warm to fire immediately rather than
  // waiting on requestIdleCallback. Cold-start tabs may not yet
  // have produced an idle window when the picker is opened.
  if (!_loadersPrewarmed) {
    _loadersPrewarmed = true;
    void loadStreamingPointCloud().catch(() => { _loadersPrewarmed = false; });
    void loadCopcWorkerClient()
      .then(({ CopcWorkerClient }) => {
        if (!copcDecoder) copcDecoder = new CopcWorkerClient();
      })
      .catch(() => { /* swallow — actual COPC open retries */ });
  }
  // EPT path lazy-imports a separate chunk; pull it in too if the
  // URL looks like an `ept.json` manifest.
  const isEpt = /(?:^|\/)ept\.json(?:\?|#|$)/i.test(url);
  if (isEpt) {
    void loadEpt().catch(() => { /* swallow — open() retries */ });
  }
}

/**
 * Best-effort "is the user on a metered / data-saving connection?" check.
 * Returns false when the Network Information API is unavailable (Safari /
 * Firefox) so capable connections still benefit. Used to gate the heavy
 * Viewer (three.js) idle pre-warm off cellular budgets.
 */
function _isDataSaver(): boolean {
  try {
    const conn = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (!conn) return false;
    if (conn.saveData) return true;
    const et = conn.effectiveType;
    return et === 'slow-2g' || et === '2g' || et === '3g';
  } catch {
    return false;
  }
}

let _loadersPrewarmed = false;
function schedulePrewarm(): void {
  if (_loadersPrewarmed) return;
  const fire = (): void => {
    if (_loadersPrewarmed) return;
    _loadersPrewarmed = true;
    void loadStreamingPointCloud().catch(() => { _loadersPrewarmed = false; });
    // Instantiate the COPC decode worker singleton during idle time.
    // The constructor spawns a Web Worker and waits for its WASM
    // (`laz-perf`) module to initialise — about 150-250 ms on a warm
    // network and ~400 ms on a cold one. Doing it here moves the cost
    // off the first scan-open's critical path so the toast-to-first-
    // node time is dominated by the actual range fetch, not by worker
    // boot. Subsequent opens already hit the cached singleton; this
    // change benefits only the cold-start path, which is the most
    // painful one to debug or demo against.
    void loadCopcWorkerClient()
      .then(({ CopcWorkerClient }) => {
        if (!copcDecoder) copcDecoder = new CopcWorkerClient();
      })
      .catch(() => { /* swallow — actual COPC open retries */ });
    // Static LAS/LAZ loader sits in its own chunk too — pre-warm it for
    // the "drop a non-COPC LAZ file" path which is the other common case.
    void loadLasLoader().catch(() => { /* swallow */ });
    // The Viewer chunk pulls in three.js / WebGPU (~800 KB) — the single
    // biggest first-open cost. Warm it during idle too so the first scan
    // opens without that download on the critical path. Gated on data
    // charge: skip it under Save-Data or a 2G/3G connection so we never
    // spend a phone's cellular budget on a scan the user hasn't opened yet.
    if (!_isDataSaver()) {
      void loadViewer().catch(() => { /* swallow — open() retries */ });
    }
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
    // Streaming-preview accounting — how much of the cloud is resident at
    // export time. Surfaced as a "Loaded" row so the PDF discloses that a
    // mid-stream report describes the full cloud but inspected only the
    // resident subset. counts().known is the total known node count.
    const nodeCounts = streamingCloud.counts();
    metadata = {
      fileName: streamingCloud.name,
      format: streamingCloud.kind === 'ept' ? 'EPT' : 'COPC',
      sourcePointCount: streamingCloud.sourcePointCount,
      width: w, depth: d, height: h, density,
      hasRgb: modes.includes('rgb'),
      hasIntensity: modes.includes('intensity'),
      hasClassification: modes.includes('classification'),
      streamingResident: {
        points: streamingCloud.residentPointCount,
        nodes: nodeCounts.resident,
        totalNodes: nodeCounts.known,
      },
      ...(crs ? { crsName: crs.name, crsUnit: crs.linearUnit } : {}),
      // Class-filter honesty — when a filter narrows the live view, disclose
      // it so the PDF's full-cloud figures aren't read as filter-scoped.
      ...(currentClassScopeStamp() ? { classScopeNote: currentClassScopeStamp() } : {}),
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
      // Class-filter honesty — when a filter narrows the live view, disclose
      // it so the PDF's full-cloud figures aren't read as filter-scoped.
      ...(currentClassScopeStamp() ? { classScopeNote: currentClassScopeStamp() } : {}),
    };
    exportFileStem = baseName(staticCloud.name);
  } else {
    throw new Error('Load a scan first.');
  }

  // Derive the cover title from the actual template so each of the six
  // templates produces a distinct, recognisable PDF. The user-reported
  // bug — "all reports show the same export" — was driven by a hardcoded
  // `title: 'Scan Report'` that made the cover identical across every
  // template choice. Pulling `label` off `getReportTemplate(templateId)`
  // gives "Engineering Inspection", "QA Validation", "Survey Summary",
  // "Terrain Review", "Technical Documentation", or "Scan Acceptance"
  // as appropriate. The dataset name moves into the subtitle so both
  // axes (template type, source scan) are surfaced on the cover.
  const validatedTemplateId = templateId as import('./report').ReportTemplateId;
  const template = report.getReportTemplate(validatedTemplateId);
  const coverTitle = template?.label ?? 'Scan Report';
  // Compute the same provenance fingerprint the Inspector's Provenance
  // section already shows, and feed it to the report. Templates that
  // include the `provenance` section get a real capture-type +
  // confidence + cited accuracy bounds — auto-computed, varies per
  // scan, gives every export per-template differentiation without
  // requiring the user to take measurements or annotate first.
  //
  // Wrapped because a malformed cloud shape shouldn't sink the whole
  // PDF — the section gracefully renders "No provenance fingerprint
  // available" when the fingerprint is undefined.
  let provenanceFp: import('./report').ReportProvenanceFingerprint | undefined;
  try {
    const activeCloud = activeId ? viewer.getCloud(activeId) : null;
    const streamingCloud = viewer.streamingCloud;
    if (activeCloud) {
      const f = classifyProvenance(signalsForStaticCloud(activeCloud as never));
      provenanceFp = {
        label: f.label,
        confidence: f.confidence,
        signals: f.signals,
        bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
        disclaimer: f.disclaimer,
      };
    } else if (streamingCloud) {
      const f = classifyProvenance(signalsForStreamingCloud(streamingCloud as never));
      provenanceFp = {
        label: f.label,
        confidence: f.confidence,
        signals: f.signals,
        bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
        disclaimer: f.disclaimer,
      };
    }
  } catch (err) {
    if (debug) console.warn('[report] classifyProvenance threw', err);
  }
  const inputs = report.composeReportInputs({
    templateId: validatedTemplateId,
    title: coverTitle,
    subtitle: metadata.fileName,
    metadata,
    visuals: [],          // user-pre-rendered Studio exports
    annotations: viewer.annotate.getAnnotations(),
    measurements: viewer.measure.getMeasurements(),
    unitSystem: viewer.measure.unitSystem,
    // Render-units → metres, the SAME factor the live measure readouts apply
    // (B2, v0.4.5) — so the report PDF's measurement values agree with the
    // panel to the digit on foot-based CRSs.
    unitToMetres: viewer.measure.unitToMetres,
    provenance: provenanceFp,
  });

  const result = await report.generateReport(inputs);
  // The download filename now mirrors the template choice so the
  // user's Downloads folder distinguishes a Survey Summary from an
  // Engineering Inspection at a glance.
  downloadBlob(`${exportFileStem}-${validatedTemplateId}.pdf`, result.blob);
  // Per-section render failures are caught by the engine's isolation pass
  // and surfaced as a `failedSections` list — the PDF still ships but
  // misses those sections. Tell the user so they're not surprised by a
  // partial deliverable, and record it for local diagnostics so the
  // partial-PDF mode is visible in the session-stats panel.
  if (result.failedSections.length > 0) {
    recordUsage('error', 'report:partial');
    const list = result.failedSections.join(', ');
    dropZone.setError(
      `Report rendered without these sections: ${list}. ` +
        'Check for unusual characters in the affected inputs and try again.',
    );
  }
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

/**
 * Push the Viewer's current render-quality state into the Inspector chips.
 * Used by callbacks that change a single chip's state but want every chip
 * — including the touch-model chip's active class — to re-sync.
 */
/**
 * Re-sync the colour-mode chip rail to whatever the active cloud is
 * actually rendering as. Called after Visuals Studio RGB ops because
 * `Viewer._ensureRgbColorMode` may have flipped the cloud into RGB
 * mode silently; without this re-sync the Inspector chip would lag
 * behind the renderer.
 */
function syncColorModeForActive(): void {
  if (!activeId) return;
  const cloud = viewer.getCloud(activeId);
  if (!cloud) return;
  const mode = viewer.colorModeOf(activeId);
  if (!mode) return;
  if (mode !== currentColorMode) currentColorMode = mode;
  inspector.setColorModes(availableModes(cloud), currentColorMode);
}

function syncInspectorRendering(): void {
  inspector.syncRendering({
    pointSize: viewer.pointSize,
    edlEnabled: viewer.edlEnabled,
    edlStrength: viewer.edlStrength,
    pointSizeMode: viewer.pointSizeMode,
    antialiasing: viewer.antialiasing,
    twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
    splatMode: viewer.splatMode,
  });
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
    touchModel: viewer.twoFingerTwistEnabled ? 'standard' : 'advanced',
    colorblindSafeClasses: colorblindSafeClasses(),
    workflow: workflowController.config,
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
  if (p.touchModel !== undefined) {
    viewer.setTwoFingerTwistEnabled(p.touchModel === 'standard');
  }
  if (p.colorblindSafeClasses !== undefined) {
    classLegendPanel.setColorblindSafe(p.colorblindSafeClasses);
    document.body.classList.toggle('olv-cvd', p.colorblindSafeClasses);
  }
  if (p.workflow !== undefined) {
    workflowController.setConfig(p.workflow);
    workflowConfigPanel.setConfig(p.workflow);
  }
}

// Provenance + Dataset Intelligence load-time card refreshers live in
// `src/app/inspectorCardRefreshers.ts` (wired as `inspectorCards`). CRS
// resolution + per-scan refresh + override handling live in
// `src/app/crsCoordinator.ts` (wired as `crsCoordinator`). Both are extracted
// from main.ts unchanged; CRS state is owned by `crsService` (declared near the
// imports) with the coordinator holding only the per-scan override-store key.

/** High-water mark for measurement count — used to detect new placements. */
let _lastMeasurementCount = 0;
/** Refresh the Measurements panel's contents and visibility. */
function refreshMeasurePanel(): void {
  measurePanel.update(viewer.measure.getSummaries());
  const measurements = viewer.measure.getMeasurements();
  const hasMeasurements = measurements.length > 0;
  measurePanel.setVisible(viewer.measureMode || hasMeasurements);
  // Local-first counter — fires only when a new measurement is placed.
  // Categorical (the kind) only; never the coordinates, never the name.
  if (measurements.length > _lastMeasurementCount) {
    const newest = measurements[measurements.length - 1];
    if (newest) recordUsage('measurement', newest.kind);
  }
  _lastMeasurementCount = measurements.length;
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
        twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
    splatMode: viewer.splatMode,
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
  if (loading) {
    showLassoToast('Already loading — cancel the current load first.');
    return;
  }
  // Claim the flag SYNCHRONOUSLY — the `await viewerLoaded` below yields to
  // the event loop, and a second drop in that window used to pass the
  // `loading` guard too (TOCTOU). The `finally` below is the only reset.
  loading = true;
  const controller = new AbortController();
  dropZone.setProgress(`Reading ${file.name}…`);
  dropZone.setCancelHandler(() => controller.abort());
  try {
    // ensure the lazy-loaded Viewer is ready before touching it.
    await viewerLoaded;
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

    // The load succeeded — now free the previously-open scan (GPU buffers +
    // retained file refs) BEFORE uploading the new one, so reopening scan after
    // scan doesn't leak the old cloud's GPU memory. Done here (post-load) so a
    // failed/cancelled load above never tears down the scan on screen.
    clearOpenStaticLayers();

    dropZone.setProgress(formatProgress({ stage: 'uploading' }));
    stage.hideEmptyState();
    const uploadStartedAt = performance.now();
    const id = viewer.addCloud(result.cloud);
    const gpuUploadMs = performance.now() - uploadStartedAt;
    activeId = id;
    // A freshly opened scan has no terrain analysis yet — drop any prior grid so
    // the Coverage colour chip starts disabled until this scan is analysed.
    viewer.setCoverageGrid(null);
    inspector.setCoverageAvailable(false);
    // Retain the source file + whether the display cloud was reduced, so the
    // Export panel can offer a full-resolution re-decode.
    sourceFileById.set(id, file);
    reducedById.set(id, result.downsampled);
    // Local-first counter — categorical source format only; never the file name.
    try { recordUsage('scan-open', result.cloud.sourceFormat); }
    catch (err) { if (debug) console.warn('[usage] recordUsage threw', err); }
    // Provenance fingerprint — pure metadata classification, surfaced in
    // the Inspector's "Provenance" section. Wrapped because a malformed
    // input shape would have aborted the rest of the post-load setup
    // (including the navBar reveal further down).
    try { inspectorCards.refreshProvenance(result.cloud); }
    catch (err) { if (debug) console.warn('[provenance] refreshProvenance threw', err); }
    // CRS — detected from the loaded cloud's metadata, merged with any
    // persisted user override. Wrapped because a malformed cloud
    // shape shouldn't break the rest of the load.
    try { crsCoordinator.refreshCrsForStaticCloud(result.cloud); }
    catch (err) { if (debug) console.warn('[crs] refreshCrsForStaticCloud threw', err); }

    dropZone.setProgress(formatProgress({ stage: 'rendering' }));
    const renderStartedAt = performance.now();
    // A freshly opened scan starts in the orbit overview, then glides in.
    viewer.setMode('orbit');
    viewer.frameAll();
    const firstRenderMs = performance.now() - renderStartedAt;

    const mode = defaultMode(result.cloud);
    currentColorMode = mode;
    viewer.setColorMode(id, mode);

    // ── CRITICAL UI REVEAL — runs BEFORE any inspector / module setup ────
    // The dock backend indicator + NavBar (Orbit/Walk/Fly mode switcher
    // + speed slider) must reveal even if a downstream inspector call
    // throws. Without this ordering, a failure in `runModules` or
    // `inspector.setReport` left the user with a rendered scan they
    // couldn't navigate around, and the backend indicator stuck at
    // "initialising…". Critical reveal first, decorations second.
    dock.setBackend(viewer.activeBackend());
    // v0.3.6 design-audit fix: reveal the dock at attach. It stays hidden
    // through the empty state so eight dimmed tools don't clutter the
    // primary CTA on mobile.
    dock.setEmpty(false);
    inspector.setEmpty(false);
    dock.setMeasureEnabled(true);
    dock.setInspectEnabled(true);
    dock.setProbeEnabled(true);
    dock.setAnnotateEnabled(true);
    dock.setCloseEnabled(true);
    navBar.element.classList.remove('olv-hidden');
    navBar.setMode('orbit');
    navBar.flashHelp();
    document.body.classList.add('olv-has-scan');
    if (isPhone()) navBar.flashTouchHint();

    // A new scan resets the saved viewpoints and annotations.
    savedViews = [];
    viewCounter = 0;
    viewer.annotate.clear();
    refreshAnnotationPanel();

    // ── Inspector setup — wrapped in defensive try/catches so a single
    //    failing analysis module or inspector call can't abort the rest.
    //    Each isolated block restores its own slice; the navigation
    //    above remains usable even if every block below fails.
    try {
      inspector.addCloud(id, result.cloud.name, result.cloud.pointCount);
      inspector.setColorModes(availableModes(result.cloud), mode);
      inspector.setDetail(result.cloud.pointCount, result.originalPointCount);
      inspectorCards.refreshDatasetIntelligenceFromStaticCloud(
        result.cloud as { pointCount: number; bounds(): { min: [number, number, number]; max: [number, number, number] } },
      );
    } catch (err) {
      if (debug) console.warn('[inspector] cloud + details setup threw', err);
    }
    try {
      inspector.setReport(runModules(result.cloud, currentClassScope(result.cloud)));
    } catch (err) {
      if (debug) console.warn('[inspector] runModules + setReport threw', err);
    }
    try {
      inspector.setViews([]);
    } catch (err) {
      if (debug) console.warn('[inspector] setViews threw', err);
    }
    // Visual Export Studio — a scan is now loaded; turn on the image-
    // export buttons so the user can capture it. Pre-warm the lazy Studio
    // chunk in the background so the first export click feels instant
    // instead of waiting on the ~7 KB gzip fetch + parse. Pure fire-and-
    // forget; we don't await the result.
    try {
      inspector.setImageExportEnabled(true);
      // Per-mode gating — disable buttons whose mode the loaded cloud can't
      // satisfy (Normal map on a LAZ, etc.) so the user sees the constraint
      // before clicking rather than as a post-click error toast.
      inspector.setImageExportAvailability(viewer.availableImageExportModes());
    } catch (err) {
      if (debug) console.warn('[inspector] setImageExportEnabled threw', err);
    }
    void prewarmExportStudio();

    // A share link, if one opened this page, restores its view onto this scan.
    if (pendingShareState) {
      try {
        applyShareState(pendingShareState, result.cloud);
      } catch (err) {
        if (debug) console.warn('[share] applyShareState threw', err);
      }
      pendingShareState = null;
    }

    // The render-quality controls reflect the viewer's state — EDL defaults
    // depend on the GPU backend, known only once `viewer.ready` resolved.
    try {
      inspector.syncRendering({
        pointSize: viewer.pointSize,
        edlEnabled: viewer.edlEnabled,
        edlStrength: viewer.edlStrength,
        pointSizeMode: viewer.pointSizeMode,
        antialiasing: viewer.antialiasing,
        twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
    splatMode: viewer.splatMode,
      });
    } catch (err) {
      if (debug) console.warn('[inspector] syncRendering threw', err);
    }

    if (!bareMode) showProjectCard(result.cloud, result.originalPointCount);

    // Reveal the Analyse panel now there's a scan to analyse. v0.4.0.
    revealAnalysePanel(result.cloud.name);

    // Classification legend (v0.4.1) — populate from the cloud's per-point
    // class buffer when present, then show. A scan with no classification
    // channel renders the panel's empty state. DISPLAY-ONLY; the all-visible
    // default mask is applied so nothing is hidden on load.
    try {
      refreshClassLegend(result.cloud.classification);
    } catch (err) {
      if (debug) console.warn('[class-legend] refresh threw', err);
    }

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
  // Race the lazy COPC + streaming chunks against `viewer.ready` so a
  // user who opens a scan during the first ~half-second of page load
  // (a common demo path) doesn't see chunk-fetch and GPU init run
  // serially. By the time `viewer.ready` resolves the chunks are
  // usually cached too — `await chunksPromise` below typically
  // resolves immediately. On a cold start, the parallelism saves
  // roughly the smaller of the two latencies (often 100-300 ms).
  const chunksPromise = Promise.all([
    loadStreamingPointCloud(),
    loadCopcWorkerClient(),
    loadStreamingColors(),
  ]);

  // Show the streaming panel as soon as we know we're on the COPC branch —
  // before `await viewer.ready`, which on cold WebGPU runners can sit for
  // 10–18 s compiling shaders. The panel reads "Loading metadata…" while
  // the viewer warms up, so the user gets immediate confirmation that the
  // file was recognised as COPC instead of staring at the empty state.
  streamingPanel.setPhase('Loading metadata…');
  streamingPanel.show();

  await viewer.ready;
  // Inspector stays visible during streaming — it carries the sections
  // that work uniformly against either source type (Scan report,
  // Provenance, Coordinate system, Image export, Report PDF). The
  // static-only sections are hidden via `setStreamingMode(true)` when
  // the streaming cloud finishes attaching; until then the Inspector
  // shows its empty placeholders, which is fine.
  inspector.element.classList.remove('olv-hidden');
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

  // Await the hoisted chunk fetches; if `viewer.ready` was the slow
  // path (cold WebGPU init) this is a no-op.
  const [{ StreamingPointCloud }, { CopcWorkerClient }, streamingColors] =
    await chunksPromise;

  const cloud = await StreamingPointCloud.open(range, displayName, signal);
  if (signal.aborted) throw new LoadCancelledError();

  if (!copcDecoder) copcDecoder = new CopcWorkerClient();
  // Wire the per-chunk decode timing hook only when a benchmark is collecting;
  // clearing it on close keeps a non-benchmark session free of any callback.
  copcDecoder.onDecodeMs = streamingBenchmark
    ? (ms) => streamingBenchmark?.recordDecodeMs(ms)
    : undefined;

  // A streaming scan is exclusive — clear any open static layers first.
  clearOpenStaticLayers();
  stage.hideEmptyState();
  // Local-first counter — categorical only ('copc' or 'ept'); never the URL.
  recordUsage('scan-open', cloud.kind === 'ept' ? 'ept' : 'copc');
  // Provenance fingerprint for streaming clouds — fed with the cloud's
  // declared point count + extent so the classifier has signal even though
  // the resident set is small. Wrapped because a malformed cloud shape
  // shouldn't break the rest of the streaming load (CRS, attach, color
  // modes, navBar reveal).
  try { inspectorCards.refreshProvenanceFromStreaming(cloud); }
  catch (err) { if (debug) console.warn('[provenance] refreshProvenanceFromStreaming threw', err); }
  // CRS for streaming clouds — same merge rule as the static path.
  try {
    crsCoordinator.refreshCrsForStreamingCloud(cloud as unknown as {
      readonly name: string;
      readonly kind: 'copc' | 'ept';
      crs(): CrsInfo | undefined;
    });
  } catch (err) {
    if (debug) console.warn('[crs] refreshCrsForStreamingCloud threw', err);
  }
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
  // Classification legend (v0.4.1) — reset to empty for the new streaming scan.
  // The legend is seeded + revealed lazily by `viewer.onStreamingNodeClasses`
  // as nodes carrying classification become resident, and refines as deeper
  // nodes stream in. A streaming source without a classification channel simply
  // never seeds the legend, so it stays hidden.
  classLegendPanel.setClasses(new Map());
  classLegendPanel.hide();
  // Clear any prior filtered scan's inspector copy/JSON scope stamp.
  syncInspectClassScope();
  // Visual Export Studio — a streaming COPC cloud is now attached;
  // the image-export buttons in the Inspector can light up. The streaming
  // path doesn't go through `inspector.addCloud`, so the gate has to flip
  // here too. Pre-warm the Studio chunk for the same reason as above.
  inspector.setImageExportEnabled(true);
  // Per-mode gating — streaming COPC / EPT rarely carry normals or
  // classification; disable the corresponding buttons at the source.
  inspector.setImageExportAvailability(viewer.availableImageExportModes());
  // Switch the Inspector into streaming layout — hides Layers / Color by
  // / Point size / Rendering / Export (their streaming-equivalents are
  // in the StreamingPanel) and pins the panel to the lower-right so
  // both panels coexist on desktop.
  inspector.setStreamingMode(true);
  try { inspector.setDetail(cloud.sourcePointCount, cloud.sourcePointCount); }
  catch (err) { if (debug) console.warn('[inspector] setDetail (streaming) threw', err); }
  lastStreamingReportCloud = cloud;
  try { inspector.setReport(runStreamingModules(cloud, classLegendPanel.getVisibility().isFiltered())); }
  catch (err) { if (debug) console.warn('[inspector] setReport (streaming) threw', err); }
  try {
    inspectorCards.refreshDatasetIntelligenceFromStreamingCloud(cloud);
  } catch (err) {
    if (debug) console.warn('[inspector] dataset intel (streaming) threw', err);
  }
  void prewarmExportStudio();

  // The metadata-driven scan summary, and a fresh saved-views list.
  const header = cloud.metadata.header;
  revealAnalysePanel(cloud.name, false); // streaming COPC also gets the terrain tools
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
  // Reveal the dock the same way the static-load path does.
  dock.setEmpty(false);
  inspector.setEmpty(false);
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
async function handleRemoteUrl(url: string, signal?: AbortSignal): Promise<void> {
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
  if (isEpt) return handleRemoteEpt(url, signal);
  return handleRemoteCopc(url, signal);
}

/**
 * Wire an optional outer abort signal (the Stage URL field's Cancel
 * button) into a load's own AbortController (the progress toast's Cancel)
 * so EITHER cancel aborts the in-flight fetches. Returns a cleanup that
 * detaches the listener — call it on every exit path so a long-lived
 * outer signal can't accumulate listeners across loads. (Mirrors the
 * private `composeSignals` discipline inside `HttpRangeSource`.)
 */
/**
 * True when `err` is a user-initiated abort, in any of the shapes a cancel
 * can surface as on the remote-open path:
 *
 *  - the platform's DOMException named `AbortError` (a fetch aborted
 *    directly by the linked signal), or
 *  - `RangeReadError` with code `'aborted'` — `HttpRangeSource` wraps the
 *    platform abort in its typed error before it reaches us.
 *
 * The Stage URL-field Cancel aborts the linked signal while a fetch or
 * range probe is in flight; neither rejection is our LoadCancelledError,
 * so cancel handling must recognise all three shapes.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === 'AbortError') return true;
  return e.name === 'RangeReadError' && e.code === 'aborted';
}

function linkAbortSignals(
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
async function handleRemoteEpt(url: string, signal?: AbortSignal): Promise<void> {
  if (loading) {
    showLassoToast('Already loading — cancel the current load first.');
    return;
  }
  // Claim the flag SYNCHRONOUSLY. Every await below yields to the event
  // loop, and a second open started in that window used to pass the
  // `loading` guard too (TOCTOU). The `finally` below is the only reset.
  loading = true;
  const controller = new AbortController();
  // Compose the Stage URL-field Cancel (outer signal) with the progress
  // toast's Cancel (this controller): either abort cancels the load.
  const unlinkAbort = linkAbortSignals(signal, controller);
  // Fire the streaming + EPT chunk pre-warm immediately. Each dynamic
  // import is one HTTP fetch + parse; running them in parallel with
  // the manifest GET below cuts cold-start by 200–700 ms.
  prewarmForUrl(url);
  // Declared outside the try so the catch can use the module's error
  // classifier when the module loaded, and a plain classifier when the
  // chunk fetch itself was the failure.
  let eptUrlMod: Awaited<ReturnType<typeof loadEpt>> | null = null;
  try {
    // URL validation is pure — run it before awaiting the lazy Viewer so a
    // malformed URL always surfaces an error toast, even if the Viewer chunk
    // hasn't loaded yet or the GPU backend can't initialise.
    eptUrlMod = await loadEpt();
    const check = eptUrlMod.validateRemoteEptUrl(url);
    if (!check.ok) {
      dropZone.setError(`${check.reason} Enter the full https://…/ept.json URL.`);
      return;
    }
    // The actual streaming open touches viewer state — defer until the lazy
    // Viewer chunk is up.
    await viewerLoaded;
    dropZone.setProgress(`Reading EPT manifest from ${shortUrl(url)}…`);
    dropZone.setCancelHandler(() => controller.abort());
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
    // Inspector stays visible during streaming — same rationale as the
    // COPC path. Streaming-only sections drop out via setStreamingMode
    // once the cloud finishes attaching.
    inspector.element.classList.remove('olv-hidden');

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
    clearOpenStaticLayers();
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
    // Per-mode gating — EPT streams almost never carry normals.
    inspector.setImageExportAvailability(viewer.availableImageExportModes());
    // Same streaming-mode layout the COPC path uses — hide Inspector's
    // static-cloud sections and populate the streaming Scan Report.
    inspector.setStreamingMode(true);
    try { inspector.setDetail(cloud.sourcePointCount, cloud.sourcePointCount); }
    catch (err) { if (debug) console.warn('[inspector] setDetail (streaming) threw', err); }
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
      lastStreamingReportCloud = eptReportCloud;
      inspector.setReport(
        runStreamingModules(eptReportCloud, classLegendPanel.getVisibility().isFiltered()),
      );
    } catch (err) { if (debug) console.warn('[inspector] setReport (streaming) threw', err); }
    void prewarmExportStudio();

    // The metadata-driven scan summary — same shape the COPC path fills,
    // adapted for EPT's metadata layout.
    const b = detection.metadata.bounds.conforming;
    const schemaSummary = `${detection.metadata.dataType} · ${detection.metadata.schema.length} attrs`;
    revealAnalysePanel(cloud.name, false); // streaming EPT also gets the terrain tools
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
    // A user-initiated cancel surfaces two ways: our own LoadCancelledError,
    // or a DOMException named `AbortError` when the Stage URL-field Cancel
    // aborts the linked signal mid-fetch. Both mean "the user changed their
    // mind" — neither is an error to report or count.
    if (err instanceof LoadCancelledError || isAbortError(err)) {
      dropZone.setProgress(null);
    } else {
      if (debug) console.error('OpenLiDARViewer — remote EPT error', err);
      recordUsage('error', 'load');
      // classified error messages, matching the COPC
      // remote-UX polish. `describeRemoteEptError` distinguishes CORS,
      // 404, 5xx, hierarchy vs. tile fetch, and transport failures.
      // Fall back to the generic classifier when the EPT chunk itself
      // failed to load (so `eptUrlMod` never arrived).
      dropZone.setError(
        eptUrlMod ? eptUrlMod.describeRemoteEptError(err, url) : describeLoadError(err),
      );
      closeStreaming();
    }
  } finally {
    unlinkAbort();
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
async function handleRemoteCopc(url: string, signal?: AbortSignal): Promise<void> {
  if (loading) {
    showLassoToast('Already loading — cancel the current load first.');
    return;
  }
  // Claim the flag SYNCHRONOUSLY. Every await below yields to the event
  // loop, and a second open started in that window used to pass the
  // `loading` guard too (TOCTOU). The `finally` below is the only reset.
  loading = true;
  const controller = new AbortController();
  // Compose the Stage URL-field Cancel (outer signal) with the progress
  // toast's Cancel (this controller): either abort cancels the load.
  const unlinkAbort = linkAbortSignals(signal, controller);
  try {
    // URL validation is pure — run it before awaiting the lazy Viewer so a
    // malformed URL always surfaces an error toast, even if the Viewer chunk
    // hasn't loaded yet or the GPU backend can't initialise.
    const check = validateRemoteCopcUrl(url);
    if (!check.ok) {
      dropZone.setError(`${check.reason} Enter an http:// or https:// URL to a COPC (.copc.laz) file.`);
      return;
    }
    // Fire the streaming-chunk pre-warm immediately — these dynamic
    // imports are independent of `viewerLoaded` and the HEAD probe, and
    // each one is a separate HTTP fetch. Parallelising them with the
    // probe shaves the smaller of the two latencies off cold-start
    // (often 100–300 ms). The chunks are idempotent / cached, so the
    // real `await Promise.all([loadStreamingPointCloud(), …])` inside
    // `openStreamingCopc` typically resolves instantly by the time
    // we reach it.
    prewarmForUrl(url);

    // The actual streaming open touches viewer state — defer until the lazy
    // Viewer chunk is up.
    await viewerLoaded;
    dropZone.setProgress(`Connecting to ${shortUrl(url)}…`);
    dropZone.setCancelHandler(() => controller.abort());
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
    // See the EPT handler: AbortError = Stage URL-field Cancel — a user
    // decision, not a load failure.
    if (err instanceof LoadCancelledError || isAbortError(err)) {
      dropZone.setProgress(null);
    } else {
      if (debug) console.error('OpenLiDARViewer — remote COPC error', err);
      recordUsage('error', 'load');
      dropZone.setError(describeRemoteCopcError(err, url));
      // A remote open that failed mid-flight leaves no scan — tidy up.
      closeStreaming();
    }
  } finally {
    unlinkAbort();
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
      return (
        `${err.message} Try hosting the file on S3 or a static CDN — most support range requests by default.`
      );
    }
    if (err.code === 'transport') {
      return `${err.message} The host also needs to allow cross-origin (CORS) requests from this site.`;
    }
    if (err.code === 'timeout') {
      return `${err.message} Try again in a moment, or pick a faster host.`;
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
  // Return the Inspector to its static layout — un-hide every section
  // and clear the streaming-mode positioning class.
  try { inspector.setStreamingMode(false); }
  catch (err) { if (debug) console.warn('[inspector] setStreamingMode(false) threw', err); }
  try { inspector.clearDatasetIntelligence(); }
  catch (err) { if (debug) console.warn('[inspector] clearDatasetIntelligence threw', err); }
  inspector.element.classList.remove('olv-hidden');
}

/**
 * True when at least one resident node sits at or below `minDepth` in
 * the streaming octree. Used by the benchmark to gate the
 * coarse-stable marker so a "first scheduler idle" event at depth 0
 * doesn't masquerade as "first usable view".
 *
 * Iterates the octree's node list; the inner loop short-circuits on
 * the first hit, so worst case is `nodes.length` per poll (~250 ms
 * cadence) for the brief window between idle and refinement.
 *
 * The cloud's structural type is inlined here so this helper stays
 * decoupled from the concrete `StreamingSource` import — the actual
 * runtime shape is the COPC + EPT octree's shared `nodes()` surface.
 */
function hasResidentAtDepth(
  cloud: {
    readonly octree: {
      nodes: () => readonly { state: string; record: { key: { depth: number } } }[];
    };
  },
  minDepth: number,
): boolean {
  for (const node of cloud.octree.nodes()) {
    if (node.state === 'resident' && node.record.key.depth >= minDepth) return true;
  }
  return false;
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
      // First time the stream GENUINELY settles, re-evaluate the scan type on
      // the now fully-resident cloud — a sparse early frame can misread a
      // 360 / house as terrain or object. One-shot per scan; a manual "Treat
      // as" override or a "run anyway" pin make this a no-op (and spend it).
      //
      // Two guards keep the one-shot THE settled verdict (v0.4.5 fix — the
      // pill stayed on Auto after "Streaming ready" because a transient idle
      // had silently spent the one-shot without committing):
      //   1. DEPTH GATE — the scheduler often reads idle at the root level
      //      (depth 0) long before the cloud fills in (same reality the
      //      benchmark's coarse-stable guard handles below). Don't even
      //      attempt the settled evaluation until the resident set spans the
      //      hierarchy's own depth (capped at 2).
      //   2. SPEND-ON-LANDED-VERDICT (v0.4.5b) — `applyScanRoute` reports
      //      whether the settled verdict actually LANDED (applied or
      //      committed) or routing is pinned/manual. A REFUSED verdict (a
      //      ceiling-heavy early frame reading terrain against a standing
      //      interior route) and an undecidable frame both leave the one-shot
      //      ARMED so a later ready poll retries on fuller geometry — gated
      //      on the resident set actually CHANGING (re-reading an identical
      //      frame cannot change the verdict; a failed gather may retry at
      //      once) and bounded by SETTLE_RETRY_CAP inside the spend rule.
      if (!streamingSettledRouted) {
        const hierarchyDepth = cloud.octree.nodes().length > 0 ? cloud.maxDepth() : 0;
        if (hasResidentAtDepth(cloud, settleTargetDepth(hierarchyDepth))) {
          const resident = cloud.residentPointCount;
          if (settleAttempts === 0 || resident !== lastSettleResident || lastSettleUndecided) {
            settleAttempts++;
            lastSettleResident = resident;
            // settled=true: this is THE settled verdict for a streaming scan —
            // under auto mode it soft-commits the "Treat as" pill to the
            // detected type (display only; routing guards unchanged).
            streamingSettledRouted = applyScanRoute(false, true);
          }
        }
      }
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
      // Coarse stable: the first poll at which the scheduler has settled
      // AND the resident set has meaningful coverage — i.e. spans at
      // least one refinement level beyond the root. On a slow link the
      // scheduler often reaches steady state at depth 0 (root only)
      // before the user moves; firing then would report "coarse stable
      // = first scheduler idle" instead of "first usable view", and
      // every benchmark across machines would look identical because
      // the depth-0 root takes roughly the same time everywhere.
      //
      // The guard caps at the deepest depth the hierarchy actually
      // exposes: large datasets must reach depth 2 before the marker
      // fires; tiny datasets whose entire hierarchy is depth 0–1 still
      // fire the marker once they reach their own max depth. Otherwise
      // small COPCs (test fixtures, small drone surveys) would never
      // mark coarse-stable, leaving the benchmark output with a
      // permanent em-dash placeholder.
      const targetDepth = Math.min(2, cloud.octree.nodes().length > 0 ? cloud.maxDepth() : 0);
      if (
        !coarseStableFired &&
        counts.resident > 0 &&
        counts.loading === 0 &&
        counts.queued === 0 &&
        hasResidentAtDepth(cloud, targetDepth)
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
  // Suggest the camera preset best suited to the scan — a dismissible chip the
  // user can accept with one click or ignore (it auto-hides).
  const rec = recommendCameraPreset({
    hasRgb: cloud.colors !== undefined,
    hasClassification: cloud.classification !== undefined,
    flatness: flatnessFromBounds(b.min, b.max),
  });
  recommendedViewChip.show(rec, () => viewer.setCameraPreset(rec.preset));
}

/** Fetch a built-in sample (a local static file — no upload) and load it. */
async function loadFromUrl(url: string, name: string): Promise<void> {
  // ensure the lazy-loaded Viewer is ready before touching it.
  await viewerLoaded;
  // Remote COPC / EPT URLs route through the streaming pipeline — a
  // `fetch().blob()` against a 1+ GB COPC would defeat the whole point
  // of streaming and try to pull the entire file before showing a
  // single point. The dispatch matches `handleRemoteUrl`'s contract so
  // the sample-button affordance can carry a real public COPC URL the
  // same way the "stream from URL" field does.
  const looksLikeRemoteStream =
    /^https?:\/\//i.test(url) &&
    (/\.copc\.laz$/i.test(url) || /\/ept\.json(?:\?|#|$)/i.test(url));
  if (looksLikeRemoteStream) {
    return handleRemoteUrl(url).catch((err) => {
      dropZone.setError(
        err instanceof Error ? err.message : `Failed to stream ${name}.`,
      );
    });
  }
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
  // Hide + clear the Analyse panel so it doesn't linger with stale
  // terrain results after the scan is closed. v0.4.0.
  analysePanel.update(null);
  analysePanel.setVisible(false);
  // Hide the Space / Object (non-terrain) panel too — it was added after this
  // reset path and a closed 360 / object scan would otherwise leave its report
  // lingering over the empty state. v0.4.3.
  objectPanel.setVisible(false);
  // No scan → hide the phone bottom-sheet (no-op on desktop).
  syncMobileSheet?.();
  // Abort any in-flight terrain compute (worker job + its reply) so a result
  // for the now-closed scan can never land on the panel, and drop every cached
  // terrain core so a stale core can't be served for a different scan and
  // memory stays bounded. Guarded inside the runner: the cache chunk is only
  // loaded after the first Analyse run, and before that there is nothing to
  // clear — so this never eagerly pulls the heavy analysis chunk.
  terrainRunner.abortAndClearCache();
  // Drop the DTM-confidence grid and disable the Coverage colour chip — the
  // grid belongs to the now-closed scan, so the 3D coverage mode must not tint
  // a different cloud with stale trust.
  viewer.setCoverageGrid(null);
  inspector.setCoverageAvailable(false);
  // Hide + clear the classification legend so it doesn't linger with a stale
  // class list after the scan is closed. v0.4.1.
  classLegendPanel.setClasses(new Map());
  classLegendPanel.hide();
  // Clear the inspector's copy/JSON scope stamp now there's no active filter.
  syncInspectClassScope();
  lastStreamingReportCloud = null;
  // Cancel any pending scan-type re-route + reset its state so a timer can't
  // fire against the now-closed scan, and the next open routes from scratch.
  if (scanRouteTimer != null) { clearTimeout(scanRouteTimer); scanRouteTimer = null; }
  lastScanVerdict = null;
  scanRouteOverridden = false;
  scanTypeOverride = 'auto';
  streamingSettledRouted = false;
  settleAttempts = 0;
  lastSettleResident = -1;
  lastSettleUndecided = false;
  scanDetectionCommitted = false;
  lastRouteResident = 0;
  exportPanel.setVisible(false);
  sourceFileById.clear();
  reducedById.clear();
  dock.setMeasureEnabled(false);
  dock.setInspectEnabled(false);
  dock.setProbeEnabled(false);
  dock.setAnnotateEnabled(false);
  dock.setAnalyseEnabled(false);
  dock.setCloseEnabled(false);
  // Hide the dock entirely while back in the empty state — the audit fix
  // that pairs with `setEmpty(false)` on every attach path.
  dock.setEmpty(true);
  inspector.setEmpty(true);
  inspector.clear();
  inspector.clearProvenance();
  // `crsService.clear()` broadcasts `null` to the inspector via its
  // subscription, which restores the CRS placeholder.
  crsCoordinator.clearDatasetKey();
  crsService.clear();
  // Clear the point inspector's coordinate context so a future Inspect
  // click on a different scan doesn't compute against the previous
  // scan's origin / CRS.
  if (viewerReady) {
    try { viewer.setInspectCoordinateContext({}); }
    catch { /* defensive */ }
  }
  // Visual Export Studio — no scan loaded, no source to render. The
  // buttons go back to disabled with their "load a scan first" hint so the
  // user can't fire an export against nothing.
  inspector.setImageExportEnabled(false);
  stage.showEmptyState();
  navBar.element.classList.add('olv-hidden');
  // Reset the NavBar mode to 'orbit'. The "Click the scan to look around"
  // prompt is gated on the mode being walk/fly + cursor-not-locked; if a
  // user closes a project while in walk/fly mode, the prompt sticks around
  // and floats over the empty-state Open-a-scan UI (visibly covering the
  // QUICK DEMOS section). Resetting to orbit hides it via `_render`.
  navBar.setMode('orbit');
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
  sourceFileById.delete(id);
  reducedById.delete(id);
  if (activeId === id) activeId = null;
  if (viewer.clouds().length === 0) resetToEmptyState();
}

/**
 * Free every currently-open static cloud before a new scan takes over — the
 * mesh's GPU buffers (geometry + material + colour/class attributes) AND the
 * retained source-file + reduced-flag map entries. A new open (static OR
 * streaming) replaces the previous scan, so without this the prior cloud's GPU
 * memory and File reference leak on every reopen (`activeId` is overwritten, so
 * `removeCloud` could never reach the old id). Does NOT reset to the empty
 * state — the caller adds the replacement immediately.
 */
function clearOpenStaticLayers(): void {
  for (const id of viewer.clouds()) {
    viewer.removeCloud(id);
    inspector.removeCloud(id);
    sourceFileById.delete(id);
    reducedById.delete(id);
    if (activeId === id) activeId = null;
  }
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
    // `snapshot()` renders the live scene through the class-mask shader, so a
    // filtered view drops hidden classes from the PNG. Stamp the same scope
    // banner the Studio export path uses so a filtered snapshot can't leave the
    // app undisclosed. With an empty stamp (nothing hidden) the helper returns
    // the input Blob unchanged, keeping the snapshot byte-identical to before.
    const stamped = await composeClassScopeBannerOntoBlob(blob, currentClassScopeStamp());
    const url = URL.createObjectURL(stamped);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'openlidarviewer.png';
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    dropZone.setError('Could not save the view');
  }
}
