/**
 * AnalysePanel.ts
 *
 * SCAFFOLD (integration). A plain-DOM panel for the contour pipeline,
 * mirroring the shape of MeasurePanel/AnnotationPanel: a `readonly
 * element`, a callbacks object, `update()`, and `setVisible()`. It reads
 * the honest-UX copy and value formatting from `contourCopy`, lists the
 * gate's interval options, shows the validation result, an evidence
 * legend, and three export buttons that serialise + download the model.
 *
 * This file is intentionally NOT yet wired into `main.ts` — it compiles
 * (tsc) as an additive module so it cannot affect the app shell or
 * bundle chunks until it is mounted. See the integration guide for the
 * exact mounting steps (it parallels how `measurePanel` is created and
 * appended in main.ts).
 *
 * TODOs for the live wiring are marked `// WIRE:` below.
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
  serializeContours,
  triggerBrowserDownload,
  type ContourFormat,
} from '../terrain/contour/contourDownload';

/** Callbacks the host (main.ts) provides. */
export interface AnalysePanelCallbacks {
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

export class AnalysePanel {
  /** The panel element — append to the stage overlay (see main.ts). */
  readonly element: HTMLElement;
  private readonly _cb: AnalysePanelCallbacks;
  private readonly _intervalRow: HTMLElement;
  private readonly _validationRow: HTMLElement;
  private readonly _body: HTMLElement;
  private _result: AnalyseContoursResult | null = null;

  constructor(callbacks: AnalysePanelCallbacks = {}) {
    this._cb = callbacks;
    this.element = el('section', { className: 'olv-analyse-panel' });

    const title = el('h2', { className: 'olv-analyse-title', text: 'Analyse' });
    const subtitle = el('p', {
      className: 'olv-analyse-sub',
      text: ANALYSE_LABELS.contours,
    });
    this._intervalRow = el('div', { className: 'olv-analyse-intervals' });
    this._validationRow = el('div', { className: 'olv-analyse-validation' });
    this._body = el('div', { className: 'olv-analyse-body' });

    this.element.append(
      title,
      subtitle,
      this._intervalRow,
      this._validationRow,
      this._body,
      this._buildExportRow(),
      this._buildLegend(),
      el('p', { className: 'olv-analyse-footer', text: NOT_SURVEY_GRADE }),
    );
    this.setVisible(false);
  }

  /** Re-render from a fresh analysis result (or clear when null). */
  update(result: AnalyseContoursResult | null): void {
    this._result = result;
    this._renderIntervals();
    this._renderValidation();
    this._renderBody();
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
      // WIRE: re-runs the pipeline at this interval via the host.
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
        if (!this._result || this._result.model.features.length === 0) return;
        const basename = this._cb.getExportBasename?.() ?? 'contours';
        triggerBrowserDownload(
          serializeContours(this._result.model, fmt, { basename, labels: this._result.labels }),
        );
      });
      row.append(btn);
    }
    return row;
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
