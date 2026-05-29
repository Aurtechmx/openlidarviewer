import { el, formatCount } from './dom';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { ColorMode } from '../render/colorModes';
import type { PointSizeMode } from '../render/pointStyle';
import { EDL_DEFAULTS, EDL_STRENGTH_RANGE } from '../render/edl';
import type { ExportFormat } from '../io/exporters';
import type { ExportMode } from '../export/types';
import {
  snapshot as snapshotUsage,
  reset as resetUsage,
  describeCounter,
  isSuppressed as usageIsSuppressed,
} from '../diagnostics/usageCounters';
import type { ProvenanceFingerprint, CaptureType } from '../diagnostics/provenance';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { listCrsEntriesByRegion, getCrsEntry } from '../geo/CrsRegistry';
// Direct subpath imports — NOT the `'../report'` barrel. The barrel
// re-exports `generateReport` / `renderReportPdf`, which transitively
// pull pdf-lib (~150 KB) into the static import graph and break the
// lazy-chunk split for the entire report engine. `ReportTemplates.ts`
// is a pure-data module with no pdf-lib dependency, so it's safe to
// hold a static reference to.
import {
  REPORT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  getReportTemplate,
} from '../report/ReportTemplates';
import type { ReportTemplateId } from '../report/types';

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
  /**
   * Visual Export Studio — render the live scan in one of the four
   * Studio modes (orthographic-rgb / height-map / intensity / classification)
   * and download the result as a PNG. The Inspector surfaces a button per
   * mode; main.ts owns the lazy import and the download wiring.
   */
  onExportImage: (mode: ExportMode) => void;
  /**
   * generate a PDF report from the live scan + annotations
   * + measurements using the named template. main.ts lazy-loads the
   * report engine + pdf-lib on first click.
   */
  onExportReport: (templateId: string) => void;
  /** Save the current camera viewpoint. */
  onSaveView: () => void;
  /** Fly to a saved viewpoint by index. */
  onApplyView: (index: number) => void;
  /** Rename a saved viewpoint by index. */
  onRenameView: (index: number, name: string) => void;
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

/**
 * Visual Export Studio — the four PNG export modes the Inspector
 * exposes in the new "Image export" section. Each entry is `[mode, label,
 * title]` — the title doubles as the hover-hint for the disabled button when
 * the mode is unavailable on the loaded cloud.
 */
// Honest button labels — user-reported confusion: "all reports show the
// same export". Root cause was the misnamed "Ortho RGB" which captures
// the CURRENT colour mode (not specifically RGB), so on a survey LAZ
// being viewed in elevation mode it produced the same image as "Height
// Map". Renamed to "View capture" so users know what they're getting:
// a PNG of whatever they currently see. Tooltip is honest that it
// preserves the active colour mode and isn't redundant with Height Map
// only when the user is actively choosing RGB / intensity / class
// before clicking.
// Order matters — the specific colour-mode buttons come FIRST because
// they reliably produce distinct images, then the generic "View capture"
// comes LAST. The reordering is the design-audit "reduction filter"
// applied: a user who clicks View capture without changing Color by
// first will get the same image as Height map (current default for
// survey LAZ). Placing the specific buttons first signals "to
// differentiate, pick one of these" before falling through to the
// generic capture.
const IMAGE_EXPORT_BUTTONS: ReadonlyArray<{
  readonly mode: ExportMode;
  readonly label: string;
  readonly title: string;
}> = [
  {
    mode: 'height-map',
    label: 'Height map',
    title: 'Forces elevation colouring. Always distinct from view-capture-in-other-modes.',
  },
  {
    mode: 'intensity',
    label: 'Intensity',
    title: 'Forces LiDAR-intensity colouring. Disabled on clouds without an intensity channel.',
  },
  {
    mode: 'classification',
    label: 'Class map',
    title: 'Forces ASPRS-classification colouring. Disabled on clouds without a classification channel.',
  },
  {
    mode: 'normal',
    label: 'Normal map',
    title:
      'RGB-encodes per-point surface normals. Disabled on clouds without normals ' +
      '(PCD / PTX / GLTF carry them; raw LiDAR rarely does).',
  },
  {
    mode: 'orthographic-rgb',
    label: 'View capture',
    title:
      'Captures the current on-screen view in whatever colour mode is active. ' +
      'To get a distinct image, switch the Color by chip before clicking — ' +
      'otherwise this matches Height Map when you are viewing in elevation.',
  },
  // Depth Map + Contour Map intentionally absent — their previous
  // implementations produced an elevation raster (same as Height Map)
  // rather than true camera-relative depth or marching-squares contour
  // lines. They will return once the proper implementations land.
];

