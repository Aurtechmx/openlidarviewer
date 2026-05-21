import { el, formatCount } from './dom';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { ColorMode } from '../render/colorModes';

export interface InspectorCallbacks {
  onColorMode: (mode: ColorMode) => void;
  onPointSize: (size: number) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
}

const MODE_LABELS: Record<ColorMode, string> = {
  rgb: 'RGB',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
};

function section(label: string, body: HTMLElement): HTMLElement {
  return el('div', { className: 'olv-section' }, [
    el('div', { className: 'olv-section-label', text: label }),
    body,
  ]);
}

/**
 * The floating Inspector panel: the cloud layer list, the color-by chips, a
 * point-size slider, the Detail readout (honest "shown / total"), and the
 * Scan Report — the output of the validation modules.
 */
export class Inspector {
  readonly element: HTMLElement;
  private readonly _cb: InspectorCallbacks;
  private readonly _layers = el('div', { className: 'olv-layers' });
  private readonly _chips = el('div', { className: 'olv-chips' });
  private readonly _detail = el('div', { className: 'olv-detail' });
  private readonly _report = el('div', { className: 'olv-report' });
  private readonly _layerRows = new Map<string, HTMLElement>();

  constructor(callbacks: InspectorCallbacks) {
    this._cb = callbacks;

    const slider = el('input', { className: 'olv-slider', type: 'range' });
    slider.type = 'range';
    slider.min = '1';
    slider.max = '8';
    slider.step = '0.5';
    slider.value = '2';
    slider.addEventListener('input', () => this._cb.onPointSize(slider.valueAsNumber));

    this.element = el('aside', { className: 'olv-inspector' }, [
      el('div', { className: 'olv-panel-title', text: 'Inspector' }),
      section('Layers', this._layers),
      section('Color by', this._chips),
      section('Point size', slider),
      section('Detail', this._detail),
      section('Scan report', this._report),
    ]);
    this._showReportPlaceholder();
  }

  /** Add a loaded cloud to the layer list. */
  addCloud(id: string, name: string, pointCount: number): void {
    const visible = el('input', { type: 'checkbox' });
    visible.type = 'checkbox';
    visible.checked = true;
    visible.addEventListener('change', () => this._cb.onToggleVisible(id, visible.checked));

    const remove = el('button', {
      className: 'olv-layer-x',
      text: '×',
      ariaLabel: `Remove ${name}`,
    });
    remove.addEventListener('click', () => this._cb.onRemove(id));

    const row = el('div', { className: 'olv-layer' }, [
      visible,
      el('span', { className: 'olv-layer-name', text: name }),
      el('span', { className: 'olv-layer-count', text: formatCount(pointCount) }),
      remove,
    ]);
    this._layerRows.set(id, row);
    this._layers.append(row);
  }

  /** Remove a cloud's layer row. */
  removeCloud(id: string): void {
    this._layerRows.get(id)?.remove();
    this._layerRows.delete(id);
  }

  /** Render the color-mode chips, marking `active` as selected. */
  setColorModes(modes: ColorMode[], active: ColorMode): void {
    this._chips.replaceChildren();
    for (const mode of modes) {
      const chip = el('button', { className: 'olv-chip', text: MODE_LABELS[mode] });
      if (mode === active) chip.classList.add('olv-chip-active');
      chip.addEventListener('click', () => {
        for (const other of this._chips.children) other.classList.remove('olv-chip-active');
        chip.classList.add('olv-chip-active');
        this._cb.onColorMode(mode);
      });
      this._chips.append(chip);
    }
  }

  /** Show the honest "shown / total" point count and a fill bar. */
  setDetail(shown: number, total: number): void {
    const pct = total > 0 ? Math.min(100, Math.round((shown / total) * 100)) : 100;
    const fill = el('div', { className: 'olv-detail-fill' });
    fill.style.width = `${pct}%`;
    this._detail.replaceChildren(
      el('div', { className: 'olv-detail-bar' }, [fill]),
      el('div', {
        className: 'olv-detail-text',
        text: `${formatCount(shown)} / ${formatCount(total)} points`,
      }),
    );
  }

  /** Render the validation rows (Health Check + Scan Report). */
  setReport(rows: AnalysisRow[]): void {
    this._report.replaceChildren();
    for (const row of rows) {
      this._report.append(
        el('div', { className: 'olv-report-row' }, [
          el('span', { className: `olv-status olv-status-${row.status}` }),
          el('span', { className: 'olv-report-label', text: row.label }),
          el('span', { className: 'olv-report-value', text: row.value }),
        ]),
      );
    }
  }

  /** Reset the panel to its empty state. */
  clear(): void {
    this._layers.replaceChildren();
    this._layerRows.clear();
    this._chips.replaceChildren();
    this._detail.replaceChildren();
    this._showReportPlaceholder();
  }

  private _showReportPlaceholder(): void {
    this._report.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Drop a scan to validate it.' }),
    );
  }
}
