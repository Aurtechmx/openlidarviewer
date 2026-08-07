// Self-hosted type pairing — Manrope (grotesk labels) + JetBrains Mono (tabular
// figures). Latin subsets only, served same-origin so nothing leaves the device.
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './style.css';
// Local-first hardening: disable loaders.gl CDN workers before any parse runs,
// so OBJ/PLY/glTF never fetch executable code from a third-party CDN.
import './io/loaderConfig';
import type { Viewer } from './render/Viewer';
import { chooseRenderBackend } from './render/renderBackendChoice';
import { isMobileDevice, MOBILE_LAYOUT_QUERY } from './ui/isMobileDevice';
import { Stage } from './ui/Stage';
import type { Sample } from './ui/Stage';
import { DropZone } from './ui/DropZone';
import { Inspector } from './ui/Inspector';
import { ThemeToggle } from './ui/ThemeToggle';
import { mountHeaderControls } from './ui/headerControls';
import { ToolDock } from './ui/toolDock';
import { revealStreamingScanChrome } from './ui/streamingScanReveal';
import { createCompassController } from './ui/compassController';
import { NavBar } from './ui/NavBar';
import { ProjectCard } from './ui/ProjectCard';
import {
  wireMeasureBarClearance,
  wireDockClearance,
  wireRailToggle,
  containPanelWheel,
  RAIL_CHEVRON_LEFT,
  RAIL_CHEVRON_RIGHT,
} from './ui/panelChrome';
import {
  applyTheme,
  readPersistedTheme,
  writePersistedTheme,
  type ThemeName,
} from './ui/themes';
import type { CommandPalette } from './ui/CommandPalette';
import type { ShortcutSheet } from './ui/ShortcutSheet';
import { bootTour, type TourHandle } from './ui/onboarding/bootTour';
import { buildMeasureConfidenceContext } from './app/measureConfidenceContext';
import { findDuplicateIds } from './ui/actionRegistry';
import { buildActionRegistry } from './app/actionDefinitions';
import { importSession as runImportSession, type SessionIoDeps } from './app/sessionIo';
import { openScan, type OpenScanDeps } from './app/openScan';
import {
  openStreamingCopc as runOpenStreamingCopc,
  handleRemoteEpt as runHandleRemoteEpt,
  isEptUrl,
  isAbortError,
  linkAbortSignals,
  type OpenStreamingDeps,
} from './app/openStreaming';
import {
  generateReportPdf as runGenerateReportPdf,
  exportGeoContext as runExportGeoContext,
  type GeoExportContext,
  type ReportExportDeps,
} from './app/reportExport';
import { WorkflowController, WORKFLOW_RECORDER_ENABLED } from './ui/WorkflowController';
import type { WorkflowConfigPanel } from './ui/WorkflowConfigPanel';
import { RecommendedViewChip } from './ui/RecommendedViewChip';
import { recommendCameraPreset, flatnessFromBounds } from './render/camera/recommendView';
import type { WorkflowEvent } from './render/workflow/workflowRecorder';
import { matchesShortcut } from './render/workflow/workflowConfig';
import { LassoVolumeTool } from './ui/LassoVolumeTool';
import {
  triggerDownload,
  downloadBytes as downloadFileBytes,
  downloadText,
} from './io/download';
import { noteEdit, pickUndo, pickRedo, withSuppressed } from './ui/undoRouter';
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
// AnalysePanel is lazy-mounted on first scan load (v0.6 P1): only the TYPE is
// imported here (erased at compile time — pulls nothing into the shell), and the
// class itself arrives through `loadAnalysePanel()` (see lazyChunks import below)
// inside `ensureAnalysePanel()`.
import type { AnalysePanel } from './ui/AnalysePanel';
import { ClassLegendPanel } from './ui/ClassLegendPanel';
import type { ReclassifyUi } from './ui/reclassifyUi';
import { countClasses } from './render/class/classHistogram';
import { toClassBuffer } from './render/class/classBuffer';
import { deriveClassificationAsync } from './render/class/deriveClassificationAsync';
import { classifierCues } from './render/class/classifierCues';
import {
  classificationCoverage,
  type DeriveClassificationOptions,
} from './render/class/deriveClassification';
import { footprintAreaM2, type ScanStoryInputs } from './intelligence/scanStory';
import { fullScope, scopeFrom, scopeStamp, notScopedSentinel, type ClassScope } from './render/class/classScope';
import { classificationLabel } from './render/pointInfo';
// ObjectPanel is lazy-mounted on first scan load (v0.6 P1, step 2): only the
// TYPE is imported here (erased at compile time — pulls nothing into the shell),
// and the class itself arrives through `loadObjectPanel()` (see lazyChunks import
// above) inside `ensureObjectPanel()`.
import type { ObjectPanel } from './ui/ObjectPanel';
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
import type { MeasurementExportContext } from './export/measurementExport';
import { makeLocalToLonLat } from './export/lonLatMapper';
import {
  crsIsKnown,
  exportScanFootprintKml,
  exportSiteKml,
  scanFootprintStatus,
  siteKmlStatus,
  type KmlActionDeps,
} from './app/kmlActions';
import { ClipPanel } from './ui/ClipPanel';
import type { ClipBox } from './render/clip/clipBox';
// Two-epoch change detection is loaded on demand (it pulls the terrain
// ground-filter + rasteriser): see compareLoadedLayers' dynamic import.
import { composeClassScopeBannerOntoBlob } from './export/ScanReportRenderer';
import { planInstantAnswer } from './intelligence/instantAnswer';
import { decodeFull } from './convert/decodeFull';
import { HelpOverlay } from './ui/HelpOverlay';
import { bindShortcuts } from './ui/shortcuts';
import { LoadCancelledError } from './io/loadFile';
import { LocalFileSource } from './io/LocalFileSource';
import { deviceCaps } from './render/deviceProfile';
import { parseEmbedConfig } from './ui/embedConfig';
// `startEmbedBridge` is only wired in `?embed=1` mode.
// Lazy-loaded so the bridge code never enters the bundle for the typical
// non-iframe page load (the dominant traffic pattern).
import { encodeShareState, decodeShareState } from './io/shareState';
import type { ShareState } from './io/shareState';
// The diagnostics runtime (DebugOverlay + streamingBenchmark + the
// instrumented range source) loads only when `?debug=1` or `?benchmark=1`
// is set — see `loadDiagnostics()` below. The types stay reachable for the
// variable annotations.
import type { StreamingBenchmark } from './render/streaming/streamingBenchmark';
import type { DebugOverlay, StreamingDebugStats } from './ui/DebugOverlay';
// Type-only: the overlay itself rides a lazy chunk (loadColorbarOverlay).
import type { ColorbarOverlay } from './ui/ColorbarOverlay';
import { estimateDecodedBytes, estimateGpuBytes } from './render/streaming/streamingBudget';
import { isZUpFormat } from './io/sniffFormat';
// `exportCloud` is dynamically imported via `loadExporters` in the onExport
// callback — the PLY/OBJ/XYZ/CSV encoders stay in their own chunk and never
// weigh on the initial payload of a session that never exports.
// Only the tiny file-router predicate is eager; the (large) serializer/parser
// is dynamically imported in exportSession/importSession so it stays off the
// initial bundle.
// The view-state seam is eager but weightless: pure capture/apply
// orchestration with type-only imports (no session parser, no three.js), so
// saveCurrentView/applyView can run synchronously from a keystroke while the
// ordering contract (camera LAST) stays unit-testable outside this bootstrap.
import {
  applyViewStateInOrder,
  buildViewState,
  type ViewStateBundle,
} from './io/viewState';
import { loadPrefs, savePrefs } from './prefs';
import { applyNavPrefsChange, navigationPrefs, restoreNavPrefs } from './render/navPrefsWiring';
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
import { validateRemoteCopcUrl } from './io/range/RangeSource';
import type { RangeSource } from './io/range/RangeSource';
import type { CopcWorkerClient } from './io/copc/worker/copcWorkerClient';
import type { EptLaszipWorkerClient } from './io/ept/worker/eptLaszipWorkerClient';
import { StreamingPanel } from './ui/StreamingPanel';
import type { StreamingQuality } from './render/streaming/streamingBudget';
// The COPC/streaming `import()` split points live in `lazyChunks.ts` — a
// module excluded from the live-build source-transform so Vite can still see the
// dynamic-import specifiers and emit the chunks (see lazyChunks.ts).
import {
  loadStreamingPointCloud,
  loadCopcWorkerClient,
  loadEptLaszipWorkerClient,
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
  loadReclassifyUi,
  loadContextMenu,
  loadWorkflowConfigPanel,
  loadCommandPalette,
  loadShortcutSheet,
  loadMeasurementExport,
  loadMeasurementReport,
  loadKmlExport,
  loadConfirmFullExport,
  loadFloorPlanConfidence,
  loadFullCloudGradeAction,
  loadSession,
  loadExportProvenance,
  loadCompareEpochs,
  loadAlignEpochs,
  loadCompareDtms,
  loadChangeRaster,
  loadApplyDisplayProfile,
  loadColorbarOverlay,
  loadAnalysePanel,
  loadObjectPanel,
} from './lazyChunks';
// Local-first usage counter. Categorical event counts only; stays in
// localStorage; never transmitted. The `?notelemetry=1` URL flag suppresses
// every `increment()` call structurally.
import {
  increment as recordUsage,
  isSuppressed as usageIsSuppressed,
} from './diagnostics/usageCounters';
import {
  fingerprintFor as provenanceFor,
  type CaptureType,
} from './diagnostics/provenance';
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
import type { CrsLinearUnit } from './io/crs';
import { streamingExtentRows } from './analysis/streamingExtentRows';
import { CrsService } from './geo/CrsService';
import { spatialContextFrom, verticalMetresPerUnit } from './geo/SpatialContext';
import { epochFrameFacts, epochFrameOptions } from './geo/frameCompatibility';
// Shared vertical-unit labeller (already eager via terrainAnalysisRunner) —
// feeds the colorbar legend's elevation unit from the resolved CRS.
import { verticalUnitLabel } from './units/units';
import { createInspectorCardRefreshers } from './app/inspectorCardRefreshers';
import { installStaleChunkRecovery } from './app/staleChunkReload';
import { createCrsCoordinator } from './app/crsCoordinator';
import { remoteCopcName, describeRemoteCopcError } from './app/remoteSourceNaming';
import { deriveVolumeRecord, horizontalSpanXY } from './render/measure/measureDerivations';
import { serviceWorkerUrl } from './app/swUrl';
import { createTerrainAnalysisRunner } from './app/terrainAnalysisRunner';
import { createAppRuntime } from './app/AppRuntime';
import { createLayerService } from './app/LayerService';
import { createViewBookmarks } from './app/viewBookmarks';
import { createScanService } from './app/ScanService';
import { createScanRouteService } from './app/ScanRouteService';
import { createProjectFrameService } from './app/projectFrame';

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
// No bundled "demo" sample. The start screen's only streaming entry points are
// the curated public-LiDAR picker (CURATED_LOCATIONS) and the open-from-URL
// field — both of which surface only datasets with a confirmed open licence.
// The previous Entwine "Public streaming demo" pointed at a bucket whose data
// carried no stated open licence, so it was removed.
const SAMPLES: Sample[] = [];

// The "Try a sample scan" ghost button under the primary CTA — the first
// curated location (smallest, confirmed open licence, streams in seconds)
// exposed as the one-click demo path. Same approval gate + streaming path
// as the curated picker; only the entry point is promoted.
const DEMO_SAMPLE: Sample = {
  id: 'flai-ch-swisssurface3d-2022',
  label: 'Switzerland · swisstopo, 84 MB',
  detail: 'swissSURFACE3D (2022), via FLAI · streams over your network, nothing uploaded',
  url: 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz',
  name: 'swisssurface3D 2022',
  sizeBytes: 83_800_000,
};

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
    handleRemoteUrl(url).then(
      // Success transition: clear the "Opening …" pulse once the scan attaches,
      // so the catalog status doesn't keep pulsing after a successful load.
      () => catalogPanel.markLoaded(),
      (err) => {
        const msg = err instanceof Error ? err.message : 'Failed to open the dataset.';
        // Surface the failure in BOTH the drop zone and the catalog's own status
        // — the catalog is what the user is looking at, so a blocked remote fetch
        // no longer reads as an endless "Opening …".
        dropZone.setError(msg);
        catalogPanel.showOpenError(`Couldn't open the dataset: ${msg}`);
      },
    );
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
        catalogPanel.markLoaded();
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

// Assigned when the tour boots (below); the splash chip calls through it.
let tour: TourHandle | null = null;

const stage = new Stage(app, {
  embed,
  samples: SAMPLES,
  demoSample: DEMO_SAMPLE,
  onSample: loadFromUrl,
  onStartTour: () => tour?.start(),
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

themeToggle = mountHeaderControls(stage, {
  initialTheme: currentTheme,
  onThemeChange: (name) => setTheme(name),
  onRecenter: () => { viewer?.frameAll(); },
});

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
 * scan-open path awaits `viewerLoaded` before touching it, and UI handlers that
 * could fire pre-init operate against an empty state where the calls are no-ops.
 *
 * The cast through `unknown` is the documented escape hatch: TS cannot see that
 * `viewerLoaded` resolves before any user-driven scan-open at runtime, but it does.
 */
let viewer: Viewer = null as unknown as Viewer;
// v0.6 P3: recover from a stale lazy chunk after a deploy. If the Viewer's
// content-hashed import fails because a newer build replaced the asset mid-session,
// do ONE guarded reload (sessionStorage cooldown, URL preserved), not a hard boot
// failure. Ordinary Viewer exceptions are NOT classified as stale and never reload.
const { importOrReload } = installStaleChunkRecovery();
const viewerLoaded: Promise<Viewer> = (async () => {
  const { Viewer: ViewerCtor } = await importOrReload(loadViewer);
  // WebKit/iOS: navigator.gpu is present but requestAdapter() -> null; probe so
  // the renderer picks WebGL 2 instead of throwing on the first scan open.
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  viewer = new ViewerCtor(stage.canvas, (await chooseRenderBackend(gpu)) === 'webgl2');
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
    // Native→metre factor for the source CRS (feet for a state-plane-feet
    // cloud). Handed to computeLassoVolume so the stockpile band it returns is
    // already converted to metres, and reused below for the m³/m² readout.
    const ctx = crsService.context();
    const lin = ctx.linearUnitToMetres;
    // Whether that factor is real or an assumed 1: an unknown CRS still yields
    // lin = 1 for display, but its points/m² density is then an assumption the
    // stockpile grade must not claim. One context answers both questions.
    const densityUnitKnown = ctx.linearUnitKnown;
    const vert = verticalMetresPerUnit(ctx, 'horizontal') ?? lin;
    const out = viewer.computeLassoVolume(lasso, 0.05, lin, densityUnitKnown, vert);
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
    // The lasso result is in the source CRS's native linear units. Convert to
    // metres before stamping m³ / m² — areas by lin², volumes by lin³ — the
    // same factor the measure tool uses. (The CRS gate below still blocks
    // geographic / unknown; this corrects the projected-feet case it lets
    // through.)
    const lin2 = lin * lin;
    // Volume factor is linear²·vertical, matching the measure tool and the
    // exports. Plain lin³ applied the HORIZONTAL unit to the vertical axis.
    const vol = lin2 * vert;
    const fillM3 = (out.result.fill * vol).toFixed(2);
    const cutM3 = (out.result.cut * vol).toFixed(2);
    const netM3 = (out.result.net * vol).toFixed(2);
    const areaM2 = (out.result.footprintArea * lin2).toFixed(1);
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
    // `out.stockpileSuffix` is the ` · Stockpile: … ± … (±%) · confidence`
    // band the Viewer computed over the same sample with a "lowest ground"
    // base plane — the honest figure cloud viewers report without. Empty when
    // there's nothing trustworthy to claim (too few points / degenerate).
    showLassoToast(
      `Volume · fill ${fillM3} m³ · cut ${cutM3} m³ · net ${netM3} m³ · ` +
        `footprint ${areaM2} m² · ${out.selectedCount.toLocaleString()} points${budgetCaption}${crsCaveat}.${out.stockpileSuffix}`,
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

  // Hold-Space re-orient: while a modal tool (measure / inspect / annotate) is
  // armed, holding Space hands pointer input back to camera navigation so the
  // user can rotate / pan / zoom mid-draw; releasing it (keyup, below) resumes
  // the tool. Outside a tool, Space keeps its walk/fly "move up" meaning, so we
  // only intercept it when a tool is active.
  if (e.code === 'Space' && viewer?.toolActive) {
    if (!e.repeat) viewer.setToolPaused(true);
    e.preventDefault();
    return;
  }

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

// Releasing Space resumes the modal tool after a hold-Space re-orient.
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && viewer?.toolActive) viewer.setToolPaused(false);
});

// Blur (Cmd-Tab away while holding Space, etc.) must also resume the tool, or it
// would stay stuck in the paused/navigation state.
window.addEventListener('blur', () => viewer?.setToolPaused(false));

// Right-click the 3-D canvas for a small navigation context menu. The menu UI
// is lazy-loaded on first use, so it stays out of the startup shell. Only armed
// once a scan is loaded — otherwise the browser's native menu is left alone.
stage.canvas.addEventListener('contextmenu', (e) => {
  if (!viewer || !scans.activeId) return;
  e.preventDefault();
  const rect = stage.canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const v = viewer;
  void loadContextMenu().then(({ showContextMenu }) => {
    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Focus here',
        run: () => {
          if (!v.focusOnScreen(ndcX, ndcY)) v.frameAll();
        },
      },
      { label: 'Frame scan', run: () => v.frameAll() },
      { label: 'Top view', run: () => void v.setStandardView('top') },
      { label: 'Front view', run: () => void v.setStandardView('front') },
      { label: 'Oblique view', run: () => void v.setCameraPreset('oblique') },
    ]);
  });
});

