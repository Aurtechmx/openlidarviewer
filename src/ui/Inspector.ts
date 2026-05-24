import { el, formatCount } from './dom';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { ColorMode } from '../render/colorModes';
import type { PointSizeMode } from '../render/pointStyle';
import { EDL_DEFAULTS, EDL_STRENGTH_RANGE } from '../render/edl';
import type { ExportFormat } from '../io/exporters';

/** The render-quality state the Inspector's Rendering controls reflect. */
export interface RenderingState {
  pointSize: number;
  edlEnabled: boolean;
  edlStrength: number;
  pointSizeMode: PointSizeMode;
  antialiasing: boolean;
}

export interface InspectorCallbacks {
  onColorMode: (mode: ColorMode) => void;
  onPointSize: (size: number) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
  /** Export the active cloud to a file format. */
  onExport: (format: ExportFormat) => void;
  /** Save the current camera viewpoint. */
  onSaveView: () => void;
  /** Fly to a saved viewpoint by index. */
  onApplyView: (index: number) => void;
  /** Delete a saved viewpoint by index. */
  onDeleteView: (index: number) => void;
  /** Toggle Eye Dome Lighting depth shading. */
  onEdlToggle: (on: boolean) => void;
  /** Set the EDL strength. */
  onEdlStrength: (strength: number) => void;
  /** Switch between adaptive and fixed point sizing. */
  onPointSizeMode: (mode: PointSizeMode) => void;
  /** Toggle point-edge antialiasing. */
  onAntialiasing: (on: boolean) => void;
}

const MODE_LABELS: Record<ColorMode, string> = {
  rgb: 'RGB',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
  normal: 'Normal',
};

/** Hover hints for each colour mode — what the chip does, for first-time users. */
const MODE_TITLES: Record<ColorMode, string> = {
  rgb: 'Colour points by their stored RGB colour',
  intensity: 'Colour points by LiDAR return intensity',
  elevation: 'Colour points by height — low to high',
  classification: 'Colour points by their ASPRS classification code',
  normal: 'Colour points by surface-normal direction',
};

const EXPORT_FORMATS: ExportFormat[] = ['ply', 'obj', 'xyz', 'csv'];

function section(label: string, body: HTMLElement): HTMLElement {
  return el('div', { className: 'olv-section' }, [
    el('div', { className: 'olv-section-label', text: label }),
    body,
  ]);
}

/** A small on/off chip button; the active class reflects the on state. */
function toggleChip(
  label: string,
  title: string,
  onChange: (on: boolean) => void,
): HTMLButtonElement {
  const chip = el('button', { className: 'olv-chip', text: label, title, type: 'button' });
  chip.addEventListener('click', () => {
    chip.blur();
    const on = !chip.classList.contains('olv-chip-active');
    chip.classList.toggle('olv-chip-active', on);
    onChange(on);
  });
  return chip;
}

/**
 * The floating Inspector panel: the cloud layer list, the color-by chips, a
 * point-size slider, the Detail readout, the Scan Report, saved camera views,
 * and the export buttons.
 */
export class Inspector {
  readonly element: HTMLElement;
  /**
   * The floating "Scan Info" launcher — append to the overlay. It opens the
   * Inspector as a bottom sheet; styling shows it on phones only, once a scan
   * has loaded.
   */
  readonly sheetToggle: HTMLButtonElement;
  private readonly _cb: InspectorCallbacks;
  private readonly _layers = el('div', { className: 'olv-layers' });
  private readonly _chips = el('div', { className: 'olv-chips' });
  private readonly _detail = el('div', { className: 'olv-detail' });
  private readonly _report = el('div', { className: 'olv-report' });
  private readonly _viewList = el('div', { className: 'olv-views' });
  private readonly _layerRows = new Map<string, HTMLElement>();
  // ── Rendering controls ──
  private readonly _pointSizeSlider: HTMLInputElement;
  private readonly _edlChip: HTMLButtonElement;
  private readonly _edlStrengthSlider: HTMLInputElement;
  private readonly _edlStrengthRow: HTMLElement;
  private readonly _aaChip: HTMLButtonElement;
  private readonly _sizeModeChips: { mode: PointSizeMode; chip: HTMLButtonElement }[];

