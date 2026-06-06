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
 *   1. Terrain Assessment hero — status · score, the headline reason, and
 *      bestFor / useCaution / notRecommendedFor guidance plus the
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
  describeIntervalOption,
  recommendIntervalText,
  formatHonestValue,
} from '../terrain/contour/contourCopy';
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
import { loadMapSheetPdf, loadDemPackage } from '../lazyChunks';
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
import { terrainAssessment } from '../terrain/contour/terrainAssessment';

/** Callbacks the host (main.ts) provides. */
export interface AnalysePanelCallbacks {
  /** Run (or re-run) terrain analysis on the loaded scan. */
  onRun?: () => void;
  /** Re-run the analysis at a chosen contour interval (metres). */
  onSelectInterval?: (intervalM: number) => void;
  /** Optional basename for downloaded files (e.g. the scan name). */
  getExportBasename?: () => string;
  /** Context for the printable map sheet (world origin, title block fields). */
  getMapContext?: () => {
    worldOrigin?: { x: number; y: number } | null;
    title?: string;
    preparedBy?: string;
    sheet?: 'letter' | 'a4' | 'a3';
    /** True when the horizontal CRS is geographic (degree cells). */
    isGeographic?: boolean;
    /** CRS WKT for the DEM export's .prj sidecar, when known. */
    wkt?: string | null;
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
  private readonly _chipsRow: HTMLElement;
  private readonly _readinessRow: HTMLElement;
  private readonly _recommendRow: HTMLElement;
  private readonly _qualityRow: HTMLElement;
  private readonly _assessmentRow: HTMLElement;
  private readonly _scoreRow: HTMLElement;
  private readonly _surfaceRow: HTMLElement;
  private readonly _intervalRow: HTMLElement;
  private readonly _coverageRow: HTMLElement;
  private readonly _validationRow: HTMLElement;
  private readonly _body: HTMLElement;
  private _result: AnalyseContoursResult | null = null;
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
  /** DEM raster export — gated only on a result existing, not the contour gate. */
  private _demButton!: HTMLButtonElement;
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

  constructor(callbacks: AnalysePanelCallbacks = {}) {
    this._cb = callbacks;
    this.element = el('section', { className: 'olv-analyse-panel' });

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
    this._chipsRow = el('div', { className: 'olv-analyse-chips' });
    this._readinessRow = el('div', { className: 'olv-analyse-readiness' });
    this._recommendRow = el('div', { className: 'olv-analyse-recommend-box' });
    this._qualityRow = el('div', { className: 'olv-analyse-quality' });
    this._intervalRow = el('div', { className: 'olv-analyse-intervals' });
    this._coverageRow = el('div', { className: 'olv-analyse-coverage' });
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
      this._chipsRow,
      section('DTM & contour readiness'),
      this._readinessRow,
      this._recommendRow,
      this._qualityRow,
      this._intervalRow,
      section('Coverage & confidence'),
      this._coverageRow,
      this._validationRow,
    );

    this._resultsRegion.append(
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
    this._renderAssessment();
    this._renderScore();
    this._renderChips();
    this._renderReadiness();
    this._renderRecommend();
    this._renderQualityReasons();
    this._renderIntervals();
    this._renderCoverage();
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

    const top = el('div', { className: 'olv-analyse-assess-top' });
    // The score is folded in from the assessment (single source of truth) so
    // the hero is the one headline, e.g. "Preview · 64/100".
    const headline = a.scoreKnown && Number.isFinite(a.score) ? `${a.status} · ${a.score}/100` : a.status;
    top.append(
      el('span', { className: 'olv-analyse-assess-label', text: 'Terrain assessment' }),
      el('span', { className: 'olv-analyse-assess-verdict', text: headline }),
    );
    this._assessmentRow.append(top);
    this._assessmentRow.append(el('div', { className: 'olv-analyse-assess-reason', text: a.reason }));
    this._assessmentRow.append(
      el('div', { className: 'olv-analyse-assess-use', text: `Best for: ${a.bestFor}` }),
    );
    if (a.useCaution) {
      this._assessmentRow.append(
        el('div', { className: 'olv-analyse-assess-caution', text: `Caution: ${a.useCaution}` }),
      );
    }
    this._assessmentRow.append(
      el('div', {
        className: 'olv-analyse-assess-not',
        text: `Not for: ${a.notRecommendedFor}`,
      }),
    );

    // Compact supporting-metrics list — each metric is a pill whose colour comes
    // from its own honest rating (good / fair / poor / unknown), never from the
    // overall status, so a single weak signal stays visible at a glance.
    const metrics = el('div', { className: 'olv-analyse-assess-metrics' });
    for (const m of a.supportingMetrics) {
      const pill = el('div', { className: `olv-analyse-assess-metric is-${m.rating}` });
      pill.append(
        el('span', { className: 'olv-analyse-assess-metric-label', text: m.label }),
        el('span', { className: 'olv-analyse-assess-metric-value', text: m.value }),
      );
      metrics.append(pill);
    }
    this._assessmentRow.append(metrics);
  }

  private _renderScore(): void {
    this._scoreRow.replaceChildren();
    const qs = this._result?.qualityScore;
    if (!qs) return;
    const head = el('div', { className: 'olv-analyse-score-head' });
    head.append(
      el('span', { className: `olv-analyse-score-num is-${qs.band}`, text: String(qs.score) }),
      el('span', { className: 'olv-analyse-score-of', text: '/ 100' }),
      el('span', { className: `olv-analyse-score-band is-${qs.band}`, text: `Terrain quality · ${qs.band}` }),
    );
    this._scoreRow.append(head);
    const bars = el('div', { className: 'olv-analyse-score-bars' });
    for (const c of qs.components) {
      const row = el('div', { className: 'olv-analyse-score-comp' });
      const track = el('div', { className: 'olv-analyse-score-track' });
      const fill = el('div', { className: 'olv-analyse-score-fill' });
      fill.style.width = `${Math.round(c.score * 100)}%`;
      track.append(fill);
      row.append(
        el('span', { className: 'olv-analyse-score-label', text: c.label }),
        track,
        el('span', {
          className: `olv-analyse-score-pct${c.neutral ? ' is-neutral' : ''}`,
          text: c.neutral ? 'n/a' : `${Math.round(c.score * 100)}%`,
        }),
      );
      bars.append(row);
    }
    this._scoreRow.append(bars);
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

    // Relief — multi-directional / single-sun hillshade with adjustable sun.
    const relief = this._reliefTile(r, s);
    if (relief) this._surfaceRow.append(relief);
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this._cb.getExportBasename?.() ?? 'terrain'}-${filename}.png`;
      a.click();
      URL.revokeObjectURL(url);
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

  private _renderIntervals(): void {
    this._intervalRow.replaceChildren();
    const gate = this._result?.gate;
    if (!gate) return;
    this._intervalRow.append(
      el('div', { className: 'olv-analyse-recommend', text: recommendIntervalText(gate) }),
    );
    for (const opt of gate.options) {
      const btn = el('button', {
        className: `olv-analyse-interval${opt.supported ? '' : ' is-disabled'}${
          this._result?.intervalM === opt.intervalM ? ' is-active' : ''
        }`,
        text: describeIntervalOption(opt),
        title: opt.reason || undefined,
      });
      btn.disabled = !opt.supported;
      // Re-runs the pipeline at the chosen interval via the host callback.
      btn.addEventListener('click', () => this._cb.onSelectInterval?.(opt.intervalM));
      this._intervalRow.append(btn);
    }
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
        // Keep the dynamic gate reason in the hint, but lead with the
        // plain-language explanation of what a Quality Level actually is.
        const qlTooltip = qlReason
          ? `${METRIC_TOOLTIPS.qualityLevel} ${qlReason}`
          : METRIC_TOOLTIPS.qualityLevel;
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

  private _buildExportRow(): HTMLElement {
    const row = el('div', { className: 'olv-analyse-export' });
    const formats: ContourFormat[] = ['geojson', 'svg', 'dxf'];
    for (const fmt of formats) {
      const btn = el('button', { className: 'olv-analyse-dl', text: fmt.toUpperCase() });
      btn.addEventListener('click', () => {
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
        triggerBrowserDownload(
          serializeContours(this._result.model, fmt, { basename, labels: this._result.labels }),
        );
      });
      this._exportButtons.push(btn);
      row.append(btn);
    }
    // Printable map sheet — the field deliverable (contours + collar + accuracy).
    const mapBtn = el('button', { className: 'olv-analyse-dl', text: 'MAP PDF' });
    mapBtn.addEventListener('click', () => void this._exportMapSheet(mapBtn));
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
        // Generation parameters (interpolation / smoothing / despike) are derived
        // from the actual run inside buildDemPackage via result.generationParams,
        // so the README can never drift from what produced the raster.
        generationDateIso: new Date().toISOString(),
        softwareName: 'OpenLiDARViewer',
        softwareVersion: __APP_VERSION__,
        metricVersion: TERRAIN_METRIC_VERSION,
      });
      const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${basename}-dem.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: DEM export failed.', err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /** Build and download the printable contour map sheet (lazy pdf-lib). */
  private async _exportMapSheet(btn: HTMLButtonElement): Promise<void> {
    const r = this._result;
    if (!r || r.model.features.length === 0 || r.quality.exportReadiness === 'blocked') return;
    const label = btn.textContent ?? 'MAP PDF';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { buildMapSheetPdf } = await loadMapSheetPdf();
      const ctx = this._cb.getMapContext?.() ?? {};
      const bytes = await buildMapSheetPdf({
        model: r.model,
        labels: r.labels,
        worldOrigin: ctx.worldOrigin ?? null,
        crs: r.model.crs,
        verticalDatum: r.model.verticalDatum,
        accuracy: r.accuracyStandards,
        readiness: r.quality.readiness,
        title: ctx.title,
        preparedBy: ctx.preparedBy,
        sheet: ctx.sheet,
      });
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this._cb.getExportBasename?.() ?? 'contours'}-map.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('OpenLiDARViewer: map sheet export failed.', err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
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
    for (const item of [
      'Ground classification',
      'Surface model (DSM)',
      'Slope & hillshade',
      '3D terrain & contour overlay',
      'Terrain report',
    ]) {
      tags.append(el('span', { className: 'olv-analyse-plan-tag', text: item }));
    }
    wrap.append(tags);
    return wrap;
  }

  /** Honesty status chips (Coverage / DTM / CRS / Datum / Export). */
  private _renderChips(): void {
    this._chipsRow.replaceChildren();
    const q = this._result!.quality;
    type Tone = 'good' | 'warn' | 'bad';
    const tri = (ok: boolean, warn = false): Tone => (ok ? 'good' : warn ? 'warn' : 'bad');
    const coverage =
      q.coverageMode === 'full' ? 'Full' : q.coverageMode === 'resident-only' ? 'Resident nodes' : 'Sampled';
    const dtm = q.readiness === 'ready' ? 'Ready' : q.readiness === 'previewOnly' ? 'Preview' : 'Blocked';
    const exp =
      q.exportReadiness === 'available' ? 'Available' : q.exportReadiness === 'previewOnly' ? 'Preview only' : 'Blocked';
    // Optional 4th tuple entry is a plain-language hover hint for the
    // jargon chips (CRS / Datum), reused from contourCopy so the wording
    // is single-sourced and consistent with the Details metrics above.
    const chips: Array<[string, string, Tone, string?]> = [
      ['Coverage', coverage, tri(q.coverageMode === 'full', true)],
      ['DTM', dtm, q.readiness === 'ready' ? 'good' : q.readiness === 'previewOnly' ? 'warn' : 'bad'],
      ['CRS', q.crsKnown ? 'Known' : 'Unknown', tri(q.crsKnown, true), METRIC_TOOLTIPS.crs],
      ['Datum', q.datumKnown ? 'Known' : 'Unknown', tri(q.datumKnown, true), METRIC_TOOLTIPS.verticalDatum],
      ['Export', exp, q.exportReadiness === 'available' ? 'good' : q.exportReadiness === 'previewOnly' ? 'warn' : 'bad'],
    ];
    for (const [k, v, tone, tip] of chips) {
      const chip = el('span', { className: `olv-analyse-chip is-${tone}` });
      if (tip) this._hint(chip, tip);
      chip.append(
        el('span', { className: 'olv-analyse-chip-k', text: k }),
        el('span', { className: 'olv-analyse-chip-v', text: v }),
      );
      this._chipsRow.append(chip);
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

  private _renderCoverage(): void {
    this._coverageRow.replaceChildren();
    const r = this._result!;
    const t = r.cellStatusTally;
    const total = t.total > 0 ? t.total : 1;
    const p = (n: number) => `${Math.round((100 * n) / total)}%`;
    const interp = t.interpolated + t.lowConfidence + t.edgeRisk;
    const conf = Number.isFinite(r.dtm.meanConfidence) ? `${Math.round(r.dtm.meanConfidence)}%` : '—';
    const rmse = Number.isFinite(r.validation.rmse) ? `${r.validation.rmse.toFixed(2)} m` : '—';
    this._coverageRow.append(
      el('div', { className: 'olv-analyse-cov', text: `Measured ${p(t.measured)} · Interpolated ${p(interp)} · Empty ${p(t.empty)}` }),
      el('div', { className: 'olv-analyse-cov', text: `Mean confidence ${conf} · Vertical RMSE ${rmse}` }),
    );
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
    this._demButton.title = hasDtm
      ? 'Download the elevation rasters (DTM / DSM / CHM) as ASCII Grid + GeoTIFF with a metadata sheet'
      : 'No covered DTM cells to export';
    // One-line caveat under the DEM button when the surface is not full coverage
    // or the quality gate is not ready — the README spells out the rest. This
    // uses the SAME condition the README caveat does (coverage !== 'full' ||
    // readiness !== 'ready') so the button note and the README can't disagree.
    const coverageMode = r.dtm.coverageMode;
    const notFull = coverageMode !== 'full';
    const notReady = r.quality.readiness !== 'ready';
    if (hasDtm && (notFull || notReady)) {
      const verdict = r.quality.readiness === 'blocked'
        ? 'blocked'
        : r.quality.readiness === 'previewOnly' ? 'preview' : 'ready';
      this._demNote.textContent =
        `Preliminary DEM — coverage: ${coverageMode}; quality gate: ${verdict}. ` +
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