// v0.5.3 — on-canvas compass / ViewCube. Promoted from the v0.5.2 URL-only flag
// to a discoverable, persisted control: toggle it from the command palette
// ("Toggle compass"), and the choice is remembered. It stays OFF by default —
// the app's left and right edges are full-height panel columns (left panels and
// the Inspector), so a persistent gizmo has no free corner to occupy without
// overlapping them; the user opts in when they want it. `?viewcube=1` forces it
// on, `?viewcube=0` off. The life cycle — preference, lazy mount, rAF loop,
// tab-visibility pausing — lives in ui/compassController.ts; see that file for
// why it is not four module-scope `let`s here.
const compass = createCompassController({
  host: () => stage.overlay,
  urlParams,
});
void viewerLoaded.then((v) => compass.attachViewer(v));

// v0.5.3 — PWA: register the offline service worker. Production + secure-context
// only, and skipped under `?test=1` so it never interferes with e2e or dev. The
// worker (public/sw.js) caches only the same-origin app shell; it leaves every
// cross-origin dataset fetch alone, so the local-first, no-upload model holds.
if (
  import.meta.env.PROD &&
  !urlParams.has('test') &&
  !navigator.webdriver && // never register under automation (Playwright/Selenium e2e)
  'serviceWorker' in navigator &&
  window.isSecureContext
) {
  window.addEventListener('load', () => {
    // Resolved against the page URL, not the origin root — the app deploys
    // under sub-paths (GitHub Pages) where '/sw.js' would 404. See swUrl.ts.
    navigator.serviceWorker.register(serviceWorkerUrl(window.location.href)).catch(() => {
      /* offline support is best-effort — a registration failure must not break the app */
    });
  });
}

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

/** Input-aware mobile check — drives the touch hint and the tighter point budget. */
function isPhone(): boolean {
  return isMobileDevice();
}

// The previously-loaded scan's label, so a 2nd drop's instant answer can name
// both epochs in its before/after offer.
let _lastInstantScanLabel: string | undefined;

/**
 * Instant analysis-on-drop: the moment a scan lands, surface the single most
 * relevant analysis one click away — terrain grade, volume, floor plan, or
 * (with a second scan) a before/after difference — all without an upload. The
 * routing is the pure `planInstantAnswer`; this only wires the chosen action to
 * the existing analysis cores. (Object/interior scans are already auto-analysed
 * by `applyScanRoute`; this still announces them and offers the next step.)
 */
