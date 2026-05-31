/**
 * MeasurePanel.ts
 *
 * The Measurements panel — a compact list of every placed measurement plus a
 * footer to export / import a measurement session (measurements and saved
 * camera views together, as one JSON file). A dumb view: the controller
 * computes the summaries; the panel renders them and reports intents back.
 */

import { el } from './dom';
import type { MeasurementSummary } from '../render/measure/MeasureController';

/** Hooks the panel calls back into. */
export interface MeasurePanelCallbacks {
  /** Delete the measurement with this id. */
  onDelete: (id: string) => void;
  /** Rename the measurement with this id. */
  onRename: (id: string, name: string) => void;
  /** Export the current session to a JSON file. */
  onExport: () => void;
  /** Import a session from a picked JSON file. */
  onImport: (file: File) => void;
}

export class MeasurePanel {
  /** The panel element — append to the stage overlay. */
  readonly element: HTMLElement;
  private readonly _cb: MeasurePanelCallbacks;
  private readonly _list: HTMLElement;

  constructor(callbacks: MeasurePanelCallbacks) {
    this._cb = callbacks;
    this._list = el('div', { className: 'olv-mp-list' });

    // Export / import a measurement session.
    const fileInput = el('input', { className: 'olv-file-input', type: 'file' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this._cb.onImport(file);
      fileInput.value = ''; // let the same file be re-picked
    });
    const exportBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Export',
      title: 'Save all measurements and saved views to a JSON session file',
    });
    exportBtn.addEventListener('click', () => {
      exportBtn.blur();
      this._cb.onExport();
    });
    const importBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Import',
      title: 'Load measurements and saved views from a JSON session file',
    });
    importBtn.addEventListener('click', () => {
      importBtn.blur();
      fileInput.click();
    });

    // v0.3.6 mobile collapse — chevron toggle in the head row, hidden
    // on desktop, lets thumb users reclaim canvas with one tap.
    const collapseBtn = el('button', {
      className: 'olv-collapse-toggle',
      type: 'button',
      ariaLabel: 'Collapse panel',
      title: 'Collapse this panel',
    });
    collapseBtn.append(el('span', { className: 'olv-chevron', text: '▾' }));
    const title = el('div', { className: 'olv-mp-title', text: 'Measurements' });
    const head = el('div', { className: 'olv-panel-head' }, [title, collapseBtn]);
    const toggleCollapsed = () => {
      this.element.classList.toggle('olv-collapsed');
    };
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      if (e.target === head || e.target === title) toggleCollapsed();
    });
    this.element = el('aside', { className: 'olv-measure-panel olv-hidden' }, [
      head,
      this._list,
      el('div', { className: 'olv-mp-footer' }, [exportBtn, importBtn, fileInput]),
    ]);
  }

  /** Show or hide the panel. */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /** Rebuild the measurement list from the controller's summaries. */
  update(summaries: MeasurementSummary[]): void {
    if (summaries.length === 0) {
      this._list.replaceChildren(
        el('div', { className: 'olv-mp-empty', text: 'No measurements yet.' }),
      );
      return;
    }
    this._list.replaceChildren(...summaries.map((s) => this._row(s)));
  }

  private _row(s: MeasurementSummary): HTMLElement {
    const dot = el('span', { className: 'olv-mp-kind', title: s.kind });

    const name = el('input', {
      className: 'olv-mp-name',
      title: 'Type to rename this measurement',
    });
    name.value = s.name;
    name.addEventListener('change', () => this._cb.onRename(s.id, name.value));

    const value = el('span', { className: 'olv-mp-value', text: s.value });

    const del = el('button', {
      className: 'olv-mp-del',
      text: '×',
      title: `Delete ${s.name}`,
      ariaLabel: `Delete ${s.name}`,
    });
    del.addEventListener('click', () => this._cb.onDelete(s.id));

    const headRow = el('div', { className: 'olv-mp-row' }, [dot, name, value, del]);

    // Profile-only: render a compact height-vs-distance chart strip
    // beneath the headline row. The chart is a single inline SVG, no
    // external libraries — keeps the Measurements panel a leaf module.
    if (s.kind === 'profile' && s.profileChart && s.profileChart.length >= 2) {
      const chart = renderProfileChart(s.profileChart);
      const children: HTMLElement[] = [headRow, chart];
      // Streaming-resident caveat: surface a coverage caption beneath the
      // chart so the analyst understands the profile only reflects the
      // points currently resident in memory, and may refine as more
      // nodes stream in.
      if (s.profileChartResidentOnly) {
        children.push(
          el('div', {
            className: 'olv-mp-chart-caveat',
            text: 'Resident-node analysis only — profile may refine as streaming loads.',
          }),
        );
      }
      return el('div', { className: 'olv-mp-row-stack' }, children);
    }

    // Volume-only: surface the streaming-resident caveat beneath the
    // headline row when the cut/fill record was sampled against
    // resident nodes only. Same caption style as the profile branch so
    // the analyst's eye reads them as the same "may refine" signal.
    if (s.kind === 'volume' && s.volumeResidentOnly) {
      const caveat = el('div', {
        className: 'olv-mp-chart-caveat',
        text: 'Resident-node analysis only — cut / fill may refine as streaming loads.',
      });
      return el('div', { className: 'olv-mp-row-stack' }, [headRow, caveat]);
    }

    return headRow;
  }
}

/**
 * Render a compact profile chart as an inline SVG. Chart bounds are
 * normalised to the sample's distance / height extents; NaN samples
 * (no-coverage bins) split the line into separate paths so a gap
 * reads as a discontinuity rather than a straight interpolation.
 *
 * Width is the panel's available column; height is fixed at 36 px to
 * sit comfortably under the headline row without dominating the list.
 */
function renderProfileChart(
  samples: readonly { distance: number; height: number }[],
): HTMLElement {
  const W = 220;
  const H = 36;
  const PAD = 2;

  // Find data bounds across hit samples only.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.height)) continue;
    if (s.distance < xMin) xMin = s.distance;
    if (s.distance > xMax) xMax = s.distance;
    if (s.height < yMin) yMin = s.height;
    if (s.height > yMax) yMax = s.height;
  }

  // If no hits at all, render a "no coverage" hint instead of a chart.
  if (!Number.isFinite(xMin)) {
    return el('div', {
      className: 'olv-mp-chart-empty',
      text: 'No points near the profile line — try a denser scan area.',
    });
  }

  const xSpan = Math.max(xMax - xMin, 1e-9);
  const ySpan = Math.max(yMax - yMin, 1e-9);

  // Walk samples and emit one path per contiguous hit run.
  const paths: string[] = [];
  let cur = '';
  for (const s of samples) {
    if (!Number.isFinite(s.height)) {
      if (cur) {
        paths.push(cur);
        cur = '';
      }
      continue;
    }
    const x = PAD + ((s.distance - xMin) / xSpan) * (W - PAD * 2);
    // Invert Y: SVG y grows downward, but elevation grows upward.
    const y = H - PAD - ((s.height - yMin) / ySpan) * (H - PAD * 2);
    cur += cur === '' ? `M${x.toFixed(2)} ${y.toFixed(2)}` : ` L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  if (cur) paths.push(cur);

  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${paths
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join('')}
  </svg>`;

  const span = ySpan;
  const title = `${samples.length} samples · Δh ${span.toFixed(2)} m`;
  return el('div', { className: 'olv-mp-chart', html: svg, title });
}