function section(label: string, body: HTMLElement): HTMLElement {
  return el('div', { className: 'olv-section' }, [
    el('div', { className: 'olv-section-label', text: label }),
    body,
  ]);
}

/**
 * A collapsible section using native `<details>` / `<summary>`. The
 * summary is styled to match the static `olv-section-label` so the
 * panel reads as a uniform list of sections — the only visual
 * difference is the disclosure caret. Default-closed for sections
 * the user opens occasionally (Detail, Provenance, Coordinate
 * system, Scan report, Saved views, every export group), which
 * reduces first-paint density by ~60% on the 232 px panel.
 */
function collapsibleSection(
  label: string,
  body: HTMLElement,
  opts: { readonly open?: boolean } = {},
): HTMLDetailsElement {
  const details = el('details', {
    className: 'olv-section olv-section-collapsible',
  }) as HTMLDetailsElement;
  if (opts.open) details.open = true;
  const summary = el('summary', {
    className: 'olv-section-label olv-section-summary',
    text: label,
  });
  details.append(summary, body);
  return details;
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
  // Captured section refs — `setStreamingMode` toggles their visibility so
  // the static-cloud-only sections drop out when a streaming COPC / EPT is
  // active and their streaming-equivalents in StreamingPanel take over.
  private _layersSection!: HTMLElement;
  private _colorBySection!: HTMLElement;
  private _pointSizeSection!: HTMLElement;
  private _renderingSection!: HTMLElement;
  private _exportSection!: HTMLElement;
  private readonly _viewList = el('div', { className: 'olv-views' });
  /** Session-stats body — rebuilt lazily when the details section opens. */
  private readonly _sessionStatsBody: HTMLElement;
  /** Provenance fingerprint body — populated by setProvenance(). */
  private readonly _provenanceBody: HTMLElement;
  /** Last fingerprint surfaced; lets the user override drop in cleanly. */
  private _currentProvenance: ProvenanceFingerprint | null = null;
  /** Caller registers this to be told when the user overrides the type. */
  private _onProvenanceOverride: ((type: CaptureType) => void) | null = null;
  /** CRS section body — populated by setCrs(). */
  private readonly _crsBody: HTMLElement;
  /** Caller registers this to react to user CRS overrides. */
  private _onCrsOverride: ((override: { epsg: number | null; kind: 'projected' | 'geographic' | 'local' }) => void) | null = null;
  private readonly _layerRows = new Map<string, HTMLElement>();
  /**
   * Visual Export Studio — the per-mode image-export buttons, kept
   * by mode so {@link setImageExportEnabled} can disable them as a group
   * when no cloud is loaded (preventing the "click → console error" gap)
   * and per-mode when a specific channel is missing.
   */
  private readonly _imageExportButtons = new Map<ExportMode, HTMLButtonElement>();
  /** The original tooltip for each image-export button — restored on enable. */
  private readonly _imageExportTitles = new Map<ExportMode, string>();
  /** the Report PDF button, gated like the image-export ones. */
  private _reportButton: HTMLButtonElement | null = null;
  private _reportSelect: HTMLSelectElement | null = null;
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

    // Visual Export Studio — one button per export mode. The class
    // matches the existing exporter row above so the CSS layout is shared.
    // Buttons start disabled — `setImageExportEnabled()` flips them on once
    // a scan is loaded so users can't fire an export with nothing to draw.
    const imageExportButtons = IMAGE_EXPORT_BUTTONS.map(({ mode, label, title }) => {
      const button = el('button', {
        className: 'olv-export-btn',
        text: label,
        title,
      });
      button.disabled = true;
      button.title = `${title} (load a scan first)`;
      button.addEventListener('click', () => {
        button.blur();
        this._cb.onExportImage(mode);
      });
      this._imageExportButtons.set(mode, button);
      this._imageExportTitles.set(mode, title);
      return button;
    });
    // The image-export row carries 7 buttons — too many to fit in a single
    // flex row inside the 232 px Inspector panel. The 2-column grid layout
    // wraps cleanly into 4 rows (last row holds the seventh button).
    const imageExporter = el('div', { className: 'olv-export-grid' }, imageExportButtons);

    // PDF Report controls. A native <select> lets the user pick from the
    // full template catalogue (`REPORT_TEMPLATES`) — the picker reads the
    // current id off the select on click. The button stays single so the
    // 232 px panel doesn't acquire a per-template button row.
    const reportSelect = el('select', {
      className: 'olv-report-select',
      ariaLabel: 'PDF report template',
    }) as HTMLSelectElement;
    for (const t of REPORT_TEMPLATES) {
      const option = el('option', { text: t.label, title: t.description });
      option.value = t.id;
      if (t.id === DEFAULT_TEMPLATE_ID) option.selected = true;
      reportSelect.append(option);
    }
    // Mirror the button's empty-state disabled gate so the select and the
    // button enable together once a scan loads.
    reportSelect.disabled = true;
    const reportButton = el('button', {
      className: 'olv-export-btn',
      text: 'Report PDF',
      title: 'Generate a multi-page PDF report from the selected template.',
    });
    reportButton.disabled = true;
    reportButton.title = `${reportButton.title} (load a scan first)`;
    reportButton.addEventListener('click', () => {
      reportButton.blur();
      const templateId = reportSelect.value as ReportTemplateId;
      // Defence-in-depth: the select is populated from REPORT_TEMPLATES, but
      // a devtools-injected <option value="…"> or a future template rename
      // could surface an unknown id. Surface a visible button-state flash
      // so the click is observably acknowledged — silently bailing left the
      // user wondering whether the click registered.
      if (!getReportTemplate(templateId)) {
        const original = reportButton.textContent;
        reportButton.textContent = 'Unknown template';
        reportButton.disabled = true;
        window.setTimeout(() => {
          reportButton.textContent = original;
          reportButton.disabled = false;
        }, 1500);
        return;
      }
      this._cb.onExportReport(templateId);
    });
    this._reportButton = reportButton;
    this._reportSelect = reportSelect;
    const reportExporter = el('div', { className: 'olv-report-row' }, [
      reportSelect,
      reportButton,
    ]);

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

    // Session stats — collapsed by default; built lazily on first open so
    // the localStorage read never happens during the empty-state render.
    this._sessionStatsBody = el('div', { className: 'olv-session-stats' });
    const sessionStats = el('details', { className: 'olv-section olv-stats-section' }, [
      el('summary', { className: 'olv-stats-summary', text: 'Session stats' }),
      this._sessionStatsBody,
    ]);
    sessionStats.addEventListener('toggle', () => {
      if ((sessionStats as HTMLDetailsElement).open) this._refreshSessionStats();
    });

    // Provenance fingerprint — populated when a scan opens via setProvenance.
    this._provenanceBody = el('div', { className: 'olv-provenance' });
    this._showProvenancePlaceholder();

    // Coordinate reference system — detected on load, user can override
    // via the picker. Sits next to Provenance because both are
    // "what kind of scan is this?" diagnostics.
    this._crsBody = el('div', { className: 'olv-crs' });
    this._showCrsPlaceholder();

    // Panel composition — design-audit reduction filter applied.
    // The top four sections (Layers / Color by / Point size / Rendering)
    // stay statically expanded because they're the user's per-frame
    // touch points. Everything below is collapsed by default — Detail
    // is informational, Provenance / Coordinate system / Scan report
    // are loaded once and re-read on demand, Saved views starts empty,
    // and the three export groups are each one-click destinations
    // users go looking for. First-paint cognitive load drops by ~60%
    // without removing any feature.
    // Per-section refs — captured so `setStreamingMode` can hide the
    // static-cloud-only sections during streaming (the StreamingPanel
    // owns the streaming-equivalents: streaming color modes, quality
    // control, saved views are mirrored there). The kept sections —
    // Detail, Provenance, Coordinate system, Scan report, Image export,
    // Report PDF — work uniformly against either source type.
    this._layersSection = section('Layers', this._layers);
    this._colorBySection = section('Color by', this._chips);
    this._pointSizeSection = section('Point size', pointSizeBody);
    this._renderingSection = section('Rendering', renderingBody);
    this._exportSection = collapsibleSection('Export', exporter);

    this.element = el('aside', { className: 'olv-inspector' }, [
      head,
      this._layersSection,
      this._colorBySection,
      this._pointSizeSection,
      this._renderingSection,
      collapsibleSection('Detail', this._detail),
      collapsibleSection('Provenance', this._provenanceBody),
      collapsibleSection('Coordinate system', this._crsBody),
      collapsibleSection('Scan report', this._report),
      collapsibleSection('Saved views', views),
      this._exportSection,
      collapsibleSection('Image export', imageExporter),
      collapsibleSection('Report PDF', reportExporter),
      sessionStats,
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

  /**
   * Visual Export Studio — toggle the image-export buttons as a
   * group. The Studio modes all require a loaded cloud (the height-map,
   * intensity, and classification exporters' `isAvailable` gates on the
   * cloud AABB), so the failure mode is hidden at the UI layer by disabling
   * the buttons until `enabled === true`. Per-mode capability gating
   * (intensity disabled on a PLY, classification disabled on PCD without
   * a label channel) is handled inside each exporter's `isAvailable`.
   */
  /**
   * Streaming-mode toggle.
   *
   * When `true`, hides the four static-cloud-only sections (Layers, Color by,
   * Point size, Rendering) and the "Export" download section. Their
   * streaming-equivalents — color modes, quality control, resident-points
   * stats — live in the StreamingPanel; the Inspector retains Detail,
   * Provenance, Coordinate system, Scan report, Saved views, Image export
   * and Report PDF, which all work uniformly against a streaming source.
   *
   * When `false` (default), all sections are visible — the static load path
   * uses the full Inspector.
   *
   * Also flags the panel with `olv-inspector-streaming` so styles can
   * react (the desktop layout repositions the panel below the
   * StreamingPanel in this mode to avoid overlap).
   */
  setStreamingMode(streaming: boolean): void {
    const hidden = streaming ? 'none' : '';
    this._layersSection.style.display = hidden;
    this._colorBySection.style.display = hidden;
    this._pointSizeSection.style.display = hidden;
    this._renderingSection.style.display = hidden;
    this._exportSection.style.display = hidden;
    this.element.classList.toggle('olv-inspector-streaming', streaming);
  }

  /**
   * Hide the Inspector entirely while the user is on the empty state, reveal
   * once a scan attaches. v0.3.6 desktop-audit fix: the panel was painting on
   * the empty state with placeholder controls (Point Size, EDL, Antialiasing,
   * 13 collapsed sections) that operated on a scan that didn't exist. Showing
   * a fully-rendered control panel before there's anything to control is the
   * empty-state anti-pattern that mirrored the toolbar dock issue we already
   * fixed; the resolution is identical — hide it.
   */
  setEmpty(empty: boolean): void {
    this.element.classList.toggle('olv-hidden', empty);
    this.sheetToggle.classList.toggle('olv-hidden', empty);
  }

  setImageExportEnabled(enabled: boolean): void {
    for (const [mode, button] of this._imageExportButtons) {
      button.disabled = !enabled;
      const baseTitle = this._imageExportTitles.get(mode) ?? '';
      button.title = enabled ? baseTitle : `${baseTitle} (load a scan first)`;
    }
    // The Report PDF button + template picker share the same gate
    // (a report against no cloud has nothing to summarise).
    if (this._reportButton) {
      this._reportButton.disabled = !enabled;
      const base = 'Generate a multi-page PDF report from the selected template.';
      this._reportButton.title = enabled ? base : `${base} (load a scan first)`;
    }
    if (this._reportSelect) {
      this._reportSelect.disabled = !enabled;
    }
  }

  /**
   * Per-mode availability override for the Visual Export Studio buttons.
   *
   * Called by main after each load to disable buttons whose mode is not
   * supported by the loaded cloud — Normal map on a LAZ, Intensity on a
   * raw PLY, Class map on a PCD without a label channel. The button stays
   * visible (so the user knows the feature exists) but is disabled with
   * the unavailability reason in its tooltip. Without this, clicking
   * Normal map on a LAZ produced an error toast at render time — a poor
   * substitute for visibly-disabled affordance.
   *
   * Pre-conditions: a scan must already be loaded. Callers gate on
   * {@link setImageExportEnabled}(true) first; this method then narrows
   * the set of enabled buttons. A mode missing from the map is treated as
   * enabled (forward-compatible: a new exporter without per-mode flags
   * still works through `setImageExportEnabled(true)`).
   */
  setImageExportAvailability(
    availability: ReadonlyMap<ExportMode, { readonly available: boolean; readonly reason?: string }>,
  ): void {
    for (const [mode, button] of this._imageExportButtons) {
      const entry = availability.get(mode);
      if (!entry) continue; // unknown mode → leave as-is
      const baseTitle = this._imageExportTitles.get(mode) ?? '';
      if (entry.available) {
        button.disabled = false;
        button.title = baseTitle;
      } else {
        button.disabled = true;
        button.title = entry.reason
          ? `${baseTitle} — ${entry.reason}`
          : `${baseTitle} (unavailable on this cloud)`;
      }
    }
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
      el('span', {
        className: `olv-status olv-status-${row.status}`,
        // Accessibility: status is encoded by colour only — add a
        // textual label so screen readers and assistive tech announce
        // pass / info / warn / fail. Visual redundancy (a glyph inside
        // the dot) is a follow-up.
        ariaLabel: ({
          pass: 'Pass',
          info: 'Info',
          warn: 'Warning',
          fail: 'Fail',
        } as const)[row.status],
      }),
      el('span', { className: 'olv-report-label', text: row.label }),
      el('span', { className: 'olv-report-value', text: row.value }),
    ]);
  }

  /**
   * Render the saved-view list — one row per stored viewpoint, each with an
   * editable name, a Go button that flies the camera there, and a delete `×`.
   */
  setViews(names: string[]): void {
    this._viewList.replaceChildren();
    if (names.length === 0) {
      this._showViewsPlaceholder();
      return;
    }
    names.forEach((name, index) => {
      const nameInput = el('input', {
        className: 'olv-view-name',
        type: 'text',
        title: 'Rename this saved view',
      });
      nameInput.value = name;
      nameInput.maxLength = 60;
      const commit = (): void => {
        const next = nameInput.value.trim();
        if (next && next !== name) this._cb.onRenameView(index, next);
        else nameInput.value = name;
      };
      nameInput.addEventListener('change', commit);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameInput.blur();
        else if (e.key === 'Escape') {
          nameInput.value = name;
          nameInput.blur();
        }
      });

      const go = el('button', {
        className: 'olv-view-go',
        text: 'Go',
        title: `Glide the camera back to ${name}`,
        ariaLabel: `Go to ${name}`,
      });
      go.addEventListener('click', () => this._cb.onApplyView(index));

      const del = el('button', {
        className: 'olv-layer-x',
        text: '×',
        title: `Delete ${name}`,
        ariaLabel: `Delete ${name}`,
      });
      del.addEventListener('click', () => this._cb.onDeleteView(index));
      this._viewList.append(el('div', { className: 'olv-view-row' }, [nameInput, go, del]));
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

  // ── Provenance fingerprint ────────────────────────────────────────────────

  /** Surface the classifier's verdict for the loaded scan. */
  setProvenance(fingerprint: ProvenanceFingerprint): void {
    this._currentProvenance = fingerprint;
    this._renderProvenance(fingerprint);
  }

  /** Restore the placeholder when the active scan closes. */
  clearProvenance(): void {
    this._currentProvenance = null;
    this._showProvenancePlaceholder();
  }

  /**
   * Register a callback the panel invokes when the user picks a different
   * capture type from the override dropdown. Caller is responsible for
   * re-classifying with the override and feeding the fresh fingerprint
   * back through `setProvenance`.
   */
  setOnProvenanceOverride(cb: (type: CaptureType) => void): void {
    this._onProvenanceOverride = cb;
  }

  /** Surface the detected (or overridden) CRS for the loaded scan. */
  setCrs(resolved: ResolvedCrs): void {
    this._renderCrs(resolved);
  }

  /** Restore the CRS placeholder when the active scan closes. */
  clearCrs(): void {
    this._showCrsPlaceholder();
  }

  /**
   * Register a callback the panel invokes when the user picks a CRS in
   * the override dropdown. Caller is responsible for persisting the
   * override (via `CrsOverrideStore.setOverride`) and re-resolving the
   * effective CRS, then feeding the result back through `setCrs`.
   */
  setOnCrsOverride(
    cb: (override: { epsg: number | null; kind: 'projected' | 'geographic' | 'local' }) => void,
  ): void {
    this._onCrsOverride = cb;
  }

  private _showProvenancePlaceholder(): void {
    this._provenanceBody.replaceChildren(
      el('div', {
        className: 'olv-report-empty',
        text: 'Load a scan to see its capture provenance.',
      }),
    );
  }

  private _showCrsPlaceholder(): void {
    this._crsBody.replaceChildren(
      el('div', {
        className: 'olv-report-empty',
        text: 'Load a scan to see its coordinate reference system.',
      }),
    );
  }

  private _renderCrs(c: ResolvedCrs): void {
    this._crsBody.replaceChildren();

    // ── Detected / active CRS summary ──────────────────────────────────────
    const headerRow = el('div', { className: 'olv-crs-summary' }, [
      el('span', { className: 'olv-crs-name', text: c.name }),
    ]);
    if (typeof c.epsg === 'number') {
      headerRow.append(el('span', { className: 'olv-crs-epsg', text: `EPSG:${c.epsg}` }));
    }
    this._crsBody.append(headerRow);

    // Confidence + source row.
    const confidenceLabel: Record<typeof c.confidence, string> = {
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      none: 'None',
    };
    const sourceLabel: Record<typeof c.source, string> = {
      'las-vlr': 'LAS / LAZ georeference VLR',
      'copc-meta': 'COPC metadata',
      'ept-srs': 'EPT srs.wkt',
      'catalog-tile': 'Public-catalog tile',
      'user-override': 'User override',
      'default-assumption': 'No metadata',
    };
    this._crsBody.append(
      el('div', { className: 'olv-crs-meta' }, [
        el('span', { className: 'olv-crs-meta-row', text: `Confidence: ${confidenceLabel[c.confidence]}` }),
        el('span', { className: 'olv-crs-meta-row', text: `Source: ${sourceLabel[c.source]}` }),
      ]),
    );

    // ── Safety warnings (kind-specific) ────────────────────────────────────
    if (c.kind === 'unknown') {
      this._crsBody.append(
        el('div', {
          className: 'olv-crs-warning',
          text: 'CRS unknown. Coordinates are shown in source units only.',
        }),
      );
    } else if (c.kind === 'geographic') {
      this._crsBody.append(
        el('div', {
          className: 'olv-crs-warning',
          text: 'Dataset coordinates are geographic degrees. Metric distances may require projection.',
        }),
      );
    } else if (c.confidence === 'low') {
      this._crsBody.append(
        el('div', {
          className: 'olv-crs-warning',
          text: 'Low-confidence detection. Confirm before using converted coordinates.',
        }),
      );
    }
    if (c.userConfirmed && c.source === 'user-override') {
      this._crsBody.append(
        el('div', {
          className: 'olv-crs-warning-soft',
          text: 'CRS override active. Coordinate conversion uses your selection.',
        }),
      );
    }

    // ── Override picker ────────────────────────────────────────────────────
    const select = el('select', {
      className: 'olv-crs-select',
      ariaLabel: 'Coordinate reference system',
    }) as HTMLSelectElement;
    const optDetected = document.createElement('option');
    optDetected.value = '__detected__';
    optDetected.textContent =
      c.source === 'user-override' ? 'Reset to detected' : 'Use detected';
    select.append(optDetected);
    const optLocal = document.createElement('option');
    optLocal.value = '__local__';
    optLocal.textContent = 'Local coordinates (no CRS)';
    select.append(optLocal);
    for (const group of listCrsEntriesByRegion()) {
      const og = document.createElement('optgroup');
      og.label = ({
        global: 'Global',
        'united-states': 'United States',
        mexico: 'Mexico',
        europe: 'Europe',
        other: 'Other',
      } as const)[group.region];
      for (const entry of group.entries) {
        const opt = document.createElement('option');
        opt.value = String(entry.epsg);
        opt.textContent = `${entry.label} (EPSG:${entry.epsg})`;
        opt.title = entry.note;
        // Preselect the currently active EPSG when it matches.
        if (typeof c.epsg === 'number' && entry.epsg === c.epsg) {
          opt.selected = true;
        }
        og.append(opt);
      }
      select.append(og);
    }
    select.addEventListener('change', () => {
      if (!this._onCrsOverride) return;
      const v = select.value;
      if (v === '__detected__') {
        // Caller restores the detected CRS by re-running detection.
        this._onCrsOverride({ epsg: null, kind: 'local' /* tag value, caller ignores */ });
        return;
      }
      if (v === '__local__') {
        this._onCrsOverride({ epsg: null, kind: 'local' });
        return;
      }
      const epsg = Number.parseInt(v, 10);
      if (!Number.isFinite(epsg)) return;
      const entry = getCrsEntry(epsg);
      if (!entry) return;
      this._onCrsOverride({ epsg, kind: entry.kind });
    });
    this._crsBody.append(
      el('label', { className: 'olv-crs-picker-label', text: 'Override' }),
      select,
    );
  }

  private _renderProvenance(f: ProvenanceFingerprint): void {
    this._provenanceBody.replaceChildren();

    // Headline — capture type + confidence badge.
    const headline = el('div', { className: 'olv-prov-headline' }, [
      el('span', { className: 'olv-prov-label', text: f.label }),
      el('span', {
        className: `olv-prov-confidence olv-prov-confidence-${f.confidence}`,
        text: `${f.confidence} confidence`,
      }),
    ]);
    this._provenanceBody.append(headline);

    // Signals — what made the classifier pick this.
    if (f.signals.length > 0) {
      const signals = el('div', { className: 'olv-prov-signals' });
      for (const s of f.signals) {
        signals.append(el('div', { className: 'olv-prov-signal', text: `· ${s}` }));
      }
      this._provenanceBody.append(signals);
    }

    // Literature ribbon — every bound carries its source.
    if (f.bounds.length > 0) {
      const ribbon = el('div', { className: 'olv-prov-ribbon' });
      ribbon.append(
        el('div', {
          className: 'olv-prov-ribbon-title',
          text: 'Expected accuracy ranges',
        }),
      );
      for (const b of f.bounds) {
        ribbon.append(
          el('div', { className: 'olv-prov-bound' }, [
            el('div', { className: 'olv-prov-bound-label', text: b.label }),
            el('div', { className: 'olv-prov-bound-value', text: b.value }),
            el('div', { className: 'olv-prov-bound-source', text: b.source }),
          ]),
        );
      }
      this._provenanceBody.append(ribbon);
    }

    // Disclaimer — always present, deliberately verbose.
    this._provenanceBody.append(
      el('div', { className: 'olv-prov-disclaimer', text: f.disclaimer }),
    );

    // User override — a small dropdown the user can use when the classifier
    // got it wrong. Caller is wired via setOnProvenanceOverride.
    const overrideRow = el('div', { className: 'olv-prov-override-row' });
    overrideRow.append(
      el('span', { className: 'olv-prov-override-label', text: 'Override:' }),
    );

    const select = el('select', { className: 'olv-prov-override-select' });
    const options: Array<[CaptureType, string]> = [
      ['iphone-lidar', 'iPhone / handheld'],
      ['drone-lidar', 'Drone / UAV ALS'],
      ['terrestrial', 'Terrestrial laser scan'],
      ['mobile-slam', 'Mobile SLAM'],
      ['aerial-als', 'Aerial / airborne ALS'],
      ['spaceborne', 'Spaceborne'],
      ['unknown', 'Unknown'],
    ];
    for (const [type, label] of options) {
      const option = el('option', { text: label }) as HTMLOptionElement;
      option.value = type;
      if (type === f.captureType) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => {
      const next = (select.value as CaptureType);
      if (this._onProvenanceOverride && next !== this._currentProvenance?.captureType) {
        this._onProvenanceOverride(next);
      }
    });
    overrideRow.append(select);
    this._provenanceBody.append(overrideRow);
  }

  // ── Session stats ─────────────────────────────────────────────────────────

  /**
   * Rebuild the Session Stats body — called when the user opens the details
   * section. Reads the counter snapshot, renders the top 12 rows, and adds
   * a small "Reset" link at the bottom. Stays cheap: a localStorage read
   * + DOM rebuild, no observers.
   */
  private _refreshSessionStats(): void {
    this._sessionStatsBody.replaceChildren();

    if (usageIsSuppressed()) {
      this._sessionStatsBody.append(
        el('div', {
          className: 'olv-report-empty',
          text: 'Session stats are disabled (?notelemetry=1).',
        }),
      );
      return;
    }

    const rows = snapshotUsage();
    if (rows.length === 0) {
      this._sessionStatsBody.append(
        el('div', {
          className: 'olv-report-empty',
          text: 'No activity counted yet. Counts stay on this device.',
        }),
      );
      return;
    }

    // Top 12 most-recent counters. Rendering more than that would crowd the
    // panel without adding signal — the long tail is one click away in the
    // localStorage inspector.
    for (const r of rows.slice(0, 12)) {
      this._sessionStatsBody.append(
        el('div', { className: 'olv-stats-row' }, [
          el('span', { className: 'olv-stats-label', text: describeCounter(r) }),
          el('span', { className: 'olv-stats-count', text: formatCount(r.count) }),
        ]),
      );
    }

    // Privacy footer + Reset link. Confirms with a native dialog so a
    // misclick never wipes history.
    const reset = el('button', {
      className: 'olv-stats-reset',
      type: 'button',
      text: 'Reset',
      title: 'Clear every counter on this device. This cannot be undone.',
    });
    reset.addEventListener('click', () => {
      if (window.confirm('Reset every session stat? This cannot be undone.')) {
        resetUsage();
        this._refreshSessionStats();
      }
    });
    this._sessionStatsBody.append(
      el('div', { className: 'olv-stats-footer' }, [
        el('span', {
          className: 'olv-stats-note',
          text: 'Counts stay on this device.',
        }),
        reset,
      ]),
    );
  }
}
