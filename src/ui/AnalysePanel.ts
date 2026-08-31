/**
 * AnalysePanel.ts
 *
 * The Analyse panel surfaces terrain readiness and contour/DEM export for
 * a loaded scan. It exposes the validated data pipeline conservatively and
 * fitness-for-use — never survey-grade.
 *
 * A plain-DOM panel mirroring MeasurePanel/AnnotationPanel: a `readonly
 * element`, a callbacks object, `update()`, and `setVisible()`. It reads
 * top-down:
 *
 *   1. Terrain Assessment hero — surface-quality status · score, the headline
 *      reason, export readiness, then a "Recommended workflow" checklist (each
 *      supported workflow graded ✓ / ⚠ / ✕ from the two axes — the upgrade over
 *      the old Best for / Caution / Not for prose), a collapsed "Why? — what's
 *      holding this back" details when the surface is not fully-good, and the
 *      supporting metrics behind the verdict.
 *   2. Details expander (collapsed) — the honesty status chips
 *      (Coverage / DTM / CRS / Datum / Export), DTM & contour readiness,
 *      recommended grid + interval, and coverage & confidence metrics
 *      (mean confidence, vertical RMSE, NVA / VVA, USGS 3DEP Quality
 *      Level). Jargon abbreviations carry plain-language hover tooltips.
 *   3. Surface models — hypsometric / hillshade previews.
 *   4. Contour & DEM exports — gated by the DTM quality gate.
 *   5. A NOT_SURVEY_GRADE footer.
 *
 * Mounted in `main.ts` next to the Measurements and Annotations panels.
 */

import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';

/**
 * What the panel needs to drive the contours derived layer. Every handler
 * RETURNS the value that was actually applied (or null when the layer is gone),
 * so the control re-reads the truth instead of assuming its own click won — the
 * record stays authoritative and the UI cannot drift from what is drawn.
 */
export interface ContourLayerControls {
  readonly visible: boolean;
  /** 0..1. */
  readonly opacity: number;
  readonly indexEmphasis: boolean;
  /** Display lift along the scene vertical axis, in the scan's vertical unit. */
  readonly heightOffset: number;
  /** e.g. "m" / "ft"; null when the file declares no vertical unit. */
  readonly verticalUnitLabel: string | null;
  onVisible(next: boolean): boolean | null;
  onOpacity(next: number): number | null;
  onIndexEmphasis(next: boolean): boolean | null;
  onHeightOffset(next: number): number | null;
}

/**
 * Label a display lift. An unknown vertical unit prints the bare number rather
 * than inventing "m" — the same fail-honest rule the metric readouts follow.
 */
function formatHeightOffset(offset: number, unitLabel: string | null): string {
  const n = Number.isFinite(offset) ? offset : 0;
  const shown = n.toFixed(2).replace(/\.?0+$/, '') || '0';
  return unitLabel ? `${shown} ${unitLabel}` : shown;
}
import {
  ANALYSE_LABELS,
  GRADE_MEANING,
  METRIC_TOOLTIPS,
  NOT_SURVEY_GRADE,
  confidenceWord,
  describeIntervalOption,
  formatHonestValue,
} from '../terrain/contour/contourCopy';
import { gradeForConfidence } from '../terrain/ground/cellConfidence';
import { triggerDownload } from '../io/download';
import {
  coverageHeatmapImage,
  COVERAGE_LEGEND,
  COVERAGE_CAPTION,
} from '../terrain/surface/coverageHeatmap';
// Colourblind-safe twin of the coverage tile: same confidence buckets on the
// Cividis palette, so a colour-vision-deficient viewer isn't left with the
// green/yellow/red ramp. Selected when the colourblind-safe palette is active.
import {
  confidenceOverlayImage,
  CONFIDENCE_LEGEND,
  CONFIDENCE_CAPTION,
} from '../terrain/surface/confidenceOverlay';
import { colorblindSafeClasses } from '../render/colorModes';
import { interpolatedCaption } from '../terrain/contour/evidenceGrade';
import {
  computeTerrainReadiness,
  type ReadinessIndicator,
} from '../terrain/contour/terrainReadiness';
// Contour serialisers + the unified provenance builder are LAZY (v0.5.4):
// only export/report actions (already async) reach them, so they ride their
// own chunk via lazyChunks instead of the eager index. Type-only imports
// below are erased at compile time and pull nothing in.
import type { ContourFormat } from '../terrain/contour/contourDownload';
import type { DxfLinearUnit } from '../terrain/contour/dxfContours';
import {
  CONTOUR_SHAPE_STYLES,
  defaultContourShapeStyle,
  type ContourShapeStyle,
} from '../terrain/contour/contourShapeStyle';
import type { ContourGeneralizeMode } from '../terrain/contour/terrainAwareTolerance';
import {
  loadMapSheetPdf,
  loadDemPackage,
  loadTerrainReportPdf,
  loadContourDownload,
  loadExportProvenance,
  loadContourDeliverableBuild,
  loadContourStudioMount,
  loadContourExportAdapter,
  loadRangeWorkbenchMount,
  loadFeatureCandidatesMount,
} from '../lazyChunks';
import {
  organizedRangeFor,
  subscribeOrganizedRange,
  type OrganizedLayerEntry,
} from '../model/organizedRangeLink';
import type { MountedRangeWorkbench } from './rangeWorkbenchMount';
import type { MountedFeatureCandidates } from './featureCandidatesMount';
import type { PointCloud } from '../model/PointCloud';
import { openModal, type ModalHandle } from './Modal';
import type { SheetSize, SheetOrientation, MapSheetPurpose } from '../render/measure/mapSheetPdf';
import type { Annotation } from '../render/annotate/types';
import {
  SHEET_OPTIONS,
  ORIENTATION_OPTIONS,
  sanitizeMapFilename,
  ensurePdfExtension,
  defaultMapTitle,
  defaultMapNotes,
  defaultMapFilename,
  annotationsOptionState,
} from '../render/measure/mapSheetExportOptions';
import { TERRAIN_METRIC_VERSION } from '../terrain/datasetIntelligence';
import {
  hypsometricColor,
  DEFAULT_CANOPY_PALETTE,
} from '../terrain/contour/hypsometric';
import { histogramBins, type Histogram } from '../terrain/contour/histogram';
import {
  shadeFromSlopeAspect,
  computeMultiHillshade,
} from '../terrain/surface/hillshade';
import { sampleTerrain } from '../terrain/contour/sampleTerrain';
import { terrainAssessment, type SupportingMetric } from '../terrain/contour/terrainAssessment';
import { recommendedWorkflows } from '../terrain/contour/recommendedWorkflow';
import { terrainProducts } from '../terrain/contour/terrainProducts';
import type { FitnessTier, StoryProduct } from '../intelligence/scanStory';
import { explainLimitations } from '../terrain/contour/whyNotReasons';
import {
  renderTerrainProducts,
  renderWorkflowCard,
  renderWhyDetails,
} from './workflowCardRender';
import type {
  LaunchFrameContext,
  ContourStudioExportProduct,
  ContourExportIntent,
} from './contourStudioMount';
import type {
  ContourExportFrameFacts,
  ContourExportPermit,
} from '../export/contourExportPermit';
import { permitStamp } from '../export/permitStamp';
import {
  sameExportTarget,
  TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL,
} from '../export/exportScanIdentity';
import type { ExportPermitStamp } from '../terrain/export/exportProvenance';
import type { ContourExportAdapter, ContourExportHost } from './contourExportAdapter';
import type { SpaceKind } from '../terrain/scanShape';
import type { ScanTypeOverride } from '../terrain/scanRoute';
import type { DatasetIntelligence } from '../terrain/datasetIntelligence';
import {
  createScanTypeControl,
  type ScanTypeControl,
  type ScanTypeDisabledReasons,
} from './scanTypeControl';
import { buildScanFitness, type FitnessInputs } from '../terrain/quality/scanFitness';
import { fitnessIcon, fitnessToneGlyph } from './fitnessIcons';
import { horizontalUnitLabel, verticalUnitSuffix, verticalUnitLabel } from '../units/units';

/** Callbacks the host (main.ts) provides. */
export interface AnalysePanelCallbacks {
  /** Run (or re-run) terrain analysis on the loaded scan. */
  onRun?: () => void;
  /** The user forced a scan type via the "Treat as" override. */
  onScanTypeChange?: (override: ScanTypeOverride) => void;
  /** Re-run the analysis at a chosen contour interval (metres). */
  onSelectInterval?: (intervalM: number) => void;
  /**
   * Build a fresh contour result at a chosen interval for the PDF export ONLY,
   * without mutating the visible panel/result. Implemented by the host over the
   * same cached terrain core the runner uses, so re-picking the deliverable
   * interval is cheap (cache hit) and has no panel side effects. When omitted,
   * the dialog falls back to the current result and disables the interval picker.
   */
  buildResultAtInterval?: (intervalM: number) => Promise<AnalyseContoursResult>;
  /**
   * Build a fresh contour result at a chosen interval AND shape style for an
   * export ONLY, over the same cached terrain core, without mutating the visible
   * panel/result. Generalises {@link buildResultAtInterval} with the contour
   * shape-style picker. When omitted, exports use the on-screen model as-is and
   * the style picker cannot regenerate.
   */
  buildResultForExport?: (opts: {
    intervalM: number;
    shapeStyle: ContourShapeStyle;
    /** Per-purpose generalization tolerance (cells) for the 'generalized' style. */
    generalizeToleranceCells?: number;
    /** Per-purpose generalization mode (uniform | terrain-aware). */
    generalizeMode?: ContourGeneralizeMode;
  }) => Promise<AnalyseContoursResult>;
  /** Optional basename for downloaded files (e.g. the scan name). */
  getExportBasename?: () => string;
  /**
   * The shell's active-scan id (null for a streaming scan). Stamped onto each
   * result in {@link AnalysePanel.update} and compared again at export time.
   *
   * A terrain result is only cleared when the session resets, so opening a
   * SECOND scan additively leaves the first scan's contours, DEM and report on
   * screen while `getMapContext` / `getExportBasename` have already moved to the
   * new scan. Exporting then writes A's geometry with B's world origin, CRS,
   * linear unit and filename — no timing involved, it reproduces every time.
   * With this wired the panel refuses instead. When omitted the panel cannot
   * tell the two apart and behaves as before.
   */
  getActiveScanId?: () => string | null;
  /**
   * The loaded cloud for a scan, or null. The panel offers the feature-candidate
   * review launcher when the cloud carries a classification; the (lazy) review
   * surface reads the building- and wire-classified points itself. Omitted in
   * embeds with no feature review.
   */
  getFeatureCloud?: (scanId: string) => PointCloud | null;
  /**
   * Switch the 3D viewer's colour mode to the colourblind-safe 'confidence'
   * trust overlay — the SAME per-cell confidence + strong/moderate/weak
   * buckets as the coverage tile's legend, rendered on Cividis stops. Wired
   * by the host to the Viewer + the Inspector's COLOR BY chip rail; when
   * omitted the coverage tile simply renders no link (e.g. an embed without
   * a colour-mode rail).
   */
  onColorByConfidence?: () => void;
  /**
   * The Inspector's Dataset Intelligence summary for the loaded scan, or null
   * when the card is empty. Read at Terrain Intelligence Report export time so
   * the PDF's Dataset Statistics section carries the SAME bucket labels
   * (density / complexity / ground visibility / metric stability) the card
   * shows. When omitted or null the report simply skips those rows.
   */
  getDatasetIntelligence?: () => DatasetIntelligence | null;
  /**
   * The scan's placed annotations, in list order, for the (opt-in) annotation
   * layer on the map sheet. The marker index is the 1-based list position, so
   * the host must return them in the SAME order the Annotations panel shows.
   * Omitted / empty ⇒ the sheet's annotation checkbox is disabled and no layer
   * is drawn.
   */
  getAnnotations?: () => ReadonlyArray<Annotation>;
  /** Context for the printable map sheet (world origin, title block fields). */
  getMapContext?: () => {
    /**
     * Load-time recentring origin (world = local + origin). `z` is optional:
     * when the host supplies it, contour exports also shift elevations into
     * the world vertical frame; without it only x/y are registered.
     */
    worldOrigin?: { x: number; y: number; z?: number } | null;
    title?: string;
    preparedBy?: string;
    sheet?: 'letter' | 'a4' | 'a3';
    /** True when the horizontal CRS is geographic (degree cells). */
    isGeographic?: boolean;
    /**
     * Source frame → WGS 84 lon/lat for the RFC 7946 contour GeoJSON.
     * Undefined when the CRS cannot be converted; the export then refuses
     * rather than writing projected numbers into degree fields.
     */
    toLonLat?: (p: readonly [number, number, number]) => [number, number, number];
    /** CRS WKT for the DEM export's .prj sidecar, when known. */
    wkt?: string | null;
    /**
     * Resolved linear unit of the horizontal CRS, when known. Drives the DXF
     * `$INSUNITS` header and the SVG scale note so a foot-based CRS stamps
     * feet (and an unresolved frame stamps honest "unitless") instead of the
     * metre default. Omitted ⇒ serializeContours' standing metre assumption.
     */
    linearUnit?: DxfLinearUnit;
    /**
     * Metres per source VERTICAL (Z) unit, when the frame resolves one — the
     * CRS's own vertical factor when declared, else the horizontal linear factor
     * for a resolved frame (so a metre CRS reads 'm', a foot CRS 'ft'). Drives
     * the complete-deliverable elevation unit, the recommended contour interval,
     * the relief / contour readiness figures, and the map-sheet interval note.
     * Absent / non-finite (local / unknown / geographic frame) ⇒ the value is
     * shown in an honest "unverified" form, NEVER falsely asserted as metres.
     */
    verticalUnitToMetres?: number | null;
    /**
     * The RAW scene up-axis of the loaded scan — the gather's own `sourceUpAxis`
     * — so the map sheet can rotate an annotation's local position into the same
     * canonical frame the contours were built in. 'z' for the survey formats a
     * georeferenced sheet is built from; 'y' for a Y-up phone-scan mesh. Omitted
     * ⇒ the sheet's 'z' default (identity), correct for every georeferenced case.
     */
    sceneUpAxis?: 'z' | 'y';
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string; title?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  return node;
}

/** A small section divider label. */
function section(text: string): HTMLElement {
  return el('div', { className: 'olv-analyse-section', text });
}

/** Prompt shown in a raster tile's sample readout before the user clicks. */
const SAMPLE_HINT = 'Click the map to sample a point.';

/**
 * The panel's resting status line: what it says with no scan and no result.
 * Named once because `update(null)` has to put it BACK. Without that, the
 * status kept whatever the last run wrote, so closing a scan left the panel
 * reading "Analysing…" over an empty state.
 */
const IDLE_STATUS = 'Load a LAS, LAZ, COPC, or EPT dataset to analyze terrain readiness.';

// Session-remembered MAP PDF dialog choices. Module-level by design (per the
// brief — NOT localStorage): they persist across opens within this tab session
// only, so the next export pre-fills the user's last Prepared by / Sheet /
// Orientation / Notes without leaking anything to disk.
let lastPreparedBy = '';
let lastSheet: SheetSize = 'letter';
let lastOrientation: SheetOrientation = 'portrait';
let lastNotes: string | null = null;
// The contour shape style is remembered on the panel instance (so it drives all
// exports), but the MAP-PDF dialog also seeds from the panel's current choice.

/**
 * Split a formatted readiness value into a leading figure and a unit so the
 * UI can set the number large and the unit as a small subscript. Examples:
 *   "68%"          → { num: "68", unit: "%" }
 *   "31% measured" → { num: "31", unit: "% measured" }
 *   "1 m"          → { num: "1",  unit: "m" }
 *   "Not ready"    → { num: "Not ready", unit: "" }  (no leading digit)
 */
export function splitReadinessValue(value: string): { num: string; unit: string } {
  const m = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(value);
  if (!m) return { num: value, unit: '' };
  return { num: m[1], unit: m[2].trim() };
}

/**
 * Decide how a readiness value + detail render across the card's two text slots.
 * The subscript slot beside the big figure is narrow, so only a short, real unit
 * ("m", "%", "ft", "% meas.") is allowed to sit there. A long, word-y annotation
 * such as "(vertical unit unverified)" would collapse that slot into a
 * one-char-per-line column, so it is kept out of the subscript and folded onto
 * the normally-wrapping detail line instead (unless the detail already carries
 * the same caveat, to avoid stating it twice).
 */
export function readinessCardParts(
  value: string,
  detail: string,
): { num: string; unitText: string; detailText: string } {
  const { num, unit } = splitReadinessValue(value);
  const compactUnit = unit.replace(/\bmeasured\b/, 'meas.');
  const unitIsCompact = compactUnit.length <= 8 && !compactUnit.includes('(');
  const caveat = unitIsCompact ? '' : unit;
  return {
    num,
    unitText: unitIsCompact ? compactUnit : '',
    detailText: caveat && !detail.includes(caveat) ? `${detail} · ${caveat}` : detail,
  };
}

export class AnalysePanel {
  /** The panel element — append to the stage overlay (see main.ts). */
  readonly element: HTMLElement;
  private readonly _cb: AnalysePanelCallbacks;
  private readonly _fitnessRow: HTMLElement;
  private readonly _readinessRow: HTMLElement;
  private readonly _recommendRow: HTMLElement;
  private readonly _qualityRow: HTMLElement;
  private readonly _assessmentRow: HTMLElement;
  private readonly _scoreRow: HTMLElement;
  private readonly _surfaceRow: HTMLElement;
  private readonly _validationRow: HTMLElement;
  private readonly _body: HTMLElement;
  private _result: AnalyseContoursResult | null = null;
  /**
   * The scan `_result` was computed on, stamped when the result lands. The
   * result outlives an additive scan open (only a session reset clears it), so
   * this is what tells an export that the analysis on screen and the map context
   * it would be stamped with come from two different scans.
   */
  private _resultScanId: string | null = null;
  /** The "Colour 3D by confidence" toggle button + its current on/off state, so
   *  its label always shows the way back to the original colour. */
  private _confidenceColorBtn?: HTMLButtonElement;
  private _confidenceColorActive = false;
  /** Status line shown while no analysis has run / while computing. */
  private readonly _status: HTMLElement;
  /**
   * Classification-edit staleness caveat over the rendered result — see
   * {@link setStaleNotice}. Same `.olv-caveat` honesty primitive as the
   * MeasurePanel's geographic-CRS notice, so "trust this less" reads the
   * same everywhere.
   */
  private readonly _staleNotice: HTMLElement;
  /** The run/re-run button. */
  private readonly _runBtn: HTMLButtonElement;
  /** Everything that only makes sense once an analysis result exists. */
  private readonly _resultsRegion: HTMLElement;
  /** Export note + legend (the raw export row is retired; see `_buildExportRow`). */
  private readonly _exportNote: HTMLElement;
  private readonly _exportButtons: HTMLButtonElement[] = [];
  /**
   * Contour Studio launcher slot + the gated deliverable container. v0.5.9 §3:
   * the crowded panel no longer shows the contour export controls inline. It
   * shows a noticed "Terrain Products" launcher; the export controls live in
   * `_contourDeliverable`, hidden until the launcher's action is invoked.
   */
  private readonly _rangeLauncher: HTMLElement;
  private readonly _rangeWorkbench: HTMLElement;
  private _rangeMounted: MountedRangeWorkbench | null = null;
  private _rangeLayerId: string | null = null;
  private _rangeToken = 0;
  private _rangeUnsubscribe: (() => void) | null = null;
  private readonly _featureLauncher: HTMLElement;
  private readonly _featureReview: HTMLElement;
  private _featureMounted: MountedFeatureCandidates | null = null;
  private _featureScanId: string | null = null;
  private _featureToken = 0;
  private readonly _contourLauncher: HTMLElement;
  /** Host for the 3D contour derived-layer controls; empty until a layer is drawn. */
  private readonly _contourLayerControls: HTMLElement;
  private readonly _contourDeliverable: HTMLElement;
  /** Monotonic token so a slow lazy launcher load can't mount a stale result. */
  private _contourToken = 0;
  /**
   * Maps each Contour Studio export product to the real, honesty-gated exporter
   * button built in `_buildExportRow`. The Studio's premium export section is the
   * single visible surface; dispatching a product clicks its backing button so
   * all existing guards, provenance, and busy-state logic are reused verbatim.
   */
  private readonly _studioExportBtns = new Map<ContourStudioExportProduct, HTMLButtonElement>();
  /**
   * The contour shape style applied to the quick GeoJSON / SVG / DXF exports.
   * The Export-Contours (map PDF) dialog overrides it per-export; there is no
   * panel-level picker — style is chosen in that dialog.
   */
  private _contourStyle: ContourShapeStyle = defaultContourShapeStyle;
  /**
   * Per-purpose generalization tolerance (cells) adopted from the active Contour
   * Studio export intent, threaded into `buildResultForExport` so each purpose's
   * 'generalized' export simplifies at its own bounded strength. Undefined means
   * "use the default tolerance" (the manual map-PDF style picker never sets it).
   */
  private _contourGeneralizeToleranceCells: number | undefined = undefined;
  /**
   * Per-purpose generalization mode adopted from the active Contour Studio export
   * intent: 'uniform' or 'terrain-aware'. Threaded into `buildResultForExport`
   * beside the tolerance. Undefined means "uniform" (the manual style picker
   * never sets it, so its exports are byte-unchanged).
   */
  private _contourGeneralizeMode: ContourGeneralizeMode | undefined = undefined;
  /**
   * The §19 export permit for the pending map-sheet PDF. The map PDF export runs
   * asynchronously through a dialog, so the permit minted at click time is
   * stashed here and read by `_buildAndDownloadMapPdf`, which refuses to write
   * when it is null or not granted. Cleared after each PDF export attempt.
   */
  private _contourPdfPermit: ContourExportPermit | null = null;
  /**
   * The active purpose's deliverable facts for the pending map-sheet PDF. Stashed
   * at Studio 'pdf' click time (alongside the permit) and read by
   * `_buildAndDownloadMapPdf` so the sheet documents the chosen purpose. Null for
   * any non-Studio export path, keeping that sheet byte-identical. Cleared after
   * each attempt.
   */
  private _contourPdfPurpose: MapSheetPurpose | null = null;
  /** DEM raster export — gated only on a result existing, not the contour gate. */
  private _demButton!: HTMLButtonElement;
  /**
   * Terrain Intelligence Report (PDF) — the client-facing deliverable. Like the
   * DEM button it is gated only on a result existing (NOT the contour gate): the
   * report honestly shows the verdicts + which products are Available / Preview /
   * Blocked, so it is valuable for a preview/blocked scan too.
   */
  private _reportButton!: HTMLButtonElement;
  /** One-line honesty caveat shown under the DEM button for non-full/preview data. */
  private _demNote!: HTMLElement;
  private readonly _legend: HTMLElement;
  /** The always-visible minimal "Planned" section. */
  private readonly _roadmap: HTMLElement;
  /**
   * Cancels the relief tile's pending rAF repaint, if one is scheduled. Set
   * while the interactive hillshade has a frame queued; cleared once it runs.
   * Re-rendering the surface row (which detaches the old tile) and hiding the
   * panel both invoke it so a queued frame can't paint a removed canvas.
   */
  private _reliefRepaintCancel: (() => void) | null = null;
  /** The "Treat as" override control — also reachable from the Object/Space
   *  panel, wired through the host to the same per-session override state. */
  private readonly _scanTypeControl: ScanTypeControl;