function showInstantAnswer(scanLabel: string): void {
  const answer = planInstantAnswer({
    cloudCount: viewer.clouds().length,
    scanShape: lastScanVerdict,
    scanLabel,
    priorScanLabel: _lastInstantScanLabel,
  });
  _lastInstantScanLabel = scanLabel;
  showLassoToast(answer.message, {
    label: answer.actionLabel,
    onClick: () => {
      switch (answer.action) {
        case 'terrain':
          // Ensure the (lazy) panel is mounted before expanding + running, so
          // the busy state and result have somewhere to land.
          analyseExpanded = true;
          void ensureAnalysePanel().then((p) => {
            p.expand();
            void terrainRunner.run();
          });
          break;
        case 'compare':
          void compareLoadedLayers();
          break;
        case 'volume':
          lassoVolumeTool.enable();
          break;
        case 'floorplan':
          // Ensure the (lazy) Object panel is mounted before revealing it, so
          // there is somewhere for the floor-plan controls to land. Track the
          // desired visibility too, so a mount still in flight replays it.
          objectDesiredVisible = true;
          void ensureObjectPanel().then((p) => p.setVisible(true));
          break;
      }
    },
  });
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

// The composition root owns the shared app state. v0.6 migrates main.ts's
// module-level mutables onto it one cluster at a time: the layer/comparison
// cluster (visibility intent, solo, last comparison) and the active-scan
// selection. The `layers`/`scan` locals are terse handles onto those clusters;
// mutating their fields writes through to the context.
const runtime = createAppRuntime();
const layers = runtime.context.layers;
const viewBookmarks = runtime.context.viewBookmarks;
const bookmarks = createViewBookmarks(runtime.context);
const scans = createScanService({ getViewer: () => viewer, context: runtime.context });
const routing = createScanRouteService(runtime.context);
// The project's shared spatial frame. LayerService reseeds it from the loaded
// layer set on every change; consumers read it through `runtime.context`.
const projectFrame = createProjectFrameService(runtime.context);
/** Each layer's explicit show/hide intent (solo overrides this without mutating it). */
const layerVisible = layers.visible;
/** True while a file load is in flight — one load at a time (see `handleFile`). */
let loading = false;

/** The active colour mode — tracked so a share link can record it. */
let currentColorMode: ColorMode | undefined;
/** The colour mode active just before the confidence overlay was turned on, so
 *  toggling the overlay off returns to exactly where the user was. */
let confidenceColorPrev: ColorMode | undefined;

/** True once the renderer backend has finished initialising. */
let viewerReady = false;
/** The `?debug=1` / `?benchmark=1` performance overlay, when one is shown. */
let debugOverlay: DebugOverlay | null = null;

/** The live colorbar legend overlay (lazy chunk) — null until first needed. */
let colorbarOverlay: ColorbarOverlay | null = null;
/** In-flight guard so a burst of refreshes fetches the overlay chunk once. */
let colorbarOverlayLoading = false;

/**
 * Refresh the on-screen colorbar legend from the Viewer's active colour
 * context. The Viewer fires `onColorContextChanged` on every mode / trim /
 * cloud / unit change (static AND streaming paths), and the streaming
 * node-ready hook re-calls this as the cloud-global ranges converge; the
 * overlay itself no-ops when the spec is unchanged, so frequent calls are
 * free. The overlay chunk is fetched on the FIRST continuous-scalar mode
 * only — an RGB-only session never downloads it.
 */
function refreshColorbarOverlay(): void {
  if (!viewerReady) return;
  const active = viewer.activeColorbar();
  if (!active) {
    colorbarOverlay?.update(null);
    return;
  }
  if (!colorbarOverlay) {
    if (colorbarOverlayLoading) return;
    colorbarOverlayLoading = true;
    void loadColorbarOverlay()
      .then((mod) => {
        colorbarOverlay = new mod.ColorbarOverlay();
        stage.overlay.append(colorbarOverlay.element);
        // Re-read the CURRENT spec — the mode may have changed while the
        // chunk was in flight, and stale legends are worse than none.
        colorbarOverlay.update(viewer.activeColorbar());
      })
      .catch((err) => {
        // A missing legend must never break the session; allow a retry on
        // the next colour change.
        colorbarOverlayLoading = false;
        console.warn('[colorbar] overlay chunk failed to load:', err);
      });
    return;
  }
  colorbarOverlay.update(active);
}

/** The COPC decode worker client — created lazily on the first COPC open. */
let copcDecoder: CopcWorkerClient | null = null;
/** The EPT laszip decode worker client — created lazily on the first EPT laszip open. */
let eptLaszipDecoder: EptLaszipWorkerClient | null = null;
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

// The point-filter windows the user has set, tracked so a saved `.olvsession`
// round-trips them (see the `pointFilters` block in serializeSession). Null =
// no filter. Cleared on the empty state.
let activeElevFilter: [number, number] | null = null;
let activeIntenFilter: [number, number] | null = null;
// True once the streaming scan's elevation + intensity filter controls have been
// seeded. Streaming (COPC/EPT) has no static cloud, so the extent setters weren't
// being called at all and the controls stayed hidden. We seed ONCE (first
// resident node) — not per node — so a growing resident intensity range can't
// re-seed and stomp a window the user has set mid-stream. Reset on every
// streaming open/close.
let streamingFilterSeeded = false;

/** Seed the streaming scan's filter controls from the resident data, once. */
function seedStreamingFilterExtents(): void {
  if (streamingFilterSeeded || !viewer.hasStreamingCloud) return;
  const elev = viewer.elevationExtent();
  const inten = viewer.intensityExtent();
  // Elevation is header-derived and available immediately; intensity needs a
  // resident node. Wait until at least one is present before marking seeded.
  if (!elev && !inten) return;
  inspector.setElevationExtent(elev);
  inspector.setIntensityExtent(inten);
  streamingFilterSeeded = true;
}

const layerService = createLayerService({
  getViewer: () => viewer,
  getInspector: () => inspector,
  context: runtime.context,
  refreshCompass: () => compass.refresh(),
  projectFrame,
});

const inspector = new Inspector({
  onColorMode: (mode) => {
    currentColorMode = mode;
    if (scans.activeId) viewer.setColorMode(scans.activeId, mode);
    // Keep the analyse-panel confidence toggle in sync when the user changes
    // colour from the COLOR BY rail instead of the toggle button. Null-safe: the
    // panel is lazy-mounted, and `hydrateAnalysePanel()` re-derives this from
    // `currentColorMode` when it does mount.
    analysePanel?.setConfidenceColorActive(mode === 'confidence');
    // Workflow rail (v0.4.5): a colour-mode change can enter/leave a preset.
    syncInspectorVisuals();
  },
  onHeightPercentileTrim: (trim) => {
    viewer.setHeightPercentileTrim(trim);
    syncInspectorVisuals();
  },
  onElevationFilter: (range) => {
    viewer.setElevationFilter(range ?? undefined);
    activeElevFilter = range;
  },
  onIntensityFilter: (range) => {
    viewer.setIntensityFilter(range ?? undefined);
    activeIntenFilter = range;
  },
  onPointSize: (size) => {
    viewer.setPointSize(size);
    syncInspectorVisuals();
    persistPrefs();
  },
  onToggleVisible: (id, visible) => layerService.setVisible(id, visible),
  onRemove: (id) => removeCloud(id),
  onToggleSolo: (id) => layerService.toggleSolo(id),
  onToggleLock: (id, locked) => viewer.setCloudLocked(id, locked),
  onCompareLayers: () => compareLoadedLayers(),
  onExportDifference: () => exportDifferenceRaster(),
  onExport: (format) => {
    const cloud = scans.activeCloud() ?? undefined;
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
    const sourceName = scans.activeId
      ? viewer.getCloud(scans.activeId)?.name
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
              triggerDownload(new Blob([pkg.zip as BlobPart], { type: 'application/zip' }), pkg.filename);
              recordUsage('export', mode);
              dropZone.setProgress(null);
              return;
            }
          } catch (err) {
            console.warn('[image-export] world-file packaging failed — shipping bare PNG:', err);
          }
        }
        triggerDownload(result.blob, `${base}-${mode}.png`);
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
    bookmarks.rename(index, name);
    inspector.setViews(bookmarks.names());
  },
  onDeleteView: (index) => {
    bookmarks.remove(index);
    inspector.setViews(bookmarks.names());
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
  onNavigationPrefsChange: (prefs) => applyNavPrefsChange(prefs, viewer, persistPrefs),
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
    const id = scans.activeId;
    if (!id) return;
    const cloud = viewer.getCloud(id);
    if (!cloud || !cloud.colors) return;
    void loadRgbAutoNormalize().then(({ rgbAutoNormalize }) => {
      if (scans.activeId !== id) return; // scan changed while we waited
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
    if (scans.activeId) {
      try {
        viewer.setColorMode(scans.activeId, p.colorMode);
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
// extracted into `src/app/`. They read the lazy `viewer` and the `scans.activeId`
// selection through getters so no top-level `viewer.*` dereference is
// introduced here — `viewer` is null until its chunk resolves.
const inspectorCards = createInspectorCardRefreshers(inspector);
const crsCoordinator = createCrsCoordinator({
  crsService,
  getViewer: () => viewer,
  isViewerReady: () => viewerReady,
  getActiveId: () => scans.activeId,
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
if (WORKFLOW_RECORDER_ENABLED) {
  // The recorder badge is always present when enabled; the heavier settings
  // popup is lazy-loaded on first open (v0.5.2 — keeps it out of the eager
  // index bundle). The dynamic import is routed through `lazyChunks` so the
  // obfuscator can't scramble the specifier into a live-only 404, the failure
  // mode that previously forced this panel eager.
  stage.overlay.append(workflowController.badge);
}
// Lazy holder for the settings popup. Its `setConfig` only syncs the popup's
// own form fields, so a session restored before the popup is ever opened keeps
// `pendingWorkflowConfig` and applies it when (if) the popup first loads; the
// functional config goes to `workflowController.setConfig` eagerly regardless.
let workflowConfigPanel: WorkflowConfigPanel | null = null;
let workflowConfigPanelLoading: Promise<WorkflowConfigPanel> | null = null;
let pendingWorkflowConfig: Parameters<typeof workflowController.setConfig>[0] | undefined;
function ensureWorkflowConfigPanel(): Promise<WorkflowConfigPanel> {
  if (workflowConfigPanel) return Promise.resolve(workflowConfigPanel);
  if (!workflowConfigPanelLoading) {
    workflowConfigPanelLoading = loadWorkflowConfigPanel().then(({ WorkflowConfigPanel }) => {
      const panel = new WorkflowConfigPanel();
      stage.overlay.append(panel.element);
      panel.onChange((cfg) => {
        workflowController.setConfig(cfg);
        persistPrefs();
      });
      if (pendingWorkflowConfig !== undefined) panel.setConfig(pendingWorkflowConfig);
      workflowConfigPanel = panel;
      return panel;
    });
  }
  return workflowConfigPanelLoading;
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
// The command palette opens only on Cmd/Ctrl-K, so it's lazy-loaded on first
// use — its module stays out of the startup chunk. `ACTION_REGISTRY` is built
// later in this file but is in module scope by the time the user can press the
// shortcut, so the deferred init reads it safely.
let commandPalette: CommandPalette | null = null;
async function openCommandPalette(): Promise<void> {
  if (!commandPalette) {
    const { CommandPalette } = await loadCommandPalette();
    commandPalette = new CommandPalette();
    stage.overlay.append(commandPalette.element);
    commandPalette.setActions(ACTION_REGISTRY);
  }
  commandPalette.toggle();
}

// A dismissible "recommended view" chip surfaced after a scan loads.
const recommendedViewChip = new RecommendedViewChip();
stage.overlay.append(recommendedViewChip.element);

// v0.3.9 — keyboard shortcut sheet (open via `?`). Reads the same
// action registry as the palette so adding a new action makes it
// discoverable in both surfaces without a second touch.
// The shortcut sheet is only ever shown on a `?` press (or the "Show keyboard
// shortcuts" action), so it is lazy-loaded on first use to keep its ~250 lines
// out of the startup shell. Same direct-dynamic-import pattern as the command
// palette below.
let shortcutSheet: ShortcutSheet | null = null;
let shortcutSheetLoading: Promise<ShortcutSheet> | null = null;
function ensureShortcutSheet(): Promise<ShortcutSheet> {
  if (shortcutSheet) return Promise.resolve(shortcutSheet);
  if (!shortcutSheetLoading) {
    shortcutSheetLoading = loadShortcutSheet().then(({ ShortcutSheet }) => {
      const sheet = new ShortcutSheet();
      stage.overlay.append(sheet.element);
      sheet.setActions(ACTION_REGISTRY);
      shortcutSheet = sheet;
      return sheet;
    });
  }
  return shortcutSheetLoading;
}

// v0.3.9 — onboarding tour; offered from the splash chip and the command
// palette, imposed never. Boot logic lives in ui/onboarding/bootTour.ts.
tour = bootTour();

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
/** Confidence (0..1) of the most recent derive, for the Dataset Story / Export
 *  Health synthesis. Null when the active scan carries no derived classification. */
let lastDerivedConfidence: number | null = null;
async function runDeriveClassification(): Promise<void> {
  if (classifyRunning) return;
  if (!scans.activeId) {
    showLassoToast('Classify · open a scan first.');
    return;
  }
  const cloud = viewer.getCloud(scans.activeId);
  if (!cloud) {
    showLassoToast('Classify · this works on a loaded (non-streaming) scan.');
    return;
  }
  // Only derive when there is no producer classification to disturb. A scan that
  // is entirely Created(0)/Unclassified(1) — or carries no classification at all
  // — is fully derivable (this is the v0.4.8 unblock: an all-class-0 file, like a
  // raw photogrammetry export, is functionally unclassified and should classify).
  // A previous DERIVE is also re-derivable (its heuristic codes aren't producer
  // truth). But a real producer classification (any ASPRS code ≥ 2) is left
  // intact — we never overwrite a surveyor's classes.
  const isDerived = cloud.classificationIsDerived;
  const cov = isDerived
    ? { unclassified: cloud.pointCount, producer: 0 }
    : classificationCoverage(cloud.classification, cloud.pointCount);
  if (cov.producer > 0) {
    showLassoToast('Classify · this scan already carries a producer classification — left untouched.');
    return;
  }
  // RGB (when present) sharpens vegetation on photogrammetry, where geometry
  // alone is noisy — a green, locally-smooth canopy isn't mistaken for a roof.
  const deriveOptions = classifierCues(cloud);

  classifyRunning = true;
  showLassoToast('Classify · deriving ground / vegetation / building…');
  try {
    const id = scans.activeId;
    const result = await deriveClassificationAsync(
      cloud.positions,
      cloud.pointCount,
      deriveOptions,
      undefined,
      undefined,
      // Live phase in the toast so a multi-second derive reads as progress,
      // not a hang. (Off-thread, so the UI repaints between phases.)
      (phase) => showLassoToast(`Classify · ${phase}…`),
    );
    if (id !== scans.activeId || viewer.getCloud(id) !== cloud) return; // scan changed
    viewer.applyDerivedClassification(id, result.codes);
    noteEdit('classification');
    lastDerivedConfidence = Number.isFinite(result.confidence) ? result.confidence : null;
    classLegendPanel.setClasses(countClasses(result.codes));
    // Surface the run's honest confidence + caveats in the legend caption, not
    // just a flat "derived" tag — so the user sees WHEN to trust it.
    const confPct = Number.isFinite(result.confidence)
      ? Math.round(result.confidence * 100)
      : null;
    classLegendPanel.setDerivedProvenance(true, {
      confidencePct: confPct,
      warnings: result.warnings,
    });
    classLegendPanel.show();
    void showReclassifyUi();
    // Honest one-line breakdown of the top classes derived.
    const total = cloud.pointCount || 1;
    const top = Object.entries(result.counts)
      .map(([code, n]) => ({ code: Number(code), n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((e) => `${classificationLabel(e.code)} ${Math.round((e.n / total) * 100)}%`)
      .join(' · ');
    const confText = confPct !== null ? ` Confidence ${confPct}%.` : '';
    const warnText = result.warnings.length > 0 ? ` ⚠ ${result.warnings[0]}` : '';
    showLassoToast(`Classify · derived (heuristic, not survey-grade): ${top}.${confText}${warnText}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/abort/i.test(msg)) showLassoToast(`Classify · failed: ${msg}`);
  } finally {
    classifyRunning = false;
  }
}

/**
 * Fill ONLY the unclassified points of a partially-classified cloud, preserving
 * every producer class. Where {@link runDeriveClassification} declines a scan
 * that already carries producer classes (≥ 2), this is the deliberate surface
 * for them: it passes the existing classification to the deriver, which derives
 * the class-0/1 gaps and leaves the surveyor's classes untouched. The result is
 * tagged derived (heuristic) overall, because the filled points are guesses.
 */
async function runFillUnclassified(): Promise<void> {
  if (classifyRunning) return;
  if (!scans.activeId) {
    showLassoToast('Fill unclassified · open a scan first.');
    return;
  }
  const cloud = viewer.getCloud(scans.activeId);
  if (!cloud) {
    showLassoToast('Fill unclassified · this works on a loaded (non-streaming) scan.');
    return;
  }
  if (cloud.classificationIsDerived || !cloud.classification) {
    showLassoToast('Fill unclassified · no producer classification to preserve — use Classify (derive).');
    return;
  }
  const cov = classificationCoverage(cloud.classification, cloud.pointCount);
  if (cov.producer === 0) {
    showLassoToast('Fill unclassified · no producer classes here — use Classify (derive) for the whole scan.');
    return;
  }
  if (cov.unclassified === 0) {
    showLassoToast('Fill unclassified · every point already carries a class — nothing to fill.');
    return;
  }
  // Preserve the producer classes; RGB (when present) sharpens the filled gaps.
  const deriveOptions: DeriveClassificationOptions = {
    existingClassification: cloud.classification,
    ...classifierCues(cloud),
  };

  classifyRunning = true;
  showLassoToast(`Fill unclassified · deriving ${cov.unclassified.toLocaleString()} points (producer classes kept)…`);
  try {
    const id = scans.activeId;
    const result = await deriveClassificationAsync(
      cloud.positions,
      cloud.pointCount,
      deriveOptions,
      undefined,
      undefined,
      (phase) => showLassoToast(`Fill unclassified · ${phase}…`),
    );
    if (id !== scans.activeId || viewer.getCloud(id) !== cloud) return; // scan changed
    viewer.applyDerivedClassification(id, result.codes);
    noteEdit('classification');
    lastDerivedConfidence = Number.isFinite(result.confidence) ? result.confidence : null;
    classLegendPanel.setClasses(countClasses(result.codes));
    const confPct = Number.isFinite(result.confidence) ? Math.round(result.confidence * 100) : null;
    classLegendPanel.setDerivedProvenance(true, { confidencePct: confPct, warnings: result.warnings });
    classLegendPanel.show();
    void showReclassifyUi();
    const confText = confPct !== null ? ` Confidence ${confPct}%.` : '';
    showLassoToast(`Fill unclassified · filled ${cov.unclassified.toLocaleString()} points (heuristic); producer classes kept.${confText}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/abort/i.test(msg)) showLassoToast(`Fill unclassified · failed: ${msg}`);
  } finally {
    classifyRunning = false;
  }
}

/**
 * Gather the facts the fitness-for-use synthesis ({@link buildScanStory} /
 * {@link buildExportHealth}) reduces, from whatever the active scan already
 * exposes. Defensive throughout: any missing piece simply yields a thinner —
 * but never wrong — story, so the card/health surfaces work pre-analysis too.
 */
function buildCurrentStoryInputs(): ScanStoryInputs {
  const cloud = scans.activeCloud();
  const streaming = viewer.streamingCloud;
  let facts: ReturnType<typeof analysePanel.storyFacts> = null;
  // Null-safe: the panel is lazy-mounted, so a story built before the first scan
  // (or before its chunk resolves) simply has no analysis facts yet.
  try { facts = analysePanel?.storyFacts() ?? null; } catch { /* not analysed */ }
  let di: ReturnType<() => typeof inspector.datasetIntelligence> | null = null;
  try { di = inspector.datasetIntelligence; } catch { /* no intelligence yet */ }

  let pointCount: number | undefined;
  let areaM2: number | undefined;
  // Footprint area in m², but only when the CRS's linear unit is known.
  // `footprintAreaM2` fails closed on an unknown unit — which would report a raw
  // span² as metres — so the Story / Health omit the area rather than claim a
  // wrong one; a foot-CRS scan otherwise reads ~10.76x too large.
  const areaCrs = crsService.current();
  // Metadata read is the FALLBACK for georef; when an analysis has run, the
  // authoritative quality.crsKnown / quality.datumKnown from storyFacts wins, so
  // the Story / Health never disagree with the panel's own CRS / Datum chips.
  let metaCrsKnown: boolean | undefined;
  let metaDatumKnown: boolean | undefined;
  let classification: 'none' | 'source' | 'derived' | undefined;
  try {
    if (cloud) {
      const b = cloud.bounds();
      areaM2 = footprintAreaM2(b.max[0] - b.min[0], b.max[1] - b.min[1], areaCrs);
      pointCount = cloud.pointCount;
      const crs = cloud.metadata?.crs as { name?: string; verticalDatum?: unknown } | undefined;
      metaCrsKnown = !!crs?.name;
      metaDatumKnown = !!crs?.verticalDatum;
      classification = cloud.classificationIsDerived ? 'derived' : cloud.classification ? 'source' : 'none';
    } else if (streaming) {
      // Tight data AABB, not the octree cube — the cube overstates footprint
      // area (and understates density) for a partial-footprint scan.
      const lb = streaming.dataBounds();
      areaM2 = footprintAreaM2(lb[3] - lb[0], lb[4] - lb[1], areaCrs);
      pointCount = streaming.sourcePointCount;
      const sCrs = streaming.crs();
      metaCrsKnown = !!sCrs?.name;
      // Read the datum from the streamed source's own CRS (COPC VLRs / EPT srs)
      // instead of assuming none — a streamed scan can carry a vertical datum
      // exactly like an uploaded file.
      metaDatumKnown = !!sCrs?.verticalDatum;
      // Don't claim producer classification a streaming scan may not carry —
      // read the actual availability instead of hardcoding 'source'.
      classification = streaming.availableColorModes().includes('classification') ? 'source' : 'none';
    }
  } catch { /* a partial story is fine */ }

  return {
    pointCount,
    areaM2,
    surfaceTier: facts?.surfaceTier,
    products: facts?.products,
    density: di?.density.bucket,
    groundVisibility: di?.groundVisibility.bucket,
    coverageMode: di?.coverage.bucket,
    crsKnown: facts?.crsKnown ?? metaCrsKnown,
    datumKnown: facts?.datumKnown ?? metaDatumKnown,
    classification,
    classConfidence: lastDerivedConfidence,
  };
}

const ACTION_REGISTRY = buildActionRegistry({
  getViewer: () => viewer,
  getTour: () => tour,
  workflowController,
  lassoVolumeTool,
  compass,
  bookmarks,
  showLassoToast,
  setTheme,
  syncLassoButton,
  runDeriveClassification,
  runFillUnclassified,
  buildCurrentStoryInputs,
  startWorkflowRecording,
  dispatchWorkflowEvent,
  ensureWorkflowConfigPanel,
  ensureShortcutSheet,
  hasScan,
  saveCurrentView,
  applyView,
});
const duplicateActionIds = findDuplicateIds(ACTION_REGISTRY);
if (duplicateActionIds.length > 0) {
  // Throw at boot rather than silently surfacing two rows with the
  // same id — duplicates almost always mean a copy-paste bug.
  throw new Error(
    `Command palette: duplicate action ids: ${duplicateActionIds.join(', ')}`,
  );
}
// Both the command palette and the shortcut sheet are lazy: each wires
// ACTION_REGISTRY into its instance during its own first-use init.

// Cmd-K / Ctrl-K toggles the palette. Esc inside the palette closes
// it (handled internally), so the universal Esc handler below
// doesn't need to know about the palette.
window.addEventListener('keydown', (e) => {
  const isToggle = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
  if (!isToggle) return;
  e.preventDefault();
  void openCommandPalette();
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
  void ensureShortcutSheet().then((sheet) => sheet.toggle());
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
    // Lazy-mount aware: the panel may not exist yet (import in flight), so the
    // toggle reads/writes the tracked desired-visibility and mounts on demand.
    const show = analysePanel ? !analysePanel.isVisible() : !analyseDesiredVisible;
    // A manual Analyse toggle is a user override — stop auto-rerouting so a
    // late streaming node can't yank the panel away.
    routing.pin();
    analyseDesiredVisible = show;
    if (show) {
      // Opening: ensure the panel is mounted, then show it.
      void ensureAnalysePanel().then((p) => p.setVisible(true));
      // Opening Analyse demotes the Object panel — track the intent (so a still-
      // mounting Object panel replays hidden) and hide it now (no-op if unmounted).
      objectDesiredVisible = false;
      objectPanel?.setVisible(false);
    } else {
      // Hiding: no need to construct just to hide — no-op when not yet mounted.
      analysePanel?.setVisible(false);
    }
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
  onGradeFullCloud: () => void runFullCloudGradeAction(),
  onCancelGrade: () => cancelFullCloudGrade(),
});

// The Measurements panel lists placed measurements; the controller drives it.
const measurePanel = new MeasurePanel({
  onDelete: (id) => viewer.measure.removeMeasurement(id),
  onRename: (id, name) => viewer.measure.renameMeasurement(id, name),
  onExport: () => void exportSession(),
  // Route through the single file router so the Import button, the Open picker,
  // and a drag-drop all open a session identically (and a scan picked here
  // still loads as a scan).
  onImport: (file) => void handleFile(file),
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
  onProfileResample: (id, params) => viewer.measure.resampleProfile(id, params),
  // Profile-station hover → highlight the matching scene dot; repaint only when the dot changed.
  onStationHover: (id, i) => { if (viewer.measure.setHoveredStation(id, i)) viewer.requestFrame(); },
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
  crsService.subscribe(() => {
    // The ONE context for the active scan (the service invalidates it before it
    // broadcasts, so this is always the CRS that just landed). Measure scale,
    // trust grade, geographic refusal and the colorbar unit all read it, so the
    // HUD and the legend cannot describe different frames.
    const ctx = crsService.context();
    viewer.measure.setUnitToMetres(ctx.linearUnitToMetres);
    // Compound CRS: the height axis may carry its OWN linear unit (UTM metres +
    // a NAVD88 height in US survey feet). Heights / box height / cut-fill
    // thickness scale by it, and absent one the GeoTIFF convention follows the
    // horizontal factor, so single-unit CRSs stay byte-identical.
    viewer.measure.setVerticalUnitToMetres(verticalMetresPerUnit(ctx, 'horizontal') ?? 1);
    // A CRS is "known" for the measurement trust grade when one resolved with a
    // real linear unit. Distinct from the unit factor: a metric (UTM) survey has
    // factor 1 yet a fully-known CRS, so the factor alone can't certify scale.
    viewer.measure.setCrsKnown(ctx.linearUnitKnown);
    // A GEOGRAPHIC (degree) CRS can't be repaired by any scalar factor —
    // X/Y are degrees, Z is linear. The controller refuses the affected
    // trust grades + captions the hint; the panel shows the persistent
    // caveat. One boolean, one seam, so the two can never disagree.
    viewer.measure.setGeographicCrs(ctx.isGeographic);
    measurePanel.setGeographicNotice(ctx.isGeographic);
    // Colorbar legend — same context, `'horizontal-when-known'` policy: an
    // explicit vertical unit wins, else the horizontal one WHEN really declared
    // (an unknown CRS reports a pass-through 1 that must not read as metres).
    // `verticalUnitLabel` returns 'units' for odd factors; that is not a unit,
    // so it maps to null and the legend shows bare numbers (honesty rule).
    const vToM = verticalMetresPerUnit(ctx, 'horizontal-when-known');
    const vLabel = vToM != null ? verticalUnitLabel(vToM) : 'units';
    viewer.setElevationUnit(vLabel === 'units' ? null : vLabel);
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
// --- Lazy Analyse-panel mount (v0.6 P1) ---------------------------------------
// The Analyse panel is constructed on the FIRST scan load, not at boot, so its
// whole terrain-assessment DOM-builder chain stays out of the empty-state shell.
// Until then `analysePanel` is a null sentinel: every call site is null-guarded
// (or routes through `ensureAnalysePanel()`), and the synchronous scan-route
// pass that runs during reveal records its intent in the tracking vars below so
// `hydrateAnalysePanel()` can replay it the instant the panel mounts.
let analysePanel: AnalysePanel = null as unknown as AnalysePanel;
// Desired panel state, mirrored so a panel mounted a beat AFTER the scan route
// was computed (the dynamic import resolves later) replays the correct state.
let analyseDesiredVisible = false;
let analyseExpanded = false;
let analyseScanTypeArgs: Parameters<AnalysePanel['setScanType']> | null = null;
// Memoised first-mount promise so concurrent first-loads share one construction.
let _analyseReady: Promise<AnalysePanel> | null = null;

/**
 * Construct the Analyse panel with the SAME callbacks the eager version used.
 * Split out only so the (large) opts object keeps a shallow indentation; called
 * exactly once, from `ensureAnalysePanel()`.
 */
function newAnalysePanel(
  Ctor: Awaited<ReturnType<typeof loadAnalysePanel>>['AnalysePanel'],
): AnalysePanel {
  return new Ctor({
    onRun: () => void terrainRunner.run(),
    onScanTypeChange: (override) => setScanTypeOverride(override),
    onSelectInterval: (m) => void terrainRunner.run(m),
    // Side-effect-free contour rebuild at the dialog's chosen FINAL interval, over
    // the SAME cached terrain core the runner uses — never mutates the panel.
    buildResultAtInterval: (m) => terrainRunner.buildResultAtInterval(m),
    // Same cached-core rebuild, generalised with the contour shape-style picker so
    // an export reflects the user's chosen interval AND line shape.
    buildResultForExport: (opts) => terrainRunner.buildResultForExport(opts),
    getExportBasename: () => lastCloudName, getAnnotations: () => viewer.annotate.getAnnotations(), getActiveScanId: () => scans.activeId,
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
      if (!scans.activeId || !viewer.hasCoverageGrid()) return;
      const cloud = viewer.getCloud(scans.activeId);
      if (!cloud) return;
      // Toggle: if the confidence overlay is already on, clicking again restores
      // the colour mode that was active before it (RGB on a coloured scan), so the
      // button is always a round trip — the user is never stranded in yellow.
      if (currentColorMode === 'confidence') {
        const restore = confidenceColorPrev ?? defaultMode(cloud);
        currentColorMode = restore;
        viewer.setColorMode(scans.activeId, restore);
        inspector.setColorModes(availableModes(cloud), restore);
        syncInspectorVisuals();
        analysePanel?.setConfidenceColorActive(false);
        return;
      }
      confidenceColorPrev = currentColorMode ?? defaultMode(cloud);
      currentColorMode = 'confidence';
      viewer.setColorMode(scans.activeId, 'confidence');
      inspector.setColorModes(availableModes(cloud), 'confidence');
      syncInspectorVisuals();
      analysePanel?.setConfidenceColorActive(true);
      // The 3D overlay tints each point by the trust of the ground beneath it.
      // Points cluster over MEASURED ground, so a surface that is largely
      // interpolated still paints mostly "strong" in 3D — the interpolated share
      // sits in point-sparse voids that have little to colour. Say so, and point
      // the user at the 2D Coverage tile, which shows every cell. Only caption
      // when interpolation is a meaningful share, so a clean scan stays quiet.
      const summary = viewer.coverageGridCellSummary();
      if (summary && summary.interpFrac >= 0.2) {
        const pct = Math.round(summary.interpFrac * 100);
        showLassoToast(
          `Confidence colour shows ground-survey trust under each point. ${pct}% of the ` +
            `surface is interpolated and point-sparse, so 3D reads mostly strong — see the ` +
            `2D Coverage tile for the full per-cell map.`,
        );
      }
    },
    getMapContext: () => {
      const cloud = scans.activeCloud();
      // Streamed COPC / EPT scans never enter `viewer.getCloud` — their
      // recentre offset lives on the streaming source (`renderOrigin`) and
      // their CRS on `crs()`. Fall back to those when no static cloud is
      // active, so a contour export from a streamed scan keeps its world
      // origin and EPSG stamp instead of silently degrading to local frame.
      const streaming = cloud ? null : viewer.streamingCloud;
      const origin = cloud?.origin ?? streaming?.renderOrigin;
      const cur = crsService.current();
      // The ONE context for this export, so sheet, DXF and GeoJSON describe one
      // frame. `cur` survives only where the RESOLVED object is itself needed
      // (the lon/lat converter) and for `linearUnit`, where "no scan yet" and
      // "unknown CRS" differ and the context collapses them.
      const ctx = crsService.context();
      return {
        // All three axes: contour serialization shifts elevations by `z` so
        // exported contour levels read in real-world (e.g. orthometric) height
        // rather than the recentred local frame.
        worldOrigin: origin ? { x: origin[0], y: origin[1], z: origin[2] } : null,
        title: `${lastCloudName} — Contours`,
        sheet: 'letter',
        isGeographic: ctx.isGeographic, sceneUpAxis: terrainRunner.getLastSourceUpAxis(),
        wkt: cloud?.metadata?.crs?.wkt ?? streaming?.crs()?.wkt ?? null,
        // The resolved CRS's linear unit (same seam every other unit consumer
        // reads) so a foot-based CRS stamps DXF $INSUNITS = feet and the SVG
        // scale note says ft — and a local/unresolved frame stamps an honest
        // "unitless" rather than asserting metres. Undefined before a CRS
        // resolves ⇒ serializeContours keeps its standing metre default.
        linearUnit: cur?.linearUnit,
        // Source frame → WGS 84 lon/lat, for the RFC 7946 contour GeoJSON.
        // Built from the SAME resolved CRS and world origin the rest of this
        // context uses, so the standard export and the native one describe one
        // scan. Null when the CRS cannot be converted — the export then refuses
        // rather than writing eastings into a longitude field.
        // Anchored at the scan's own origin, because the converter probes the
        // anchor to decide whether it can work at all — probing (0,0) would
        // fail every UTM grid. Contour coordinates arrive already shifted to
        // world, so they are re-localised against that same anchor here.
        toLonLat: (() => {
          if (!origin || !cur) return undefined;
          const m = makeLocalToLonLat(cur, [origin[0], origin[1], origin[2]]);
          if (!m) return undefined;
          return (p: readonly [number, number, number]): [number, number, number] =>
            m([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
        })(),
        // Metres per source VERTICAL (Z) unit: the CRS's own vertical factor when
        // it declares one, else the horizontal linear factor when the frame is
        // actually resolved (GeoTIFF default: vertical follows the model's linear
        // unit — so a metre CRS reads "m", a foot CRS "ft"). A local / unknown
        // frame (linearUnit 'unknown') leaves this undefined so the deliverable
        // elevation unit + the contour interval / relief show an honest
        // "unverified" unit rather than a false metre. The complete deliverable,
        // and the Analyse panel's readiness / recommend / map-sheet notes, read this.
        verticalUnitToMetres: verticalMetresPerUnit(ctx, 'horizontal-when-known'),
      };
    },
  });
}

/**
 * Construct + mount the Analyse panel exactly once, pulling its chunk through
 * `loadAnalysePanel()`. Idempotent and memoised: concurrent first-mounts share
 * the single in-flight promise, and the double-construct guard means only one
 * panel is ever built. After construction it inserts into the DOM (desktop left
 * column, or the mobile sheet when that layout is active) and hydrates the
 * tracked state.
 */
function ensureAnalysePanel(): Promise<AnalysePanel> {
  if (analysePanel) return Promise.resolve(analysePanel);
  if (_analyseReady) return _analyseReady;
  _analyseReady = loadAnalysePanel().then(({ AnalysePanel: Ctor }) => {
    // A concurrent caller may have won the race while the import was in flight.
    if (!analysePanel) {
      analysePanel = newAnalysePanel(Ctor);
      // Insert into the DOM in its canonical spot; no-op in bare/embed mode
      // where no left column was built.
      mountAnalysePanelElement?.(analysePanel.element);
      // Replay whatever state the (already-run) scan route asked for.
      hydrateAnalysePanel();
    }
    return analysePanel;
  });
  return _analyseReady;
}

/**
 * Replay the tracked Analyse-panel state onto the freshly-mounted panel — the
 * "Treat as" control, visibility, expand state, and confidence-colour toggle —
 * so a panel that mounted a beat after the scan route was computed shows exactly
 * what the route asked for. Called once from `ensureAnalysePanel()`.
 */
function hydrateAnalysePanel(): void {
  if (!analysePanel) return;
  if (analyseScanTypeArgs) analysePanel.setScanType(...analyseScanTypeArgs);
  analysePanel.setVisible(analyseDesiredVisible);
  if (analyseExpanded) analysePanel.expand();
  analysePanel.setConfidenceColorActive(currentColorMode === 'confidence');
}

// Classification legend — one row per ASPRS class present in the scan, with a
// colour swatch (matching "colour by class"), a live "shown" point count, and a
// visibility checkbox. DISPLAY ONLY: a change applies the 256-entry mask to the
// GPU and re-renders the legend; it does NOT scope metrics/analysis. v0.4.1.
// The streaming cloud whose header report is currently shown, kept so a later
// class-filter toggle can re-stamp the not-class-scoped sentinel without
// re-deriving it from scratch. Null for static scans / the empty state.
let lastStreamingReportCloud: Parameters<typeof runStreamingModules>[0] | null = null;

const classLegendPanel = new ClassLegendPanel();

// Manual classification-edit panel — lazy-loaded and mounted just below the
// legend the first time a classification appears, so its controls + lasso tool
// stay out of the startup shell. `showReclassifyUi()` is called wherever a
// classification becomes available; `hideReclassifyUi()` on detach.
let reclassifyUi: ReclassifyUi | null = null;
let reclassifyUiLoading: Promise<void> | null = null;
async function showReclassifyUi(): Promise<void> {
  if (reclassifyUi) {
    reclassifyUi.setVisible(true);
    reclassifyUi.refresh();
    return;
  }
  // Dedupe concurrent first-mounts so the panel is only ever created once.
  if (!reclassifyUiLoading) {
    reclassifyUiLoading = (async () => {
      const { createReclassifyUi } = await loadReclassifyUi();
      const ui = createReclassifyUi({
        canvas: stage.canvas,
        getViewer: () => viewer,
        getActiveId: () => scans.activeId,
        onToast: showLassoToast,
        onAutoClassify: () => runDeriveClassification(),
      });
      classLegendPanel.element.after(ui.element);
      reclassifyUi = ui;
    })();
  }
  await reclassifyUiLoading;
  // Cast: TS can't see the async IIFE reassign the outer `let` across the await.
  (reclassifyUi as ReclassifyUi | null)?.setVisible(true);
}
function hideReclassifyUi(): void {
  reclassifyUi?.setVisible(false);
}

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
    if (scans.activeId) viewer.setColorMode(scans.activeId, 'classification');
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
  const cloud = scans.activeCloud();
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
      // Streaming counts are a running tally over decoded nodes (folded below
      // as more arrive), not full-file totals — disclose that in the legend.
      // setClasses() resets the flag, so set it after seeding.
      classLegendPanel.setStreamingMode(true);
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
  // Colour-context changes (mode / trim / cloud / unit, static AND
  // streaming) drive the live colorbar legend through one seam.
  viewer.onColorContextChanged = refreshColorbarOverlay;
  viewer.onStreamingNodeReady = () => {
    // Seed the elevation + intensity filter controls once the first node is
    // resident (idempotent + guarded, so it runs a single time per streaming
    // scan). Fixes the streaming filter controls staying hidden.
    seedStreamingFilterExtents();
    // The cloud-global colour ranges reseed as coarser nodes arrive
    // (StreamingRenderer.onNodeReady) — keep the legend's window in step.
    // The overlay no-ops on an unchanged spec, so this per-node call is free.
    refreshColorbarOverlay();
    // A manual (non-auto) "Treat as" choice pins the routing exactly like the
    // "Run terrain anyway" override — a late streaming node must not flip it.
    if (routing.pinned) return;
    const resident = viewer.residentPointTotal();
    if (resident < lastRouteResident * SCAN_REROUTE_GROWTH) return;
    lastRouteResident = resident;
    routing.schedule(() => applyScanRoute(false), 500);
  };
  // GPU render-stage failures (shader-compile / pipeline-creation) surface on the
  // WebGPU device's uncaptured-error channel — AFTER a scan's decode + attach have
  // already resolved. Without this hook such a failure is silent: the scan "opens",
  // the progress toast clears, and the canvas stays blank with no reason shown
  // (the exact "scans not opening and doesn't show why" report). Route it to BOTH
  // surfaces a scan can be opened from — the drop-zone toast (device files) and the
  // catalog status line (public datasets) — so whichever the user just used shows
  // the cause. De-duplicated inside the Viewer, so this fires once per distinct error.
  viewer.onGpuError = (message) => {
    const friendly =
      `The GPU couldn't render this scan (${message}). ` +
      `Try a smaller scan, reload the page, or update your browser/GPU drivers.`;
    dropZone.setError(friendly);
    catalogPanel.showOpenError(friendly);
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


// --- Lazy Object/Space-panel mount (v0.6 P1, step 2) --------------------------
// Object-scan panel — shown instead of terrain analysis for compact 3-D scans
// (phone scans of objects / rooms). "Run anyway" reveals + runs the terrain
// pipeline if the shape detector misjudged the scan. Constructed on the FIRST
// scan load, not at boot, so its DOM-builder chain — and the `scanTypeControl`
// it shares only with the (now-lazy) Analyse panel — stay out of the empty-state
// shell. Until then `objectPanel` is a null sentinel: every call site is
// null-guarded (or routes through `ensureObjectPanel()`), and the synchronous
// scan-route pass records its intent in the tracking vars below so
// `hydrateObjectPanel()` can replay it the instant the panel mounts.
let objectPanel: ObjectPanel = null as unknown as ObjectPanel;
// Desired panel state, mirrored so a panel mounted a beat AFTER the scan route
// was computed (the dynamic import resolves later) replays the correct state.
let objectDesiredVisible = false;
let objectScanTypeArgs: Parameters<ObjectPanel['setScanType']> | null = null;
// The last content the route asked the panel to render (showSpace / showObject),
// captured verbatim so a panel that mounts after the route ran shows the same
// report — not a stale empty state. Null before any non-terrain route.
let objectContent:
  | { readonly kind: 'space'; readonly args: Parameters<ObjectPanel['showSpace']> }
  | { readonly kind: 'object'; readonly args: Parameters<ObjectPanel['showObject']> }
  | null = null;
// Memoised first-mount promise so concurrent first-loads share one construction.
let _objectReady: Promise<ObjectPanel> | null = null;

/**
 * Construct the Object/Space panel with the SAME callbacks the eager version
 * used. Split out only so the (large) opts object keeps a shallow indentation;
 * called exactly once, from `ensureObjectPanel()`.
 */
function newObjectPanel(
  Ctor: Awaited<ReturnType<typeof loadObjectPanel>>['ObjectPanel'],
): ObjectPanel {
  return new Ctor({
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
    const { floorPlanConfidence } = await loadFloorPlanConfidence();
    objectPanel.showFloorPlanSummary(floorPlanConfidence(plan));
  },
  });
}

/**
 * Construct + mount the Object panel exactly once, pulling its chunk through
 * `loadObjectPanel()`. Idempotent and memoised: concurrent first-mounts share
 * the single in-flight promise, and the double-construct guard means only one
 * panel is ever built. After construction it inserts into the DOM (desktop left
 * column, or the mobile sheet when that layout is active) and hydrates the
 * tracked state. Mirrors `ensureAnalysePanel`.
 */
function ensureObjectPanel(): Promise<ObjectPanel> {
  if (objectPanel) return Promise.resolve(objectPanel);
  if (_objectReady) return _objectReady;
  _objectReady = loadObjectPanel().then(({ ObjectPanel: Ctor }) => {
    // A concurrent caller may have won the race while the import was in flight.
    if (!objectPanel) {
      objectPanel = newObjectPanel(Ctor);
      // Insert into the DOM in its canonical spot; no-op in bare/embed mode
      // where no left column was built.
      mountObjectPanelElement?.(objectPanel.element);
      // Replay whatever state the (already-run) scan route asked for.
      hydrateObjectPanel();
    }
    return objectPanel;
  });
  return _objectReady;
}

/**
 * Replay the tracked Object-panel state onto the freshly-mounted panel — the
 * "Treat as" control, the last space/object report content, and visibility — so
 * a panel that mounted a beat after the scan route was computed shows exactly
 * what the route asked for. Called once from `ensureObjectPanel()`.
 */
function hydrateObjectPanel(): void {
  if (!objectPanel) return;
  if (objectScanTypeArgs) objectPanel.setScanType(...objectScanTypeArgs);
  if (objectContent) {
    if (objectContent.kind === 'space') objectPanel.showSpace(...objectContent.args);
    else objectPanel.showObject(...objectContent.args);
  }
  objectPanel.setVisible(objectDesiredVisible);
}

// Terrain-analysis runner — extracted into `src/app/`. Constructed here, after
// `analysePanel`, so the panel/object-panel callbacks above (which fire only on
// user input) can drive it. Reads the lazy `viewer` and the `scans.activeId`
// selection through getters so no top-level `viewer.*` dereference is added.
const terrainRunner = createTerrainAnalysisRunner({
  getViewer: () => viewer,
  // The panel is lazy-mounted (ensureAnalysePanel), so the runner reads it
  // through a getter — never captures the boot-time null sentinel. Every runner
  // entry point (onRun / onSelectInterval callbacks, the "run anyway" hatches)
  // fires only after the panel has mounted, so this always resolves non-null.
  getAnalysePanel: () => analysePanel,
  getActiveId: () => scans.activeId,
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
    // Fold the run's ENGINE-DERIVED terrain complexity (the VRM/TPI summary
    // computed alongside the core, off the interactive path) into the card:
    // the band label replaces the header-time heuristic and the numeric
    // median + IQR with window and units rides as the row's hover detail. A
    // run that measured nothing (null summary/band) leaves the row honest.
    const cx = result.complexity;
    inspectorCards.noteTerrainComplexity(
      cx && cx.band ? { bucket: cx.band, label: cx.bandLabel, detail: cx.detail } : null,
    );
  },
});

// Honesty guard: a manual classification edit changes the bare-earth surface, so
// any cached terrain core / on-screen grade computed from the old classes is now
// stale. Drop the cache (and abort any in-flight compute) the moment an edit
// lands, so the next Analyse recomputes against the edited classes instead of
// serving a number that silently no longer matches what's on screen.
void viewerLoaded.then((v) => {
  v.onClassificationEdited = () => {
    terrainRunner.abortAndClearCache();
    // The cache is gone but the RENDERED result/contours are not — without a
    // caveat they read as current while reflecting the previous classes. The
    // panel no-ops when nothing is on screen; a completed re-run clears it.
    analysePanel?.setStaleNotice(
      'Classification edited — results reflect the previous classification. Re-run Analyse to refresh.',
    );
  };
});

// Per-cloud source files + reduced flags, so the Export panel can re-decode a
// local file at full resolution (the viewer keeps only the display-reduced
// cloud for large scans). Streamed/remote scans have no entry here.
const sourceFileById = new Map<string, File>();
const reducedById = new Map<string, boolean>();

// In-project "Export / Convert" panel — converts the open cloud to LAS / XYZ
// / ASC with the same CRS options as the splash batch converter. The engine
// (proj4) is imported lazily on Export, so this panel adds nothing heavy.
// Streaming export snapshot — the Convert lane exports the resident (decoded-
// so-far) points of a streaming scan. Building it concatenates every frontier
// node, so it is materialised only at the actual Export click: the panel's live
// summary reads the allocation-free `summaryInfo`, and the pending check uses
// `exportFrontierPointTotal`, so nothing else reaches here. It is deliberately
// NOT memoised — the old resident-count key returned a stale coarse snapshot
// when the frontier changed composition (parent → children) at the same total
// count. A fresh snapshot is always the current frontier.
function streamingExportCloud(): PointCloud | null {
  // `viewer` is null until the lazy Viewer chunk resolves; guard the deref.
  const sc = viewer?.streamingCloud;
  if (!sc) return null;
  return viewer.snapshotResidentCloud();
}

/**
 * Origin + CRS + name for the ACTIVE scan, static OR streaming — a thin caller
 * over the extracted `src/app/reportExport.ts`. The origin-resolution rule (static
 * `sourceOrigin`, else streaming `renderOrigin`, else zero) and the CRS-label
 * honesty rule (`effectiveCrsName`) live in that module; here we bind the shell's
 * running state through `reportExportDeps`.
 */
function exportGeoContext(): GeoExportContext {
  return runExportGeoContext(reportExportDeps);
}

/**
 * The running-app seam the two Google Earth products write through (see
 * `src/app/kmlActions.ts`). Accessors, not snapshots, so the lazily-bound Viewer
 * and the current CRS are read at call time.
 */
const kmlDeps: KmlActionDeps = {
  hasViewer: () => Boolean(viewer),
  geo: exportGeoContext,
  crsCurrent: () => crsService.current(),
  annotations: () => viewer?.annotate.getAnnotations() ?? [],
  measurements: () => viewer?.measure.getMeasurements() ?? [],
  viewpoints: () =>
    viewBookmarks.savedViews.map((v) => ({
      name: v.name,
      position: v.pose.position,
      target: v.pose.target,
    })),
  worldUp: () => viewer.measure.worldUp,
  unitToMetres: () => viewer.measure.unitToMetres,
  // Static: the bounds of the points actually loaded. Streaming: the LAS header
  // extent, which the source DECLARES and can be wider than the nodes fetched so
  // far — different claims, so the basis travels into the file. So does the
  // up-axis: X/Y is the horizontal plane only in a Z-up frame, and the footprint
  // gate refuses the rest. Streaming COPC/EPT are LAS-derived, hence Z-up.
  scanExtent: () => {
    const c = scans.activeCloud();
    if (c) {
      const b = c.bounds();
      return {
        extent: { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] },
        basis: 'the resident points', upAxis: isZUpFormat(c.sourceFormat) ? 'z' : 'y',
      };
    }
    const b = viewer?.streamingCloud?.dataBounds();
    if (!b) return null;
    return {
      extent: { minX: b[0], minY: b[1], maxX: b[3], maxY: b[4] },
      basis: 'the declared header extent', upAxis: 'z',
    };
  },
  baseName: (name) => baseName(name),
  downloadText: (filename, text) => downloadText(filename, text),
  setError: (message) => dropZone.setError(message),
  loadKmlExport,
};

const exportPanel = new ExportPanel({
  // Allocation-free summary for the live panel — NEVER snapshots the streaming
  // resident set (that ~150 MB materialization is deferred to the Export click
  // via getCloud below). Reads only scalar facts: resident count + colour/CRS
  // capabilities the streaming source already knows.
  summaryInfo: () => {
    // `viewer` is null until the lazy Viewer chunk resolves, and ExportPanel's
    // constructor calls this (via _renderSummary) during startup — before that.
    // Optional-chain both derefs, exactly like isReduced / streamingExportCloud;
    // an explicit `viewer == null` check would trip TS2367 (viewer is typed
    // non-null via a cast). No viewer ⇒ nothing exportable yet.
    if (scans.activeId != null) {
      const c = viewer?.getCloud(scans.activeId);
      if (!c) return null;
      const crs = c.metadata?.crs ?? null;
      return {
        pointCount: c.pointCount,
        hasRgb: c.colors != null,
        hasGpsTime: c.gpsTime != null,
        crsName: crs?.name ?? null,
        hasWkt: crs?.wkt != null,
        classProvenance: c.classificationIsDerived
          ? 'derived'
          : c.classification != null ? 'source' : 'none',
      };
    }
    const sc = viewer?.streamingCloud;
    if (!sc) return null;
    const crs = sc.crs();
    return {
      // The frontier total, not the resident total: an export drops ancestor
      // nodes that have a resident descendant, so counting every resident point
      // promised roughly twice the points and bytes the write delivered.
      pointCount: viewer.exportFrontierPointTotal(),
      hasRgb: sc.availableColorModes().includes('rgb'),
      // COPC/EPT point records (PDRF 6/7/8) carry GPS time.
      hasGpsTime: true,
      crsName: crs?.name ?? null,
      hasWkt: crs?.wkt != null,
      // Streaming classification is read straight from the source records — a
      // decode never derives it — so it is 'source' when the schema carries it.
      classProvenance: sc.availableColorModes().includes('classification') ? 'source' : 'none',
    };
  },
  getCloud: () => (scans.activeId ? viewer.getCloud(scans.activeId) ?? null : streamingExportCloud()),
  // Pending = a streaming cloud is attached but its export frontier is still
  // empty. Read the allocation-free frontier count rather than materialising a
  // snapshot just to test it for null.
  isStreamingPending: () => viewer?.streamingCloud != null && viewer.exportFrontierPointTotal() === 0,
  getActiveClip: () => viewer.getClip(), getActiveScanId: () => scans.activeId,
  hasFullSource: () => scans.activeId != null && sourceFileById.has(scans.activeId),
  hasClassEdits: () => scans.activeId != null && (viewer?.canUndoClassification(scans.activeId) ?? false),
  // A streaming snapshot exports only resident points, so it is a reduced subset
  // until the whole cloud lands — flagged so the status reads "reduced view".
  isReduced: () => {
    if (scans.activeId != null) return reducedById.get(scans.activeId) === true;
    // `viewer` is null until the lazy Viewer chunk resolves, and ExportPanel's
    // constructor calls this (via _renderFullResRow) during startup — before
    // that. Optional-chain the deref: with no viewer there is no streaming
    // cloud, so nothing is a reduced view yet. (An explicit `viewer == null`
    // check would trip TS2367 since `viewer` is typed non-null via a cast.)
    const sc = viewer?.streamingCloud;
    return sc != null && sc.residentPointCount < sc.sourcePointCount;
  },
  getFullCloud: async () => {
    const f = scans.activeId ? sourceFileById.get(scans.activeId) : null;
    if (!f) return null;
    // Full-resolution re-decode reads the whole file into memory and expands it
    // into typed attribute arrays — several × the file size at peak. A user can
    // preview a multi-GB scan fine, then crash the tab on full-res export, so
    // confirm before decoding a large source. The confirm pulls the dialog +
    // byte formatter, so it's lazy-loaded here (full-res export is a deliberate
    // action) to keep it out of the eager startup chunk. Declining aborts.
    const { confirmFullExport } = await loadConfirmFullExport();
    if (!(await confirmFullExport(f))) return null;
    return decodeFull(await f.arrayBuffer(), f.name);
  },
  // Called synchronously while the ExportPanel builds its Products lane — which
  // happens before the lazy `viewer` chunk resolves, so it must tolerate a null
  // viewer (return 0) instead of dereferencing it and crashing app init.
  measurementCount: () => (viewer ? viewer.measure.getMeasurements().length : 0),
  exportMeasurements: async (format) => {
    if (!viewer) return;
    const measurements = viewer.measure.getMeasurements();
    if (measurements.length === 0) return;
    // Measurement points are LOCAL (recentered); add the origin back to land them
    // in the source projected/local frame. `exportGeoContext` resolves the
    // origin for streaming scans too (renderOrigin) — a plain static-only read
    // would export at render-frame coordinates. Geographic reprojection
    // (→ lon/lat) is a later option — for now we emit in the scan's own frame.
    // Resolved BEFORE the import below (as exportIntegrityReport already does),
    // so the frame and the measurements come from one instant, not two.
    const geo = exportGeoContext();
    const ctx: MeasurementExportContext = {
      toOutput: (p) => [p[0] + geo.origin[0], p[1] + geo.origin[1], p[2] + geo.origin[2]],
      up: viewer.measure.worldUp,
      unitToMetres: viewer.measure.unitToMetres,
      verticalUnitToMetres: viewer.measure.verticalUnitToMetres,
      crsName: geo.crsName,
      geographic: false,
    };
    const { measurementsToGeoJSON, measurementsToCsv } = await loadMeasurementExport();
    const text = format === 'geojson'
      ? measurementsToGeoJSON(measurements, ctx)
      : measurementsToCsv(measurements, ctx);
    const stem = geo.name ? baseName(geo.name) : 'measurements';
    downloadText(`${stem}-measurements.${format === 'geojson' ? 'geojson' : 'csv'}`, text);
  },
  exportIntegrityReport: async () => {
    if (!viewer) return;
    const ms = viewer.measure.getMeasurements();
    if (ms.length === 0) return;
    const geo = exportGeoContext();
    const { integrityReportFile } = await loadMeasurementReport();
    const f = integrityReportFile(
      ms,
      viewer.measure.worldUp,
      viewer.measure.unitToMetres,
      viewer.measure.verticalUnitToMetres,
      geo.name ? baseName(geo.name) : 'scan',
      geo.crsName,
      new Date().toISOString(),
      scans.activeId ? viewer.classificationEpoch(scans.activeId) : 0,
      __APP_VERSION__,
    );
    downloadText(f.filename, f.text);
  },
  exportKml: () => void exportSiteKml(kmlDeps),
  kmlStatus: () => siteKmlStatus(kmlDeps),
  exportScanFootprint: () => void exportScanFootprintKml(kmlDeps),
  scanFootprintStatus: () => scanFootprintStatus(kmlDeps),
});

// Drive the Export panel's Coordinate-System auto-collapse from the CRS service:
// an ungeoreferenced (local / unknown) scan has no real-world CRS to keep /
// assign / reproject, so the step collapses to a one-line note. A georeferenced
// scan behaves exactly as before. Fires on every resolve / override change, plus
// once here to seed the initial (no-scan ⇒ collapsed) state.
crsService.subscribe((resolved) => {
  exportPanel.setCrsKnown(crsIsKnown(resolved));
});
exportPanel.setCrsKnown(crsIsKnown(crsService.current()));

// Clip box — an axis-aligned slab the viewer renders through (GPU clipping
// planes) with an exact CPU kept-count. The keep/cull math is the pure
// `clipBox` core; this panel + the viewer wiring realise it.
const clipPanel = new ClipPanel({
  // `viewer?.` — ClipPanel's constructor calls setVisible(false) → onApply(null)
  // synchronously, which fires before the deferred Viewer is assigned (it's
  // `null` until the first scan loads). Clearing a clip on a non-existent viewer
  // is a no-op, so guard like every other boot-reachable viewer callback here.
  onApply: (clip: ClipBox | null) => viewer?.setClip(clip),
  fitBounds: () => {
    const c = scans.activeCloud();
    return c ? c.bounds() : null;
  },
  keptCount: () => (scans.activeId ? viewer.clipKeptCount(scans.activeId) : null),
});

// ── Scan-type routing state ─────────────────────────────────────────────────
// `revealAnalysePanel` runs once at open, when a streaming cloud may have only
// a sparse coarse level resident — a misread is likely. `applyScanRoute` is
// re-run as the cloud fills in (debounced, growth-gated) and only flips panels
// when the verdict actually changes, so it never thrashes. Once the user forces
// a panel ("Run terrain anyway" / Analyse toggle) `routing.overridden` pins it.
let lastScanVerdict: SpaceKind | null = null;
let lastRouteResident = 0;
/** Re-route only after the resident cloud grows by this factor (cheap gate). */
const SCAN_REROUTE_GROWTH = 1.4;

// ── Manual scan-type override ────────────────────────────────────────────────
// The safety net for a misdetection: the user can FORCE the route via the
// "Treat as" control in either panel. A non-auto choice WINS over the detected
// verdict and pins the routing like `routing.overridden` so a streaming
// re-evaluation can't flip it. Per-session, reset to 'auto' on every new scan.
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
// `routing.typeOverride`/detection exactly as before, it never pins anything, and
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
  routing.setTypeOverride(override);
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
  // A non-auto manual override pins the routing exactly like `routing.overridden`:
  // a streaming re-evaluation must never flip a deliberate user choice. The
  // one-shot is spent: a pinned/manual session never soft-commits.
  if (!initial && (routing.pinned)) return true;
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
    override: routing.typeOverride,
    initial,
    lastVerdict: lastScanVerdict,
    pinned: routing.overridden,
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
    override: routing.typeOverride,
    pinned: routing.overridden,
    applied: plan.apply,
    committed: plan.commitDetected !== null,
    attempts: settleAttempts,
  });
  if (!plan.apply) {
    if (plan.commitDetected !== null) {
      const committedDisabled = treatAsDisabledFor(detected);
      // Track for hydration + apply (no-op while the panel's chunk is in flight).
      objectScanTypeArgs = [routing.typeOverride, plan.commitDetected, committedDisabled, true];
      objectPanel?.setScanType(...objectScanTypeArgs);
      analyseScanTypeArgs = [routing.typeOverride, plan.commitDetected, committedDisabled, true];
      analysePanel?.setScanType(...analyseScanTypeArgs);
    }
    return oneShotSpent;
  }
  const effective = plan.effective;
  lastScanVerdict = effective;

  const isNonTerrain = plan.showObjectPanel;
  if (isNonTerrain && shape && gathered) {
    const activeCloud = scans.activeCloud();
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
    // The active scan's context, so a foot-based CRS reports honest metre/feet
    // dimensions from the same object the terrain core reads.
    const spaceCtx = crsService.context();
    const unitToMetres = spaceCtx.linearUnitToMetres;
    const space = spaceMetrics(gathered.positions, {
      upAxis: shape.up,
      spaceKind: effective === 'interior' ? 'interior' : 'object',
      unitToMetres,
      unitKnown: spaceCtx.linearUnitKnown,
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
    // Track the content for hydration; apply now (no-op if not yet mounted).
    if (spaceKind === 'interior') {
      objectContent = { kind: 'space', args: [space, shape] };
      objectPanel?.showSpace(space, shape);
    } else {
      objectContent = { kind: 'object', args: [object, space, shape] };
      objectPanel?.showObject(object, space, shape);
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
    if (effective === 'interior') {
      objectContent = { kind: 'space', args: [null, null] };
      objectPanel?.showSpace(null, null);
    } else {
      objectContent = { kind: 'object', args: [null, null, null] };
      objectPanel?.showObject(null, null, null);
    }
  } else {
    lastSpaceExport = null;
  }
  // Track desired visibility for hydration; apply now (no-op if not yet mounted).
  objectDesiredVisible = plan.showObjectPanel;
  objectPanel?.setVisible(plan.showObjectPanel);
  analyseDesiredVisible = plan.showAnalysePanel;
  analysePanel?.setVisible(plan.showAnalysePanel);
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
  const committed = routing.typeOverride === 'auto' && scanDetectionCommitted;
  // Track for hydration + apply (no-op while the panel's chunk is in flight).
  objectScanTypeArgs = [routing.typeOverride, effective, treatAsDisabled, committed];
  objectPanel?.setScanType(...objectScanTypeArgs);
  analyseScanTypeArgs = [routing.typeOverride, effective, treatAsDisabled, committed];
  analysePanel?.setScanType(...analyseScanTypeArgs);
  // Forcing terrain is the explicit "run anyway": surface the Analyse panel
  // AND kick the pipeline, matching the old escape hatch. The panel must also
  // EXPAND out of its collapsed-chip state — it is built collapsed, and routing
  // the user to a chip that hides the busy state, the result, and the way back
  // is exactly the dead-panel bug this guards against. `plan.runTerrain` is
  // true ONLY for the manual 'terrain' override — a detected-terrain route
  // shows the collapsed panel but NEVER starts the analysis by itself.
  if (plan.runTerrain) {
    // The explicit "run terrain anyway" hatch: mount the panel (if the import is
    // still in flight), expand it out of its collapsed chip, then run. Mounting
    // first guarantees the busy state + result have somewhere to land.
    analyseExpanded = true;
    void ensureAnalysePanel().then((p) => {
      p.expand();
      void terrainRunner.run();
    });
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

// Set once the desktop left-panel column (and mobile sheet) are built (full app
// only). Lets the lazily-mounted Analyse panel insert itself into the DOM in its
// canonical spot the instant its chunk resolves — the column is built before any
// scan (thus before the panel exists), so it can't be appended eagerly. The
// closure routes into the mobile sheet's Analyse slot when that layout is active,
// else between the class-legend and export panels in the left column. Null in
// bare/embed mode (no column), where the panel simply stays detached as before.
let mountAnalysePanelElement: ((el: HTMLElement) => void) | null = null;
// Same seam for the (also lazy) Object panel — inserts it just before the
// class-legend panel in the left column, or into the mobile Analyse slot (after
// the Analyse panel) when that layout is active. Null in bare/embed mode.
let mountObjectPanelElement: ((el: HTMLElement) => void) | null = null;

function revealAnalysePanel(name: string, settled = true): void {
  lastCloudName = baseName(name);
  exportPanel.setVisible(true);
  exportPanel.refresh();
  // Build the measure snap index from the resident cloud (static scans only;
  // a streaming scan has no resident array, so snapping stays off and says so).
  const snapCloud = scans.activeCloud();
  viewer.measure.setSnapSource(snapCloud?.positions ?? null);
  // Reveal the clip control and seed its box from this scan's bounds (disabled
  // until the user enables it). Skip the reseed when the viewer already holds
  // a clip — a session restore may have landed one before the scan revealed,
  // and fitToScan() applies with the panel's own (disabled) flag, which would
  // replace the restored clip with "disabled, full-bounds", destroying it.
  clipPanel.setVisible(true);
  if (!viewer.getClip()) clipPanel.fitToScan();
  // Fresh scan → clear any prior override + verdict so the open-time route is
  // authoritative and streaming re-routes can fire again. The manual "Treat as"
  // override is per-session-per-scan: a new scan returns to auto-detection,
  // and any settled soft-commit from the previous scan is forgotten.
  routing.reset();
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
  // Mount the Analyse + Object panels on this scan load (v0.6 P1 lazy seam). The
  // route above ran synchronously against the not-yet-mounted panels, recording
  // their intent in the tracking vars; once each chunk resolves the panel
  // constructs, mounts, and `hydrate{Analyse,Object}Panel()` replays that intent.
  // Fire-and-forget: nothing here awaits the panels.
  void ensureAnalysePanel();
  void ensureObjectPanel();
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
  // The legend is revealed even for a class-less scan: it renders a designed
  // empty state (explanatory message + disabled "Show all") that is the entry
  // point to Classify (derive a classification). Hiding it would remove that
  // affordance — the empty legend is intentional, not a defect.
  classLegendPanel.show();
  void showReclassifyUi();
  // Reset the inspector's copy/JSON scope stamp — the fresh legend is
  // all-visible, so this clears any stamp left by a prior filtered scan.
  syncInspectClassScope();
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
  // The hand tool (v0.5.5 P1) is flag-gated (?handPan=off). The flag lives
  // in the lazy Viewer chunk (devFlags must stay out of the startup shell),
  // so the NavBar learns about it here, once the Viewer has resolved —
  // before any scan load reveals the NavBar.
  navBar.setPanAvailable(viewer.handPanEnabled);
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
      // Null-safe: profile selection needs a scan (panel mounted), but track the
      // desired-hidden state too so a not-yet-mounted panel hydrates hidden.
      analyseDesiredVisible = false;
      analysePanel?.setVisible(false);
      dock.setAnalyseActive(false);
      measurePanel.setVisible(true);
    }
  });
  // Persist the unit choice whenever it changes.
  viewer.measure.setOnUnitChange(persistPrefs);
  viewer.annotate.setOnChange(() => {
    refreshAnnotationPanel();
    // Mark the annotation stack as most-recently-edited so a global Undo
    // targets it (suppressed while the router itself replays an undo/redo).
    noteEdit('annotation');
  });

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
      // Elevation filter (v0.5.6) device-verify seam: pass a world-space
      // [min, max] window (or null to clear) and confirm points outside it hide.
      setElevationFilter: (range: [number, number] | null) =>
        v.setElevationFilter(range ?? undefined),
      // Intensity filter (v0.5.6) device-verify seam: pass a raw-intensity
      // [min, max] window (or null to clear) and confirm points outside it hide.
      setIntensityFilter: (range: [number, number] | null) =>
        v.setIntensityFilter(range ?? undefined),
      // Classification edit seam — seed a uniform class, reclassify a screen
      // lasso, undo/redo, and read a point's class, so the reclassify tool's
      // full flow is e2e-verifiable without running the heavy classifier.
      seedUniformClass: (cls: number): number => {
        if (!scans.activeId) return 0;
        const cloud = v.getCloud(scans.activeId);
        if (!cloud) return 0;
        const n = cloud.positions.length / 3;
        v.applyDerivedClassification(scans.activeId, new Uint8Array(n).fill(cls));
        return n;
      },
      reclassifyLasso: (lasso: ReadonlyArray<{ x: number; y: number }>, newClass: number): number =>
        scans.activeId ? v.reclassifyLasso(scans.activeId, lasso, newClass).changedCount : 0,
      undoClass: (): boolean => (scans.activeId ? v.undoClassification(scans.activeId) : false),
      redoClass: (): boolean => (scans.activeId ? v.redoClassification(scans.activeId) : false),
      classAt: (i: number): number => {
        const c = scans.activeId ? v.getCloud(scans.activeId)?.classification : undefined;
        return c ? c[i] : -1;
      },
      // Mount/show the reclassify panel (normally triggered when a
      // classification appears) and re-sync its undo/redo enabled state, so the
      // visible controls are e2e-drivable without running the full classifier.
      showReclassify: () => showReclassifyUi(),
      refreshReclassify: () => reclassifyUi?.refresh(),
      // EPT laszip decode-worker round-trip — the one path no other e2e
      // exercises end-to-end in a real browser: the lazy worker-client chunk
      // load, `new Worker(new URL(...))` URL resolution (the seam the live
      // source-transform can scramble), laz-perf WASM init inside the worker,
      // decode of a complete LAZ tile, and the zero-copy transfer back.
      // Returns the decoded point count so the spec can assert against the
      // known fixture. Owns and disposes its own worker — never touches
      // viewer state.
      decodeEptLaszipTileInWorker: async (tile: ArrayBuffer): Promise<number> => {
        const { EptLaszipWorkerClient } = await loadEptLaszipWorkerClient();
        const client = new EptLaszipWorkerClient();
        try {
          const decoded = await client.decodeTile(tile, [0, 0, 0]);
          return decoded.pointCount;
        } finally {
          client.dispose();
        }
      },
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
    leftPanels.id = 'olv-left-panels'; // P11 — aria-controls target for the rail toggle
    // NOTE: analysePanel.element AND objectPanel.element are intentionally ABSENT
    // here — both panels are lazy-mounted on first scan load (v0.6 P1). The Object
    // panel inserts itself just before the class-legend panel, and the Analyse
    // panel between the class-legend and export panels, via
    // `mountObjectPanelElement` / `mountAnalysePanelElement` below.
    leftPanels.append(measurePanel.element, annotationPanel.element, classLegendPanel.element, exportPanel.element, clipPanel.element);
    stage.overlay.append(leftPanels);
    // P9 — wheel ownership: a wheel over a panel scrolls the panel and must never
    // reach the camera. Stop it here (passive — this is plain scrolling, never a
    // preventDefault), so no ancestor handler can act on a panel scroll. The
    // canvas controller also gates on target (NavController `_handleWheel`).
    containPanelWheel(leftPanels);
    containPanelWheel(inspector.element);
    containPanelWheel(streamingPanel.element);
    // Push the column below the measure toolbar whenever it is visible —
    // see wireMeasureBarClearance for why this is measured, not static CSS.
    wireMeasureBarClearance(viewer.measureElements.hint, leftPanels);
    // P11 — keep the column above the real dock height, and add the one-tap rail collapse.
    wireDockClearance(dock.dock, leftPanels);
    stage.addTeardown(wireRailToggle({
      overlay: stage.overlay,
      panels: [leftPanels],
      tabClass: 'olv-rail-tab',
      chevron: RAIL_CHEVRON_LEFT,
      collapsedClass: 'olv-rail-collapsed',
      storageKey: 'olv.leftRail.collapsed',
      ariaControls: 'olv-left-panels',
    }));
    // Right column — each panel collapses on its own handle, centred on that
    // panel. The Streaming card (top, only while a COPC streams) and the
    // Inspector (bottom, or full-height when not streaming) are independent, so
    // one can be hidden without the other. Both handles ride the same right
    // edge; the empty-state hide keeps only the visible panel's handle on screen.
    if (!inspector.element.id) inspector.element.id = 'olv-inspector';
    if (!streamingPanel.element.id) streamingPanel.element.id = 'olv-streaming-panel';
    stage.addTeardown(wireRailToggle({
      overlay: stage.overlay,
      panels: [streamingPanel.element],
      tabClass: 'olv-right-rail-tab',
      chevron: RAIL_CHEVRON_RIGHT,
      collapsedClass: 'olv-right-collapsed',
      storageKey: 'olv.rightRail.streaming.collapsed',
      ariaControls: streamingPanel.element.id,
    }));
    stage.addTeardown(wireRailToggle({
      overlay: stage.overlay,
      panels: [inspector.element],
      tabClass: 'olv-right-rail-tab',
      chevron: RAIL_CHEVRON_RIGHT,
      collapsedClass: 'olv-right-collapsed',
      storageKey: 'olv.rightRail.inspector.collapsed',
      ariaControls: inspector.element.id,
    }));
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
      // Both the Analyse and Object panels are lazy-mounted, so re-parent each
      // only once it exists (analyse first, then object). A mobile empty-state
      // boot BEFORE any scan runs this with BOTH still null — the slot stays
      // empty, and each panel slots itself in via `mountAnalysePanelElement` /
      // `mountObjectPanelElement` when it later mounts.
      if (analysePanel) mobileSheet.slot('analyse').append(analysePanel.element);
      if (objectPanel) mobileSheet.slot('analyse').append(objectPanel.element);
      mobileSheet
        .slot('layers')
        .append(
          classLegendPanel.element,
          measurePanel.element,
          annotationPanel.element,
          exportPanel.element,
        );
      // Drop the desktop collapsed state so mobile users don't see a nested
      // collapsed header inside the sheet's own collapse chrome.
      analysePanel?.element.classList.remove('olv-collapsed');
      exportPanel.element.classList.remove('olv-collapsed');
      // The now-empty left column would still capture touches over its band —
      // hide it. The Inspector's standalone "Scan Info" launcher is superseded.
      leftPanels.classList.add('olv-hidden');
      inspector.sheetToggle.classList.add('olv-hidden');
    };
    const toDesktopLayout = (): void => {
      // Restore the desktop default collapsed state we dropped for the mobile
      // sheet, so a device that crosses the breakpoint (rotate / resize) gets the
      // compact desktop panels back rather than fully-expanded ones.
      analysePanel?.element.classList.add('olv-collapsed');
      exportPanel.element.classList.add('olv-collapsed');
      leftPanels.classList.remove('olv-hidden');
      inspector.sheetToggle.classList.remove('olv-hidden');
      // Inspector returns to the overlay in its original slot (just before the
      // streaming panel); the left column is rebuilt in its original order. The
      // Object and Analyse panels are included only once each has lazily mounted
      // (Object before the class-legend panel, Analyse between the class-legend
      // and export panels — via mountObjectPanelElement / mountAnalysePanelElement).
      stage.overlay.insertBefore(inspector.element, streamingPanel.element);
      const desktopPanels: HTMLElement[] = [
        measurePanel.element,
        annotationPanel.element,
      ];
      if (objectPanel) desktopPanels.push(objectPanel.element);
      desktopPanels.push(classLegendPanel.element);
      if (analysePanel) desktopPanels.push(analysePanel.element);
      desktopPanels.push(exportPanel.element);
      leftPanels.append(...desktopPanels);
    };

    // Layout swap stays keyed to the shared mobile-layout condition (orientation-
    // independent, so a phone stays mobile in landscape) so JS and CSS agree.
    const mobileMql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(MOBILE_LAYOUT_QUERY)
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

    // The lazy Analyse panel inserts itself here once its chunk resolves. When
    // the mobile sheet is active it goes into the Analyse slot ahead of the
    // object panel; otherwise between the class-legend and export panels in the
    // left column. Robust to either target panel not being where we expect
    // (falls back to append) so a mid-flip mount can never throw.
    mountAnalysePanelElement = (el: HTMLElement): void => {
      if (mobileApplied) {
        const slot = mobileSheet.slot('analyse');
        // insertBefore(firstChild) puts Analyse first (object panel follows);
        // acts as append when the slot is empty.
        slot.insertBefore(el, slot.firstChild);
        el.classList.remove('olv-collapsed');
      } else if (exportPanel.element.parentElement === leftPanels) {
        leftPanels.insertBefore(el, exportPanel.element);
      } else {
        leftPanels.append(el);
      }
    };
    // The lazy Object panel inserts itself here once its chunk resolves. When
    // the mobile sheet is active it goes into the Analyse slot AFTER the Analyse
    // panel; otherwise just before the class-legend panel in the left column.
    // Robust to the target panel not being where we expect (falls back to
    // append) so a mid-flip mount can never throw.
    mountObjectPanelElement = (el: HTMLElement): void => {
      if (mobileApplied) {
        // append puts Object after the Analyse panel in the shared Analyse slot.
        mobileSheet.slot('analyse').append(el);
      } else if (classLegendPanel.element.parentElement === leftPanels) {
        leftPanels.insertBefore(el, classLegendPanel.element);
      } else {
        leftPanels.append(el);
      }
    };
    // If either panel already mounted before this wiring ran (possible only if a
    // scan's import resolved between column build and here), place it now.
    if (analysePanel) mountAnalysePanelElement(analysePanel.element);
    if (objectPanel) mountObjectPanelElement(objectPanel.element);

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
        if (helpOverlay.isOpen) return;
        const id = scans.activeId;
        const canClass = !!id && viewer.canUndoClassification(id);
        const pick = pickUndo(viewer.annotate.canUndo, canClass);
        if (!pick) return;
        withSuppressed(() => {
          if (pick === 'classification' && id) viewer.undoClassification(id);
          else viewer.annotate.undo();
        });
        if (pick === 'classification') reclassifyUi?.refresh();
      },
      onRedo: () => {
        if (helpOverlay.isOpen) return;
        const id = scans.activeId;
        const canClass = !!id && viewer.canRedoClassification(id);
        const pick = pickRedo(viewer.annotate.canRedo, canClass);
        if (!pick) return;
        withSuppressed(() => {
          if (pick === 'classification' && id) viewer.redoClassification(id);
          else viewer.annotate.redo();
        });
        if (pick === 'classification') reclassifyUi?.refresh();
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
async function startEmbedBridgeLazy(): Promise<typeof import('./ui/embedBridge')> {
  return loadEmbedBridge();
}

if (embed) {
  // Wire the origin allow-list off the page URL (?embedParent / ?embedOrigins):
  // when a deployer relaxes X-Frame-Options for cross-origin embedding, inbound
  // commands are then gated to the configured origin(s) instead of any parent.
  void startEmbedBridgeLazy().then((m) => m.startEmbedBridge({
    onLoadFile: (buffer, fileName) => void handleFile(new File([buffer], fileName)),
    onJumpCamera: (camera) => viewer.applyCameraState(camera),
    onToggleLayer: (id, visible) => viewer.setCloudVisible(id, visible),
    onFocusAnnotation: (id) => viewer.jumpToAnnotation(id),
  }, m.embedBridgeOptionsFromUrl(window.location.search)));
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
// Defer the deep-link open one microtask so module evaluation finishes first.
// `handleRemoteUrl` reaches the prewarm path, which reads module-level state
// (`_loadersPrewarmed`, the decoder singleton) declared further down this file;
// calling it synchronously here — above those declarations — tripped a
// temporal-dead-zone in strict ESM (dev), masked only by production bundling.
if (copcUrlParam) queueMicrotask(() => void handleRemoteUrl(copcUrlParam));

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

/** Re-entry guard for the full-cloud grade — one run at a time per session. */
let fullCloudGradeRunning = false;

/**
 * Run the full-cloud grade. The orchestration — sampling plan,
 * decode through the session decoder, grade, and panel updates — lives in a
 * lazily-imported module so it (and the adapter + grade it pulls in) never
 * weighs on the live index bundle; this stub only owns the re-entry guard.
 */
let fullCloudGradeController: AbortController | null = null;
async function runFullCloudGradeAction(): Promise<void> {
  if (fullCloudGradeRunning) return;
  fullCloudGradeRunning = true;
  fullCloudGradeController = new AbortController();
  try {
    const { runFullCloudGrade } = await loadFullCloudGradeAction();
    await runFullCloudGrade({
      viewer,
      panel: streamingPanel,
      signal: fullCloudGradeController.signal,
      debug,
    });
  } finally {
    fullCloudGradeRunning = false;
    fullCloudGradeController = null;
  }
}

/** Abort an in-flight full-cloud grade — the streaming panel's Cancel control. */
function cancelFullCloudGrade(): void {
  fullCloudGradeController?.abort();
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
    // Metered-commit backlog. Left absent in the default immediate mode, where
    // no upload queue runs and the driver never records a pass — so the overlay
    // shows this line only once metering is actually committing.
    const up = streamingBenchmark.uploadCounters();
    if (up.committedPerFrame.count > 0 || up.pendingNodes > 0) {
      sample.commitPending = up.pendingNodes;
      sample.commitPendingBytes = up.pendingBytes;
      sample.nodesCommitted = up.nodesCommitted;
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
  readonly crs?: () => { readonly linearUnit?: CrsLinearUnit; readonly linearUnitToMetres?: number; readonly verticalUnitToMetres?: number } | null;
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

  // Bounds — the header's source-coordinate min/max is the TIGHT data extent
  // (a 1000×1000×138 m scan reports 138 m here). Do NOT use `localBounds`: for
  // streaming that is the octree ROOT CUBE (1000³), which over-reports the
  // vertical (and any partial-footprint) span. This matches the Streaming
  // panel's Extent row, which also reads the header.
  const header = cloud.metadata?.header;
  if (header) {
    // Convert the source-CRS units to metres before printing "m" / "pts/m²",
    // exactly as the static Scan Report and the PDF do. A state-plane-FEET COPC
    // otherwise over-reports extent ~3.28× and density ~10.8×, mislabelled as
    // metres. `streamingExtentRows` FAILS CLOSED on an unconfirmed unit
    // (placeholder `linearUnitToMetres: 1`): it drops the "m"/"pts/m²" claim
    // rather than stamping metres onto non-metre data — as measure/lasso do.
    const crsInfo = cloud.crs?.() ?? null;
    const ext = streamingExtentRows(header, crsInfo, cloud.sourcePointCount);
    if (!ext.unitConfirmed) {
      rows.push({
        label: 'Units',
        value: 'unconfirmed — source CRS declares no linear unit; extents shown in source units',
        status: 'warn',
      });
    }
    for (const r of ext.rows) {
      rows.push(r.scoped ? headerMetric(r.label, r.value) : info(r.label, r.value));
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
 * Assemble + render a PDF report from the live state — a thin caller over the
 * extracted `src/app/reportExport.ts`. The metadata assembly, provenance
 * fingerprint, template normalisation and download live in that module, along with
 * the pure `reportPointCount` (file-scale honesty) and `isNonTerrainVerdict`
 * (capture lens) decisions; here we bind the shell's running state through
 * `reportExportDeps`.
 */
function generateReportPdf(templateId: string): Promise<void> {
  return runGenerateReportPdf(templateId, reportExportDeps);
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
  if (!scans.activeId) return;
  const cloud = viewer.getCloud(scans.activeId);
  if (!cloud) return;
  const mode = viewer.colorModeOf(scans.activeId);
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
    splatMode: viewer.splatMode,
    antialiasing: viewer.antialiasing,
    unitSystem: viewer.measure.unitSystem,
    touchModel: viewer.twoFingerTwistEnabled ? 'standard' : 'advanced',
    colorblindSafeClasses: colorblindSafeClasses(),
    workflow: workflowController.config,
    navigation: navigationPrefs(),
  });
}

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

/** Apply preferences saved in a previous session; each key applies only if it was stored. */
function applyPrefs(): void {
  const p = loadPrefs();
  if (p.pointSize !== undefined) viewer.setPointSize(p.pointSize);
  if (p.edlEnabled !== undefined) viewer.setEdlEnabled(p.edlEnabled);
  if (p.edlStrength !== undefined) viewer.setEdlStrength(p.edlStrength);
  if (p.pointSizeMode !== undefined) viewer.setPointSizeMode(p.pointSizeMode);
  if (p.splatMode !== undefined) viewer.setSplatMode(p.splatMode);
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
    // Remember the popup's display config; apply it now if the popup is already
    // loaded, otherwise `ensureWorkflowConfigPanel` applies it on first open.
    pendingWorkflowConfig = p.workflow;
    if (workflowConfigPanel) workflowConfigPanel.setConfig(p.workflow);
  }
  if (p.navigation !== undefined) restoreNavPrefs(p.navigation, viewer, inspector);
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
  measurePanel.setConfidenceContext(buildMeasureConfidenceContext(viewer, crsService.current()));
  const measurements = viewer.measure.getMeasurements();
  const hasMeasurements = measurements.length > 0;
  measurePanel.setVisible(viewer.measureMode || hasMeasurements);
  // Local-first counter, categorical (the kind) only — never coordinates or names.
  if (measurements.length > _lastMeasurementCount) {
    const newest = measurements[measurements.length - 1];
    if (newest) recordUsage('measurement', newest.kind);
  }
  _lastMeasurementCount = measurements.length;
  // Keep the Export panel's Products lane in sync with the measurement count.
  exportPanel.refresh();
}

/** Refresh the Annotations panel's contents and visibility. */
function refreshAnnotationPanel(): void {
  annotationPanel.update(viewer.annotate.getSummaries());
  const hasAnnotations = viewer.annotate.getAnnotations().length > 0;
  annotationPanel.setVisible(viewer.annotateMode || hasAnnotations);
  // Keep the Export panel's Site-KML enablement in sync — annotations alone can
  // make a KML worth exporting, not only measurements.
  exportPanel.refresh();
}

/** Whether a scan is currently loaded — gates the tool keyboard shortcuts. */
function hasScan(): boolean {
  return viewer.clouds().length > 0 || viewer.hasStreamingCloud;
}

/**
 * ONE capture path for a restorable view state. The session exporter's
 * GLOBAL fields and every named saved view both come from here, so the two
 * surfaces can never drift — what a `.olvsession` restores globally is
 * exactly what a saved view restores by name. `buildViewState` prunes unset
 * fields (emit-only-when-set), which is what keeps a bundle-free view's
 * serialisation byte-identical to the v6 writer's output.
 */
function captureViewState(): ViewStateBundle {
  return buildViewState({
    // The camera is meaningful only with a scan on stage — a session exported
    // from the empty state must not carry a bogus default pose. (`hasScan`
    // is the same predicate that gates the tool shortcuts.)
    camera: hasScan() ? viewer.getCameraState() : undefined,
    render: {
      pointSize: viewer.pointSize,
      edlEnabled: viewer.edlEnabled,
      edlStrength: viewer.edlStrength,
      pointSizeMode: viewer.pointSizeMode,
      antialiasing: viewer.antialiasing,
    },
    colorMode: viewer.activeColorMode(),
    // v5 contract — the class filter is the list of HIDDEN ASPRS codes;
    // empty means "no filter" and is pruned rather than serialised.
    classFilter: classLegendPanel.getVisibility().hiddenCodes(),
    // The active point-filter windows, so a restore reproduces "only the
    // ground band" / "hide low-return noise". Omitted when unset.
    ...(activeElevFilter || activeIntenFilter
      ? {
          pointFilters: {
            ...(activeElevFilter ? { elevation: activeElevFilter } : {}),
            ...(activeIntenFilter ? { intensity: activeIntenFilter } : {}),
          },
        }
      : {}),
    // Whenever the viewer holds a clip — enabled or not — so a
    // positioned-but-dormant box keeps its geometry across the round trip.
    clip: viewer.getClip() ?? undefined,
  }) ?? {};
}

/**
 * ONE apply path for a restorable view state — session import and named-view
 * restore both route through here. The field ORDER and the present/absent
 * guards live in the pure orchestrator (`io/viewState.ts`, unit-tested:
 * camera strictly LAST, every field independent); the sinks below carry the
 * host-specific wiring.
 *
 * Streaming honesty: a restore re-applies the recipe and re-renders — on a
 * streaming cloud the resident node set varies with budget and load order,
 * so identical point MEMBERSHIP is not guaranteed, only the same
 * camera/clip/colour/filter state over whatever is resident.
 */
function applyViewState(vs: ViewStateBundle): void {
  applyViewStateInOrder(vs, {
    render: (r) => {
      viewer.setPointSize(r.pointSize);
      viewer.setPointSizeMode(r.pointSizeMode);
      viewer.setEdlEnabled(r.edlEnabled);
      viewer.setEdlStrength(r.edlStrength);
      viewer.setAntialiasing(r.antialiasing);
      inspector.syncRendering({
        pointSize: viewer.pointSize,
        edlEnabled: viewer.edlEnabled,
        edlStrength: viewer.edlStrength,
        pointSizeMode: viewer.pointSizeMode,
        antialiasing: viewer.antialiasing,
        twoFingerTwistEnabled: viewer.twoFingerTwistEnabled,
        splatMode: viewer.splatMode,
      });
    },
    colorMode: (mode) => {
      // Apply to every static cloud; the streaming subsystem too.
      for (const id of viewer.clouds()) viewer.setColorMode(id, mode);
      viewer.setStreamingColorMode(mode);
    },
    classFilter: (codes) => {
      // v5 — re-apply the saved class-visibility filter. The panel re-renders
      // and emits onChange, which the host has wired to the GPU mask, so the
      // restored scan shows the same classes the author left visible.
      classLegendPanel.applyFilter(codes);
    },
    pointFilters: (pf) => {
      // v6 — re-apply the saved elevation / intensity windows, but ONLY when
      // a scan is actually loaded. The elevation window is converted to the
      // cloud's attribute space using that cloud's origin + up-axis; applying
      // it with no scan present would convert against origin 0 and the
      // default axis, so the window would be wrong the moment a scan did
      // load. A view state is an overlay for an open scan, so "no scan ⇒
      // skip the filter" is the correct, non-surprising behaviour.
      if (scans.activeId == null && !viewer.hasStreamingCloud) return;
      // The Inspector extents were seeded when the scan opened, so restoring
      // writes the window into the inputs and drives the GPU filter + cue.
      if (pf.elevation) {
        viewer.setElevationFilter(pf.elevation);
        inspector.restoreElevationFilter(pf.elevation);
        activeElevFilter = [pf.elevation[0], pf.elevation[1]];
      }
      if (pf.intensity) {
        viewer.setIntensityFilter(pf.intensity);
        inspector.restoreIntensityFilter(pf.intensity);
        activeIntenFilter = [pf.intensity[0], pf.intensity[1]];
      }
    },
    clip: (clip) => {
      // Restore the saved clip box so a shared capsule reproduces the
      // author's isolation/cut-away, not an unclipped scene.
      viewer.setClip(clip);
      clipPanel.setVisible(true);
      // Reflect the restored clip in the panel UI without re-firing onApply —
      // the viewer already holds it, and firing through the panel while its
      // own enabled flag was still false used to clear the restored clip.
      clipPanel.setState(clip);
    },
    camera: (camera) => {
      // Fly the live camera to the saved viewpoint — the orchestrator applies
      // this LAST, so nothing after it can move the restored framing.
      viewer.applyCameraState(camera);
    },
  });
}

/**
 * Capture the current viewpoint AND display state as a named saved view.
 * The pose keeps the v6 camera-bookmark slot; everything else the exporter
 * would record globally (render, colour mode, class filter, point filters,
 * clip) rides in the bundle, so restoring the view by name reproduces the
 * full picture — the "Figure 3 = view state 'north-scarp'" contract.
 */
function saveCurrentView(): void {
  const { camera, ...rest } = captureViewState();
  // `getCameraState` (not the bare pose) so a non-default FOV or nav mode is
  // part of what the view restores; the empty-state fallback keeps the old
  // bare-pose behaviour when no scan gates the capture.
  bookmarks.add({ pose: camera ?? viewer.getCameraPose(), state: buildViewState(rest) });
  refreshViewsUI();
}

/** Push the saved-view names to whichever panel is currently shown. */
function refreshViewsUI(): void {
  const names = bookmarks.names();
  if (viewer.hasStreamingCloud) streamingPanel.setViews(names);
  else inspector.setViews(names);
}

/** Glide the camera to a saved view — and (v7) restore its display state. */
function applyView(index: number): void {
  const view = bookmarks.get(index);
  if (!view) return;
  if (!view.state) {
    // A pre-v7 (camera-only) view keeps its exact old behaviour: glide the
    // pose and touch nothing else — not even the FOV, which the richer
    // applyCameraState path would reset to the default.
    viewer.applyCameraPose(view.pose);
    return;
  }
  // Full restore through the one apply path; the pose rides as the bundle's
  // camera so the orchestrator applies it LAST.
  applyViewState({ ...view.state, camera: view.pose });
}

/** Delete a saved view and refresh the list. */
function deleteView(index: number): void {
  bookmarks.remove(index);
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
  if (state.colorMode && scans.activeId) {
    const modes = availableModes(cloud);
    if (modes.includes(state.colorMode as ColorMode)) {
      currentColorMode = state.colorMode as ColorMode;
      viewer.setColorMode(scans.activeId, currentColorMode);
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
async function exportSession(): Promise<void> {
  const { serializeSession } = await loadSession();
  const cloud = scans.activeCloud() ?? undefined;
  // A streaming-only session has no static cloud. Its frame still exists — the
  // streaming source's renderOrigin — and streaming COPC/EPT are LAS-derived,
  // hence Z-up. Deriving origin/upAxis from the (absent) static cloud wrote
  // [0,0,0] + Y-up, so the session reopened displaced by the whole render origin
  // and mis-oriented.
  const upAxis: 'y' | 'z' = cloud
    ? isZUpFormat(cloud.sourceFormat) ? 'z' : 'y'
    : viewer.streamingCloud ? 'z' : 'y';

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
    // Tight data AABB, not the octree cube — see the dataBounds() note above.
    const b = streamingCloud.dataBounds();
    const crs = streamingCloud.crs();
    scanSummary = {
      fileName: streamingCloud.name,
      sourcePoints: streamingCloud.sourcePointCount,
      width: b[3] - b[0],
      depth: b[4] - b[1],
      height: b[5] - b[2],
      ...(crs ? { crs: crs.name, crsUnit: crs.linearUnit, ...(crs.epsg != null ? { epsg: crs.epsg } : {}) } : {}),
    };
  } else if (cloud) {
    const b = cloud.bounds();
    scanSummary = {
      fileName: cloud.name,
      sourcePoints: cloud.declaredPointCount ?? cloud.decodedPointCount ?? cloud.pointCount,
      width: b.max[0] - b.min[0],
      depth: b.max[1] - b.min[1],
      height: b.max[2] - b.min[2],
      ...(cloud.metadata?.crs
        ? {
            crs: cloud.metadata.crs.name,
            crsUnit: cloud.metadata.crs.linearUnit,
            ...(cloud.metadata.crs.epsg != null ? { epsg: cloud.metadata.crs.epsg } : {}),
          }
        : {}),
    };
  }

  // v7 — the verify-only processing manifest, filled into the slot the schema
  // reserved. Derived from the CURRENT analysis result's provenance (the same
  // derivation every terrain export stamps), so a session saved after an
  // analysis carries the ordered, hash-chained record of the methods + final
  // parameters behind the on-screen numbers. No analysis → the slot stays
  // absent (serializeSession omits it), never an empty placeholder. The
  // provenance/manifest modules ride the lazy terrain-export chunk — loaded
  // here on demand via lazyChunks so the eager shell stays manifest-free.
  let processingManifest: unknown;
  // Null-safe: saving a session before any scan (or before the panel's chunk
  // resolves) simply carries no analysis manifest.
  const analysed = analysePanel?.currentResult() ?? null;
  if (analysed) {
    const { buildExportProvenance, processingManifestFromProvenance } =
      await loadExportProvenance();
    processingManifest = processingManifestFromProvenance(
      buildExportProvenance(analysed, {
        basename: exportFileName ? baseName(exportFileName) : null,
        generatedAt: new Date(),
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
      }),
    );
  }

  // The GLOBAL live state and every saved view's bundle come from the same
  // capture path (captureViewState) — the extraction that replaced the old
  // inline field-by-field block here, so the export and the named views can
  // never record different notions of "the current state". Field-level
  // rationale (the v5 clip write-side fix, the hidden-codes contract, the
  // emit-only-when-set discipline) lives on captureViewState itself.
  const viewState = captureViewState();
  const json = serializeSession({
    upAxis,
    // The scene's real frame, static OR streaming — exportGeoContext resolves the
    // static cloud's origin, else the streaming renderOrigin, else zero.
    origin: [...exportGeoContext().origin],
    unitSystem: viewer.measure.unitSystem,
    // v7 — a view with a captured bundle serialises it per-view; a camera-only
    // view (e.g. restored from a v6 file) spreads nothing and keeps its exact
    // v6 byte-shape.
    views: viewBookmarks.savedViews.map((v) => ({ name: v.name, camera: v.pose, ...(v.state ?? {}) })),
    measurements: viewer.measure.getMeasurements(),
    annotations: viewer.annotate.getAnnotations(),
    camera: viewState.camera,
    render: viewState.render,
    colorMode: viewState.colorMode,
    scanSummary,
    classFilter: viewState.classFilter,
    ...(viewState.pointFilters ? { pointFilters: viewState.pointFilters } : {}),
    clip: viewState.clip,
    // v6 — stamp the producing app version so a later re-open can tell whether a
    // newer build would read the scan differently (see exportStaleness).
    software: __APP_VERSION__,
    // v7 — the reserved slot, filled above when an analysis exists; the
    // serializer omits it when undefined so no-analysis sessions keep their
    // byte-shape.
    processingManifest,
  });
  // `.olvsession` is the new canonical extension; the file is
  // still JSON internally (Mac/Linux's Open With dialog associates the
  // double-click flow). Filename derived from the active scan name when
  // possible so a folder of exports doesn't collide.
  const stem = exportFileName ? baseName(exportFileName) : 'openlidarviewer';
  downloadText(`${stem}.olvsession`, json);
}

/**
 * Session import — a thin caller over the extracted `src/app/sessionIo.ts`.
 * Binds the shell's running state to the module's deps; the parse / verify /
 * rebase / apply logic and the pure `ScanFacts` adapter live in that module.
 */
const sessionIoDeps: SessionIoDeps = {
  viewerReady: viewerLoaded,
  getViewer: () => viewer,
  loadSession,
  appVersion: __APP_VERSION__,
  getActiveScanId: () => scans.activeId,
  getActiveCloud: () => scans.activeCloud(),
  exportOrigin: () => exportGeoContext().origin,
  bookmarks,
  setInspectorViews: (names) => inspector.setViews(names),
  refreshMeasurePanel,
  refreshAnnotationPanel,
  applyViewState,
  setCrsOverride: (args) => {
    crsService.setOverride(args);
  },
  showToast: showLassoToast,
  setDropError: (message) => dropZone.setError(message),
};

function importSession(file: File, opts: { skipScanConfirm?: boolean } = {}): Promise<void> {
  return runImportSession(file, opts, sessionIoDeps);
}

/**
 * Open/load pipeline — a thin caller over the extracted `src/app/openScan.ts`.
 * Binds the shell's running state to the module's deps; the three-way router
 * (session / COPC / static), the post-load orchestration and the pure
 * `layerChipCount` / `shouldResetSavedWork` decisions live in that module.
 */
const openScanDeps: OpenScanDeps = {
  viewerReady: viewerLoaded,
  getViewer: () => viewer,
  importSession,
  isLoading: () => loading,
  setLoading: (v) => { loading = v; },
  showToast: showLassoToast,
  dropZone,
  openLocalCopc: async (fileToOpen, signal) => {
    const { LocalFileRangeSource } = await loadLocalFileRangeSource();
    await openStreamingCopc(new LocalFileRangeSource(fileToOpen), fileToOpen.name, signal);
  },
  loadLocalSource: (fileToLoad, callbacks, options) => new LocalFileSource(fileToLoad).load(callbacks, options),
  renderBudget: deviceCapsValue.renderBudget,
  isPhone,
  deviceMemoryGB,
  stage,
  closeStreaming,
  scans,
  layerIdentity: runtime.layerIdentity,
  inspector,
  inspectorCards,
  crsCoordinator,
  dock,
  navBar,
  bookmarks,
  layerService,
  setLayerVisible: (id, visible) => { layerVisible.set(id, visible); },
  rememberSourceFile: (id, sourceFile) => { sourceFileById.set(id, sourceFile); },
  rememberReduced: (id, reduced) => { reducedById.set(id, reduced); },
  refreshAnnotationPanel,
  setCurrentColorMode: (mode) => { currentColorMode = mode; },
  loadApplyDisplayProfile,
  runModules,
  currentClassScope,
  prewarmExportStudio: () => { void prewarmExportStudio(); },
  getPendingShareState: () => pendingShareState,
  clearPendingShareState: () => { pendingShareState = null; },
  applyShareState,
  bareMode,
  showProjectCard,
  revealAnalysePanel,
  showInstantAnswer,
  refreshClassLegend,
  debug,
  benchmark,
  getDebugOverlay: () => debugOverlay,
};

/** Load a dropped or sampled File: parse, render, and populate the Inspector. */
function handleFile(file: File): Promise<void> {
  return openScan(file, openScanDeps);
}

/**
 * Remote / streaming opens — thin callers over the extracted
 * `src/app/openStreaming.ts`. `openStreamingDeps` binds the shell's running
 * state (the load flag, the streaming-session decode workers / benchmark, the
 * quality preset) and its view collaborators to the module's accessors; the
 * COPC + EPT open pipelines, and the pure `isEptUrl` / `isAbortError` /
 * `linkAbortSignals` decisions, live in that module.
 */
const openStreamingDeps: OpenStreamingDeps = {
  loadStreamingPointCloud,
  loadCopcWorkerClient,
  loadStreamingColors,
  loadEptLaszipWorkerClient,
  loadEpt,
  loadDiagnostics,
  viewerReady: viewerLoaded,
  getViewer: () => viewer,
  isLoading: () => loading,
  setLoading: (v) => { loading = v; },
  getStreamingBenchmark: () => streamingBenchmark,
  setStreamingBenchmark: (b) => { streamingBenchmark = b; },
  setCoarseStableFired: (v) => { coarseStableFired = v; },
  getCopcDecoder: () => copcDecoder,
  setCopcDecoder: (d) => { copcDecoder = d; },
  getEptLaszipDecoder: () => eptLaszipDecoder,
  setEptLaszipDecoder: (d) => { eptLaszipDecoder = d; },
  getStreamingQuality: () => streamingQuality,
  setLastStreamingReportCloud: (c) => { lastStreamingReportCloud = c; },
  debug,
  benchmark,
  showToast: showLassoToast,
  dropZone,
  stage,
  inspector,
  streamingPanel,
  classLegendPanel,
  inspectorCards,
  crsCoordinator,
  bookmarks,
  isPhone,
  closeStreaming,
  clearOpenStaticLayers,
  startStreamingStatusPolling,
  revealStreamingChrome: () => revealStreamingScanChrome({
    dock, inspector, navBar, backend: viewer.activeBackend(), body: document.body,
  }),
  revealAnalysePanel,
  prewarmExportStudio: () => { void prewarmExportStudio(); },
  prewarmForUrl,
  refreshViewsUI,
  hideReclassifyUi,
  syncInspectClassScope,
  runStreamingModules,
};

/**
 * Report / geo-context export — thin callers over the extracted
 * `src/app/reportExport.ts`. `reportExportDeps` binds the shell's running state
 * (the lazy Viewer, the active-scan seam, the resolved CRS, the scan verdict and
 * the class-scope stamp) to the module's accessors; the PDF assembly and the
 * origin/CRS resolution, plus the pure `effectiveCrsName` / `reportPointCount` /
 * `isNonTerrainVerdict` decisions, live in that module.
 */
const reportExportDeps: ReportExportDeps = {
  viewerReady: viewerLoaded,
  getViewer: () => viewer,
  scans,
  crsCurrent: () => crsService.current(),
  lastScanVerdict: () => lastScanVerdict,
  classScopeStamp: currentClassScopeStamp,
  baseName,
  loadReportEngine,
  dropZone,
  debug,
};

/**
 * Open a COPC scan from any range-readable source — a local file or a remote
 * HTTP URL — through the streaming pipeline. A thin caller over
 * `src/app/openStreaming.ts`; the local-file and remote-COPC paths both route
 * here so the metadata read / attach / reveal happens in one place.
 */
function openStreamingCopc(
  range: RangeSource,
  displayName: string,
  signal: AbortSignal,
): Promise<void> {
  return runOpenStreamingCopc(range, displayName, signal, openStreamingDeps);
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
  // EPT detection is URL-pattern only — fast, no network, no schema fetch, so
  // the routing decision is synchronous and doesn't depend on the EPT lazy
  // chunk loading (a malformed URL still surfaces an error toast even when the
  // EPT or Viewer chunks aren't reachable). `isEptUrl` lives beside the handler.
  if (isEptUrl(url)) return handleRemoteEpt(url, signal);
  return handleRemoteCopc(url, signal);
}

/**
 * Open a remote EPT dataset by its `ept.json` URL — a thin caller over
 * `src/app/openStreaming.ts`, which owns the manifest fetch / validate / attach
 * pipeline and binds the shell's running state through `openStreamingDeps`.
 */
function handleRemoteEpt(url: string, signal?: AbortSignal): Promise<void> {
  return runHandleRemoteEpt(url, signal, openStreamingDeps);
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
    // Blue blinking "Opening …" (by dataset name) — the same prominent indicator
    // device files show, so a public/streaming open reads identically. Staged
    // progress from the streaming pipeline supersedes it once bytes arrive.
    dropZone.setOpening(`Opening ${remoteCopcName(url)}…`);
    dropZone.setCancelHandler(() => controller.abort());
    // The remote range source is part of the lazy COPC chunk.
    const { HttpRangeSource } = await loadHttpRangeSource();
    const range = new HttpRangeSource(url);
    // A HEAD probe for range support runs before the streaming UI appears, so
    // a host that cannot stream reports a precise reason instead of stalling.
    await range.probe(controller.signal);
    if (controller.signal.aborted) throw new LoadCancelledError();
    // Prior-scene teardown is transactional (gate F4): openStreamingCopc defers
    // it to attachStreamingCloud (build replacement, then detach prior) — a
    // malformed COPC that fails to open leaves the scene intact, as local does.
    await openStreamingCopc(range, remoteCopcName(url), controller.signal);
    streamingFilterSeeded = false; // fresh scan re-seeds its own filter extents
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
      // Transactional: a failed open left the prior scene untouched, so keep it
      // — only tidy the streaming chrome when no streaming scene remains.
      if (!viewer.hasStreamingCloud) closeStreaming();
    }
  } finally {
    unlinkAbort();
    loading = false;
  }
}




/** Close a streaming scan: stop polling, detach, restore the static panel. */
function closeStreaming(): void {
  // A new streaming scan must re-seed its filter controls from its own data.
  streamingFilterSeeded = false;
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
  // Abort an in-flight full-cloud grade — the scan it was decoding is going away,
  // so its decode is now orphaned work (its result is discarded by the grade's
  // own stale-cloud guard regardless; this just stops it early).
  cancelFullCloudGrade();
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
  // No scan open → take the compass down (nothing to orient).
  compass.refresh();
  // Hiding the clip panel also clears the active clip (see ClipPanel.setVisible).
  clipPanel.setVisible(false);
  // Hide + clear the Analyse panel so it doesn't linger with stale
  // terrain results after the scan is closed. v0.4.0. Null-safe: the panel is
  // lazy-mounted, so a reset before any scan simply has nothing to clear. Also
  // reset the tracked desired state so a fresh open starts hidden/collapsed.
  if (analysePanel) {
    analysePanel.update(null);
    analysePanel.setVisible(false);
  }
  analyseDesiredVisible = false;
  analyseExpanded = false;
  // Hide the Space / Object (non-terrain) panel too — it was added after this
  // reset path and a closed 360 / object scan would otherwise leave its report
  // lingering over the empty state. v0.4.3. Null-safe: the panel is lazy-mounted,
  // so a reset before any scan simply has nothing to clear. Drop the tracked
  // content + desired state so a fresh open starts hidden with no stale report.
  objectPanel?.setVisible(false);
  objectDesiredVisible = false;
  objectContent = null;
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
  // No scan → clear any elevation filter and hide its control.
  viewer.setElevationFilter(undefined);
  inspector.setElevationExtent(null);
  viewer.setIntensityFilter(undefined);
  inspector.setIntensityExtent(null);
  activeElevFilter = null;
  activeIntenFilter = null;
  streamingFilterSeeded = false;
  // Hide + clear the classification legend so it doesn't linger with a stale
  // class list after the scan is closed. v0.4.1.
  classLegendPanel.setClasses(new Map());
  classLegendPanel.hide();
  hideReclassifyUi();
  // Clear the inspector's copy/JSON scope stamp now there's no active filter.
  syncInspectClassScope();
  lastStreamingReportCloud = null;
  // Cancel any pending scan-type re-route + reset its state so a timer can't
  // fire against the now-closed scan, and the next open routes from scratch.
  routing.cancelScheduled();
  lastScanVerdict = null;
  routing.reset();
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
  scans.clear();
  bookmarks.clear();
  viewer.annotate.clear();
  // Drop the snap index so a future scan can't snap to the previous cloud.
  viewer.measure.setSnapSource(null);
  refreshMeasurePanel();
  refreshAnnotationPanel();
}

/** Remove a cloud from the scene and the Inspector. */

/**
 * Two-epoch change detection over the two loaded layers (first = before,
 * second = after). Runs the shared-grid DTM comparison and shows the cut/fill
 * + co-registration summary. The work (two ground filters) runs on the main
 * thread, so it's deferred a frame to let the "working" line paint; large
 * clouds may take a moment.
 */


function compareLoadedLayers(): void {
  const ids = viewer.clouds();
  if (ids.length !== 2) return;
  const a = viewer.getCloud(ids[0]) ?? null;
  const b = viewer.getCloud(ids[1]) ?? null;
  if (!a || !b) return;
  inspector.setCompareResult(['Comparing elevations… running ground filters, one moment.']);
  inspector.setDifferenceAvailable(false);
  layers.lastDifference = null;
  void (async () => {
    // Load the change-detection code on demand, then yield a frame so the
    // "working" line paints before the synchronous ground-filter compute.
    const [{ buildSharedEpochDtms }, { alignEpochClouds, summarizeAlignment }, { compareDtms, summarizeChange }, { changeToEsriAscii }] =
      await Promise.all([
        loadCompareEpochs(),
        loadAlignEpochs(),
        loadCompareDtms(),
        loadChangeRaster(),
      ]);
    await new Promise((resolve) => setTimeout(resolve, 16));
    try {
      // Pass each cloud's origin: the two are recentred by their own origins, so
      // the comparison must align them in a common world frame, not raw local.
      // Unit info rides along so the shared grid's ~0.25 m cell floor is
      // expressed in SOURCE units (degrees/feet), not raw source-unit 0.25 —
      // and it now comes from ONE context per epoch, built at this boundary, so
      // alignment, difference and exported raster cannot disagree about the
      // metre scale (`epochFrameOptions`) or the declared frame
      // (`declaredFrameLabel` keeps two UNDECLARED scans off the "same frame"
      // branch instead of matching them on the display placeholder).
      const ctxA = spatialContextFrom(a.metadata?.crs);
      const ctxB = spatialContextFrom(b.metadata?.crs);
      const frames = epochFrameOptions(ctxA, ctxB);
      // `sourceOrigin`, not the live project origin: this is the epoch world
      // comparison. The frame facts come from each epoch's context.
      const beforeCloud = { positions: a.positions, origin: a.sourceOrigin, ...epochFrameFacts(ctxA) };
      const afterCloud = { positions: b.positions, origin: b.sourceOrigin, ...epochFrameFacts(ctxB) };
      // Coarse-register the after cloud onto the before cloud first (yaw + x/y
      // only — a real vertical change is the signal, so z is preserved), so a
      // small horizontal misregistration between epochs is not read as movement.
      // Refuse a fit whose residual exceeds 10% of the scene span: that means the
      // two clouds never registered, so it's compared as-is rather than shifted.
      // The span is measured in SOURCE units (horizontalSpanXY is unit-agnostic)
      // while the gate option is metres, so convert by the CRS's linear factor —
      // geographic frames don't have one, but alignment refuses those outright.
      const span = horizontalSpanXY(a.positions, a.sourceOrigin);
      const spanUnitToM = frames.horizontalUnitToMetres ?? 1;
      const { after: alignedAfter, alignment } = alignEpochClouds(beforeCloud, afterCloud, {
        maxResidualM: span > 0 ? span * 0.1 * spanUnitToM : undefined, horizontalUnitKnown: frames.horizontalUnitKnown, // one shared verdict: the alignment and the difference below read the SAME frame facts, so a shift reported in metres is never followed by a difference that refuses metres
      });
      const dtms = buildSharedEpochDtms(beforeCloud, alignedAfter);
      if (!dtms) {
        inspector.setCompareResult(['Could not compare — a layer has no ground points.']);
        return;
      }
      // Unit factors so cut/fill is m³ and Δz/LoD metres, not source units; a
      // geographic frame has no such factor at all, which `frames` flags so the
      // comparison refuses volumes rather than printing degree² figures as m³.
      const cmp = compareDtms(dtms.before, dtms.after, {
        ...frames, // isGeographic + horizontalUnitKnown + horizontalUnitToMetres, from the two contexts
        verticalUnitToMetres: ctxA.verticalUnitToMetres, // Z keeps its OWN declared scale; the horizontal verdict never stands in for it
      });
      const header = `${baseName(a.name)} (before) → ${baseName(b.name)} (after)`;
      inspector.setCompareResult([header, summarizeAlignment(alignment), ...summarizeChange(cmp)]);
      // A georeferenced .asc of the signed difference. The shared grid is built
      // in the common world frame, so its origin IS the scan's projected corner.
      // The .asc grid geometry (cellsize + corners) is in the source LINEAR
      // unit, but detectChange returns Δz in metres. Express the cell values in
      // that same linear unit so the raster is internally consistent (a foot-CRS
      // export otherwise carries foot geometry with metre values, and any GIS
      // volume mixes ft² with m). Metre / compound-metre-horizontal CRS ⇒ 1, a
      // byte-identical no-op; OLV never reprojects, so the grid unit stays source.
      // A provably frame-incompatible pair reports no numbers, so it must not
      // hand out a difference raster either.
      if (cmp.frameIncompatible) {
        inspector.setDifferenceAvailable(false);
        return;
      }
      const gridUnitToMetres = frames.horizontalUnitToMetres ?? 1;
      const ascDiff =
        gridUnitToMetres === 1
          ? cmp.result.diff
          : cmp.result.diff.map((v) => v / gridUnitToMetres);
      layers.lastDifference = {
        stem: `${baseName(a.name)}-to-${baseName(b.name)}-difference`,
        asc: () =>
          changeToEsriAscii({
            diff: ascDiff,
            ncols: dtms.cols,
            nrows: dtms.rows,
            cellSizeM: dtms.cellSizeM,
            xllCorner: dtms.before.originH1,
            yllCorner: dtms.before.originH2,
          }),
      };
      inspector.setDifferenceAvailable(true);
    } catch (err) {
      inspector.setCompareResult([`Compare failed: ${err instanceof Error ? err.message : String(err)}`]);
    }
  })();
}

/** Download the most recent elevation difference as an ESRI ASCII grid. */
function exportDifferenceRaster(): void {
  const diff = layers.lastDifference;
  if (diff) downloadText(`${diff.stem}.asc`, diff.asc());
}

function removeCloud(id: string): void {
  viewer.removeCloud(id);
  inspector.removeCloud(id);
  sourceFileById.delete(id);
  reducedById.delete(id);
  layerVisible.delete(id);
  if (layers.solo === id) layers.solo = null;
  scans.clearIf(id);
  if (viewer.clouds().length === 0) resetToEmptyState();
  else {
    layerService.refreshCrsFlags();
    layerService.applyVisibility();
    inspector.setElevationExtent(viewer.elevationExtent());
    inspector.setIntensityExtent(viewer.intensityExtent());
  }
}

/**
 * Free every currently-open static cloud before a new scan takes over — the
 * mesh's GPU buffers (geometry + material + colour/class attributes) AND the
 * retained source-file + reduced-flag map entries. A new open (static OR
 * streaming) replaces the previous scan, so without this the prior cloud's GPU
 * memory and File reference leak on every reopen (`scans.activeId` is overwritten, so
 * `removeCloud` could never reach the old id). Does NOT reset to the empty
 * state — the caller adds the replacement immediately.
 */
function clearOpenStaticLayers(): void {
  lastDerivedConfidence = null;
  for (const id of viewer.clouds()) {
    viewer.removeCloud(id);
    inspector.removeCloud(id);
    sourceFileById.delete(id);
    reducedById.delete(id);
    scans.clearIf(id);
  }
  layerVisible.clear();
  layers.solo = null;
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
  layerVisible.clear();
  layers.solo = null;
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
      // Publishability: burn the labelled colorbar when a continuous scalar
      // mode is active. Self-gating in the Viewer (categorical modes draw
      // nothing), and single-sourced with the on-screen legend, so the PNG
      // always matches what the user saw.
      colorbar: true,
    });
    // `snapshot()` renders the live scene through the class-mask shader, so a
    // filtered view drops hidden classes from the PNG. Stamp the same scope
    // banner the Studio export path uses so a filtered snapshot can't leave the
    // app undisclosed. With an empty stamp (nothing hidden) the helper returns
    // the input Blob unchanged, keeping the snapshot byte-identical to before.
    let stamped = await composeClassScopeBannerOntoBlob(blob, currentClassScopeStamp());
    // Embed figure provenance (build / CRS / colormap / camera / clip) as PNG
    // text chunks — the same chunks every Studio export carries, so a saved
    // view can answer "which build drew you, seen from where?" months later.
    // The stamping code lives in the lazy Studio chunk (already pre-warmed
    // after a scan loads); a chunk-load or stamping failure is swallowed
    // because the snapshot itself must never sink on a metadata enrichment.
    try {
      const studio = await loadExportStudio();
      stamped = await studio.stampFigureProvenanceOntoBlob(
        stamped,
        viewer.figureViewContext(),
      );
    } catch (err) {
      console.warn('[snapshot] provenance stamping skipped:', err);
    }
    triggerDownload(stamped, 'openlidarviewer.png');
  } catch {
    dropZone.setError('Could not save the view');
  }
}
