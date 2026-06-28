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
import { interpolatedCaption } from '../terrain/contour/evidenceGrade';
import {
  computeTerrainReadiness,
  type ReadinessIndicator,
} from '../terrain/contour/terrainReadiness';
import {
  serializeContours,
  triggerBrowserDownload,
  type ContourFormat,
} from '../terrain/contour/contourDownload';
import type { DxfLinearUnit } from '../terrain/contour/dxfContours';
import {
  CONTOUR_SHAPE_STYLES,
  defaultContourShapeStyle,
  type ContourShapeStyle,
} from '../terrain/contour/contourShapeStyle';
import { buildExportProvenance } from '../terrain/export/exportProvenance';
import { loadMapSheetPdf, loadDemPackage, loadTerrainReportPdf } from '../lazyChunks';
import { openModal, type ModalHandle } from './Modal';
import type { SheetSize, SheetOrientation } from '../render/measure/mapSheetPdf';
import {
  SHEET_OPTIONS,
  ORIENTATION_OPTIONS,
  sanitizeMapFilename,
  ensurePdfExtension,
  defaultMapTitle,
  defaultMapNotes,
  defaultMapFilename,
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
  }) => Promise<AnalyseContoursResult>;
  /** Optional basename for downloaded files (e.g. the scan name). */
  getExportBasename?: () => string;
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
    /** CRS WKT for the DEM export's .prj sidecar, when known. */
    wkt?: string | null;
    /**
     * Resolved linear unit of the horizontal CRS, when known. Drives the DXF
     * `$INSUNITS` header and the SVG scale note so a foot-based CRS stamps
     * feet (and an unresolved frame stamps honest "unitless") instead of the
     * metre default. Omitted ⇒ serializeContours' standing metre assumption.
     */
    linearUnit?: DxfLinearUnit;
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
function splitReadinessValue(value: string): { num: string; unit: string } {
  const m = value.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { num: value, unit: '' };
  return { num: m[1], unit: m[2].trim() };
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
  /** The "Colour 3D by confidence" toggle button + its current on/off state, so
   *  its label always shows the way back to the original colour. */
  private _confidenceColorBtn?: HTMLButtonElement;
  private _confidenceColorActive = false;
  /** Status line shown while no analysis has run / while computing. */
  private readonly _status: HTMLElement;
  /** The run/re-run button. */
  private readonly _runBtn: HTMLButtonElement;
  /** Everything that only makes sense once an analysis result exists. */
  private readonly _resultsRegion: HTMLElement;
  /** Export row + note + legend. */
  private readonly _exportRow: HTMLElement;
  private readonly _exportNote: HTMLElement;
  private readonly _exportButtons: HTMLButtonElement[] = [];
  /**
   * The contour shape style applied to the quick GeoJSON / SVG / DXF exports.
   * The Export-Contours (map PDF) dialog overrides it per-export; there is no
   * panel-level picker — style is chosen in that dialog.
   */
  private _contourStyle: ContourShapeStyle = defaultContourShapeStyle;
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
      text: 'Load a LAS, LAZ, COPC, or EPT dataset to analyze terrain readiness.',
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
    this._exportRow = this._buildExportRow();
    this._exportNote = el('p', { className: 'olv-analyse-export-note' });
    this._legend = this._buildLegend();
    this._roadmap = this._buildRoadmap();

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

    this._resultsRegion.append(
      this._fitnessRow,
      this._assessmentRow,
      details,
      section('Surface models'),
      this._surfaceRow,
      section('Contour export'),
      this._exportRow,
      this._exportNote,
      this._legend,
      this._body,
    );

    this.element.append(
      head,
      subtitle,
      this._runBtn,
      this._status,
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

  /** Re-render from a fresh analysis result (or clear when null). */
  update(result: AnalyseContoursResult | null): void {
    this._result = result;
    const has = !!result;
    this._status.style.display = has ? 'none' : '';
    this._resultsRegion.style.display = has ? '' : 'none';
    // Once results exist the button is a quiet "Re-run", not the loud
    // primary action — visual weight follows importance.
    this._runBtn.textContent = this._runLabel();
    this._runBtn.classList.toggle('is-rerun', has);
    if (!has) return;
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
    const exportTier =
      a.exportReadiness === 'Ready' ? 'good' : a.exportReadiness === 'Blocked' ? 'blocked' : 'preview';
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

    const stats = el('div', { className: 'olv-analyse-surface-stats' });
    stats.append(
      el('div', { className: 'olv-analyse-surface-stat', text: `Above-ground height: p95 ${fmt(s.canopy.p95HeightM)} m · max ${fmt(s.canopy.maxHeightM)} m` }),
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
      caption: `Above ground · p95 ${fmt(s.canopy.p95HeightM)} m · max ${fmt(s.canopy.maxHeightM)} m`,
      values: s.canopy.heightM,
      cols: r.dtm.cols,
      rows: r.dtm.rows,
      color: (v) => {
        const c = hypsometricColor(v, 0, canopyMax, DEFAULT_CANOPY_PALETTE);
        return [c.r, c.g, c.b];
      },
      visible: (v) => Number.isFinite(v) && v > 0.05,
      legend: { min: 0, max: s.canopy.maxHeightM, palette: DEFAULT_CANOPY_PALETTE, unit: 'm' },
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

    const canvas = this._makeCanvas(cols, rows);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(cols, rows);
      // The rasteriser flips north-up to match the other preview tiles; copy
      // its RGBA straight into the canvas ImageData.
      const raster = coverageHeatmapImage(r.dtm, { northUp: true });
      img.data.set(raster.data);
      ctx.putImageData(img, 0, 0);
    }

    const tile = el('div', { className: 'olv-analyse-raster-tile' });
    tile.append(el('div', { className: 'olv-analyse-sublabel', text: 'Coverage (trust)' }));
    const wrap = this._rasterWrap(canvas);
    tile.append(wrap.wrap);
    tile.append(this._coverageLegend());
    tile.append(el('div', { className: 'olv-analyse-caption', text: COVERAGE_CAPTION }));

    const readout = this._sampleReadout();
    tile.append(readout);
    this._attachCoverageSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'coverage'));
    tile.append(dl);

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

  /** A discrete 3-stop coverage legend: green / yellow / red = strong / moderate / weak. */
  private _coverageLegend(): HTMLElement {
    const wrap = el('div', { className: 'olv-analyse-coverage-legend' });
    for (const stop of COVERAGE_LEGEND) {
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
        const support = grade === 'solid' ? 'strong' : grade === 'dashed' ? 'moderate' : 'weak';
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
    tile.append(readout);
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, opts.filename));
    tile.append(dl);
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
    tile.append(readout);
    this._attachSampler(canvas, wrap.crosshair, cols, rows, readout);

    const dl = el('button', { className: 'olv-analyse-surface-dl', text: 'Export PNG' });
    dl.addEventListener('click', () => this._downloadRasterPng(canvas, cols, rows, 'relief'));
    tile.append(dl);

    repaint();
    return tile;
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
      readout.classList.toggle('is-empty', !sample || !sample.covered);
      // Drop the crosshair at the click point — percentages survive resize.
      crosshair.style.left = `${(fx * 100).toFixed(2)}%`;
      crosshair.style.top = `${(fy * 100).toFixed(2)}%`;
      crosshair.style.display = 'block';
    });
  }

  /** Format a terrain sample for the readout line. */
  private _sampleReadoutText(sample: ReturnType<typeof sampleTerrain>): string {
    if (!sample) return SAMPLE_HINT;
    if (!sample.covered) return 'Sample · outside coverage';
    const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
    return `Sample · ${f(sample.elevationM, 2)} m · slope ${f(sample.slopeDeg)}° · canopy ${f(sample.canopyM)} m`;
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
    const covered: number[] = [];
    for (let i = 0; i < dtm.z.length; i++) {
      if (dtm.coverage[i] !== 0 && Number.isFinite(dtm.z[i])) covered.push(dtm.z[i]);
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
      text: `${fmt(hist.min)} – ${fmt(hist.max)} m · ${hist.total.toLocaleString()} cells`,
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
    const readiness = computeTerrainReadiness(this._result);
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

    // Left column: label over the supporting line.
    const main = el('div', { className: 'olv-analyse-ready-main' });
    main.append(
      el('div', { className: 'olv-analyse-ready-label', text: ind.label }),
      el('div', { className: 'olv-analyse-ready-detail', text: ind.detail }),
    );

    // Right column: a big tabular figure with the unit set as a subscript,
    // and a colour-coded rating pill (the rating word stays for colourblind
    // safety, no longer relying on hue alone).
    const { num, unit } = splitReadinessValue(ind.value);
    // Keep the unit compact so the figure can't crowd the supporting line.
    const unitText = unit.replace(/\bmeasured\b/, 'meas.');
    const figure = el('div', {
      className: `olv-analyse-ready-figure${num.match(/\d/) ? '' : ' is-text'}`,
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
    const products: StoryProduct[] = terrainProducts(a, workflows).map((p) => ({
      label: p.label,
      status: p.status === 'ready' ? 'Ready' : p.status === 'preview' ? 'Preview' : 'Blocked',
    }));
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
    const cal = this._result?.calibration;
    const calText = cal?.assessable
      ? cal.calibrated
        ? 'Confidence is calibrated against held-out points.'
        : 'Warning: confidence does not track error here.'
      : 'Calibration not assessable on this scan.';
    this._validationRow.append(
      this._hint(
        el('div', { className: 'olv-analyse-rmse', text: `Vertical RMSE: ${rmse.text}` }),
        METRIC_TOOLTIPS.rmse,
      ),
      el('div', { className: 'olv-analyse-cal', text: calText }),
    );

    // Standards expression — NVA (95% conf), VVA (95th pct), and the USGS
    // 3DEP Quality Level the surface meets on density + RMSEz together.
    const std = this._result?.accuracyStandards;
    if (std) {
      const fmtM = (n: number | null): string =>
        n != null && Number.isFinite(n) ? `${n.toFixed(2)} m` : '—';
      if (std.nvaM != null || std.vvaM != null) {
        this._validationRow.append(this._hint(
          el('div', {
            className: 'olv-analyse-strata',
            text: `NVA ${fmtM(std.nvaM)} · VVA ${fmtM(std.vvaM)} (95%)`,
          }),
          `${METRIC_TOOLTIPS.nva} ${METRIC_TOOLTIPS.vva}`,
        ));
      }
      if (std.qualityLevel !== 'unknown') {
        const qlReason = std.qualityLevelReason;
        // When the gather strided the cloud, the density behind the QL is a
        // uniform-stride extrapolation (the core pushes a warning saying so).
        // Carry that into the QL hint so the chip is never read as an exact,
        // directly-counted grade — the same honesty the space-scan path gives.
        const strideNote = (this._result?.warnings ?? []).some((w) =>
          w.includes('uniform-stride assumption'),
        )
          ? ' Density is scaled from the analysed sample (uniform-stride assumption), so this grade is an estimate.'
          : '';
        // Keep the dynamic gate reason in the hint, but lead with the
        // plain-language explanation of what a Quality Level actually is.
        const qlTooltip =
          (qlReason
            ? `${METRIC_TOOLTIPS.qualityLevel} ${qlReason}`
            : METRIC_TOOLTIPS.qualityLevel) + strideNote;
        this._validationRow.append(this._hint(
          el('div', {
            className: 'olv-analyse-ql',
            text: `USGS 3DEP ${std.qualityLevel}`,
          }),
          qlTooltip,
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
      intervalM: r.model.intervalM,
      shapeStyle: style,
    });
  }

  private _buildExportRow(): HTMLElement {
    const row = el('div', { className: 'olv-analyse-export' });
    const formats: ContourFormat[] = ['geojson', 'svg', 'dxf'];
    for (const fmt of formats) {
      const btn = el('button', { className: 'olv-analyse-dl', text: fmt.toUpperCase() });
      btn.addEventListener('click', () => {
        void (async (): Promise<void> => {
          // Hard guard — the quality gate also disables the buttons, but a
          // blocked export must never write a misleading file.
          if (
            !this._result ||
            this._result.model.features.length === 0 ||
            this._result.quality.exportReadiness === 'blocked'
          ) {
            return;
          }
          const basename = this._cb.getExportBasename?.() ?? 'contours';
          const label = btn.textContent ?? fmt.toUpperCase();
          btn.disabled = true;
          btn.textContent = '…';
          try {
            // Regenerate at the selected shape style (cache hit; reuses the
            // on-screen result when the style already matches), then serialize
            // with the unified provenance derived from that SAME result.
            const result = await this._resultForExport();
            const provenance = buildExportProvenance(result, {
              basename,
              generatedAt: new Date(),
              softwareVersion: __APP_VERSION__,
              metricVersion: TERRAIN_METRIC_VERSION,
            });
            // World-frame registration: the analysis runs in the cloud's
            // recentred LOCAL frame, so exports must add the load-time
            // origin back (the same `worldOrigin` the DEM package and map
            // sheet already use). When the host can't supply one,
            // serializeContours omits the CRS stamp rather than
            // georeferencing local coordinates.
            const mapCtx = this._cb.getMapContext?.();
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
              }),
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('OpenLiDARViewer: contour export failed.', err);
          } finally {
            btn.disabled = false;
            btn.textContent = label;
          }
        })();
      });
      this._exportButtons.push(btn);
      row.append(btn);
    }
    // Printable map sheet — the field deliverable (contours + collar + accuracy).
    // Clicking opens a pre-export dialog (title-block fields + interval +
    // filename) rather than exporting immediately.
    const mapBtn = el('button', { className: 'olv-analyse-dl', text: 'Export Contours' });
    mapBtn.addEventListener('click', () => this._openMapPdfDialog(mapBtn));
    this._exportButtons.push(mapBtn);
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
    row.append(this._reportButton);

    // Honesty caveat for the DEM export — the raster stays usable for partial /
    // preview data, but the user is told one line up front (the README carries
    // the full disclosure). Empty + hidden until _renderExportGate fills it.
    this._demNote = el('p', { className: 'olv-analyse-dem-note' });
    this._demNote.style.display = 'none';
    row.append(this._demNote);
    return row;
  }

  /** Build and download the georeferenced DEM package (lazy raster writers). */
  private async _exportDemPackage(btn: HTMLButtonElement): Promise<void> {
    const r = this._result;
    if (!r) return;
    const label = btn.textContent ?? 'DEM (ZIP)';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { buildDemPackage } = await loadDemPackage();
      const ctx = this._cb.getMapContext?.() ?? {};
      const basename = this._cb.getExportBasename?.() ?? 'terrain';
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
   * Build and download the one-click Terrain Intelligence Report (lazy pdf-lib).
   * It assembles the on-screen verdicts, coverage, accuracy, workflows, warnings
   * and available products into a sectioned PDF — NO new analysis — and stamps
   * the unified provenance (so it matches every other export of this scan).
   * Filename: `<basename>-terrain-report.pdf`.
   */
  private async _exportTerrainReport(btn: HTMLButtonElement): Promise<void> {
    const r = this._result;
    if (!r) return;
    const label = btn.textContent ?? 'Intelligence report (PDF)';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { buildTerrainReportPdf } = await loadTerrainReportPdf();
      const basename = this._cb.getExportBasename?.() ?? 'terrain';
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

    const ctx = this._cb.getMapContext?.() ?? {};
    const basename = this._cb.getExportBasename?.() ?? 'contours';
    const currentInterval = r.model.intervalM;
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
      lastNotes ?? defaultMapNotes({ basename, intervalM: currentInterval, crs: r.model.crs });

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
      if (opt.intervalM === currentInterval) o.selected = true;
      intervalSel.append(o);
    }
    // Without a regeneration callback we cannot change the interval honestly —
    // lock the picker to the current deliverable so the file matches the panel.
    if (!canRegen) intervalSel.disabled = true;

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
    if (!canRegen) styleSel.disabled = true;

    const filenameInput = document.createElement('input');
    filenameInput.type = 'text';
    filenameInput.className = 'olv-modal-input';
    filenameInput.value = defaultMapFilename(basename);

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
    );

    // ── locked / auto section (read-only) ────────────────────────────────────
    const a = r.accuracyStandards;
    const fmtM = (v: number | null | undefined): string =>
      v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : '—';
    const lockedRows: Array<[string, string]> = [
      ['Horizontal CRS', r.model.crs ?? '— not georeferenced'],
      ['Vertical datum', r.model.verticalDatum ?? '—'],
      ['NVA (95%)', fmtM(a?.nvaM)],
      ['VVA (95th pct)', fmtM(a?.vvaM)],
      ['RMSEz', fmtM(a?.rmseZM)],
      ['USGS 3DEP', a && a.qualityLevel !== 'unknown' ? a.qualityLevel : '—'],
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
            (chosenInterval !== currentInterval || chosenStyle !== currentStyle)
          ) {
            result = await this._cb.buildResultForExport!({
              intervalM: chosenInterval,
              shapeStyle: chosenStyle,
            });
          }
          // Remember the chosen style as the default for subsequent quick exports.
          this._contourStyle = chosenStyle;
          await this._buildAndDownloadMapPdf(result, {
            title: titleInput.value,
            preparedBy: preparedInput.value,
            notes: notesInput.value,
            sheet: sheetSel.value as SheetSize,
            orientation: orientSel.value as SheetOrientation,
            filename: filenameInput.value,
            worldOrigin: ctx.worldOrigin ?? null,
            generatedAt,
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
      worldOrigin: { x: number; y: number } | null;
      generatedAt: Date;
    },
  ): Promise<void> {
    const { buildMapSheetPdf } = await loadMapSheetPdf();
    // Resolved linear unit so the sheet's scale bar + 1:N ratio honour a foot
    // CRS (the map is drawn in source units) instead of the metre default.
    const linearUnit = this._cb.getMapContext?.()?.linearUnit;
    // The unified provenance, derived from the SAME result the sheet plots, so
    // the title block's CRS / datum / style / accuracy / readiness / date can't
    // drift from the GeoJSON / DXF / SVG / DEM exports of this scan.
    const provenance = buildExportProvenance(result, {
      basename: this._cb.getExportBasename?.() ?? undefined,
      generatedAt: opts.generatedAt,
      softwareVersion: __APP_VERSION__,
      metricVersion: TERRAIN_METRIC_VERSION,
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
    // Genuinely-future capabilities only. The earlier list (ground
    // classification, DSM, slope/hillshade, 3D overlay, terrain report) has all
    // shipped — leaving them here advertised done work as "planned", which
    // contradicts the buttons in this very panel. These three are the real,
    // not-yet-shipped roadmap (3D Tiles is documented as planned in
    // supported-formats.md; out-of-core loading and co-registered change
    // detection are the open engineering items).
    for (const item of [
      '3D Tiles / PNTS streaming',
      'Out-of-core large-file loading',
      'Co-registered change detection',
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
    const ql = r.accuracyStandards.qualityLevel;
    const hasClass = r.excludedByClassification > 0;
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
      // The contour result doesn't carry the full class histogram; the presence
      // of classified returns dropped before ground filtering tells us the
      // source WAS classified (else ground was derived).
      unclassifiedFraction: hasClass ? 0 : null,
      hasGroundClass: hasClass,
      coverageMode: r.dtm.coverageMode,
      qualityLevel: ql !== 'unknown' ? ql : null,
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

    for (const c of f.caveats) {
      this._fitnessRow.append(el('div', { className: 'olv-fit-caveat', text: c }));
    }
  }


  private _renderRecommend(): void {
    this._recommendRow.replaceChildren();
    const g = this._result!.gridRecommendation;
    this._recommendRow.append(
      el('div', { className: 'olv-analyse-reco', text: `Recommended grid: ${g.cellSizeM} m` }),
      el('div', { className: 'olv-analyse-reco', text: `Recommended contour interval: ${g.contourIntervalM} m` }),
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
    if (hasDtm && (notFull || exportNotReady)) {
      const verdict = exp === 'blocked' ? 'blocked' : exp === 'previewOnly' ? 'preview' : 'ready';
      const georef = r.quality.exportReasons.length > 0 ? ` (${r.quality.exportReasons.join(', ')})` : '';
      this._demNote.textContent =
        `Preliminary DEM — coverage: ${coverageMode}; export readiness: ${verdict}${georef}. ` +
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
    } else if (e === 'previewOnly') {
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