  constructor(callbacks: AnalysePanelCallbacks = {}) {
    this._cb = callbacks;
    this.element = el('section', { className: 'olv-analyse-panel' });
    this._scanTypeControl = createScanTypeControl({
      onChange: (o) => this._cb.onScanTypeChange?.(o),
    });

    // Collapsible head (same pattern as the Measurements panel) so the
    // panel is an opt-in chip, not an always-open wall on the left edge.
    const title = el('div', { className: 'olv-analyse-title olv-panel-title', text: 'Analyse' });
    const chevron = el('span', { className: 'olv-chevron', text: '▾' });
    const collapseBtn = el('button', { className: 'olv-collapse-toggle', title: 'Collapse this panel' });
    collapseBtn.setAttribute('type', 'button');
    collapseBtn.setAttribute('aria-label', 'Collapse Analyse panel');
    collapseBtn.append(chevron);
    const head = el('div', { className: 'olv-panel-head' });
    head.append(title, collapseBtn);
    const toggleCollapsed = () => this.element.classList.toggle('olv-collapsed');
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      if (e.target === head || e.target === title) toggleCollapsed();
    });

    const subtitle = el('p', { className: 'olv-analyse-sub', text: ANALYSE_LABELS.contours });
    const runBtn = el('button', {
      className: 'olv-analyse-run',
      text: 'Run terrain analysis',
      title: 'Classify ground, build the DTM, validate it, and check contour readiness',
    });
    runBtn.addEventListener('click', () => {
      runBtn.blur();
      this._cb.onRun?.();
    });
    this._runBtn = runBtn;
    this._status = el('p', {
      className: 'olv-analyse-status',
      text: IDLE_STATUS,
    });
    this._assessmentRow = el('div', { className: 'olv-analyse-assessment' });
    this._scoreRow = el('div', { className: 'olv-analyse-score' });
    this._surfaceRow = el('div', { className: 'olv-analyse-surface' });
    this._fitnessRow = el('div', { className: 'olv-analyse-fitness' });
    this._readinessRow = el('div', { className: 'olv-analyse-readiness' });
    this._recommendRow = el('div', { className: 'olv-analyse-recommend-box' });
    this._qualityRow = el('div', { className: 'olv-analyse-quality' });
    this._validationRow = el('div', { className: 'olv-analyse-validation' });
    this._body = el('div', { className: 'olv-analyse-body' });
    // Build the export buttons (populates `_studioExportBtns` + `_exportButtons`);
    // the returned row is intentionally not mounted — the Contour Studio workspace
    // owns the visible export section and dispatches to these backing buttons.
    this._buildExportRow();
    this._exportNote = el('p', { className: 'olv-analyse-export-note' });
    this._legend = this._buildLegend();
    this._roadmap = this._buildRoadmap();

    // Contour Studio launcher + gated deliverable (v0.5.9 §3). The deliverable is
    // revealed only when the launcher action fires; the Contour Studio workspace
    // (mounted lazily into this container) now owns the single premium export
    // section. The old raw "Contour export" button row is retired — its buttons
    // are still built (below) but kept detached as the backing click-targets the
    // Studio export section dispatches to, so every exporter's guards, provenance
    // and busy-state are reused verbatim rather than re-implemented.
    // Structured data (v0.6.6). A context-sensitive launcher for the Range
    // Frame Workbench: rendered ONLY when the active layer actually carries an
    // acquisition grid, and mounted from its own lazy chunk. It sits OUTSIDE
    // `_resultsRegion` because a scanner grid exists the moment the file is
    // decoded and has nothing to do with whether a terrain analysis has run.
    this._rangeLauncher = el('div', { className: 'olv-analyse-range-launcher' });
    this._rangeWorkbench = el('div', { className: 'olv-analyse-range-workbench olv-hidden' });

    // Feature candidates (v0.6.8). A context-sensitive launcher for the
    // candidate-review surface, rendered ONLY when the active scan carries
    // building- or wire-classified points, and mounted from its own lazy chunk.
    this._featureLauncher = el('div', { className: 'olv-analyse-feature-launcher' });
    this._featureReview = el('div', { className: 'olv-analyse-feature-review olv-hidden' });

    this._contourLauncher = el('div', { className: 'olv-analyse-contour-launcher' });
    this._contourLayerControls = el('div', { className: 'olv-analyse-layer-controls olv-hidden' });
    this._contourDeliverable = el('div', {
      className: 'olv-analyse-contour-deliverable olv-hidden',
    });
    // Re-surface the DEM honesty caveat under the Studio export section. The
    // Contour Studio workspace is prepended into this container at mount time, so
    // this note sits BELOW it; `_renderExportGate` fills + shows it whenever a
    // preview/partial DEM is exportable, keeping the one-line caveat visible in
    // the UI (not only in the exported README).
    this._contourDeliverable.append(this._demNote);

    // Everything that needs a result lives in one region we show/hide.
    this._resultsRegion = el('div', { className: 'olv-analyse-results' });
    // The detailed metrics live behind a collapsed "Details" expander so the
    // Terrain Assessment hero leads and the panel reads top-down: verdict →
    // (details on demand) → surface models → exports. Native <details> keeps it
    // keyboard-accessible with no JS.
    const details = el('details', { className: 'olv-analyse-details' });
    const summary = el('summary', { className: 'olv-analyse-details-summary', text: 'Details' });
    details.append(
      summary,
      this._scoreRow,
      section('DTM & contour readiness'),
      this._readinessRow,
      this._recommendRow,
      this._qualityRow,
      section('Validation detail'),
      this._validationRow,
    );

    // Sits at the TOP of the results region so a stale verdict can never be
    // read as current before the caveat is seen (see setStaleNotice).
    this._staleNotice = el('div', {
      className: 'olv-caveat olv-analyse-stale-notice olv-hidden',
    });

    // Terrain Products (Contour Studio launcher + gated deliverable) leads the
    // results as its own surface — the deliverable entry point is no longer
    // buried below the metrics and surface models. The launcher card carries its
    // own "Terrain Products" eyebrow; this wrapper just groups + spaces it. Only
    // the stale caveat outranks it, so a stale verdict is never read as current.
    const terrainProducts = el('div', { className: 'olv-analyse-products' });
    terrainProducts.append(this._contourLauncher, this._contourLayerControls, this._contourDeliverable);

    this._resultsRegion.append(
      this._staleNotice,
      terrainProducts,
      this._fitnessRow,
      this._assessmentRow,
      details,
      section('Surface models'),
      this._surfaceRow,
      this._legend,
      this._body,
    );

    this.element.append(
      head,
      subtitle,
      this._runBtn,
      this._status,
      this._rangeLauncher,
      this._rangeWorkbench,
      this._featureLauncher,
      this._featureReview,
      this._resultsRegion,
      this._roadmap,
      this._scanTypeControl.element,
      el('p', { className: 'olv-analyse-footer', text: NOT_SURVEY_GRADE }),
    );
    this._resultsRegion.style.display = 'none';
    // Start collapsed — the panel earns its height only after the user
    // runs an analysis.
    this.element.classList.add('olv-collapsed');
    this.setVisible(false);

