/**
 * AnalysePanel.ts
 *
 * The Analyse panel is MOUNTED as a preview surface for terrain
 * readiness and contour export. It exposes the validated data pipeline
 * conservatively and does NOT yet represent a full interactive terrain
 * suite — a minimal "Planned" tag row sets that expectation, and there are
 * no dead buttons.
 *
 * A plain-DOM panel mirroring MeasurePanel/AnnotationPanel: a `readonly
 * element`, a callbacks object, `update()`, and `setVisible()`. It shows,
 * in order: honesty status chips, DTM & contour readiness, recommended
 * grid + interval, contour export (gated by the DTM quality gate),
 * coverage & confidence, and a minimal "Planned" section. Mounted in
 * `main.ts` next to the Measurements and Annotations panels.
 */

import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import {
  ANALYSE_LABELS,
  GRADE_MEANING,
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

/** Callbacks the host (main.ts) provides. */
export interface AnalysePanelCallbacks {
  /** Run (or re-run) terrain analysis on the loaded scan. */
  onRun?: () => void;
  /** Re-run the analysis at a chosen contour interval (metres). */
  onSelectInterval?: (intervalM: number) => void;
  /** Optional basename for downloaded files (e.g. the scan name). */
  getExportBasename?: () => string;
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

export class AnalysePanel {
  /** The panel element — append to the stage overlay (see main.ts). */
  readonly element: HTMLElement;
  private readonly _cb: AnalysePanelCallbacks;
  private readonly _chipsRow: HTMLElement;
  private readonly _readinessRow: HTMLElement;
  private readonly _recommendRow: HTMLElement;
  private readonly _qualityRow: HTMLElement;
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
  private readonly _legend: HTMLElement;
  /** The always-visible minimal "Planned" section. */
  private readonly _roadmap: HTMLElement;

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
    this._resultsRegion.append(
      this._chipsRow,
      section('DTM & contour readiness'),
      this._readinessRow,
      this._recommendRow,
      this._qualityRow,
      this._intervalRow,
      section('Coverage & confidence'),
      this._coverageRow,
      this._validationRow,
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
    this._renderChips();
    this._renderReadiness();
    this._renderRecommend();
    this._renderQualityReasons();
    this._renderIntervals();
    this._renderCoverage();
    this._renderValidation();
    this._renderBody();
    this._renderExportGate();
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
    // Value and rating share one line — the rating word stays (colourblind
    // safety) but no longer earns its own row.
    const top = el('div', { className: 'olv-analyse-ready-top' });
    top.append(
      el('span', { className: 'olv-analyse-ready-value', text: ind.value }),
      el('span', { className: 'olv-analyse-ready-rating', text: ind.rating }),
    );
    card.append(
      el('div', { className: 'olv-analyse-ready-label', text: ind.label }),
      top,
      el('div', { className: 'olv-analyse-ready-detail', text: ind.detail }),
    );
    return card;
  }

  setVisible(on: boolean): void {
    this.element.style.display = on ? '' : 'none';
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
      el('div', { className: 'olv-analyse-rmse', text: `Vertical RMSE: ${rmse.text}` }),
      el('div', { className: 'olv-analyse-cal', text: calText }),
    );
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
    return row;
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
    const chips: Array<[string, string, Tone]> = [
      ['Coverage', coverage, tri(q.coverageMode === 'full', true)],
      ['DTM', dtm, q.readiness === 'ready' ? 'good' : q.readiness === 'previewOnly' ? 'warn' : 'bad'],
      ['CRS', q.crsKnown ? 'Known' : 'Unknown', tri(q.crsKnown, true)],
      ['Datum', q.datumKnown ? 'Known' : 'Unknown', tri(q.datumKnown, true)],
      ['Export', exp, q.exportReadiness === 'available' ? 'good' : q.exportReadiness === 'previewOnly' ? 'warn' : 'bad'],
    ];
    for (const [k, v, tone] of chips) {
      const chip = el('span', { className: `olv-analyse-chip is-${tone}` });
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