  constructor(callbacks: InspectorCallbacks) {
    this._cb = callbacks;

    // ── Point size: an adaptive/fixed mode toggle above the size slider ──
    const slider = el('input', {
      className: 'olv-slider',
      type: 'range',
      title: 'Drag to set the base on-screen size of each point',
    });
    slider.type = 'range';
    slider.min = '1';
    slider.max = '8';
    slider.step = '0.5';
    slider.value = '1';
    slider.addEventListener('input', () => this._cb.onPointSize(slider.valueAsNumber));
    this._pointSizeSlider = slider;

    this._sizeModeChips = (['adaptive', 'fixed'] as PointSizeMode[]).map((mode) => {
      const chip = el('button', {
        className: 'olv-chip',
        type: 'button',
        text: mode === 'adaptive' ? 'Adaptive' : 'Fixed',
        title:
          mode === 'adaptive'
            ? 'Points scale with camera distance — far points stay visible, near ones do not bloat'
            : 'Every point keeps a constant on-screen size',
      });
      chip.addEventListener('click', () => {
        chip.blur();
        for (const c of this._sizeModeChips) {
          c.chip.classList.toggle('olv-chip-active', c.mode === mode);
        }
        this._cb.onPointSizeMode(mode);
      });
      return { mode, chip };
    });
    const pointSizeBody = el('div', { className: 'olv-render-group' }, [
      el('div', { className: 'olv-chips' }, this._sizeModeChips.map((c) => c.chip)),
      slider,
    ]);

    // ── Rendering: Eye Dome Lighting toggle + strength, antialiasing ──
    this._edlChip = toggleChip(
      'Eye Dome Lighting',
      'Toggle Eye Dome Lighting — depth shading that makes 3D structure far more readable',
      (on) => {
        this._edlStrengthRow.classList.toggle('olv-hidden', !on);
        this._cb.onEdlToggle(on);
      },
    );
    this._aaChip = toggleChip(
      'Antialiasing',
      'Toggle antialiasing — smooths the edge of every point',
      (on) => this._cb.onAntialiasing(on),
    );

    this._edlStrengthSlider = el('input', {
      className: 'olv-slider',
      type: 'range',
      title: 'Drag to set how pronounced the depth shading is',
    });
    this._edlStrengthSlider.type = 'range';
    this._edlStrengthSlider.min = String(EDL_STRENGTH_RANGE.min);
    this._edlStrengthSlider.max = String(EDL_STRENGTH_RANGE.max);
    this._edlStrengthSlider.step = '0.05';
    this._edlStrengthSlider.value = String(EDL_DEFAULTS.strength);
    this._edlStrengthSlider.addEventListener('input', () =>
      this._cb.onEdlStrength(this._edlStrengthSlider.valueAsNumber),
    );
    this._edlStrengthRow = el('div', { className: 'olv-render-row olv-hidden' }, [
      el('span', { className: 'olv-render-label', text: 'Strength' }),
      this._edlStrengthSlider,
    ]);
    const renderingBody = el('div', { className: 'olv-render-group' }, [
      el('div', { className: 'olv-chips' }, [this._edlChip, this._aaChip]),
      this._edlStrengthRow,
    ]);

    // Saved views: a "save" button above a list of stored viewpoints.
    const saveView = el('button', {
      className: 'olv-view-save',
      text: '+ Save current view',
      title: 'Store the current camera angle so you can return to it later',
    });
    saveView.addEventListener('click', () => {
      saveView.blur();
      this._cb.onSaveView();
    });
    const views = el('div', {}, [saveView, this._viewList]);

    // Export: one button per supported output format.
    const exportButtons = EXPORT_FORMATS.map((format) => {
      const button = el('button', {
        className: 'olv-export-btn',
        text: format.toUpperCase(),
        title: `Export the cloud as ${format.toUpperCase()}`,
      });
      button.addEventListener('click', () => {
        button.blur();
        this._cb.onExport(format);
      });
      return button;
    });
    const exporter = el('div', { className: 'olv-export' }, exportButtons);

    // The header carries the panel title and — on phones, where the panel is
    // a bottom sheet — a close control.
    const sheetClose = el('button', {
      className: 'olv-sheet-close',
      text: '×',
      ariaLabel: 'Close scan info',
    });
    sheetClose.addEventListener('click', () => this.closeSheet());
    const head = el('div', { className: 'olv-panel-head' }, [
      el('div', { className: 'olv-panel-title', text: 'Scan Intelligence' }),
      sheetClose,
    ]);

    this.element = el('aside', { className: 'olv-inspector' }, [
      head,
      section('Layers', this._layers),
      section('Color by', this._chips),
      section('Point size', pointSizeBody),
      section('Rendering', renderingBody),
      section('Detail', this._detail),
      section('Scan report', this._report),
      section('Saved views', views),
      section('Export', exporter),
    ]);
    this._showReportPlaceholder();
    this._showViewsPlaceholder();

    // The phone-only launcher that slides the panel up as a bottom sheet.
    this.sheetToggle = el('button', {
      className: 'olv-scaninfo-btn',
      type: 'button',
      text: 'Scan Info',
      ariaLabel: 'Show scan information',
    });
    this.sheetToggle.addEventListener('click', () => this.toggleSheet());
  }