    // The registry is written where a layer is mounted and dropped, both behind
    // lazy boundaries, so the panel subscribes rather than being pushed to from
    // the startup shell. Reading it once here covers the case where the layer
    // was mounted before this panel was.
    this._rangeUnsubscribe = subscribeOrganizedRange(() => this._refreshRangeLauncher());
    this._refreshRangeLauncher();
    this._refreshFeatureLauncher();
  }

  /**
   * Show, replace, or remove the Range Frame Workbench launcher for whichever
   * layer is active.
   *
   * The gate is the presence of an acquisition grid on that layer and nothing
   * else. No grid means no card at all — not a disabled one — so the panel
   * carries no entry point to a surface that would have nothing to show.
   */
  private _refreshRangeLauncher(): void {
    const layerId = this._cb.getActiveScanId?.() ?? null;
    const entry: OrganizedLayerEntry | null = organizedRangeFor(layerId);
    if (!entry) {
      this._teardownRange();
      return;
    }
    if (this._rangeLayerId === entry.layerId && this._rangeMounted) return;
    this._teardownRange();
    this._rangeLayerId = entry.layerId;
    const token = ++this._rangeToken;
    void loadRangeWorkbenchMount()
      .then((m) => {
        if (token !== this._rangeToken) return;
        this._rangeMounted = m.mountRangeWorkbench({
          set: entry.set,
          layerId: entry.layerId,
          recordPosition: entry.recordPosition,
          upAxis: entry.upAxis,
          launcherHost: this._rangeLauncher,
          workbenchHost: this._rangeWorkbench,
          onLaunch: () => this._rangeWorkbench.classList.remove('olv-hidden'),
        });
      })
      .catch(() => {
        /* An optional inspection surface: omit it rather than break the panel. */
      });
  }

  private _teardownRange(): void {
    this._rangeToken++;
    this._rangeMounted?.dispose();
    this._rangeMounted = null;
    this._rangeLayerId = null;
    this._rangeLauncher.replaceChildren();
    this._rangeWorkbench.replaceChildren();
    this._rangeWorkbench.classList.add('olv-hidden');
  }

  /**
   * Show, replace, or remove the feature-candidate launcher for whichever scan
   * is active. Gated on the host returning extraction input — a scan with no
   * building- or wire-classified points shows no launcher.
   */
  private _refreshFeatureLauncher(): void {
    const scanId = this._cb.getActiveScanId?.() ?? null;
    const cloud = scanId ? this._cb.getFeatureCloud?.(scanId) ?? null : null;
    // Gate cheaply on the presence of a classification — the specific
    // building/wire scan is the lazy surface's job, not a per-refresh cost.
    if (!scanId || !cloud || !cloud.classification) {
      this._teardownFeatures();
      return;
    }
    if (this._featureScanId === scanId && this._featureMounted) return;
    this._teardownFeatures();
    this._featureScanId = scanId;
    const token = ++this._featureToken;
    void loadFeatureCandidatesMount()
      .then((m) => {
        if (token !== this._featureToken) return;
        this._featureMounted = m.mountFeatureCandidates({
          cloud,
          launcherHost: this._featureLauncher,
          reviewHost: this._featureReview,
          onLaunch: () => this._featureReview.classList.remove('olv-hidden'),
        });
      })
      .catch(() => {
        /* An optional review surface: omit it rather than break the panel. */
      });
  }

  private _teardownFeatures(): void {
    this._featureToken++;
    this._featureMounted?.dispose();
    this._featureMounted = null;
    this._featureScanId = null;
    this._featureLauncher.replaceChildren();
    this._featureReview.replaceChildren();
    this._featureReview.classList.add('olv-hidden');
  }

  /** Drop the registry subscription. Call when the panel is discarded. */
  destroy(): void {
    this._teardownFeatures();
    this._rangeUnsubscribe?.();
    this._rangeUnsubscribe = null;
    this._teardownRange();
  }

  private _runLabel(): string {
    return this._result ? 'Re-run analysis' : 'Run terrain analysis';
  }

  /** Three shimmer placeholder cards while the analysis computes. */
  private _showSkeleton(): void {
    this._readinessRow.replaceChildren();
    for (let i = 0; i < 3; i++) {
      this._readinessRow.append(el('div', { className: 'olv-analyse-ready is-skeleton' }));
    }
  }

  /** Show a transient status (e.g. "Analysing…"). */
  setStatus(text: string): void {
    this._status.textContent = text;
    this._status.style.display = '';
  }

  /** Toggle the busy state — disables the run button and shows a status. */
  setBusy(busy: boolean, text = 'Analysing…'): void {
    this._runBtn.disabled = busy;
    this._runBtn.textContent = busy ? 'Analysing…' : this._runLabel();
    if (busy) {
      this.setStatus(text);
      this._showSkeleton();
    }
  }

  /**
   * Show (or clear, with `null`) a staleness caveat over the currently
   * rendered result. Wired from the host's `onClassificationEdited` hook: an
   * in-place class edit invalidates the terrain-core cache (the runner
   * handles that), but the rendered result/contours stay on screen — without
   * this line they read as current when they reflect the PREVIOUS
   * classification (stale-analysis honesty finding, Critical). No-op while
   * no result is shown (nothing on screen to be stale); a fresh
   * {@link update} clears it, because the new run reflects the edit.
   */
  setStaleNotice(text: string | null): void {
    const show = text != null && this._result != null;
    this._staleNotice.textContent = show ? text : '';
    this._staleNotice.classList.toggle('olv-hidden', !show);
  }

  /**
   * The CURRENT analysis result, or null when none has run (or the scan was
   * cleared). Exposed for the session exporter: the `.olvsession` embeds the
   * verify-only processing manifest derived from this result's provenance, and
   * main.ts owns the session-export flow while this panel owns the result —
   * a read-only accessor is the narrowest seam between the two.
   */
  currentResult(): AnalyseContoursResult | null {
    return this._result;
  }

  /** Re-render from a fresh analysis result (or clear when null). */
  update(result: AnalyseContoursResult | null): void {
    this._result = result;
    // Bind the result to the scan it was computed on. The runner only lands a
    // result while its own dataset guard still holds, so the active id here IS
    // the id the analysis ran against.
    this._resultScanId = result ? this._cb.getActiveScanId?.() ?? null : null;
    // Any update supersedes a pending staleness caveat: a fresh result was
    // computed against the edited classes, and a clear removes the result
    // the caveat was about.
    this.setStaleNotice(null);
    const has = !!result;
    this._status.style.display = has ? 'none' : '';
    this._resultsRegion.style.display = has ? '' : 'none';
    // Once results exist the button is a quiet "Re-run", not the loud
    // primary action — visual weight follows importance.
    this._runBtn.textContent = this._runLabel();
    this._runBtn.classList.toggle('is-rerun', has);
    if (!has) {
      // No result: clear the launcher and re-hide the deliverable so a stale
      // contour export UI can never linger after the scan is cleared. Bumping
      // the token cancels any in-flight lazy launcher mount.
      this._contourToken++;
      this._contourLauncher.replaceChildren();
      this._contourDeliverable.classList.add('olv-hidden');
      // Put the resting prompt and the enabled button back. The status line is
      // shown again just above, so leaving the last run's text there surfaced
      // "Analysing…" on a panel with no scan; and `setBusy` is the only other
      // writer of `disabled`, so a run that never reached its release left the
      // control dead for the session.
      this._status.textContent = IDLE_STATUS;
      this._runBtn.disabled = false;
      return;
    }
    this._renderFitness();
    this._renderAssessment();
    this._renderScore();
    this._renderReadiness();
    this._renderRecommend();
    this._renderQualityReasons();
    this._renderValidation();
    this._renderSurface();
    this._renderBody();
    this._renderExportGate();
  }

  /**
   * Supply the reference-frame facts (from the terrain runner, which owns the
   * CRS service) and (re)mount the Contour Studio launcher. The launcher, its
   * state adapter, and its strings live behind a lazy chunk (v0.5.9 §26.1), so
   * this kicks off a dynamic import and mounts the result asynchronously; a
   * monotonic token drops a stale mount if the scan changed meanwhile.
   *
   * The launcher replaces the always-visible contour export section: the export
   * controls stay hidden in `_contourDeliverable` until the user clicks the
   * launcher's action. `null` (or no current result) clears the launcher.
   * Honesty-first: label + enabled state come from the computed launch state.
   */
  /**
   * Show (or clear) the controls for the CONTOURS derived layer drawn in the 3D
   * scene. Passing null hides the group — there is no layer to drive, so an
   * inert control would imply one exists.
   *
   * The panel owns no layer state: every control reports the user's intent and
   * re-reads what the service actually applied, so the record stays the single
   * source of truth and the UI can never drift from what is drawn.
   */
  setContourLayerControls(controls: ContourLayerControls | null): void {
    const host = this._contourLayerControls;
    host.replaceChildren();
    if (!controls) {
      host.classList.add('olv-hidden');
      return;
    }
    host.classList.remove('olv-hidden');
    host.append(el('div', { className: 'olv-analyse-layer-head', text: 'Contours in 3D' }));

    const row = el('div', { className: 'olv-analyse-layer-row' });

    // Visibility.
    const visLabel = el('label', { className: 'olv-analyse-layer-toggle' });
    const visCb = document.createElement('input');
    visCb.type = 'checkbox';
    visCb.checked = controls.visible;
    visCb.setAttribute('aria-label', 'Show contours in the 3D scene');
    visLabel.append(visCb, el('span', { text: 'Show' }));

    // Index emphasis.
    const idxLabel = el('label', { className: 'olv-analyse-layer-toggle' });
    const idxCb = document.createElement('input');
    idxCb.type = 'checkbox';
    idxCb.checked = controls.indexEmphasis;
    idxCb.setAttribute('aria-label', 'Emphasise index contours');
    idxLabel.append(idxCb, el('span', { text: 'Index emphasis' }));
    row.append(visLabel, idxLabel);

    // Opacity.
    const opRow = el('label', { className: 'olv-analyse-layer-slider' });
    const opVal = el('span', {
      className: 'olv-analyse-layer-val',
      text: `${Math.round(controls.opacity * 100)}%`,
    });
    const opInput = document.createElement('input');
    opInput.type = 'range'; opInput.min = '0'; opInput.max = '100'; opInput.step = '5';
    opInput.value = String(Math.round(controls.opacity * 100));
    opInput.setAttribute('aria-label', 'Contour layer opacity');
    opRow.append(el('span', { className: 'olv-analyse-layer-tag', text: 'Opacity' }), opInput, opVal);

    // Height offset — a DISPLAY lift so the lines read on the surface rather
    // than z-fighting the points. Labelled in the scan's own vertical unit, and
    // never presented as a change to the contour elevations.
    const hOff = el('label', { className: 'olv-analyse-layer-slider' });
    const hVal = el('span', {
      className: 'olv-analyse-layer-val',
      text: formatHeightOffset(controls.heightOffset, controls.verticalUnitLabel),
    });
    const hInput = document.createElement('input');
    hInput.type = 'range'; hInput.min = '0'; hInput.max = '200'; hInput.step = '5';
    hInput.value = String(Math.round(controls.heightOffset * 100));
    hInput.setAttribute('aria-label', 'Contour layer height offset (display only)');
    hOff.append(el('span', { className: 'olv-analyse-layer-tag', text: 'Lift' }), hInput, hVal);

    visCb.addEventListener('change', () => {
      // Re-read the applied value: the service, not the checkbox, decides.
      const applied = controls.onVisible(visCb.checked);
      visCb.checked = applied ?? visCb.checked;
    });
    idxCb.addEventListener('change', () => {
      const applied = controls.onIndexEmphasis(idxCb.checked);
      idxCb.checked = applied ?? idxCb.checked;
    });
    opInput.addEventListener('input', () => {
      const next = Number(opInput.value) / 100;
      const applied = controls.onOpacity(next) ?? next;
      opVal.textContent = `${Math.round(applied * 100)}%`;
    });
    hInput.addEventListener('input', () => {
      const next = Number(hInput.value) / 100;
      const applied = controls.onHeightOffset(next) ?? next;
      hVal.textContent = formatHeightOffset(applied, controls.verticalUnitLabel);
    });

    host.append(row, opRow, hOff);
  }

  setContourFrame(ctx: LaunchFrameContext | null): void {
    const token = ++this._contourToken; // any new call supersedes a pending mount
    this._contourLauncher.replaceChildren();
    // Always re-hide first: opening the deliverable is an explicit user action,
    // and a fresh frame must not leak the previous scan's open panel.
    this._contourDeliverable.classList.add('olv-hidden');
    const result = this._result;
    if (!ctx || !result) return;
    void loadContourStudioMount()
      .then((m) => {
        // Drop if a newer frame/result landed while the chunk loaded.
        if (token !== this._contourToken || this._result !== result) return;
        m.mountContourStudio({
          result,
          ctx,
          launcherHost: this._contourLauncher,
          deliverableHost: this._contourDeliverable,
          onLaunch: () => this._contourDeliverable.classList.remove('olv-hidden'),
          onExport: (product, btn, intent, frame) =>
            this._handleContourStudioExport(product, btn, intent, frame),
        });
      })
      .catch(() => {
        /* The launcher is an optional post-analysis surface — if its chunk
         * fails to load, omit it rather than breaking the panel. */
      });
  }

  /**
   * Run the real, honesty-gated exporter behind a Contour Studio export product.
   * The Studio workspace owns the visible premium export section; each product
   * routes to the SAME exporter the panel uses, so every guard (blocked-export
   * refusal), provenance stamp and unit handling is reused — no export logic is
   * duplicated. `srcBtn` (the clicked Studio button) shows the busy state, so a
   * long export reads as in-progress on the button the user actually pressed.
   */
  private _handleContourStudioExport(
    product: ContourStudioExportProduct,
    srcBtn: HTMLButtonElement,
    intent: ContourExportIntent,
    frame: ContourExportFrameFacts,
  ): void {
    // The export orchestration (permit gate, dispatch, busy/blocked state) lives
    // in ContourExportAdapter, loaded LAZILY: the permit resolver pulls the
    // evidence registry, so keeping it out of the eager panel holds that whole
    // chain out of the startup shell (§26.1). The Studio is already lazy, so the
    // chunk is loadable by the time a user can click an export.
    void loadContourExportAdapter()
      .then(({ ContourExportAdapter }) => {
        if (!this._contourExportAdapter) {
          const host: ContourExportHost = {
            setContourStyle: (style, generalizeToleranceCells, generalizeMode) => {
              this._contourStyle = style;
              this._contourGeneralizeToleranceCells = generalizeToleranceCells;
              this._contourGeneralizeMode = generalizeMode;
            },
            exportVector: (fmt, opts) => this._exportContourFormat(fmt, undefined, opts),
            openMapPdf: (permit, intent) => {
              this._contourPdfPermit = permit;
              // Stash the purpose deliverable facts so the async map-sheet build
              // documents the chosen purpose (presentation only; the permit is
              // the sole gate). Field-compatible with MapSheetPurpose.
              this._contourPdfPurpose = intent.deliverable;
              this._studioExportBtns.get('pdf')?.click();
            },
            exportDemPackage: (stamp) => this._exportDemPackage(this._demButton, stamp),
            exportCompletePackage: (permit, intent) => this._exportCompletePackage(permit, intent),
            exportTerrainReport: (stamp) => this._exportTerrainReport(this._reportButton, stamp),
          };
          this._contourExportAdapter = new ContourExportAdapter(host);
        }
        this._contourExportAdapter.handle(product, srcBtn, intent, frame);
      })
      .catch(() => {
        /* The export orchestration chunk failed to load — leave the button
         * untouched rather than crash the panel. */
      });
  }
  private _contourExportAdapter: ContourExportAdapter | null = null;

  /**
   * Composite terrain quality score — a single 0–100 number with its band and
   * a quiet weighted breakdown of the six signals it draws on. Sits above the
   * verdict chips: a glance-level summary, with the gate deciding export.
   */
  /**
   * The single top-level verdict the reviewer asked for — Good / Preview /
   * Limited / Blocked — sitting above every detailed metric so a non-specialist
   * reads the bottom line first: status + folded score, why, what it is good
   * for, what to be cautious about, what it is NOT for, and the real supporting
   * metrics behind it (each colour-coded by its own rating).
   */
  private _renderAssessment(): void {
    this._assessmentRow.replaceChildren();
    if (!this._result) return;
    const a = terrainAssessment(this._result);
    const tier = a.status.toLowerCase(); // good | preview | limited | blocked
    this._assessmentRow.className = `olv-analyse-assessment is-${tier}`;

    // The surface-quality verdict + score + per-dimension breakdown now lead the
    // panel in the Data Fitness scorecard (_renderFitness) — the single
    // authoritative headline. This assessment block no longer repeats that hero;
    // it carries only the things the scorecard doesn't: the Export-readiness
    // axis, the per-deliverable Terrain Products list, the "Why?" causes, and the
    // full metric breakdown. (The exact 0–100 score stays reachable in the
    // collapsed Details disclosure below.)

    // EXPORT READINESS is the SECOND, distinct axis — surface quality gated by
    // a known CRS + vertical datum. Rendered on its own line with its reason so
    // a datum-less but clean scan reads "Surface quality: Good · Export
    // readiness: Preview — vertical datum unknown". Colour reuses the rating
    // tokens (good / moderate / blocked), never a new hardcoded colour.
    let exportTier: 'good' | 'blocked' | 'preview';
    if (a.exportReadiness === 'Ready') {
      exportTier = 'good';
    } else if (a.exportReadiness === 'Blocked') {
      exportTier = 'blocked';
    } else {
      exportTier = 'preview';
    }
    const exportLine = el('div', { className: `olv-analyse-assess-export is-${exportTier}` });
    exportLine.append(
      el('span', { className: 'olv-analyse-assess-export-label', text: 'Export readiness' }),
      el('span', { className: 'olv-analyse-assess-export-verdict', text: a.exportReadiness }),
    );
    if (a.exportReason) {
      exportLine.append(
        el('span', { className: 'olv-analyse-assess-export-reason', text: `— ${a.exportReason}` }),
      );
    }
    this._assessmentRow.append(exportLine);

    // Terrain Products (v0.4.5) — the per-deliverable status list the user
    // reads first: one row per product, Ready ✓ / Preview ⚠ / Blocked ✕ with
    // its one-line reason. A pure VIEW over the same graded workflow rows —
    // `terrainProducts` renames the grades and selects assessment-minted
    // reason strings, minting nothing — so the list can never disagree with
    // the checklist below it. The full "Recommended workflow" checklist stays
    // available, collapsed, for anyone who wants the verb-level detail.
    const workflows = recommendedWorkflows(a, this._result.quality);
    // Pass the verdict reason so products held back by that SAME surface reason
    // don't repeat it on every row (it is already shown once on the verdict);
    // only a product-specific reason renders, and then collapsed behind a toggle.
    this._assessmentRow.append(renderTerrainProducts(terrainProducts(a, workflows), a.reason));
    const workflowDetail = el('details', { className: 'olv-analyse-workflow-details' });
    workflowDetail.append(
      el('summary', {
        className: 'olv-analyse-workflow-details-summary',
        text: 'Workflow detail',
      }),
      renderWorkflowCard(workflows),
    );
    this._assessmentRow.append(workflowDetail);

    // Why? — what's holding this back. Shown only when the surface is not
    // fully-good (Surface Quality below Good, or Export Readiness below Ready):
    // a collapsed details with the honest causes (each with its figure) AND the
    // concrete fixes. When everything is green there is nothing to explain, so
    // the helper returns null and we render nothing.
    const notFullyGood = a.status !== 'Good' || a.exportReadiness !== 'Ready';
    if (notFullyGood) {
      const why = renderWhyDetails(explainLimitations(this._result));
      if (why) this._assessmentRow.append(why);
    }

    // Supporting metrics — each metric is a pill whose colour comes from its own
    // honest rating (good / fair / poor / unknown), never from the overall
    // status, so a single weak signal stays visible at a glance.
    //
    // DENSITY REDUCTION (v0.4.6 saturation audit): instead of one flat 9-pill
    // pile, the chips are tiered. A small PRIMARY row of the 2–3 decisive chips
    // (DTM quality + Coverage + the worst-rated remaining signal) is ALWAYS
    // visible; the FULL nine, grouped into Coverage / Surface / Accuracy /
    // Georef clusters, live in an "All metrics" <details> that defaults open on
    // desktop and collapsed on mobile (CSS-driven, see _syncMetricsDisclosure).
    // Nothing is hidden from a trust decision — the verdict, export readiness,
    // terrain products and the "Why?" causes all stay always-visible above this;
    // only the full numeric breakdown is tiered behind one keyboard-accessible
    // disclosure, with the headline numbers promoted into the primary row.
    this._assessmentRow.append(this._renderAssessMetrics(a.supportingMetrics));

    // Derived complexity metrics (v0.5.4) — one compact line under the
    // assessment: VRM median [IQR] with its window, TPI dominant class with
    // its radius, units always stated. The strings are pre-formatted by the
    // (already lazily-loaded) analysis chunk that computed them, so the
    // panel stays a passthrough and every surface prints the same words.
    // The cited density-reliability caveat renders with the standard
    // `.olv-caveat` honesty treatment; nothing renders when the run
    // measured nothing (no fabricated band).
    const cx = this._result.complexity;
    if (cx?.band) {
      // Collapsed by default: the VRM/TPI detail and its cited reliability
      // caveat are deep metrics, kept one tap away so the assessment reads at
      // a glance instead of ending in a wall of statistics.
      const details = el('details', { className: 'olv-analyse-derived' });
      details.append(
        el('summary', { className: 'olv-analyse-derived-label', text: 'Derived complexity' }),
        el('div', {
          className: 'olv-analyse-derived-value',
          text: `${cx.bandLabel} — ${cx.detail}`,
        }),
      );
      const caveat = cx.warnings.find((w) => w.includes('reliability threshold'));
      if (caveat) {
        details.append(
          el('div', { className: 'olv-caveat olv-analyse-derived-caveat', text: caveat }),
        );
      }
      this._assessmentRow.append(details);
    }
  }

  /**
   * Render the supporting-metrics block: an always-visible primary row of the
   * decisive chips plus a grouped, collapsible "All metrics" disclosure holding
   * the full nine in Coverage / Surface / Accuracy / Georef clusters. Pure DOM
   * grouping — every chip the assessment minted is still present and reachable;
   * the disclosure only tiers the full set behind a default-open (desktop) /
   * default-collapsed (mobile) expander so the panel reads less dense at a glance.
   */
  private _renderAssessMetrics(metrics: ReadonlyArray<SupportingMetric>): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-assess-metricwrap' });
    const byLabel = new Map(metrics.map((m) => [m.label, m] as const));

    const pill = (m: SupportingMetric): HTMLElement => {
      const p = el('div', { className: `olv-analyse-assess-metric is-${m.rating}` });
      p.append(
        el('span', { className: 'olv-analyse-assess-metric-label', text: m.label }),
        el('span', { className: 'olv-analyse-assess-metric-value', text: m.value }),
      );
      return p;
    };

    // ── PRIMARY (always visible): the decisive few ────────────────────────
    // DTM quality is the headline number; Coverage frames everything else. The
    // third slot is the single most concerning remaining signal — the worst-
    // rated chip among the rest (poor > fair > unknown > good) — so whatever is
    // actually dragging this surface down is never buried behind the disclosure.
    const ratingRank: Record<SupportingMetric['rating'], number> = {
      poor: 0,
      fair: 1,
      unknown: 2,
      good: 3,
    };
    const primaryLabels = new Set(['DTM quality', 'Scan scope']);
    const rest = metrics.filter((m) => !primaryLabels.has(m.label));
    const worst = rest
      .slice()
      .sort((x, y) => ratingRank[x.rating] - ratingRank[y.rating])[0];
    if (worst) primaryLabels.add(worst.label);
    const primary = el('div', { className: 'olv-analyse-assess-metrics is-primary' });
    for (const label of ['DTM quality', 'Scan scope', worst?.label]) {
      const m = label ? byLabel.get(label) : undefined;
      if (m) primary.append(pill(m));
    }
    wrap.append(primary);

    // ── ALL METRICS (grouped, progressive disclosure) ─────────────────────
    // Four meaningful clusters instead of a flat pile. Demote the Georef cluster
    // header note when both georef chips read "unknown" (not informative beyond
    // the export-readiness line already shown above) — the chips still render,
    // just flagged so the always-"unknown" pair never masquerades as signal.
    const clusters: Array<{ name: string; labels: string[] }> = [
      { name: 'Coverage', labels: ['Scan scope', 'Empty cells', 'Interpolation'] },
      { name: 'Surface', labels: ['Ground density', 'DTM quality', 'Edge risk'] },
      { name: 'Accuracy', labels: ['Vertical RMSE'] },
      { name: 'Georef', labels: ['CRS', 'Vertical datum'] },
    ];
    const details = el('details', { className: 'olv-analyse-assess-metrics-all' });
    details.append(
      el('summary', {
        className: 'olv-analyse-assess-metrics-summary',
        text: 'All metrics',
      }),
    );
    for (const cluster of clusters) {
      const present = cluster.labels
        .map((l) => byLabel.get(l))
        .filter((m): m is SupportingMetric => m != null);
      if (present.length === 0) continue;
      const allUnknown = present.every((m) => m.rating === 'unknown');
      const group = el('div', {
        className: `olv-analyse-assess-metricgroup${allUnknown ? ' is-uninformative' : ''}`,
      });
      group.append(
        el('div', { className: 'olv-analyse-assess-metricgroup-name', text: cluster.name }),
      );
      const row = el('div', { className: 'olv-analyse-assess-metrics' });
      for (const m of present) row.append(pill(m));
      group.append(row);
      details.append(group);
    }
    // Default open on desktop, collapsed on mobile — set imperatively so it
    // tracks viewport changes without duplicating the chips in the DOM.
    this._syncMetricsDisclosure(details);
    wrap.append(details);
    return wrap;
  }

  /**
   * The deep "All metrics" disclosure (Coverage / Surface / Accuracy / Georef
   * clusters) defaults COLLAPSED — the decisive chips above it (DTM quality,
   * Coverage, Interpolation) carry the headline, so first-glance load stays low
   * and the full breakdown is one click away. Honesty-first: nothing is removed
   * from the DOM, only the default open-state, so every chip stays reachable.
   */
  private _syncMetricsDisclosure(details: HTMLDetailsElement): void {
    details.open = false;
  }

  private _renderScore(): void {
    this._scoreRow.replaceChildren();
    const qs = this._result?.qualityScore;
    if (!qs) return;
    // Honesty parity with the headline verdict: when the assessment tier is
    // `preview` (score computed on a partial / coarse streaming sample), this
    // DETAILS number is provisional too. Mark it with the same tilde the
    // verdict uses and tag the band "· preview" so the expanded breakdown can
    // never read as a settled, full-cloud grade while the hero above it says
    // "Preview · ~54/100". A non-preview score keeps the exact number.
    const isPreview = terrainAssessment(this._result!).status.toLowerCase() === 'preview';
    const approx = isPreview ? '~' : '';
    // The single fitness verdict (Good / Preview / Limited / Blocked) lives in the
    // hero above. This breakdown must NOT assert a second, competing adjective:
    // the 0–100 band ("good" ≥60) and the gate-driven fitness status judge
    // different things, so stamping "good" next to a "Limited" hero reads as a
    // contradiction on the same number. Label this neutrally as the composite
    // score; the tier still drives the colour, and the preview tilde is kept.
    const bandText = isPreview ? 'Composite score · preview' : 'Composite score';
    const head = el('div', { className: 'olv-analyse-score-head' });
    head.append(
      el('span', { className: `olv-analyse-score-num is-${qs.band}`, text: `${approx}${qs.score}` }),
      el('span', { className: 'olv-analyse-score-of', text: '/ 100' }),
      el('span', { className: `olv-analyse-score-band is-${qs.band}`, text: bandText }),
    );
    if (isPreview) {
      head.title =
        'Provisional — scored on the streamed-in sample so far. Let the full cloud stream in, then re-run for a settled grade.';
    }
    this._scoreRow.append(head);
    // The six weighted COMPONENTS (Coverage / Confidence / Validation / Density /
    // Edge / Ground) are the same axes the Data Fitness scorecard above already
    // shows as plain-language traffic-light rows — so the bar breakdown is no
    // longer rendered here. This drill-down keeps only the single composite
    // number; the scorecard owns the per-dimension view.
  }

  /**
   * Surface models — above-ground height (DSM − DTM), slope distribution, and
   * a north-up hillshade preview the user can export as a PNG.
   */
  /**
   * Re-render the surface tiles in place — used when the app-wide colourblind-
   * safe palette toggles, so the coverage tile swaps between the green/yellow/red
   * ramp and its Cividis twin without a re-analysis. No-op with no result;
   * leaves staleness, scan binding and the run button untouched (unlike update).
   */
  refreshForPalette(): void {
    if (this._result) this._renderSurface();
  }

  private _renderSurface(): void {
    // Drop any frame the previous relief tile queued — the tile it would paint
    // is about to be detached by replaceChildren().
    this._reliefRepaintCancel?.();
    this._reliefRepaintCancel = null;
    this._surfaceRow.replaceChildren();
    const r = this._result;
    const s = r?.surface;
    if (!r || !s) return;
    const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');

    const vu = this._verticalSuffix();
    const stats = el('div', { className: 'olv-analyse-surface-stats' });
    stats.append(
      el('div', { className: 'olv-analyse-surface-stat', text: `Above-ground height: p95 ${fmt(s.canopy.p95HeightM)}${vu} · max ${fmt(s.canopy.maxHeightM)}${vu}` }),
      el('div', { className: 'olv-analyse-surface-stat', text: `Slope: mean ${fmt(s.slope.meanDeg)}° · max ${fmt(s.slope.maxDeg)}°` }),
    );
    const total = s.slope.bands.flat + s.slope.bands.moderate + s.slope.bands.steep;
    if (total > 0) {
      const pct = (n: number): number => Math.round((100 * n) / total);
      stats.append(el('div', {
        className: 'olv-analyse-surface-stat is-dim',
        text: `Flat ${pct(s.slope.bands.flat)}% · Moderate ${pct(s.slope.bands.moderate)}% · Steep ${pct(s.slope.bands.steep)}%`,
      }));
    }
    this._surfaceRow.append(stats);

    // Bare-earth elevation distribution — a hypsometric read of the DTM.
    const hist = this._elevationHistogram(r.dtm);
    if (hist) this._surfaceRow.append(hist);

    // Canopy height model — above-ground height (DSM − DTM) on a green ramp.
    // Ground (≈0 m) is left transparent so the eye reads structure, not a
    // flat green field.
    const canopyMax = Number.isFinite(s.canopy.maxHeightM) && s.canopy.maxHeightM > 0
      ? s.canopy.maxHeightM
      : 1;
    const chm = this._rasterPreview({
      label: 'Canopy height (CHM)',
      caption: `Above ground · p95 ${fmt(s.canopy.p95HeightM)}${vu} · max ${fmt(s.canopy.maxHeightM)}${vu}`,
      values: s.canopy.heightM,
      cols: r.dtm.cols,
      rows: r.dtm.rows,
      color: (v) => {
        const c = hypsometricColor(v, 0, canopyMax, DEFAULT_CANOPY_PALETTE);
        return [c.r, c.g, c.b];
      },
      visible: (v) => Number.isFinite(v) && v > 0.05,
      legend: { min: 0, max: s.canopy.maxHeightM, palette: DEFAULT_CANOPY_PALETTE, unit: this._verticalUnitToken() },
      filename: 'canopy-height',
    });
    if (chm) this._surfaceRow.append(chm);

    // Coverage — a green/yellow/red trust read of the bare-earth DTM. Same
    // confidence the dashed-contour evidence uses, so the two agree.
    const coverage = this._coverageTile(r);
    if (coverage) this._surfaceRow.append(coverage);

    // Relief — multi-directional / single-sun hillshade with adjustable sun.
    const relief = this._reliefTile(r, s);
    if (relief) this._surfaceRow.append(relief);
  }

  /**
   * The coverage heatmap tile — green (strong/measured) / yellow (moderate/
   * interpolated) / red (weak/extrapolated or gap), with empty cells left
   * transparent. A projection of the per-cell DTM confidence the pipeline
   * already computes; no new analysis. Carries a 3-stop legend, a click-to-
   * sample readout reporting the cell's confidence + grade word, an Export PNG
   * button, and the honesty caption. Never claims survey-grade.
   */
  private _coverageTile(r: AnalyseContoursResult): HTMLElement | null {
    const cols = r.dtm.cols;
    const rows = r.dtm.rows;
    if (!(cols > 0 && rows > 0) || r.dtm.confidence.length !== cols * rows) return null;

    // Honour the app's colourblind-safe palette preference for this data tile.
    const cvd = colorblindSafeClasses();
    const canvas = this._makeCanvas(cols, rows);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(cols, rows);
      // The rasteriser flips north-up to match the other preview tiles; copy
      // its RGBA straight into the canvas ImageData. Under the colourblind-safe
      // palette, render the Cividis confidence twin instead of the green/yellow/
      // red ramp — same buckets, accessible colours.
      const raster = cvd
        ? confidenceOverlayImage(r.dtm, { northUp: true })
        : coverageHeatmapImage(r.dtm, { northUp: true });
      img.data.set(raster.data);
      ctx.putImageData(img, 0, 0);
    }

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: 'Coverage (trust)' }));
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);
    tile.append(this._coverageLegend(cvd));
    tile.append(el('div', { className: 'olv-analyse-caption', text: cvd ? CONFIDENCE_CAPTION : COVERAGE_CAPTION }));

    const readout = this._sampleReadout();
    this._attachCoverageSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'coverage'));
    tile.append(this._tileFooter(readout, dl));

    // Link to the 3D 'Confidence' colour mode — the colourblind-safe twin of
    // this tile, painting the SAME buckets onto the point cloud itself. Lives
    // on the tile because the tile's legend is where the buckets are defined;
    // the Inspector's COLOR BY rail carries the matching chip.
    if (this._cb.onColorByConfidence) {
      const link = el('button', {
        className: 'olv-analyse-surface-dl',
        title:
          'Colour the 3D point cloud by this per-cell confidence — same ' +
          'strong/moderate/weak buckets, colourblind-safe (Cividis) ramp. ' +
          'Click again to restore the original colour.',
      });
      // The button is a TOGGLE: its label and pressed state reflect whether the
      // confidence overlay is currently on, so there is always an obvious way
      // back to the original colour (the COLOR BY rail on the right is the other
      // route, but the user clicked HERE so the way out belongs here too).
      this._confidenceColorBtn = link;
      this._applyConfidenceColorLabel();
      link.addEventListener('click', () => this._cb.onColorByConfidence?.());
      tile.append(link);
    }
    return tile;
  }

  /** Reflect whether the confidence overlay is currently active on the toggle
   *  button — label flips to "Show original colour" and a pressed state shows.
   *  Called by the host when the overlay is toggled (here or via COLOR BY). */
  setConfidenceColorActive(active: boolean): void {
    this._confidenceColorActive = active;
    this._applyConfidenceColorLabel();
  }

  private _applyConfidenceColorLabel(): void {
    const btn = this._confidenceColorBtn;
    if (!btn) return;
    btn.textContent = this._confidenceColorActive
      ? 'Show original colour'
      : 'Colour 3D by confidence';
    btn.classList.toggle('olv-chip-active', this._confidenceColorActive);
    btn.setAttribute('aria-pressed', this._confidenceColorActive ? 'true' : 'false');
  }

  /** A discrete 3-stop coverage legend: the green/yellow/red ramp, or the Cividis
   *  confidence twin when the colourblind-safe palette is active. Same buckets. */
  private _coverageLegend(colorblindSafe = false): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-coverage-legend' });
    for (const stop of colorblindSafe ? CONFIDENCE_LEGEND : COVERAGE_LEGEND) {
      const item = el('div', { className: 'olv-analyse-coverage-legend-item' });
      const sw = el('span', { className: 'olv-analyse-coverage-swatch' });
      sw.style.background = `rgb(${stop.color.r},${stop.color.g},${stop.color.b})`;
      item.append(sw, el('span', { text: `${stop.word} — ${stop.meaning}` }));
      wrap.append(item);
    }
    return wrap;
  }

  /**
   * Click-to-sample for the coverage tile: maps a click to a DTM cell and
   * reports that cell's confidence + grade word, reusing the readout style of
   * the other tiles. Reads the confidence grid directly (sampleTerrain doesn't
   * carry confidence), so the readout matches the pixel under the crosshair.
   */
  private _attachCoverageSampler(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    cols: number,
    rows: number,
    readout: HTMLElement,
  ): void {
    canvas.classList.add('is-samplable');
    canvas.addEventListener('click', (e) => {
      const r = this._result;
      if (!r) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const col = Math.max(0, Math.min(cols - 1, Math.floor(fx * cols)));
      const displayRow = Math.max(0, Math.min(rows - 1, Math.floor(fy * rows)));
      const row = rows - 1 - displayRow; // undo the north-up flip
      const i = row * cols + col;
      const covered = r.dtm.coverage[i] !== 0;
      if (!covered) {
        readout.textContent = 'Sample · outside coverage';
        readout.classList.add('is-empty');
      } else {
        const conf = r.dtm.confidence[i];
        const grade = gradeForConfidence(conf);
        let support: 'strong' | 'moderate' | 'weak';
        if (grade === 'solid') {
          support = 'strong';
        } else if (grade === 'dashed') {
          support = 'moderate';
        } else {
          support = 'weak';
        }
        const c = Number.isFinite(conf) ? Math.round(conf) : 0;
        readout.textContent = `Sample · ${support} support · confidence ${c}% (${confidenceWord(conf)})`;
        readout.classList.remove('is-empty');
      }
      crosshair.style.left = `${(fx * 100).toFixed(2)}%`;
      crosshair.style.top = `${(fy * 100).toFixed(2)}%`;
      crosshair.style.display = 'block';
    });
  }

  /**
   * Render a grid raster as a north-up preview tile with a heading, caption,
   * optional colour-ramp legend, click-to-sample, and a print-resolution PNG
   * export. Shared raster-preview system used by the canopy-height tile.
   */
  private _rasterPreview(opts: {
    label: string;
    caption: string;
    values: ArrayLike<number>;
    cols: number;
    rows: number;
    /** src grid index → RGB (0–255). */
    color: (value: number, srcIndex: number) => [number, number, number];
    /** src grid index → whether the cell is drawn (else transparent). */
    visible: (value: number, srcIndex: number) => boolean;
    filename: string;
    legend?: { min: number; max: number; palette: typeof DEFAULT_CANOPY_PALETTE; unit: string };
  }): HTMLElement | null {
    const { cols, rows, values } = opts;
    if (!(cols > 0 && rows > 0) || values.length !== cols * rows) return null;

    const canvas = this._makeCanvas(cols, rows);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(cols, rows);
      for (let row = 0; row < rows; row++) {
        const src = (rows - 1 - row) * cols; // flip so north reads up
        const dst = row * cols;
        for (let c = 0; c < cols; c++) {
          const si = src + c;
          const o = (dst + c) * 4;
          if (opts.visible(values[si], si)) {
            const [rr, gg, bb] = opts.color(values[si], si);
            img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
          } else {
            img.data[o + 3] = 0;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: opts.label }));
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);

    if (opts.legend && Number.isFinite(opts.legend.max) && opts.legend.max > 0) {
      tile.append(this._legendBar(opts.legend));
    }
    tile.append(el('div', { className: 'olv-analyse-caption', text: opts.caption }));

    const readout = this._sampleReadout();
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, opts.filename));
    tile.append(this._tileFooter(readout, dl));
    return tile;
  }

  /**
   * The relief tile — a hillshade the user can re-light interactively. Defaults
   * to a soft multi-directional shade; a toggle drops to a single sun with an
   * azimuth slider, and altitude applies to both. Re-lighting reuses the cached
   * slope/aspect grids, so it's a cheap per-cell pass with no Horn recompute.
   */
  private _reliefTile(
    r: AnalyseContoursResult,
    s: AnalyseContoursResult['surface'],
  ): HTMLElement | null {
    const cols = r.dtm.cols;
    const rows = r.dtm.rows;
    const { slope, aspect } = s.relief;
    const coverage = r.dtm.coverage;
    if (!(cols > 0 && rows > 0) || slope.length !== cols * rows) return null;

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: 'Relief (hillshade)' }));
    const canvas = this._makeCanvas(cols, rows);
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);
    tile.append(this._grayLegend());

    const caption = el('div', { className: 'olv-analyse-caption' });
    let multi = true;
    let azimuth = 315;
    let altitude = 45;

    const repaint = (): void => {
      const res = multi
        ? computeMultiHillshade(slope, aspect, coverage, cols, rows, { altitudeDeg: altitude })
        : shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, {
            azimuthDeg: azimuth,
            altitudeDeg: altitude,
          });
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(cols, rows);
        for (let row = 0; row < rows; row++) {
          const src = (rows - 1 - row) * cols;
          const dst = row * cols;
          for (let c = 0; c < cols; c++) {
            const si = src + c;
            const o = (dst + c) * 4;
            if (res.coverage[si] !== 0) {
              const v = res.shade[si];
              img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
            } else {
              img.data[o + 3] = 0;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      caption.textContent = multi
        ? `Multi-directional · alt ${altitude}°`
        : `Sun ${String(azimuth).padStart(3, '0')}° · alt ${altitude}°`;
    };

    // Coalesce slider repaints into one rAF: dragging fires many `input`
    // events per frame, but a full per-cell hillshade + ImageData write is
    // expensive on a large grid. We keep only a single pending frame; when it
    // runs it reads the LATEST azimuth/altitude (the slider handlers update
    // those before scheduling), so intermediate positions are skipped and the
    // most recent one always wins — including the final value on release.
    // The pending frame is cancellable from outside (see _reliefRepaintCancel)
    // so a re-render or panel close can't leave a queued frame painting a
    // detached canvas.
    let reliefRafId: number | null = null;
    const canSchedule = typeof requestAnimationFrame === 'function';
    const cancelRepaint = (): void => {
      if (reliefRafId !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(reliefRafId);
        reliefRafId = null;
      }
    };
    const scheduleRepaint = (): void => {
      // No rAF (e.g. jsdom in tests) — fall back to a synchronous repaint so
      // behaviour is unchanged where coalescing isn't available.
      if (!canSchedule) { repaint(); return; }
      if (reliefRafId !== null) return;
      reliefRafId = requestAnimationFrame(() => {
        reliefRafId = null;
        repaint();
      });
    };
    // Expose the cancel so teardown (surface re-render / panel hide) can drop a
    // queued frame before this tile is detached.
    this._reliefRepaintCancel = cancelRepaint;

    // Controls: multi-directional toggle + azimuth + altitude.
    const controls = el('div', { className: 'olv-analyse-relief-controls' });
    const multiLabel = el('label', { className: 'olv-analyse-relief-toggle' });
    const multiCb = document.createElement('input');
    multiCb.type = 'checkbox';
    multiCb.checked = true;
    multiLabel.append(multiCb, el('span', { text: 'Multi-directional' }));

    const azRow = el('label', { className: 'olv-analyse-relief-slider is-off' });
    const azVal = el('span', { className: 'olv-analyse-relief-val', text: 'off' });
    const azInput = document.createElement('input');
    azInput.type = 'range'; azInput.min = '0'; azInput.max = '360'; azInput.step = '5';
    azInput.value = '315'; azInput.disabled = true;
    azInput.setAttribute('aria-label', 'Sun azimuth');
    azRow.append(el('span', { className: 'olv-analyse-relief-tag', text: 'Sun' }), azInput, azVal);

    const altRow = el('label', { className: 'olv-analyse-relief-slider' });
    const altVal = el('span', { className: 'olv-analyse-relief-val', text: '45°' });
    const altInput = document.createElement('input');
    altInput.type = 'range'; altInput.min = '5'; altInput.max = '85'; altInput.step = '5';
    altInput.value = '45';
    altInput.setAttribute('aria-label', 'Sun altitude');
    altRow.append(el('span', { className: 'olv-analyse-relief-tag', text: 'Alt' }), altInput, altVal);

    multiCb.addEventListener('change', () => {
      multi = multiCb.checked;
      azInput.disabled = multi;
      azRow.classList.toggle('is-off', multi);
      azVal.textContent = multi ? 'off' : `${String(azimuth).padStart(3, '0')}°`;
      repaint();
    });
    azInput.addEventListener('input', () => {
      azimuth = Number(azInput.value);
      azVal.textContent = `${String(azimuth).padStart(3, '0')}°`;
      scheduleRepaint();
    });
    altInput.addEventListener('input', () => {
      altitude = Number(altInput.value);
      altVal.textContent = `${altitude}°`;
      scheduleRepaint();
    });
    controls.append(multiLabel, azRow, altRow);
    tile.append(controls);
    tile.append(caption);

    const readout = this._sampleReadout();
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'relief'));
    tile.append(this._tileFooter(readout, dl));

    repaint();
    return tile;
  }

  /**
   * v0.5.5 P12 — compact per-tile footer. Adjacent raster tiles (coverage,
   * relief, canopy) each stacked a full-width "Click the map to sample a
   * point." row above a full-width "Export PNG" row, so the rail repeated
   * the same two blocks map after map. The readout and the tile's action
   * button now share ONE compact line per map. Nothing is removed — the
   * readout keeps its live-region semantics and its hint text, and the
   * button keeps its behaviour; only the presentation is consolidated.
   */
  private _tileFooter(readout: HTMLElement, ...actions: HTMLElement[]): HTMLElement {
    const footer = el('div', { className: 'olv-analyse-tile-footer' });
    footer.append(readout, ...actions);
    return footer;
  }

  /** A grid-sized canvas styled as a preview raster. */
  private _makeCanvas(cols: number, rows: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    canvas.className = 'olv-analyse-raster';
    return canvas;
  }

  /** A colour-ramp legend bar with min/max ticks. */
  private _legendBar(legend: {
    min: number; max: number; palette: typeof DEFAULT_CANOPY_PALETTE; unit: string;
  }): HTMLElement {
    const stops = legend.palette
      .map((s) => `rgb(${s.color.r},${s.color.g},${s.color.b}) ${Math.round(s.t * 100)}%`)
      .join(', ');
    const wrap = el('div', { className: 'olv-analyse-legend' });
    const bar = el('div', { className: 'olv-analyse-legend-bar' });
    bar.style.background = `linear-gradient(90deg, ${stops})`;
    const ticks = el('div', { className: 'olv-analyse-legend-ticks' });
    ticks.append(
      el('span', { text: `${legend.min}` }),
      el('span', { text: `${legend.max.toFixed(1)} ${legend.unit}` }),
    );
    wrap.append(bar, ticks);
    return wrap;
  }

  /** Wrap a raster canvas so a positioned crosshair can ride on top of it. */
  private _rasterWrap(canvas: HTMLCanvasElement): { wrap: HTMLElement; crosshair: HTMLElement } {
    const wrap = el('div', { className: 'olv-analyse-raster-wrap' });
    const crosshair = el('span', { className: 'olv-analyse-xhair' });
    crosshair.style.display = 'none';
    wrap.append(canvas, crosshair);
    return { wrap, crosshair };
  }

  /** A polite live region for sample readouts (screen readers announce updates). */
  private _sampleReadout(): HTMLElement {
    const readout = el('div', { className: 'olv-analyse-sample', text: SAMPLE_HINT });
    readout.setAttribute('role', 'status');
    readout.setAttribute('aria-live', 'polite');
    return readout;
  }

  /** A static dark→light legend strip for the grayscale relief tile. */
  private _grayLegend(): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-legend' });
    const bar = el('div', { className: 'olv-analyse-legend-bar' });
    bar.style.background = 'linear-gradient(90deg, #1a1d24 0%, #f4f6fb 100%)';
    const ticks = el('div', { className: 'olv-analyse-legend-ticks' });
    ticks.append(el('span', { text: 'shadow' }), el('span', { text: 'light' }));
    wrap.append(bar, ticks);
    return wrap;
  }

  /** Click-to-sample: map a click on a north-up raster to a DTM cell + readout. */
  private _attachSampler(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    cols: number,
    rows: number,
    readout: HTMLElement,
  ): void {
    canvas.classList.add('is-samplable');
    canvas.addEventListener('click', (e) => {
      const r = this._result;
      if (!r) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const col = Math.max(0, Math.min(cols - 1, Math.floor(fx * cols)));
      const displayRow = Math.max(0, Math.min(rows - 1, Math.floor(fy * rows)));
      const row = rows - 1 - displayRow; // undo the north-up flip
      const sample = sampleTerrain(r, col, row);
      readout.textContent = this._sampleReadoutText(sample);
      readout.classList.toggle('is-empty', !sample?.covered);
      // Drop the crosshair at the click point — percentages survive resize.
      crosshair.style.left = `${(fx * 100).toFixed(2)}%`;
      crosshair.style.top = `${(fy * 100).toFixed(2)}%`;
      crosshair.style.display = 'block';
    });
  }

  /**
   * The surface rasters (elevation, canopy height) keep Z in the source file's
   * VERTICAL unit — the terrain core never converts it. So the on-screen labels
   * must name that unit, not hardcode "m": a US-foot scan's 30 ft canopy was
   * being printed as "30 m". Derived from the map context's
   * `verticalUnitToMetres`; unknown surfaces as an explicit "unverified" tag,
   * never a false metre claim.
   */
  private _verticalSuffix(): string {
    return verticalUnitSuffix(this._cb.getMapContext?.()?.verticalUnitToMetres);
  }

  /** The bare vertical-unit token ('m' | 'ft' | 'units') for legend captions. */
  private _verticalUnitToken(): string {
    const vum = this._cb.getMapContext?.()?.verticalUnitToMetres;
    return vum != null && Number.isFinite(vum) && vum > 0 ? verticalUnitLabel(vum) : 'units';
  }

  /** Format a terrain sample for the readout line. */
  private _sampleReadoutText(sample: ReturnType<typeof sampleTerrain>): string {
    if (!sample) return SAMPLE_HINT;
    if (!sample.covered) return 'Sample · outside coverage';
    const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const u = this._verticalSuffix();
    return `Sample · ${f(sample.elevationM, 2)}${u} · slope ${f(sample.slopeDeg)}° · canopy ${f(sample.canopyM)}${u}`;
  }

  /** Upscale a preview canvas to ~2048 px long edge and download as PNG. */
  private _downloadRasterPng(
    source: HTMLCanvasElement,
    cols: number,
    rows: number,
    filename: string,
  ): void {
    const TARGET_LONG_EDGE = 2048;
    const longEdge = Math.max(cols, rows);
    const scale = longEdge > 0 ? Math.max(1, TARGET_LONG_EDGE / longEdge) : 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cols * scale));
    out.height = Math.max(1, Math.round(rows * scale));
    const octx = out.getContext('2d');
    if (octx) {
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(source, 0, 0, out.width, out.height);
    }
    (octx ? out : source).toBlob((blob) => {
      if (!blob) return;
      triggerDownload(blob, `${this._cb.getExportBasename?.() ?? 'terrain'}-${filename}.png`);
    });
  }

  /**
   * Compact SVG histogram of the bare-earth DTM elevations (covered cells
   * only). A quick read of the terrain's hypsometry — where the ground sits.
   * Returns null when there are too few cells to be meaningful.
   */
  private _elevationHistogram(dtm: { z: Float32Array; coverage: Uint8Array }): HTMLElement | null {
    // The analysis runs in the cloud's RECENTRED frame, so `dtm.z` is local —
    // the DEM package adds the load-time vertical origin back before writing
    // absolute grids, and this panel must do the same or it labels a local
    // residual "Bare-earth elevation … m". On a Swiss LV95 scan whose true
    // ground sits at 330–467 m, the un-restored read showed −498.9 – −388.8:
    // the right SHAPE at the wrong datum, which is exactly the kind of wrong
    // that survives a glance. No origin ⇒ the frame is local anyway, so the
    // caption says so rather than implying an elevation.
    const oz = this._cb.getMapContext?.()?.worldOrigin?.z;
    const shift = Number.isFinite(oz) ? (oz as number) : 0;
    const absolute = shift !== 0;
    const covered: number[] = [];
    for (let i = 0; i < dtm.z.length; i++) {
      if (dtm.coverage[i] !== 0 && Number.isFinite(dtm.z[i])) covered.push(dtm.z[i] + shift);
    }
    if (covered.length < 16) return null;
    const hist = histogramBins(covered, 24);
    if (hist.peak <= 0 || !(hist.max > hist.min)) return null;

    const wrap = el('div', { className: 'olv-analyse-hist' });
    wrap.append(el('div', { className: 'olv-analyse-sublabel', text: 'Bare-earth elevation' }));
    wrap.append(this._histogramSvg(hist));
    const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '—');
    wrap.append(el('div', {
      className: 'olv-analyse-caption',
      text:
        `${fmt(hist.min)} – ${fmt(hist.max)}${this._verticalSuffix()} · ${hist.total.toLocaleString()} cells` +
        (absolute ? '' : ' · local frame (no vertical origin)'),
    }));
    return wrap;
  }

  /** Build the bar SVG for a histogram. Pure layout — no labels (caption carries them). */
  private _histogramSvg(hist: Histogram): SVGSVGElement {
    const W = 240;
    const H = 56;
    const n = hist.counts.length;
    const gap = 1;
    const bw = (W - gap * (n - 1)) / n;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'olv-analyse-hist-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Bare-earth elevation distribution');
    for (let i = 0; i < n; i++) {
      const h = hist.peak > 0 ? (hist.counts[i] / hist.peak) * (H - 2) : 0;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', `${(bw + gap) * i}`);
      rect.setAttribute('y', `${H - h}`);
      rect.setAttribute('width', `${Math.max(0.5, bw)}`);
      rect.setAttribute('height', `${h}`);
      rect.setAttribute('class', 'olv-analyse-hist-bar');
      svg.append(rect);
    }
    return svg;
  }

  private _renderReadiness(): void {
    this._readinessRow.replaceChildren();
    if (!this._result) return;
    // Thread the source vertical-unit scale so the contour-readiness value /
    // relief carry the CRS's real unit (or an honest "unverified") instead of a
    // hard-coded metre.
    const readiness = computeTerrainReadiness(this._result, {
      verticalUnitToMetres: this._cb.getMapContext?.()?.verticalUnitToMetres,
    });
    for (const ind of [
      readiness.groundConfidence,
      readiness.dtmQuality,
      readiness.contourReadiness,
    ]) {
      this._readinessRow.append(this._readinessCard(ind));
    }
  }

  private _readinessCard(ind: ReadinessIndicator): HTMLElement {
    const card = el('div', { className: `olv-analyse-ready is-${ind.rating}` });

    // Right column: a big tabular figure with the unit set as a subscript,
    // and a colour-coded rating pill (the rating word stays for colourblind
    // safety, no longer relying on hue alone). A long, word-y unit is demoted
    // off the narrow subscript and onto the detail line (see readinessCardParts).
    const { num, unitText, detailText } = readinessCardParts(ind.value, ind.detail);

    // Left column: label over the supporting line.
    const main = el('div', { className: 'olv-analyse-ready-main' });
    main.append(
      el('div', { className: 'olv-analyse-ready-label', text: ind.label }),
      el('div', { className: 'olv-analyse-ready-detail', text: detailText }),
    );

    const figure = el('div', {
      className: `olv-analyse-ready-figure${/\d/.exec(num) ? '' : ' is-text'}`,
    });
    figure.append(el('span', { className: 'olv-analyse-ready-value', text: num }));
    if (unitText) figure.append(el('span', { className: 'olv-analyse-ready-unit', text: unitText }));

    const side = el('div', { className: 'olv-analyse-ready-side' });
    side.append(
      figure,
      el('span', {
        className: 'olv-analyse-ready-rating',
        text: ind.rating === 'unavailable' ? 'N/A' : ind.rating,
      }),
    );

    card.append(main, side);
    return card;
  }

  setVisible(on: boolean): void {
    // Hiding the panel mid-drag: drop any queued relief repaint so it can't
    // fire against a tile that's no longer on screen.
    if (!on) {
      this._reliefRepaintCancel?.();
      this._reliefRepaintCancel = null;
    }
    this.element.style.display = on ? '' : 'none';
  }

  /** Whether the panel is currently shown (not display:none). */
  isVisible(): boolean {
    return this.element.style.display !== 'none';
  }

  /**
   * Programmatically expand the panel out of its collapsed-chip state. The
   * panel is constructed collapsed (it earns its height only once the user
   * wants terrain), but when the host routes here by FORCING terrain over a
   * non-terrain detection it must expand — otherwise the busy state, the
   * result, and the "Treat as" control (the way back to the Space/Object
   * panel) are all hidden under the chip and the hand-off reads as the panel
   * simply shutting down.
   */
  expand(): void {
    this.element.classList.remove('olv-collapsed');
  }

  /**
   * Story-relevant facts from the CURRENT terrain assessment — the surface tier,
   * the per-product Ready/Preview/Blocked grades, and the AUTHORITATIVE
   * georeferencing knowledge (the same `quality.crsKnown` / `quality.datumKnown`
   * the panel's own CRS / Datum chips render) — for the Dataset Story / Export
   * Health synthesis. Returns null when no analysis has run, so the story
   * degrades to "not yet analysed" rather than fabricating a verdict, and the
   * caller falls back to a metadata read for georef.
   */
  storyFacts(): {
    surfaceTier: FitnessTier;
    products: StoryProduct[];
    crsKnown: boolean;
    datumKnown: boolean;
  } | null {
    if (!this._result) return null;
    const a = terrainAssessment(this._result);
    const workflows = recommendedWorkflows(a, this._result.quality);
    const products: StoryProduct[] = terrainProducts(a, workflows).map((p) => {
      let status: StoryProduct['status'];
      if (p.status === 'ready') {
        status = 'Ready';
      } else if (p.status === 'preview') {
        status = 'Preview';
      } else {
        status = 'Blocked';
      }
      return { label: p.label, status };
    });
    const tier: FitnessTier =
      a.status === 'Good' || a.status === 'Preview' || a.status === 'Limited' || a.status === 'Blocked'
        ? a.status
        : 'Unknown';
    return {
      surfaceTier: tier,
      products,
      crsKnown: !!this._result.quality.crsKnown,
      datumKnown: !!this._result.quality.datumKnown,
    };
  }

  /** Reflect the host's override + the effective route in the "Treat as"
   *  control, so the terrain panel can also force Object / Interior / Auto.
   *  `disabled` greys out segments detection has ruled out, with reasons. */
  setScanType(
    override: ScanTypeOverride,
    effective: SpaceKind | null,
    disabled?: ScanTypeDisabledReasons,
    detectionCommitted?: boolean,
  ): void {
    this._scanTypeControl.set(override, effective, disabled, detectionCommitted);
    // Opening a scan routes through here, and the active layer is what the
    // launcher is gated on, so this is where a newly opened structured file
    // gets its entry point.
    this._refreshRangeLauncher();
    this._refreshFeatureLauncher();
  }

  /**
   * Attach a "what this means" hover hint to a metric node, matching the
   * affordance the Inspector's DatasetIntelligenceCard uses on its rows:
   * the plain-language string becomes the `title` attribute and the cursor
   * turns to `help` so users see more info is one hover away. Additive and
   * accessible — never changes the displayed value.
   */
  private _hint<T extends HTMLElement>(node: T, tooltip: string): T {
    node.title = tooltip;
    node.style.cursor = 'help';
    return node;
  }

  private _renderValidation(): void {
    this._validationRow.replaceChildren();
    const v = this._result?.validation;
    if (!v) return;
    const rmse = formatHonestValue({
      value: Number.isFinite(v.rmse) ? v.rmse : null,
      units: 'm',
      reasonWhenAbsent: 'Not enough ground points to cross-validate.',
    });
    const cal = this._result?.confidenceOrdering;
    let calText: string;
    if (cal?.assessable) {
      calText = cal.orderingConsistent
        ? 'Confidence ordering is consistent with held-out error.'
        : 'Warning: confidence does not track error here.';
    } else {
      calText = 'Confidence ordering not assessable on this scan.';
    }
    this._validationRow.append(
      this._hint(
        el('div', { className: 'olv-analyse-rmse', text: `Vertical RMSE: ${rmse.text}` }),
        METRIC_TOOLTIPS.rmse,
      ),
      el('div', { className: 'olv-analyse-cal', text: calText }),
    );

    // Standards expression — NVA (95% conf), VVA (95th pct), and which published
    // USGS 3DEP nominal-pulse-density reference floors the observed ground-return
    // density clears (density only; no quality-level determination).
    const std = this._result?.accuracyStandards;
    if (std) {
      const fmtM = (n: number | null): string =>
        n != null && Number.isFinite(n) ? `${n.toFixed(2)} m` : '—';
      if (std.nvaM != null || std.vvaM != null) {
        // "-style (hold-out)": the figures use the ASPRS 2014 FORMULAS on
        // internally withheld points, not independent checkpoints — the
        // label must not claim a checkpoint assessment (see the tooltips).
        this._validationRow.append(this._hint(
          el('div', {
            className: 'olv-analyse-strata',
            text: `NVA-style ${fmtM(std.nvaM)} · VVA-style ${fmtM(std.vvaM)} (95%, hold-out)`,
          }),
          `${METRIC_TOOLTIPS.nva} ${METRIC_TOOLTIPS.vva}`,
        ));
      }
      if (std.densityReferenceFloorsMet.length > 0) {
        // When the gather strided the cloud, the density is a uniform-stride
        // extrapolation (the core pushes a warning saying so). Carry that into
        // the hint so the figure is never read as an exact, directly-counted
        // density — the same honesty the space-scan path gives.
        const strideNote = (this._result?.warnings ?? []).some((w) =>
          w.includes('uniform-stride assumption'),
        )
          ? ' Density is scaled from the analysed sample (uniform-stride assumption).'
          : '';
        // A density REFERENCE, not a quality-level grade: ground-return density
        // is not a nominal-pulse-density determination. The chip names the 3DEP
        // density floor cleared as context; the tooltip states the boundary.
        this._validationRow.append(this._hint(
          el('div', {
            className: 'olv-analyse-ql',
            text: `USGS density ref: ≥ ${std.densityReferenceFloorsMet[0]} floor`,
          }),
          std.densityReferenceNote + strideNote,
        ));
      }
    }

    // Stratified RMSE — only shown when more than one stratum clears a minimum
    // sample count (a 1–2 point stratum gives a noisy RMSE with no confidence
    // cue), since a lone stratum just restates the overall figure above.
    const MIN_STRATUM_SAMPLES = 5;
    const fmtR = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '—');
    const slopeParts = (v.perSlopeBand ?? [])
      .filter((b) => b.count >= MIN_STRATUM_SAMPLES)
      .map((b) => `${b.band} ${fmtR(b.rmse)}`);
    if (slopeParts.length > 1) {
      this._validationRow.append(el('div', {
        className: 'olv-analyse-strata',
        text: `RMSE by slope: ${slopeParts.join(' · ')} m`,
      }));
    }
    const zoneParts = (v.perZone ?? [])
      .filter((z) => z.count >= MIN_STRATUM_SAMPLES)
      .map((z) => `${z.zone} ${fmtR(z.rmse)}`);
    if (zoneParts.length > 1) {
      this._validationRow.append(el('div', {
        className: 'olv-analyse-strata',
        text: `RMSE by zone: ${zoneParts.join(' · ')} m`,
      }));
    }

    // Measured-cell empirical reliability with its Wilson CI, kept distinct from
    // interpolated model support (Phase 4). Only shown with enough measured
    // held-out points; a small sample gives a wide, uninformative interval.
    const rel = this._result?.reliabilitySplit;
    if (rel && rel.measured.n >= MIN_STRATUM_SAMPLES && Number.isFinite(rel.measured.reliability)) {
      const pct = (x: number): string => `${Math.round(x * 100)}%`;
      const m = rel.measured;
      this._validationRow.append(this._hint(
        el('div', {
          className: 'olv-analyse-reliability',
          text: `Measured reliability: ${pct(m.reliability)} (95% CI ${pct(m.ciLow)}–${pct(m.ciHigh)}) at |Δz| ≤ ${fmtR(m.tolerance)} m`,
        }),
        'Of the held-out ground points on measured cells, the share whose height came within the tolerance, with a Wilson 95% confidence interval. Interpolated (void-filled) cells are model support, not a measured reliability.',
      ));
    }

    // Spatially-blocked hold-out RMSE — a less optimistic accuracy estimate than
    // the random hold-out above, since it predicts across whole withheld blocks
    // (Phase 4). Shown with its bootstrap CI when it was computed.
    const blocked = this._result?.blockedAccuracy;
    if (blocked && blocked.n > 0 && Number.isFinite(blocked.rmse)) {
      this._validationRow.append(this._hint(
        el('div', {
          className: 'olv-analyse-blocked',
          text: `Blocked RMSE: ${fmtR(blocked.rmse)} m (95% CI ${fmtR(blocked.ciLow)}–${fmtR(blocked.ciHigh)})`,
        }),
        'Spatially-blocked cross-validation: the surface is rebuilt with whole blocks withheld, then scored on them, so it measures how the DTM predicts across a real gap. It runs larger than the random hold-out RMSE, which is optimistic because withheld points sit among their neighbours. Still a data-quality diagnostic, not field-checkpoint accuracy.',
      ));
    }
  }

  private _renderBody(): void {
    this._body.replaceChildren();
    if (!this._result) return;
    this._body.append(
      el('div', {
        className: 'olv-analyse-caption',
        text: interpolatedCaption(this._result.tally),
      }),
    );
    if (this._result.excludedByClassification > 0) {
      this._body.append(
        el('div', {
          className: 'olv-analyse-caption is-dim',
          text: `Excluded ${this._result.excludedByClassification.toLocaleString()} classified vegetation/building/noise return(s) before ground filtering.`,
        }),
      );
    }
  }

  /**
   * Refuse an export whose result belongs to a scan that is no longer active,
   * and say so on the panel. Returns true when the caller must write nothing.
   *
   * Every terrain deliverable mixes the result (computed on one scan) with the
   * host's live map context and basename (read from whatever is active now), so
   * a result that outlived its scan would be published in the wrong frame under
   * the wrong name. Refusing is deliberate over silently clearing the result:
   * the analysis is the user's work and re-running it is their call, so the
   * panel keeps it on screen and explains why it cannot be exported.
   *
   * Called at the head of every export path AND again after any regeneration
   * await, since a scan can be opened while contours are being rebuilt.
   */
  private _refuseForeignScanExport(): boolean {
    if (!this._result || !this._cb.getActiveScanId) return false;
    if (sameExportTarget(this._resultScanId, this._cb.getActiveScanId())) return false;
    this.setStaleNotice(TERRAIN_RESULT_FOREIGN_SCAN_REFUSAL);
    return true;
  }

  /**
   * Resolve the full analysis result to serialize for a contour export at the
   * panel's current shape style. Reuses the on-screen result when the style
   * already matches (no recompute); otherwise regenerates from the cached core at
   * the model's interval + the selected style, without touching the visible
   * panel. Returning the whole result (not just the model) lets the caller derive
   * the unified export provenance from the SAME result it serialises.
   */
  private async _resultForExport(): Promise<AnalyseContoursResult> {
    const r = this._result!;
    const style = this._contourStyle;
    if (style === r.model.contourStyle || !this._cb.buildResultForExport) {
      return r;
    }
    return this._cb.buildResultForExport({
      // A regeneration re-runs the pipeline, so it takes the interval that was
      // REQUESTED. Feeding back the emitted (possibly thinned) spacing would
      // coarsen the export away from the contours on screen.
      intervalM: r.requestedIntervalM ?? r.model.intervalM,
      shapeStyle: style,
      generalizeToleranceCells: this._contourGeneralizeToleranceCells,
      generalizeMode: this._contourGeneralizeMode,
    });
  }

  /**
   * Serialize + download the contours in one vector format. Extracted so both
   * the (detached) backing button and the Studio export section can drive it and
   * await completion. When `btn` is supplied its busy state is toggled; the guard
   * still refuses a blocked export so no misleading file is ever written.
   */
  private async _exportContourFormat(
    fmt: ContourFormat,
    btn?: HTMLButtonElement,
    provenanceExtra?: {
      contourMethod?: string;
      deliverablePurpose?: string;
      permit?: ContourExportPermit | null;
    },
  ): Promise<void> {
    // §19 ENFORCEMENT: a contour file requires a GRANTED evidence permit minted
    // by resolveContourExportPermit. No permit (or a blocked one) ⇒ write nothing.
    // This replaces the old ad-hoc `exportReadiness === 'blocked'` check with the
    // single authoritative gate, so no serialize path can bypass the registry.
    const permit = provenanceExtra?.permit ?? null;
    if (!permit?.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        'OpenLiDARViewer: contour export refused — no granted evidence permit (§19).',
      );
      return;
    }
    if (!this._result || this._result.model.features.length === 0) {
      return;
    }
    if (this._refuseForeignScanExport()) return;
    // Both frame inputs are read HERE, before the regeneration await below: the
    // rebuild can take seconds and the host's map context follows the ACTIVE
    // scan, so reading it afterwards would georeference these contours with
    // whatever scan the user opened meanwhile.
    const basename = this._cb.getExportBasename?.() ?? 'contours';
    const mapCtx = this._cb.getMapContext?.();
    const label = btn?.textContent ?? '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    try {
      // Regenerate at the selected shape style (cache hit; reuses the on-screen
      // result when the style already matches), then serialize with the unified
      // provenance derived from that SAME result.
      const result = await this._resultForExport();
      const [{ serializeContours, triggerBrowserDownload }, { buildExportProvenance }] =
        await Promise.all([loadContourDownload(), loadExportProvenance()]);
      // Re-verify after the regeneration: the captured context is the right one
      // for `basename`/`mapCtx`, but a scan opened during the rebuild means the
      // user is no longer looking at this analysis, and publishing it now would
      // hand them a file for a scan they have moved on from.
      if (this._refuseForeignScanExport()) return;
      const provenance = buildExportProvenance(result, {
        basename,
        generatedAt: new Date(),
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
        // Contour Studio purpose provenance: the geometry method actually
        // exported (analytical vs generalized) + the purpose that chose it.
        contourMethod: provenanceExtra?.contourMethod,
        deliverablePurpose: provenanceExtra?.deliverablePurpose,
        // §19: stamp the evidence-gate permit that authorised this file, so the
        // artifact records the decision (validated / exploratory + watermark).
        exportPermit: permitStamp(permit),
      });
      // World-frame registration: the analysis runs in the cloud's recentred
      // LOCAL frame, so exports must add the load-time origin back (the same
      // `worldOrigin` the DEM package and map sheet already use). When the host
      // can't supply one, serializeContours omits the CRS stamp rather than
      // georeferencing local coordinates.
      const worldOrigin = mapCtx?.worldOrigin ?? null;
      triggerBrowserDownload(
        serializeContours(result.model, fmt, {
          basename,
          labels: result.labels,
          provenance,
          worldOrigin,
          // Resolved CRS unit → DXF $INSUNITS + the SVG scale note, so a
          // foot-based CRS stamps feet instead of the metre default.
          linearUnit: mapCtx?.linearUnit,
          toLonLat: mapCtx?.toLonLat,
        }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: contour export failed.', err);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  private _buildExportRow(): HTMLElement {
    const row = el('div', { className: 'olv-analyse-export' });
    const formats: ContourFormat[] = ['geojson', 'geojson-native', 'svg', 'dxf'];
    // Both GeoJSON frames are offered side by side: the standard one for
    // anything that reads RFC 7946, the native one for GIS that wants the
    // survey grid. Labelling them apart is the point — the failure mode is
    // loading the wrong frame without noticing.
    const LABEL: Record<ContourFormat, string> = {
      geojson: 'GEOJSON (WGS 84)',
      'geojson-native': 'GEOJSON (SOURCE CRS)',
      svg: 'SVG',
      dxf: 'DXF',
    };
    for (const fmt of formats) {
      const btn = el('button', { className: 'olv-analyse-dl', text: LABEL[fmt] });
      btn.addEventListener('click', () => void this._exportContourFormat(fmt, btn));
      this._exportButtons.push(btn);
      this._studioExportBtns.set(fmt, btn);
      row.append(btn);
    }
    // Printable map sheet — the field deliverable (contours + collar + accuracy).
    // Clicking opens a pre-export dialog (title-block fields + interval +
    // filename) rather than exporting immediately.
    const mapBtn = el('button', { className: 'olv-analyse-dl', text: 'Export Contours' });
    mapBtn.addEventListener('click', () => this._openMapPdfDialog(mapBtn));
    this._exportButtons.push(mapBtn);
    this._studioExportBtns.set('pdf', mapBtn);
    row.append(mapBtn);

    // DEM package — the georeferenced raster deliverable (DTM + DSM + CHM as
    // ASCII Grid + GeoTIFF + metadata). Deliberately NOT pushed onto
    // `_exportButtons`: the raster is valid bare-earth data regardless of
    // whether the *contour* quality gate is satisfied, so it stays enabled
    // whenever an analysis exists. It carries an accent style to read as the
    // primary "take the data with you" action.
    this._demButton = el('button', { className: 'olv-analyse-dl is-primary', text: 'DEM (ZIP)' });
    this._demButton.title = 'Download the elevation rasters (DTM / DSM / CHM) as ASCII Grid + GeoTIFF with a metadata sheet';
    this._demButton.addEventListener('click', () => void this._exportDemPackage(this._demButton));
    this._studioExportBtns.set('package', this._demButton);
    row.append(this._demButton);

    // Terrain Intelligence Report — the one-click, client-facing deliverable that
    // assembles the assessment, coverage, accuracy, workflows, warnings and
    // available products into one sectioned PDF. A primary-ish action distinct
    // from the contour/DEM/map exports. Deliberately NOT pushed onto
    // `_exportButtons`: like the DEM, it stays enabled whenever an analysis
    // exists — it honestly reports a preview/blocked scan rather than hiding it.
    this._reportButton = el('button', {
      className: 'olv-analyse-dl is-primary',
      text: 'Intelligence report (PDF)',
    });
    this._reportButton.title =
      'Download a one-page terrain intelligence report: assessment, coverage, accuracy, recommended workflows and which products you can take away';
    this._reportButton.addEventListener('click', () => void this._exportTerrainReport(this._reportButton));
    this._studioExportBtns.set('report', this._reportButton);
    row.append(this._reportButton);

    // Honesty caveat for the DEM export — the raster stays usable for partial /
    // preview data, but the user is told one line up front (the README carries
    // the full disclosure). Empty + hidden until _renderExportGate fills it.
    this._demNote = el('p', { className: 'olv-analyse-dem-note' });
    this._demNote.style.display = 'none';
    // NOTE: _demNote is mounted into `_contourDeliverable` (below the Studio
    // export section), not this detached row — see the constructor.
    return row;
  }

  /** Build and download the georeferenced DEM package (lazy raster writers). */
  private async _exportDemPackage(
    btn: HTMLButtonElement,
    exportPermit?: ExportPermitStamp | null,
  ): Promise<void> {
    const r = this._result;
    if (!r) return;
    if (this._refuseForeignScanExport()) return;
    const label = btn.textContent ?? 'DEM (ZIP)';
    btn.disabled = true;
    btn.textContent = '…';
    // Frame + name captured before the writer chunk loads, so the raster and its
    // .prj / README describe the scan this result came from.
    const ctx = this._cb.getMapContext?.() ?? {};
    const basename = this._cb.getExportBasename?.() ?? 'terrain';
    try {
      const { buildDemPackage } = await loadDemPackage();
      const bytes = buildDemPackage(r, {
        worldOrigin: ctx.worldOrigin ?? null,
        basename,
        wkt: ctx.wkt ?? null,
        isGeographic: ctx.isGeographic ?? false,
        // Resolved linear unit so a foot-based CRS labels the README's cell
        // size / bounds / elevation as feet instead of the metre default.
        linearUnit: ctx.linearUnit,
        // Generation parameters (interpolation / smoothing / despike) are derived
        // from the actual run inside buildDemPackage via result.generationParams,
        // so the README can never drift from what produced the raster.
        generationDateIso: new Date().toISOString(),
        softwareName: 'OpenLiDARViewer',
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
        // The §19 evidence-gate permit the Studio resolved for this raster (DTM
        // claim), stamped into the README's provenance. null via the direct
        // convenience button, which keeps its own availability.
        exportPermit: exportPermit ?? null,
      });
      triggerDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${basename}-dem.zip`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: DEM export failed.', err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /**
   * Build + download the complete deliverable ZIP (curated contours + DTM +
   * provenance + README + SHA256SUMS), gated by the resolved permit. The contour
   * geometry is regenerated at the SELECTED PURPOSE's style (Survey Review = exact
   * analytical; a cartographic purpose = generalized at its tolerance), so the
   * bundle matches the chosen purpose and stamps the geometry method + purpose;
   * the permit decision + stamp travel into every file's provenance.
   */
  private async _exportCompletePackage(
    permit: ContourExportPermit,
    intent: ContourExportIntent,
  ): Promise<void> {
    if (!permit.ok || !this._result) return;
    if (this._refuseForeignScanExport()) return;
    // Captured before the regeneration + writer awaits below (which are seconds
    // of work), so the bundle's origin, unit and filename belong to the scan the
    // contours were computed on.
    const ctx = this._cb.getMapContext?.() ?? {};
    const basename = this._cb.getExportBasename?.() ?? 'contours';
    try {
      // Regenerate the bundled geometry at the SELECTED PURPOSE's style + tolerance
      // (Survey Review = exact analytical; a cartographic purpose = generalized at
      // its tolerance), so the Complete ZIP matches the purpose the user chose and
      // is labelled analytical/cartographic by its actual style.
      // Regeneration is what makes the stamped method/purpose truthful: without it
      // we fall back to the on-screen result, whose style may not match the intent.
      const canRegen = !!this._cb.buildResultForExport;
      const result = canRegen
        ? await this._cb.buildResultForExport!({
            // Requested, not emitted — see `_resultForExport`.
            intervalM: this._result.requestedIntervalM ?? this._result.model.intervalM,
            shapeStyle: intent.shapeStyle,
            generalizeToleranceCells: intent.generalizeToleranceCells,
          })
        : this._result;
      const { buildContourDeliverableFromResultAsync } = await loadContourDeliverableBuild();
      // Same re-verification as the vector exports: a scan opened during the
      // rebuild means this bundle is no longer the one the user is looking at.
      if (this._refuseForeignScanExport()) return;
      const bytes = await buildContourDeliverableFromResultAsync(result, {
        decision: permit.decision,
        basename,
        worldOrigin: ctx.worldOrigin ?? null,
        linearUnit: ctx.linearUnit,
        // Real elevation-axis unit when the CRS declares one; undefined ⇒ the
        // README honestly reports the vertical unit as unknown (never the plan unit).
        verticalUnitToMetres: ctx.verticalUnitToMetres,
        isGeographic: ctx.isGeographic ?? false,
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
        generatedAt: new Date(),
        exportPermit: permitStamp(permit),
        // Stamp the geometry method + purpose so the bundle self-describes what it
        // holds — but ONLY when we regenerated at the intent's style, so a fallback
        // to the on-screen result never stamps a method that mismatches the bytes.
        // The geometry role is labelled by the actual result style regardless.
        contourMethod: canRegen ? intent.methodTag : null,
        deliverablePurpose: canRegen ? intent.purpose : null,
      });
      triggerDownload(
        new Blob([bytes as BlobPart], { type: 'application/zip' }),
        `${basename}-contour-deliverable.zip`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: complete deliverable export failed.', err);
    }
  }

  /**
   * Build and download the one-click Terrain Intelligence Report (lazy pdf-lib).
   * It assembles the on-screen verdicts, coverage, accuracy, workflows, warnings
   * and available products into a sectioned PDF — NO new analysis — and stamps
   * the unified provenance (so it matches every other export of this scan).
   * Filename: `<basename>-terrain-report.pdf`.
   */
  private async _exportTerrainReport(
    btn: HTMLButtonElement,
    exportPermit?: ExportPermitStamp | null,
  ): Promise<void> {
    const r = this._result;
    if (!r) return;
    if (this._refuseForeignScanExport()) return;
    const label = btn.textContent ?? 'Intelligence report (PDF)';
    btn.disabled = true;
    btn.textContent = '…';
    // Name + frame read before the pdf-lib chunk loads, so the report's header
    // describes the scan its verdicts were computed on.
    const basename = this._cb.getExportBasename?.() ?? 'terrain';
    const mapCtx = this._cb.getMapContext?.() ?? {};
    try {
      const { buildTerrainReportPdf } = await loadTerrainReportPdf();
      // The renderer assembles the content from the SAME result the panel shows,
      // stamping the unified provenance via these options — so the report's
      // header / footer (CRS, datum, verdicts, accuracy, date) can never drift
      // from the GeoJSON / DXF / map sheet / DEM exports of this scan.
      const bytes = await buildTerrainReportPdf(r, {
        basename,
        generatedAt: new Date(),
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
        // The Inspector card's CURRENT bucket summary (or null) — the report's
        // Dataset Statistics rows must be the card's own strings, never a
        // re-derivation that could disagree with what the user saw on screen.
        intelligence: this._cb.getDatasetIntelligence?.() ?? null,
        // The §19 evidence-gate permit the Studio resolved for this report (DTM
        // claim), stamped into the provenance footer. null via the direct
        // convenience button, which keeps its own availability.
        exportPermit: exportPermit ?? null,
        // The source horizontal unit so the Footprint (extent) reads the CRS's
        // real unit ('ft' / 'degrees') instead of a hard-coded metre.
        linearUnit: mapCtx.linearUnit,
        isGeographic: mapCtx.isGeographic,
      });
      triggerDownload(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${basename}-terrain-report.pdf`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: terrain report export failed.', err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /**
   * Open the pre-export MAP PDF dialog: an accessible modal that lets the user
   * edit the title-block fields, the FINAL contour interval, and the output
   * filename (all pre-filled from the scan), while the measured/accuracy fields
   * stay AUTO + LOCKED. On Export it (optionally) regenerates the contour model
   * at the chosen interval from the cached core — without mutating the panel —
   * then builds + downloads the PDF.
   */
  private _openMapPdfDialog(triggerBtn: HTMLButtonElement): void {
    const r = this._result;
    // Same hard guard as the export itself — a blocked / empty result never
    // reaches the dialog.
    if (!r || r.model.features.length === 0 || r.quality.exportReadiness === 'blocked') return;
    // Refuse before the dialog rather than after the user fills the title block:
    // the pre-filled fields come from the ACTIVE scan while `r` came from
    // another, so the sheet would document a scan it does not plot.
    if (this._refuseForeignScanExport()) return;

    const ctx = this._cb.getMapContext?.() ?? {};
    const basename = this._cb.getExportBasename?.() ?? 'contours';
    // Two different quantities: what the contours on the sheet ARE spaced at,
    // and what was asked for. The sheet's note describes the first; the picker
    // and the "did it change" test are about the request.
    const currentInterval = r.model.intervalM;
    const requestedInterval = r.requestedIntervalM ?? r.model.intervalM;
    const currentStyle = r.model.contourStyle;
    const canRegen = typeof this._cb.buildResultForExport === 'function';
    // Capture one timestamp so the LOCKED "Generated" value the user sees equals
    // the one printed on the sheet.
    const generatedAt = new Date();

    // ── editable fields ──────────────────────────────────────────────────────
    let fieldSeq = 0;
    const nextId = (): string => `olv-mappdf-${++fieldSeq}`;
    const field = (labelText: string, control: HTMLElement, hint?: string): HTMLElement => {
      const id = nextId();
      control.id = id;
      const lab = el('label', { className: 'olv-modal-label', text: labelText });
      lab.setAttribute('for', id);
      const wrap = el('div', { className: 'olv-modal-field' });
      wrap.append(lab, control);
      if (hint) wrap.append(el('p', { className: 'olv-modal-hint', text: hint }));
      return wrap;
    };

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'olv-modal-input';
    titleInput.value = defaultMapTitle({ title: ctx.title, basename });

    const preparedInput = document.createElement('input');
    preparedInput.type = 'text';
    preparedInput.className = 'olv-modal-input';
    preparedInput.value = lastPreparedBy;
    preparedInput.placeholder = 'Name or organisation (optional)';

    const notesInput = document.createElement('textarea');
    notesInput.className = 'olv-modal-input olv-modal-textarea';
    notesInput.rows = 3;
    notesInput.value =
      lastNotes ??
      defaultMapNotes({
        basename,
        intervalM: currentInterval,
        crs: r.model.crs,
        // The interval is a source VERTICAL-unit value — label it from the CRS so
        // a foot / unresolved frame never seeds a false 'm'.
        verticalUnitToMetres: ctx.verticalUnitToMetres,
      });

    const sheetSel = document.createElement('select');
    sheetSel.className = 'olv-modal-input';
    for (const opt of SHEET_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === lastSheet) o.selected = true;
      sheetSel.append(o);
    }

    const orientSel = document.createElement('select');
    orientSel.className = 'olv-modal-input';
    for (const opt of ORIENTATION_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === lastOrientation) o.selected = true;
      orientSel.append(o);
    }

    const intervalSel = document.createElement('select');
    intervalSel.className = 'olv-modal-input';
    for (const opt of r.gate.options) {
      const o = document.createElement('option');
      o.value = String(opt.intervalM);
      o.textContent = describeIntervalOption(opt);
      o.disabled = !opt.supported;
      if (opt.intervalM === requestedInterval) o.selected = true;
      intervalSel.append(o);
    }
    // Without a regeneration callback we cannot change the interval honestly —
    // lock the picker to the current deliverable so the file matches the panel.
    if (!canRegen) {
      intervalSel.disabled = true;
      intervalSel.title = 'Locked to the current deliverable so the exported file matches the panel.';
    }

    // Contour shape style — seeded from the panel's current choice; drives the
    // shape of the plotted contours on the sheet.
    const styleSel = document.createElement('select');
    styleSel.className = 'olv-modal-input';
    for (const opt of CONTOUR_SHAPE_STYLES) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      o.title = opt.description;
      if (opt.value === this._contourStyle) o.selected = true;
      styleSel.append(o);
    }
    if (!canRegen) {
      styleSel.disabled = true;
      styleSel.title = 'Locked to the current deliverable so the exported file matches the panel.';
    }

    const filenameInput = document.createElement('input');
    filenameInput.type = 'text';
    filenameInput.className = 'olv-modal-input';
    filenameInput.value = defaultMapFilename(basename);

    // Annotations opt-in. Default OFF (a plain sheet unless asked for) and
    // DISABLED when the scan carries none, so the option is discoverable but
    // clearly unavailable — the enable/label logic is the pure
    // `annotationsOptionState` so the dialog and its unit tests agree.
    const annotationCount = this._cb.getAnnotations?.().length ?? 0;
    const annoState = annotationsOptionState(annotationCount);
    const annoCheck = document.createElement('input');
    annoCheck.type = 'checkbox';
    annoCheck.className = 'olv-modal-check';
    // Default ON when the scan actually has annotations, so a map sheet includes
    // them without the user hunting for the toggle — the reported "annotations
    // missing from the map sheet" was this box sitting unchecked. A scan with no
    // annotations keeps the clean, byte-reproducible sheet: the option is
    // disabled there, so `!disabled` leaves it off and unchanged.
    annoCheck.checked = !annoState.disabled;
    annoCheck.disabled = annoState.disabled;

    const editable = el('div', { className: 'olv-modal-grid' });
    editable.append(
      field('Title', titleInput),
      field('Prepared by', preparedInput),
      field('Project / Notes', notesInput, 'Free text printed in the title block.'),
      field('Sheet size', sheetSel),
      field('Orientation', orientSel),
      field(
        'Contour interval',
        intervalSel,
        canRegen
          ? 'The final interval for this deliverable.'
          : 'Interval regeneration unavailable — using the current contours.',
      ),
      field(
        'Contour style',
        styleSel,
        canRegen
          ? 'The line shape for the plotted contours.'
          : 'Style regeneration unavailable — using the current contours.',
      ),
      field('Output filename', filenameInput, 'A single .pdf is added on download.'),
      field(annoState.label, annoCheck, annoState.hint),
    );

    // ── locked / auto section (read-only) ────────────────────────────────────
    const a = r.accuracyStandards;
    const fmtM = (v: number | null | undefined): string =>
      v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : '—';
    const lockedRows: Array<[string, string]> = [
      ['Horizontal CRS', r.model.crs ?? '— not georeferenced'],
      ['Vertical datum', r.model.verticalDatum ?? '—'],
      ['NVA-style (95%, hold-out)', fmtM(a?.nvaM)],
      ['VVA-style (95th pct, hold-out)', fmtM(a?.vvaM)],
      ['RMSEz', fmtM(a?.rmseZM)],
      // A density REFERENCE (which 3DEP nominal-pulse-density floor the measured
      // ground-return density clears), not a quality-level grade — ground-return
      // density is not a pulse-density determination.
      [
        'USGS density ref',
        a && a.densityReferenceFloorsMet.length > 0 ? `≥ ${a.densityReferenceFloorsMet[0]} floor` : '—',
      ],
      ['Approx. scale', 'auto — fits sheet'],
      ['Generated', generatedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
    ];
    const locked = el('div', { className: 'olv-modal-locked' });
    locked.append(el('div', { className: 'olv-modal-locked-head', text: 'Measured (auto · locked)' }));
    const lockedGrid = el('div', { className: 'olv-modal-locked-grid' });
    for (const [k, v] of lockedRows) {
      lockedGrid.append(
        el('span', { className: 'olv-modal-locked-k', text: k }),
        el('span', { className: 'olv-modal-locked-v', text: v }),
      );
    }
    locked.append(
      lockedGrid,
      el('p', {
        className: 'olv-modal-locked-note',
        text: 'These are measured from the scan and not editable.',
      }),
    );

    const body = el('div', { className: 'olv-modal-form' });
    body.append(editable, locked);

    // ── actions ──────────────────────────────────────────────────────────────
    const errLine = el('p', { className: 'olv-modal-error' });
    errLine.style.display = 'none';
    const cancelBtn = el('button', { className: 'olv-modal-btn olv-modal-cancel', text: 'Cancel' });
    cancelBtn.setAttribute('type', 'button');
    const exportBtn = el('button', { className: 'olv-modal-btn olv-modal-cta', text: 'Export PDF' });
    exportBtn.setAttribute('type', 'button');
    const footer = el('div', { className: 'olv-modal-actions' });
    footer.append(errLine, cancelBtn, exportBtn);

    const handle: ModalHandle = openModal({
      title: 'Export contour map (PDF)',
      body,
      footer,
      returnFocusTo: triggerBtn,
    });

    cancelBtn.addEventListener('click', () => handle.close());

    exportBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        errLine.style.display = 'none';
        exportBtn.disabled = true;
        cancelBtn.disabled = true;
        const restoreLabel = exportBtn.textContent ?? 'Export PDF';
        exportBtn.textContent = 'Exporting…';
        try {
          const chosenInterval = Number(intervalSel.value);
          const chosenStyle = styleSel.value as ContourShapeStyle;
          // Regenerate ONLY when the interval OR the shape style changed AND a
          // builder exists — from the cached core, without touching the visible
          // result.
          let result = r;
          if (
            canRegen &&
            Number.isFinite(chosenInterval) &&
            (chosenInterval !== requestedInterval || chosenStyle !== currentStyle)
          ) {
            result = await this._cb.buildResultForExport!({
              intervalM: chosenInterval,
              shapeStyle: chosenStyle,
            });
          }
          // Remember the chosen style as the default for subsequent quick exports.
          // A manual pick uses the default generalization tolerance, so clear any
          // per-purpose tolerance a prior Studio export had adopted.
          this._contourStyle = chosenStyle;
          this._contourGeneralizeToleranceCells = undefined;
          await this._buildAndDownloadMapPdf(result, {
            title: titleInput.value,
            preparedBy: preparedInput.value,
            notes: notesInput.value,
            sheet: sheetSel.value as SheetSize,
            orientation: orientSel.value as SheetOrientation,
            filename: filenameInput.value,
            worldOrigin: ctx.worldOrigin ?? null,
            generatedAt,
            // A disabled checkbox can never be checked, so a scan with no
            // annotations always exports the plain sheet.
            includeAnnotations: annoCheck.checked,
          });
          // Remember the user's choices for the rest of the session.
          lastPreparedBy = preparedInput.value;
          lastSheet = sheetSel.value as SheetSize;
          lastOrientation = orientSel.value as SheetOrientation;
          lastNotes = notesInput.value;
          handle.close();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('OpenLiDARViewer: map sheet export failed.', err);
          errLine.textContent = 'Export failed — see the console for details.';
          errLine.style.display = '';
          exportBtn.disabled = false;
          cancelBtn.disabled = false;
          exportBtn.textContent = restoreLabel;
        }
      })();
    });
  }

  /** Build and download the printable contour map sheet (lazy pdf-lib). */
  private async _buildAndDownloadMapPdf(
    result: AnalyseContoursResult,
    opts: {
      title: string;
      preparedBy: string;
      notes: string;
      sheet: SheetSize;
      orientation: SheetOrientation;
      filename: string;
      worldOrigin: { x: number; y: number; z?: number } | null;
      generatedAt: Date;
      /** Draw the (opt-in) annotation layer on the sheet. */
      includeAnnotations: boolean;
    },
  ): Promise<void> {
    // §19 ENFORCEMENT: the map sheet is a gated contour deliverable. It is only
    // reachable via the Studio 'pdf' product, which stashes a granted permit; a
    // null / blocked permit means write nothing (defensive — matches the vector
    // and package paths so no PDF escapes the gate).
    const permit = this._contourPdfPermit;
    this._contourPdfPermit = null;
    // Consume the stashed purpose (Studio path only); cleared so a later non-Studio
    // export can never inherit a stale purpose.
    const purpose = this._contourPdfPurpose;
    this._contourPdfPurpose = null;
    if (!permit?.ok) {
      // eslint-disable-next-line no-console
      console.warn('OpenLiDARViewer: map sheet export refused — no granted evidence permit (§19).');
      return;
    }
    // The dialog can sit open for minutes and its Export can regenerate the
    // contours, so the scan is checked again here — right before the sheet is
    // built — not only when the dialog was opened.
    if (this._refuseForeignScanExport()) return;
    // Resolved linear unit so the sheet's scale bar + 1:N ratio honour a foot
    // CRS (the map is drawn in source units) instead of the metre default. Read
    // the map context ONCE, before the pdf chunks load — it also supplies the
    // scene up-axis the annotation markers are rotated by.
    const mapCtx = this._cb.getMapContext?.();
    const linearUnit = mapCtx?.linearUnit;
    const sheetBasename = this._cb.getExportBasename?.() ?? undefined;
    // Annotation layer inputs, only gathered when the user opted in. The list is
    // read straight from the host (same order as the Annotations panel, so the
    // marker index matches) — and read here, alongside the rest of the sheet's
    // inputs, so the whole sheet comes from one instant. The up-axis MUST be the
    // gather's own — see the frame reasoning in annotationMapProjection.ts.
    const annotations = opts.includeAnnotations ? this._cb.getAnnotations?.() ?? [] : [];
    const sceneUpAxis = mapCtx?.sceneUpAxis ?? 'z';
    const { buildMapSheetPdf } = await loadMapSheetPdf();
    const { buildExportProvenance } = await loadExportProvenance();
    // The unified provenance, derived from the SAME result the sheet plots, so
    // the title block's CRS / datum / style / accuracy / readiness / date can't
    // drift from the GeoJSON / DXF / SVG / DEM exports of this scan.
    const provenance = buildExportProvenance(result, {
      basename: sheetBasename,
      generatedAt: opts.generatedAt,
      softwareVersion: __APP_VERSION__,
      metricVersion: TERRAIN_METRIC_VERSION,
      // Stamp the permit into the sheet's provenance (title-block honesty).
      exportPermit: permitStamp(permit),
    });
    const bytes = await buildMapSheetPdf({
      model: result.model,
      labels: result.labels,
      worldOrigin: opts.worldOrigin,
      provenance,
      crs: result.model.crs,
      verticalDatum: result.model.verticalDatum,
      linearUnit,
      accuracy: result.accuracyStandards,
      // The map sheet is a georeferenced deliverable, so its readiness note
      // reflects EXPORT readiness (surface quality gated by a known CRS +
      // datum): a clean surface with an unknown datum prints PREVIEW, not a
      // validated note. 'available' → 'ready' for the note's vocabulary.
      readiness:
        result.quality.exportReadiness === 'available' ? 'ready' : result.quality.exportReadiness,
      title: opts.title.trim() || undefined,
      preparedBy: opts.preparedBy.trim() || undefined,
      notes: opts.notes.trim() || undefined,
      sheet: opts.sheet,
      orientation: opts.orientation,
      generatedAt: opts.generatedAt,
      includeAnnotations: opts.includeAnnotations,
      annotations,
      sceneUpAxis,
      // Purpose deliverable facts (Studio path) so the sheet renders purpose-
      // specific content. Null on any other path ⇒ byte-identical sheet.
      purpose,
    });
    triggerDownload(
      new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      ensurePdfExtension(sanitizeMapFilename(opts.filename)),
    );
  }

  /**
   * A minimal "Planned" section — a quiet tag row of upcoming capabilities.
   * No per-item explanations, no badges, not interactive (so there are no
   * dead buttons), and short enough not to read as an itemised spec.
   */
  private _buildRoadmap(): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-roadmap' });
    wrap.append(section('Planned'));
    const tags = el('div', { className: 'olv-analyse-plan' });
    // Genuinely-future capabilities only. Advertising shipped work as "planned"
    // contradicts the buttons in this very panel, so the earlier items are gone
    // as they land: 3D Tiles now streams tile bodies as the camera needs them
    // (openTilesetLayer), heavy files load out of core (openLocalHeavyLas), and
    // two-epoch change detection runs over epochs already in a compatible frame
    // (compareLoadedLayers). What remains open is bringing scans that are NOT
    // already in a common frame together: automatic scan-to-scan registration,
    // and cross-CRS reprojection into one viewer frame — the mount still refuses
    // a CRS mismatch rather than reprojecting (see KNOWN_LIMITATIONS).
    for (const item of [
      'Scan-to-scan registration',
      'Cross-CRS reprojection to a common frame',
    ]) {
      tags.append(el('span', { className: 'olv-analyse-plan-tag', text: item }));
    }
    wrap.append(tags);
    return wrap;
  }

  /**
   * The verdict-led "Data Fitness" scorecard: ONE plain verdict + a six-row
   * traffic-light scorecard (friendly metaphor icon + shape-distinct tone glyph
   * + plain summary) + the non-hideable caveats. Sourced from the same result
   * the panel already computes — no new analysis.
   */
  private _renderFitness(): void {
    this._fitnessRow.replaceChildren();
    const r = this._result;
    if (!r) return;
    const a = terrainAssessment(r);
    const t = r.cellStatusTally;
    const covered = t.measured + t.interpolated + t.lowConfidence + t.edgeRisk;
    const densityFloor = r.accuracyStandards.densityReferenceFloorsMet[0] ?? null;
    const hasClass = r.excludedByClassification > 0;
    // Whether the source linear unit is confirmed — the same gate every other
    // unit consumer applies (`crs.linearUnit !== 'unknown'`). An unknown-unit or
    // CRS-less scan carries the inert placeholder factor 1, so the density
    // (pts/m²) and vertical-accuracy (m) verdicts would silently assert metres;
    // pass the flag so scanFitness holds those metric claims and discloses the
    // assumption instead of stamping a bare "pts/m²" / "m".
    const fitLinearUnit = this._cb.getMapContext?.()?.linearUnit;
    const unitKnown = fitLinearUnit != null && fitLinearUnit !== 'unknown';
    const inputs: FitnessInputs = {
      status: a.status,
      score: a.scoreKnown ? a.score : null,
      crsKnown: !!r.quality.crsKnown,
      datumKnown: !!r.quality.datumKnown,
      crsName: r.dtm.crs,
      datumName: r.dtm.verticalDatum,
      measuredFraction: covered > 0 ? t.measured / covered : null,
      groundDensityPerM2: Number.isFinite(r.cellMetrics.meanDensity) ? r.cellMetrics.meanDensity : null,
      verticalRmse: Number.isFinite(r.validation.rmse) ? r.validation.rmse : null,
      notSurveyGrade: true,
      unit: 'm',
      unitToMetres: 1,
      unitKnown,
      // The contour result doesn't carry the full class histogram; the presence
      // of classified returns dropped before ground filtering tells us the
      // source WAS classified (else ground was derived).
      unclassifiedFraction: hasClass ? 0 : null,
      hasGroundClass: hasClass,
      coverageMode: r.dtm.coverageMode,
      densityReferenceFloor: densityFloor,
    };
    const f = buildScanFitness(inputs);

    const hero = el('div', { className: `olv-fit-verdict is-${f.overallTone}${f.provisional ? ' is-provisional' : ''}` });
    hero.append(el('span', { className: 'olv-fit-verdict-text', text: f.verdict }));
    if (f.tierBadge) hero.append(el('span', { className: 'olv-fit-badge', text: f.tierBadge }));
    this._fitnessRow.append(hero);

    const grid = el('div', { className: 'olv-fit-grid' });
    for (const d of f.dimensions) {
      const row = el('div', { className: `olv-fit-row is-${d.tone}` });
      const ico = el('span', { className: 'olv-fit-ico' });
      ico.innerHTML = fitnessIcon(d.key);
      const tone = el('span', { className: 'olv-fit-tone' });
      tone.innerHTML = fitnessToneGlyph(d.tone);
      row.append(
        ico,
        el('span', { className: 'olv-fit-label', text: d.label }),
        tone,
        el('span', { className: 'olv-fit-sum', text: d.summary }),
      );
      this._hint(row, d.summary);
      grid.append(row);
    }
    this._fitnessRow.append(grid);

    if (f.caveats.length > 0) {
      // Collapsed by default: the caveats restate the checklist dimensions above
      // in longer form, so they sit behind one disclosure instead of stacking a
      // wall of repeated text under the list.
      const notes = el('details', { className: 'olv-fit-caveats' });
      notes.append(
        el('summary', {
          className: 'olv-fit-caveats-summary',
          text: `Notes (${f.caveats.length})`,
        }),
      );
      for (const c of f.caveats) {
        notes.append(el('div', { className: 'olv-fit-caveat', text: c }));
      }
      this._fitnessRow.append(notes);
    }
  }


  private _renderRecommend(): void {
    this._recommendRow.replaceChildren();
    const g = this._result!.gridRecommendation;
    // The grid cell size is in the source HORIZONTAL unit and the contour
    // interval in the source VERTICAL unit — neither is guaranteed metres. Label
    // each from the resolved CRS so a foot / geographic frame never reads a false
    // "m", and an unresolved vertical shows an honest "unverified" form.
    const ctx = this._cb.getMapContext?.() ?? {};
    const gridUnit = horizontalUnitLabel({
      isGeographic: ctx.isGeographic,
      linearUnit: ctx.linearUnit,
    });
    const intervalSuffix = verticalUnitSuffix(ctx.verticalUnitToMetres);
    this._recommendRow.append(
      el('div', { className: 'olv-analyse-reco', text: `Recommended grid: ${g.cellSizeM} ${gridUnit}` }),
      el('div', {
        className: 'olv-analyse-reco',
        text: `Recommended contour interval: ${g.contourIntervalM}${intervalSuffix}`,
      }),
    );
  }

  private _renderQualityReasons(): void {
    this._qualityRow.replaceChildren();
    for (const reason of this._result!.quality.reasons) {
      this._qualityRow.append(el('div', { className: 'olv-analyse-reason', text: reason }));
    }
  }


  /** Enable/disable export by the quality gate; set the note + legend. */
  private _renderExportGate(): void {
    const r = this._result!;
    const e = r.quality.exportReadiness;
    const hasFeatures = r.model.features.length > 0;
    const blocked = e === 'blocked' || !hasFeatures;
    for (const b of this._exportButtons) b.disabled = blocked;
    // The DEM raster export is independent of the contour gate — it only needs
    // a bare-earth surface to exist (covered DTM cells).
    const hasDtm = r.dtm.coverage.some((c) => c !== 0);
    this._demButton.disabled = !hasDtm;
    // The Intelligence Report is gated the same way as the DEM — it only needs an
    // analysis to summarise; it honestly reports a preview/blocked verdict.
    this._reportButton.disabled = !hasDtm;
    this._demButton.title = hasDtm
      ? 'Download the elevation rasters (DTM / DSM / CHM) as ASCII Grid + GeoTIFF with a metadata sheet'
      : 'No covered DTM cells to export';
    // One-line caveat under the DEM button when the surface is not full coverage
    // or the GEOREFERENCED export is not ready — the README spells out the rest.
    // The DEM is the georeferenced deliverable, so the note keys off EXPORT
    // readiness (CRS + datum gated), using the SAME condition the README caveat
    // does (coverage !== 'full' || exportReadiness !== 'available') so the
    // button note and the README can't disagree. Any georeferencing gap (unknown
    // CRS / datum) is named inline.
    const coverageMode = r.dtm.coverageMode;
    const notFull = coverageMode !== 'full';
    const exp = r.quality.exportReadiness;
    const exportNotReady = exp !== 'available';
    const demNoteApplies = hasDtm && (notFull || exportNotReady);
    // v0.5.5 P12 — the DEM caveat and the contour preview caveat used to
    // render as two ADJACENT banners with overlapping content ("Preliminary
    // DEM — …" stacked directly above "Preview export — not survey-grade
    // …"). When BOTH apply, they merge into one consolidated caveat that
    // states both facts; each still renders alone when only one applies.
    // No disclosed information is removed — only the duplicate framing.
    const previewNoteApplies = e === 'previewOnly' && hasFeatures;
    const merged = demNoteApplies && previewNoteApplies;
    if (demNoteApplies) {
      let verdict: 'blocked' | 'preview' | 'ready';
      if (exp === 'blocked') {
        verdict = 'blocked';
      } else if (exp === 'previewOnly') {
        verdict = 'preview';
      } else {
        verdict = 'ready';
      }
      const georef = r.quality.exportReasons.length > 0 ? ` (${r.quality.exportReasons.join(', ')})` : '';
      this._demNote.textContent = merged
        ? `Preliminary DEM — coverage: ${coverageMode}; export readiness: ${verdict}${georef}. ` +
          `Contour and DEM exports are previews — not survey-grade (see the reasons above); ` +
          `the README carries the caveat. Not for reliable terrain products.`
        : `Preliminary DEM — coverage: ${coverageMode}; export readiness: ${verdict}${georef}. ` +
          `Exported with a caveat in the README; not for reliable terrain products.`;
      this._demNote.style.display = '';
    } else {
      this._demNote.textContent = '';
      this._demNote.style.display = 'none';
    }
    this._legend.style.display = hasFeatures ? '' : 'none';
    if (e === 'blocked') {
      this._exportNote.textContent = `Export disabled — ${r.quality.reasons[0] ?? 'DTM quality gate not met.'}`;
    } else if (!hasFeatures) {
      this._exportNote.textContent = 'No contours at this interval to export.';
    } else if (e === 'previewOnly' && !merged) {
      this._exportNote.textContent = 'Preview export — not survey-grade (see the reasons above).';
    } else {
      this._exportNote.textContent = '';
    }
  }

  private _buildLegend(): HTMLElement {
    const legend = el('div', { className: 'olv-analyse-legend' });
    (['solid', 'dashed', 'gap'] as const).forEach((grade) => {
      legend.append(
        el('div', {
          className: `olv-analyse-legend-item is-${grade}`,
          text: `${grade}: ${GRADE_MEANING[grade]}`,
        }),
      );
    });
    return legend;
  }
}