  /** Open the Inspector as a bottom sheet (phones). */
  openSheet(): void {
    this.element.classList.add('olv-sheet-open');
  }

  /** Close the bottom sheet. */
  closeSheet(): void {
    this.element.classList.remove('olv-sheet-open');
  }

  /** Toggle the bottom sheet open or closed. */
  toggleSheet(): void {
    this.element.classList.toggle('olv-sheet-open');
  }

  /** Add a loaded cloud to the layer list. */
  addCloud(id: string, name: string, pointCount: number): void {
    const visible = el('input', { type: 'checkbox', title: 'Show or hide this scan' });
    visible.type = 'checkbox';
    visible.checked = true;
    visible.addEventListener('change', () => this._cb.onToggleVisible(id, visible.checked));

    const remove = el('button', {
      className: 'olv-layer-x',
      text: '×',
      title: `Remove ${name} from the scene`,
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
      const chip = el('button', {
        className: 'olv-chip',
        text: MODE_LABELS[mode],
        title: MODE_TITLES[mode],
      });
      if (mode === active) chip.classList.add('olv-chip-active');
      chip.addEventListener('click', () => {
        for (const other of this._chips.children) other.classList.remove('olv-chip-active');
        chip.classList.add('olv-chip-active');
        this._cb.onColorMode(mode);
      });
      this._chips.append(chip);
    }
  }

  /** Reflect the viewer's current render-quality state in the controls. */
  syncRendering(state: RenderingState): void {
    this._pointSizeSlider.value = String(state.pointSize);
    this._edlChip.classList.toggle('olv-chip-active', state.edlEnabled);
    this._edlStrengthRow.classList.toggle('olv-hidden', !state.edlEnabled);
    this._edlStrengthSlider.value = String(state.edlStrength);
    this._aaChip.classList.toggle('olv-chip-active', state.antialiasing);
    for (const c of this._sizeModeChips) {
      c.chip.classList.toggle('olv-chip-active', c.mode === state.pointSizeMode);
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

  /**
   * Render the report rows. Headline metrics show directly; rows marked
   * `advanced` (the health diagnostics) are tucked into a collapsible
   * "Advanced report" so the default view stays clean.
   */
  setReport(rows: AnalysisRow[]): void {
    this._report.replaceChildren();
    const advanced: AnalysisRow[] = [];
    for (const row of rows) {
      if (row.advanced) advanced.push(row);
      else this._report.append(this._reportRow(row));
    }
    if (advanced.length > 0) {
      const body = el('div', { className: 'olv-advanced-body' });
      for (const row of advanced) body.append(this._reportRow(row));
      this._report.append(
        el('details', { className: 'olv-advanced' }, [
          el('summary', { className: 'olv-advanced-summary', text: 'Advanced report' }),
          body,
        ]),
      );
    }
  }

  /** Build a single status / label / value report row. */
  private _reportRow(row: AnalysisRow): HTMLElement {
    return el('div', { className: 'olv-report-row' }, [
      el('span', { className: `olv-status olv-status-${row.status}` }),
      el('span', { className: 'olv-report-label', text: row.label }),
      el('span', { className: 'olv-report-value', text: row.value }),
    ]);
  }

  /** Render the saved-view list — one clickable row per stored viewpoint. */
  setViews(names: string[]): void {
    this._viewList.replaceChildren();
    if (names.length === 0) {
      this._showViewsPlaceholder();
      return;
    }
    names.forEach((name, index) => {
      const go = el('button', {
        className: 'olv-view-name',
        text: name,
        title: 'Glide the camera back to this saved viewpoint',
      });
      go.addEventListener('click', () => this._cb.onApplyView(index));
      const del = el('button', {
        className: 'olv-layer-x',
        text: '×',
        title: `Delete ${name}`,
        ariaLabel: `Delete ${name}`,
      });
      del.addEventListener('click', () => this._cb.onDeleteView(index));
      this._viewList.append(el('div', { className: 'olv-view-row' }, [go, del]));
    });
  }

  /** Reset the panel to its empty state. */
  clear(): void {
    this._layers.replaceChildren();
    this._layerRows.clear();
    this._chips.replaceChildren();
    this._detail.replaceChildren();
    this._showReportPlaceholder();
    this._showViewsPlaceholder();
    this.closeSheet();
  }

  private _showReportPlaceholder(): void {
    this._report.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Drop a scan to validate it.' }),
    );
  }

  private _showViewsPlaceholder(): void {
    this._viewList.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'No saved views yet.' }),
    );
  }
}
