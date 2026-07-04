import { el, formatCount } from './dom';
import { openConfirm } from './Modal';
import { DatasetIntelligenceCard } from './DatasetIntelligenceCard';
import type {
  DatasetIntelligence,
  DatasetIntelligenceInput,
} from '../terrain/datasetIntelligence';
import type { AnalysisRow } from '../analysis/ModuleApi';
import { scopeStamp } from '../render/class/classScope';
import { classificationLabel } from '../render/pointInfo';
import type { ColorMode } from '../render/colorModes';
import {
  buildColorChipModel,
  COVERAGE_DISABLED_TITLE,
  ANALYSIS_GATED_MODES,
} from './colorChipModel';
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
// Workflow presets (v0.4.5) — pure table; the rail renders it, main.ts
// applies it through the Viewer's existing setters.
import {
  listTerrainWorkflowPresets,
  type TerrainWorkflowPresetId,
} from '../render/terrainWorkflowPresets';

/** The render-quality state the Inspector's Rendering controls reflect. */
export interface RenderingState {
  pointSize: number;
  edlEnabled: boolean;
  edlStrength: number;
  pointSizeMode: PointSizeMode;
  antialiasing: boolean;
  /**
   * Mobile touch model. `true` = standard (twist + pinch + pan
   * decomposition, default); `false` = advanced (3-finger zoom). The
   * chip is shown to every user — it's harmless on desktop where touch
   * isn't in play and matters on tablet / phone where it ships v0.3.7's
   * new gesture surface.
   */
  twoFingerTwistEnabled: boolean;
  /**
   * Active splat mode — drives the chip rail highlight in the
   * Rendering section. The viewer keeps the source of truth; the
   * Inspector mirrors it via `syncRendering`.
   */
  splatMode: 'classic' | 'soft' | 'inspection' | 'gaussian';
}

export interface InspectorCallbacks {
  onColorMode: (mode: ColorMode) => void;
  /**
   * v0.3.7 final-polish — symmetric height percentile trim.
   * `trim = 5` clips to the 5 / 95 band (default), `trim = 0` uses
   * true min/max, `trim = 25` uses the 25 / 75 band for a very
   * dramatic gradient on field-only scans.
   */
  onHeightPercentileTrim: (trim: number) => void;
  /**
   * Elevation filter (v0.5.6): a world-space `[min, max]` height window, or
   * `null` to clear. Points outside the window are hidden.
   */
  onElevationFilter?: (range: [number, number] | null) => void;
  /**
   * A raw-intensity `[min, max]` filter window, or `null` to clear. Points
   * whose intensity falls outside the window are hidden.
   */
  onIntensityFilter?: (range: [number, number] | null) => void;
  onPointSize: (size: number) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
  /** Isolate a layer (show only it); calling again on the active layer clears isolate. */
  onToggleSolo?: (id: string) => void;
  /** Lock a layer out of picking / measuring (it stays drawn). */
  onToggleLock?: (id: string, locked: boolean) => void;
  /** Compare the two loaded layers' elevations (two-epoch change detection). */
  onCompareLayers?: () => void;
  /** Download the most recent comparison's signed difference as a georeferenced raster. */
  onExportDifference?: () => void;
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
  /**
   * Toggle the two-finger twist + pinch + pan recogniser. `on = true` →
   * standard (decomposition). `on = false` → advanced (3-finger zoom).
   * Persisted by main.ts through `prefs.touchModel`.
   */
  onTwoFingerTwist: (on: boolean) => void;
  /**
   * Visuals Studio chip rails + Advanced sliders.
   *
   * Each callback maps a single chip / slider click to the Viewer's
   * matching setter. `main.ts` wires them through; the Inspector keeps
   * the highlight state in sync via `syncVisuals(state)` so an external
   * preset change (session restore, public API call) reflects in the UI.
   */
  onRgbAppearancePreset: (id: string) => void;
  onEdlPreset: (id: 'subtle' | 'balanced' | 'inspection' | null) => void;
  onSkyPreset: (id: string) => void;
  /** Advanced (streaming COPC only) — white-balance sliders. */
  onWhiteBalance: (temperature: number, tint: number) => void;
  /** Advanced (streaming COPC only) — auto-balance button. */
  onAutoBalance: () => void;
  /** Rendering > Splat mode chip rail. */
  onSplatMode: (id: 'classic' | 'soft' | 'inspection' | 'gaussian') => void;
  /**
   * Visuals Studio > Workflow chip rail (v0.4.5) — apply a terrain workflow
   * preset (Terrain / Construction / Mining / Forestry / Hydrology /
   * Archaeology). A pure bundle over existing knobs; main.ts fans it out to
   * the Viewer's setters and re-syncs.
   */
  onTerrainWorkflowPreset: (id: TerrainWorkflowPresetId) => void;
}

const MODE_LABELS: Record<ColorMode, string> = {
  rgb: 'RGB',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
  normal: 'Normal',
  density: 'Density',
  coverage: 'Coverage',
  confidence: 'Confidence',
};

/** Hover hints for each colour mode — what the chip does, for first-time users. */
const MODE_TITLES: Record<ColorMode, string> = {
  rgb: 'Colour points by their stored RGB colour',
  intensity: 'Colour points by LiDAR return intensity',
  elevation: 'Colour points by height — low to high',
  classification: 'Colour points by their ASPRS classification code',
  normal: 'Colour points by surface-normal direction',
  density: 'Colour points by local coverage — dark = sparse, bright = dense',
  coverage:
    'Colour points by bare-earth trust — green strong (measured), yellow ' +
    'moderate (interpolated), red weak (extrapolated/gap). Approximate.',
  confidence:
    'Colour points by bare-earth trust on the colourblind-safe Cividis ramp — ' +
    'bright strong (measured), mid moderate (interpolated), dark weak ' +
    '(extrapolated/gap). Same buckets as Coverage. Approximate.',
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
      'otherwise this matches Height Map when you are viewing in elevation. ' +
      'Georeferenced scans (known CRS + world origin) instead download a ' +
      'top-down ortho ZIP with .pgw/.prj sidecars that GIS tools place directly.',
  },
  // Depth Map + Contour Map intentionally absent — their previous
  // implementations produced an elevation raster (same as Height Map)
  // rather than true camera-relative depth or marching-squares contour
  // lines. They will return once the proper implementations land.
];

/**
 * Visuals Studio — Visuals Studio state the Inspector keeps in sync
 * with the Viewer. When the active preset changes (chip click, session
 * restore, or public-API call) the Inspector flips the matching chip
 * highlight.
 */
export interface VisualsStudioState {
  readonly rgbAppearancePresetId: string | null;
  readonly edlPresetId: 'subtle' | 'balanced' | 'inspection' | null;
  readonly skyPresetId: string;
  /** Current white-balance temperature; only meaningful for streaming COPC. */
  readonly temperature: number;
  /** Current white-balance tint; only meaningful for streaming COPC. */
  readonly tint: number;
  /**
   * Workflow preset rail state (v0.4.5): the preset the current knobs match,
   * `'custom'` when the user deviated from every preset, or null/absent to
   * leave the rail unhighlighted (pre-v0.4.5 callers omit the field).
   */
  readonly workflowPresetId?: TerrainWorkflowPresetId | 'custom' | null;
}

/** The six RGB appearance chips Visuals Studio surfaces. */
const VISUALS_RGB_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'natural', label: 'Natural' },
  { id: 'photoreal-rgb', label: 'Photoreal' },
  { id: 'drone-rgb', label: 'Drone RGB' },
  { id: 'mobile-lidar', label: 'Mobile LiDAR' },
  { id: 'survey', label: 'Survey' },
  { id: 'high-contrast', label: 'High Contrast' },
];

/** The four EDL chips (Off + three named presets). */
const VISUALS_EDL_CHIPS: ReadonlyArray<{
  id: 'subtle' | 'balanced' | 'inspection' | null;
  label: string;
}> = [
  { id: null, label: 'Off' },
  { id: 'subtle', label: 'Subtle' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'inspection', label: 'Inspection' },
];

/** The five sky chips Visuals Studio surfaces. */
const VISUALS_SKY_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'studio-dark', label: 'Studio Dark' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'survey-light', label: 'Survey Light' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'black', label: 'Black' },
];

/**
 * Splat mode chips — Rendering > Point appearance rail. Four modes:
 *   - Classic: crisp single-pixel samples (the v0.3.7 baseline).
 *   - Soft: 1.5× sprite radius with forced alphaToCoverage so
 *     neighbouring samples kiss and read as a continuous surface.
 *   - Inspection: 2× sprite radius for sparse measurement work.
 *   - Gaussian (P13): a windowed radial-Gaussian point kernel — a smooth
 *     sprite falloff, NOT a trained 3D Gaussian Splat scene.
 */
const VISUALS_SPLAT_CHIPS: ReadonlyArray<{
  id: 'classic' | 'soft' | 'inspection' | 'gaussian';
  label: string;
  /** Optional custom tooltip; falls back to a generated one when absent. */
  title?: string;
}> = [
  { id: 'classic', label: 'Classic Points' },
  { id: 'soft', label: 'Soft Splats' },
  { id: 'inspection', label: 'Inspection Splats' },
  {
    id: 'gaussian',
    label: 'Gaussian',
    // Honesty: this is a point-sprite kernel, NOT a trained 3D Gaussian Splat scene.
    title:
      'Gaussian-shaped point rendering. This smooths ordinary point samples and is not a trained 3D Gaussian Splat scene.',
  },
];

function section(label: string, body: HTMLElement): HTMLElement {
  return el('div', { className: 'olv-section' }, [
    el('div', { className: 'olv-section-label', text: label }),
    body,
  ]);
}

/**
 * True when a `[lo, hi]` window actually hides points versus the cloud's full
 * extent — used to flag a range-filter section as "filtering". A window equal to
 * (or wider than) the extent hides nothing, so it should not read as active.
 * With no known extent, any window is treated as filtering.
 */
function narrowsExtent(
  lo: number,
  hi: number,
  ext: { min: number; max: number } | null,
): boolean {
  if (!ext) return true;
  return lo > ext.min || hi < ext.max;
}

/** Blur a numeric input on Enter so the value commits on narrow / touch screens. */
function enterConfirms(input: HTMLInputElement): void {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
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
  /**
   * Phone-only tap target. The Inspector's panel head doubles as a sheet
   * handle on mobile so the user can tap the bar at the bottom of the
   * viewport to expand/collapse the Scan Intelligence card. On desktop
   * the listener is harmless — the sheet-open class is a no-op when the
   * panel isn't styled as a sheet.
   */
  private _sheetHead!: HTMLElement;
  private readonly _cb: InspectorCallbacks;
  private readonly _layers = el('div', { className: 'olv-layers' });
  private readonly _chips = el('div', { className: 'olv-chips' });
  /**
   * Visible reason shown below the colour-mode rail while the analysis-gated
   * chips (Coverage / Confidence) are disabled. WHY visible (not just the
   * chip's `title`): a `title` tooltip needs a hover, which touch devices
   * don't have — so on a phone the only explanation for why those chips are
   * greyed used to be invisible. This line carries the same reason in the flow.
   */
  private readonly _chipsNote = el('p', { className: 'olv-chips-note olv-hidden' });
  /** Visuals Studio — Visuals Studio chip rails. Stored so syncVisuals can re-flag active. */
  private readonly _visualsRgbRail = el('div', { className: 'olv-chips' });
  private readonly _visualsEdlRail = el('div', { className: 'olv-chips' });
  private readonly _visualsSkyRail = el('div', { className: 'olv-chips' });
  /** Visuals Studio > Workflow preset rail (v0.4.5) + its "Custom" state chip. */
  private readonly _visualsWorkflowRail = el('div', { className: 'olv-chips' });
  /** Rendering > Splat mode chip rail. */
  private readonly _visualsSplatRail = el('div', { className: 'olv-chips' });
  /**
   * Advanced disclosure (Temperature / Tint / Auto-balance) — only
   * makes sense for streaming COPC tiles. For local LAZ the RGB preset
   * chips cover the same intent without the manual-tweak complexity,
   * so this details element is hidden via `_advancedVisible` until a
   * streaming cloud attaches. Stored so the host can flip visibility.
   */
  private _wbAdvancedDetails: HTMLDetailsElement | null = null;
  private readonly _wbTemperatureSlider = (() => {
    const s = el('input', { type: 'range', className: 'olv-wb-slider' }) as HTMLInputElement;
    s.min = '-100';
    s.max = '100';
    s.step = '5';
    s.value = '0';
    return s;
  })();
  private readonly _wbTintSlider = (() => {
    const s = el('input', { type: 'range', className: 'olv-wb-slider' }) as HTMLInputElement;
    s.min = '-100';
    s.max = '100';
    s.step = '5';
    s.value = '0';
    return s;
  })();
  /**
   * v0.3.7 final-polish — symmetric height percentile-trim slider.
   * Visible only when the active colour mode is 'elevation'. Default
   * trim is 5 (the 5 / 95 percentile band).
   */
  private readonly _heightTrimRow = el('div', {
    className: 'olv-height-trim-row olv-hidden',
  });
  private readonly _heightTrimSlider = (() => {
    const slider = el('input', {
      type: 'range',
      className: 'olv-height-trim-slider',
    }) as HTMLInputElement;
    slider.min = '0';
    slider.max = '25';
    slider.step = '1';
    slider.value = '5';
    return slider;
  })();
  private readonly _heightTrimLabel = el('span', {
    className: 'olv-height-trim-label',
    text: '5%',
  });
  // Elevation filter (v0.5.6) — two world-space bounds. The section is hidden
  // until a static cloud provides an extent to seed the inputs.
  private _elevExtent: { min: number; max: number } | null = null;
  private readonly _elevMinInput = (() => {
    const i = el('input', { type: 'number', className: 'olv-elev-input' }) as HTMLInputElement;
    i.step = 'any';
    i.setAttribute('aria-label', 'Minimum elevation');
    return i;
  })();
  private readonly _elevMaxInput = (() => {
    const i = el('input', { type: 'number', className: 'olv-elev-input' }) as HTMLInputElement;
    i.step = 'any';
    i.setAttribute('aria-label', 'Maximum elevation');
    return i;
  })();
  private _elevFilterSection!: HTMLElement;
  // Intensity filter (v0.5.6) — mirrors the elevation filter, raw intensity units.
  private _intenExtent: { min: number; max: number } | null = null;
  private readonly _intenMinInput = (() => {
    const i = el('input', { type: 'number', className: 'olv-elev-input' }) as HTMLInputElement;
    i.step = 'any';
    i.setAttribute('aria-label', 'Minimum intensity');
    return i;
  })();
  private readonly _intenMaxInput = (() => {
    const i = el('input', { type: 'number', className: 'olv-elev-input' }) as HTMLInputElement;
    i.step = 'any';
    i.setAttribute('aria-label', 'Maximum intensity');
    return i;
  })();
  private _intenFilterSection!: HTMLElement;
  private readonly _detail = el('div', { className: 'olv-detail' });
  private readonly _report = el('div', { className: 'olv-report' });
  // Captured section refs — `setStreamingMode` toggles their visibility so
  // the static-cloud-only sections drop out when a streaming COPC / EPT is
  // active and their streaming-equivalents in StreamingPanel take over.
  private _layersSection!: HTMLElement;
  private _colorBySection!: HTMLElement;
  private _renderingSection!: HTMLElement;
  private _exportSection!: HTMLElement;
  private readonly _viewList = el('div', { className: 'olv-views' });
  /** Session-stats body — rebuilt lazily when the details section opens. */
  private readonly _sessionStatsBody: HTMLElement;
  /** Dataset Intelligence card — surfaced under the title, above Layers. */
  private readonly _datasetIntelligence: DatasetIntelligenceCard;
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
  /** Lazily-created one-line CRS-mismatch note under the layer list. */
  private _layerNote: HTMLElement | null = null;
  /** Lazily-created two-epoch compare button + result, shown with exactly 2 layers. */
  private _compareBtn: HTMLButtonElement | null = null;
  private _compareResult: HTMLElement | null = null;
  private _diffBtn: HTMLButtonElement | null = null;
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
  private readonly _pointSizeValue: HTMLElement;
  private readonly _edlChip: HTMLButtonElement;
  private readonly _edlStrengthSlider: HTMLInputElement;
  private readonly _edlStrengthRow: HTMLElement;
  private readonly _aaChip: HTMLButtonElement;
  private readonly _touchChip: HTMLButtonElement;
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
    // Live numeric readout so the user knows the exact point size they're
    // dragging (e.g. "1.0 px"), not just a slider position.
    this._pointSizeValue = el('span', { className: 'olv-render-value', text: '1.0 px' });
    slider.addEventListener('input', () => {
      this._pointSizeValue.textContent = `${slider.valueAsNumber.toFixed(1)} px`;
      this._cb.onPointSize(slider.valueAsNumber);
    });
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
    // Point size now lives inside the merged Rendering body below as
    // a sub-group. The chips + slider are pulled in by reference.

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
    // Touch model chip — active state means "Twist" gesture is enabled
    // (the default v0.3.7 standard model). Tapping it off switches to
    // the advanced model where 3 fingers dolly and 2 fingers twist+pan.
    // The label and title shift between modes so a returning user knows
    // which model is currently armed without opening the help sheet.
    this._touchChip = toggleChip(
      'Touch twist',
      'On — two-finger twist rotates the view. Off — two fingers pinch-zoom (classic) and three fingers zoom in/out',
      (on) => this._cb.onTwoFingerTwist(on),
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
    // Rendering is the "technician's tool" — raw sliders + toggles.
    // Visuals Studio above it carries the preset surface; this section
    // stays collapsed by default. Point size lives here too as a
    // sub-group so first-paint density stays low and every raw
    // tunable is one place.
    const renderingBody = el('div', { className: 'olv-render-group' }, [
      el('div', { className: 'olv-render-sublabel olv-render-sublabel-row' }, [
        el('span', { text: 'Point size' }),
        this._pointSizeValue,
      ]),
      el('div', { className: 'olv-chips' }, this._sizeModeChips.map((c) => c.chip)),
      slider,
      el('div', { className: 'olv-render-sublabel', text: 'Point appearance' }),
      this._visualsSplatRail,
      el('div', { className: 'olv-render-sublabel', text: 'Eye Dome Lighting' }),
      el('div', { className: 'olv-chips' }, [this._edlChip, this._aaChip, this._touchChip]),
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
    // a bottom sheet — a close control. The close handler stops propagation
    // so the head's own tap-to-toggle listener (wired below) doesn't fire a
    // second toggle and immediately re-open the sheet.
    const sheetClose = el('button', {
      className: 'olv-sheet-close',
      text: '×',
      ariaLabel: 'Close scan info',
    });
    sheetClose.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.closeSheet();
    });
    // v0.4.3 — the theme picker moved OUT of this panel into a single
    // shape-morphing button in the top-right header (ThemeToggle.ts).
    // The Scan Intelligence panel no longer carries the Dark / Light /
    // High-contrast chip rail.
    // The chevron is a CSS-only `▾` glyph; it rotates 180° when the sheet
    // is open. Together with the grip handle and the new tap-the-head
    // behaviour this signals to phone users that the bar at the bottom of
    // the screen is interactive — previously they saw "Scan Intelligence"
    // and a `×` close button but nothing told them tapping the title would
    // open the panel, so the bar read as a status pill, not a handle.
    const sheetChevron = el('span', {
      className: 'olv-sheet-chevron',
      text: '▾',
    });
    sheetChevron.setAttribute('aria-hidden', 'true');
    const head = el('div', { className: 'olv-panel-head' }, [
      el('div', { className: 'olv-panel-title', text: 'Scan Intelligence' }),
      sheetChevron,
      sheetClose,
    ]);
    // Make the whole head row act as a toggle on phones. On desktop the
    // sheet stays static and toggleSheet is a no-op-shaped class flip, so
    // the listener costs nothing.
    head.addEventListener('click', () => this.toggleSheet());
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'false');
    head.tabIndex = 0;
    head.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.toggleSheet();
      }
    });
    this._sheetHead = head;

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
    // v0.3.7 final-polish — build the height percentile-trim row and
    // mount it inside the "Color by" section beneath the chip rail.
    // The row hides itself when the active mode isn't 'elevation'.
    this._heightTrimRow.replaceChildren(
      el('span', { className: 'olv-height-trim-name', text: 'Trim outliers' }),
      this._heightTrimSlider,
      this._heightTrimLabel,
    );
    this._heightTrimSlider.addEventListener('input', () => {
      const trim = Number.parseInt(this._heightTrimSlider.value, 10);
      const safe = Number.isFinite(trim) ? trim : 5;
      this._heightTrimLabel.textContent = `${safe}%`;
      this._cb.onHeightPercentileTrim(safe);
    });
    const colorByBody = el('div', { className: 'olv-color-by-body' }, [
      this._chips,
      this._chipsNote,
      this._heightTrimRow,
    ]);
    this._colorBySection = section('Color by', colorByBody);

    // Elevation filter (v0.5.6) — a world-space height window; points outside it
    // hide. Seeded from the cloud's z-extent by `setElevationExtent`, and hidden
    // until then. Applies only when both bounds parse (ignores mid-typing).
    const applyElev = (): void => {
      const lo = Number(this._elevMinInput.value);
      const hi = Number(this._elevMaxInput.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
      this._cb.onElevationFilter?.([lo, hi]);
      // Flag the section as actively hiding points only when the window is
      // narrower than the cloud's full extent — a full-range window filters
      // nothing, so it shouldn't read as active.
      this._elevFilterSection.classList.toggle(
        'olv-filter-active',
        narrowsExtent(lo, hi, this._elevExtent),
      );
    };
    this._elevMinInput.addEventListener('input', applyElev);
    this._elevMaxInput.addEventListener('input', applyElev);
    enterConfirms(this._elevMinInput);
    enterConfirms(this._elevMaxInput);
    const elevReset = el('button', { className: 'olv-elev-reset', text: 'Show all' });
    elevReset.setAttribute('type', 'button');
    elevReset.setAttribute('title', 'Clear the filter and show every point in this scan');
    elevReset.addEventListener('click', () => {
      if (this._elevExtent) {
        this._elevMinInput.value = String(Math.floor(this._elevExtent.min));
        this._elevMaxInput.value = String(Math.ceil(this._elevExtent.max));
      }
      this._cb.onElevationFilter?.(null);
      this._elevFilterSection.classList.remove('olv-filter-active');
    });
    const elevBody = el('div', { className: 'olv-elev-body' }, [
      el('div', { className: 'olv-elev-row' }, [
        el('span', { className: 'olv-elev-cap', text: 'Min' }),
        this._elevMinInput,
        el('span', { className: 'olv-elev-cap', text: 'Max' }),
        this._elevMaxInput,
      ]),
      elevReset,
    ]);
    this._elevFilterSection = section('Elevation filter', elevBody);
    this._elevFilterSection.classList.add('olv-hidden');

    // Intensity filter (v0.5.6) — a raw-intensity window; points outside it
    // hide. Seeded from the cloud's intensity range by `setIntensityExtent`, and
    // hidden until then (and for clouds with no intensity channel).
    const applyInten = (): void => {
      const lo = Number(this._intenMinInput.value);
      const hi = Number(this._intenMaxInput.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
      this._cb.onIntensityFilter?.([lo, hi]);
      this._intenFilterSection.classList.toggle(
        'olv-filter-active',
        narrowsExtent(lo, hi, this._intenExtent),
      );
    };
    this._intenMinInput.addEventListener('input', applyInten);
    this._intenMaxInput.addEventListener('input', applyInten);
    enterConfirms(this._intenMinInput);
    enterConfirms(this._intenMaxInput);
    const intenReset = el('button', { className: 'olv-elev-reset', text: 'Show all' });
    intenReset.setAttribute('type', 'button');
    intenReset.setAttribute('title', 'Clear the filter and show every point in this scan');
    intenReset.addEventListener('click', () => {
      if (this._intenExtent) {
        this._intenMinInput.value = String(Math.floor(this._intenExtent.min));
        this._intenMaxInput.value = String(Math.ceil(this._intenExtent.max));
      }
      this._cb.onIntensityFilter?.(null);
      this._intenFilterSection.classList.remove('olv-filter-active');
    });
    const intenBody = el('div', { className: 'olv-elev-body' }, [
      el('div', { className: 'olv-elev-row' }, [
        el('span', { className: 'olv-elev-cap', text: 'Min' }),
        this._intenMinInput,
        el('span', { className: 'olv-elev-cap', text: 'Max' }),
        this._intenMaxInput,
      ]),
      intenReset,
    ]);
    this._intenFilterSection = section('Intensity filter', intenBody);
    this._intenFilterSection.classList.add('olv-hidden');

    // Visuals Studio — Visuals Studio.
    // Build the three chip rails. Each chip's click fires the matching
    // callback; `syncVisuals` updates the active class on every rail
    // when the Viewer state changes from outside (preset import,
    // public-API call, etc.).
    // Workflow preset rail (v0.4.5) — Terrain / Construction / Mining /
    // Forestry / Hydrology / Archaeology, plus a non-interactive "Custom"
    // chip that lights up when the current knobs match no preset (the user
    // deviated). One click fans the bundle out through main.ts.
    for (const preset of listTerrainWorkflowPresets()) {
      const chip = el('button', {
        className: 'olv-chip',
        text: preset.label,
        title: preset.description,
      });
      chip.dataset.presetId = preset.id;
      // aria-pressed is the canonical toggle-state signal — the active class
      // alone is colour-only, invisible to a screen reader. syncVisuals keeps
      // it in lockstep with the highlight.
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        chip.blur();
        this._cb.onTerrainWorkflowPreset(preset.id);
      });
      this._visualsWorkflowRail.append(chip);
    }
    {
      // "Custom" is a STATE indicator, not an action — disabled so it can't
      // be clicked, present so a deviation is named rather than silently
      // un-highlighting every preset.
      const custom = el('button', {
        className: 'olv-chip olv-chip-custom',
        text: 'Custom',
        title:
          'Your current look does not match a workflow preset — adjust any ' +
          'preset by hand and this lights up. Click a preset to return to it.',
      });
      custom.disabled = true;
      custom.dataset.presetId = 'custom';
      // The Custom chip is a pressed-state peer of the presets: when the user
      // deviates it is the "active" pill, and aria-pressed must say so even
      // though the button itself is inert.
      custom.setAttribute('aria-pressed', 'false');
      this._visualsWorkflowRail.append(custom);
    }

    for (const def of VISUALS_RGB_CHIPS) {
      const chip = el('button', {
        className: 'olv-chip',
        text: def.label,
        title: `Apply the ${def.label} RGB appearance preset`,
      });
      chip.dataset.presetId = def.id;
      chip.addEventListener('click', () => this._cb.onRgbAppearancePreset(def.id));
      this._visualsRgbRail.append(chip);
    }
    for (const def of VISUALS_EDL_CHIPS) {
      const chip = el('button', {
        className: 'olv-chip',
        text: def.label,
        title:
          def.id === null
            ? 'Disable Eye Dome Lighting'
            : `Apply the ${def.label} EDL preset`,
      });
      chip.dataset.presetId = def.id ?? 'off';
      chip.addEventListener('click', () => this._cb.onEdlPreset(def.id));
      this._visualsEdlRail.append(chip);
    }
    for (const def of VISUALS_SKY_CHIPS) {
      const chip = el('button', {
        className: 'olv-chip',
        text: def.label,
        title: `Switch the background to ${def.label}`,
      });
      chip.dataset.presetId = def.id;
      chip.addEventListener('click', () => this._cb.onSkyPreset(def.id));
      this._visualsSkyRail.append(chip);
    }
    // Splat mode rail — three chips under Rendering > Splat mode.
    for (const def of VISUALS_SPLAT_CHIPS) {
      const chip = el('button', {
        className: 'olv-chip',
        text: def.label,
        title: def.title ?? `Render points as ${def.label.toLowerCase()}`,
      });
      chip.dataset.presetId = def.id;
      chip.addEventListener('click', () => this._cb.onSplatMode(def.id));
      this._visualsSplatRail.append(chip);
    }

    // Advanced disclosure body. The streaming COPC pipeline uses a
    // different colour path than local LAZ, and the preset chips
    // sometimes don't cover what an analyst needs on a fresh aerial
    // tile. These manual sliders (Temperature, Tint, Auto-balance)
    // only affect streaming clouds; the host (main.ts) hides them
    // entirely when no streaming cloud is active so local-LAZ users
    // never see a control that won't move their picture.
    const wbTempLabel = el('span', { className: 'olv-wb-label', text: '0' });
    const wbTintLabel = el('span', { className: 'olv-wb-label', text: '0' });
    this._wbTemperatureSlider.addEventListener('input', () => {
      const t = Number.parseInt(this._wbTemperatureSlider.value, 10) / 100;
      const tint = Number.parseInt(this._wbTintSlider.value, 10) / 100;
      wbTempLabel.textContent = String(Math.round(t * 100));
      this._cb.onWhiteBalance(t, tint);
    });
    this._wbTintSlider.addEventListener('input', () => {
      const t = Number.parseInt(this._wbTemperatureSlider.value, 10) / 100;
      const tint = Number.parseInt(this._wbTintSlider.value, 10) / 100;
      wbTintLabel.textContent = String(Math.round(tint * 100));
      this._cb.onWhiteBalance(t, tint);
    });
    const autoBalanceBtn = el('button', {
      className: 'olv-chip olv-wb-auto',
      text: 'Auto-balance',
      title: 'Streaming COPC only — analyse the cloud histogram and suggest a tuned bundle',
    });
    autoBalanceBtn.addEventListener('click', () => this._cb.onAutoBalance());

    const advancedBody = el('div', { className: 'olv-visuals-advanced' }, [
      el('div', { className: 'olv-visuals-advanced-hint',
        text: 'Streaming COPC only. For local LAZ, use the RGB preset chips above.' }),
      el('div', { className: 'olv-visuals-row' }, [
        el('span', { className: 'olv-visuals-row-name', text: 'Temperature' }),
        this._wbTemperatureSlider,
        wbTempLabel,
      ]),
      el('div', { className: 'olv-visuals-row' }, [
        el('span', { className: 'olv-visuals-row-name', text: 'Tint' }),
        this._wbTintSlider,
        wbTintLabel,
      ]),
      el('div', { className: 'olv-visuals-row' }, [autoBalanceBtn]),
    ]);
    this._wbAdvancedDetails = el('details', {
      className: 'olv-visuals-advanced-details olv-hidden',
    }) as HTMLDetailsElement;
    this._wbAdvancedDetails.append(
      el('summary', {
        className: 'olv-visuals-advanced-summary',
        text: 'Advanced (streaming only)',
      }),
      advancedBody,
    );

    const visualsBody = el('div', { className: 'olv-visuals-body' }, [
      // Workflow presets lead the Studio: the highest-leverage, least-effort
      // control answers "what job is this scan for?" before per-knob rails.
      el('div', { className: 'olv-visuals-group-label', text: 'Workflow' }),
      this._visualsWorkflowRail,
      el('div', { className: 'olv-visuals-group-label', text: 'RGB' }),
      this._visualsRgbRail,
      el('div', { className: 'olv-visuals-group-label', text: 'Depth (EDL)' }),
      this._visualsEdlRail,
      el('div', { className: 'olv-visuals-group-label', text: 'Background' }),
      this._visualsSkyRail,
      this._wbAdvancedDetails,
    ]);
    // Visuals Studio is the curator's tool — preset chips that pick a
    // tuned bundle in one click. Default-open so first-paint surfaces
    // the most-impactful, least-effortful control. Rendering below it
    // is the technician's tool (raw sliders) and stays default-closed.
    const visualsStudioSection = collapsibleSection('Visuals Studio', visualsBody, {
      open: true,
    });
    // Point size folded into Rendering as a sub-group — the visible
    // Point size, point-size mode, EDL and antialiasing share this one
    // "Rendering" section; it stays visible during streaming so point
    // thickness remains adjustable on a streaming COPC / EPT.
    this._renderingSection = collapsibleSection('Rendering', renderingBody);
    this._exportSection = collapsibleSection('Export', exporter);

    // Dataset Intelligence — informational summary of the Terrain
    // Foundation outputs. Lives directly under the Scan Intelligence
    // title and above the Visuals Studio preset rail. Empty-state by
    // default so the panel never lies on first paint.
    this._datasetIntelligence = new DatasetIntelligenceCard();

    this.element = el('aside', { className: 'olv-inspector' }, [
      head,
      this._datasetIntelligence.element,
      this._layersSection,
      this._colorBySection,
      this._elevFilterSection,
      this._intenFilterSection,
      // Visuals Studio (presets, curator's tool) → Rendering (raw,
      // technician's tool). Point size is folded into Rendering as a
      // sub-group, so the panel keeps one slot per intent instead of
      // three overlapping ones.
      visualsStudioSection,
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

  /**
   * Seed the elevation-filter inputs from a cloud's world extent and reveal
   * the section. Passing null hides the section (no static cloud loaded).
   */
  setElevationExtent(ext: { min: number; max: number } | null): void {
    this._elevExtent = ext;
    if (!ext || !Number.isFinite(ext.min) || !Number.isFinite(ext.max)) {
      this._elevFilterSection.classList.add('olv-hidden');
      return;
    }
    this._elevMinInput.value = String(Math.floor(ext.min));
    this._elevMaxInput.value = String(Math.ceil(ext.max));
    this._elevFilterSection.classList.remove('olv-hidden');
    // A fresh seed is the full extent — nothing filtered yet.
    this._elevFilterSection.classList.remove('olv-filter-active');
  }

  /**
   * Seed the intensity-filter inputs from a cloud's intensity range and reveal
   * the section. Passing null hides it (no static cloud, or no intensity
   * channel).
   */
  setIntensityExtent(ext: { min: number; max: number } | null): void {
    this._intenExtent = ext;
    if (!ext || !Number.isFinite(ext.min) || !Number.isFinite(ext.max)) {
      this._intenFilterSection.classList.add('olv-hidden');
      return;
    }
    this._intenMinInput.value = String(Math.floor(ext.min));
    this._intenMaxInput.value = String(Math.ceil(ext.max));
    this._intenFilterSection.classList.remove('olv-hidden');
    this._intenFilterSection.classList.remove('olv-filter-active');
  }

  /** Open the Inspector as a bottom sheet (phones). */
  openSheet(): void {
    this.element.classList.add('olv-sheet-open');
    this._sheetHead?.setAttribute('aria-expanded', 'true');
  }

  /** Close the bottom sheet. */
  closeSheet(): void {
    this.element.classList.remove('olv-sheet-open');
    this._sheetHead?.setAttribute('aria-expanded', 'false');
  }

  /** Toggle the bottom sheet open or closed. */
  toggleSheet(): void {
    const open = this.element.classList.toggle('olv-sheet-open');
    this._sheetHead?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /** Add a loaded cloud to the layer list. `crsLabel` shows the layer's CRS, when known. */
  addCloud(id: string, name: string, pointCount: number, crsLabel?: string | null): void {
    const visible = el('input', { type: 'checkbox', title: 'Show or hide this scan' });
    visible.type = 'checkbox';
    visible.checked = true;
    visible.addEventListener('change', () => this._cb.onToggleVisible(id, visible.checked));

    // Isolate (solo): show only this layer. A second click clears isolate.
    const solo = el('button', {
      className: 'olv-layer-solo',
      text: '◉',
      title: `Isolate ${name} — hide the other layers`,
      ariaLabel: `Isolate ${name}`,
    });
    solo.addEventListener('click', () => this._cb.onToggleSolo?.(id));

    // Lock: keep the layer drawn but exclude it from picking / measuring.
    const lock = el('button', {
      className: 'olv-layer-lock',
      text: '○',
      title: `Lock ${name} out of picking and measuring`,
      ariaLabel: `Lock ${name} out of picking`,
    });
    let locked = false;
    lock.addEventListener('click', () => {
      locked = !locked;
      lock.classList.toggle('is-active', locked);
      lock.textContent = locked ? '●' : '○';
      lock.title = locked
        ? `${name} is locked — unlock to pick / measure it`
        : `Lock ${name} out of picking and measuring`;
      this._cb.onToggleLock?.(id, locked);
    });

    const remove = el('button', {
      className: 'olv-layer-x',
      text: '×',
      title: `Remove ${name} from the scene`,
      ariaLabel: `Remove ${name}`,
    });
    remove.addEventListener('click', () => this._cb.onRemove(id));

    const crs = el('span', {
      className: 'olv-layer-crs',
      text: crsLabel ?? '—',
      title: crsLabel ? `Coordinate system: ${crsLabel}` : 'No coordinate system declared',
    });

    const row = el('div', { className: 'olv-layer' }, [
      visible,
      el('span', { className: 'olv-layer-name', text: name }),
      el('span', { className: 'olv-layer-count', text: formatCount(pointCount) }),
      crs,
      solo,
      lock,
      remove,
    ]);
    this._layerRows.set(id, row);
    this._layers.append(row);
  }

  /** Mark the isolated (soloed) layer's button as active; `null` clears all. */
  setLayerSolo(soloId: string | null): void {
    for (const [id, row] of this._layerRows) {
      row.querySelector('.olv-layer-solo')?.classList.toggle('is-active', id === soloId);
    }
  }

  /**
   * Flag layers whose CRS doesn't match the others and show a one-line note.
   * Honest overlay guard: a silently mismatched frame is called out, not trusted.
   */
  setLayerCrsFlags(mismatched: ReadonlySet<string>, summary: string): void {
    for (const [id, row] of this._layerRows) {
      const bad = mismatched.has(id);
      row.classList.toggle('olv-layer-crs-mismatch', bad);
      if (bad) row.title = 'This layer does not share the others’ coordinate system.';
      else row.removeAttribute('title');
    }
    if (!this._layerNote) {
      this._layerNote = el('p', { className: 'olv-layer-note' });
      this._layersSection.append(this._layerNote);
    }
    this._layerNote.textContent = summary;
    this._layerNote.style.display = summary ? '' : 'none';
  }

  private _ensureCompareUi(): void {
    if (this._compareBtn) return;
    const btn = el('button', {
      className: 'olv-bc-pill olv-layer-compare',
      type: 'button',
      text: 'Compare elevation',
      title: 'Difference the two loaded layers as before → after (two-epoch change detection)',
    }) as HTMLButtonElement;
    btn.style.display = 'none';
    btn.addEventListener('click', () => this._cb.onCompareLayers?.());
    const result = el('pre', { className: 'olv-layer-compare-result' });
    result.style.display = 'none';
    const diff = el('button', {
      className: 'olv-bc-pill olv-layer-compare',
      type: 'button',
      text: 'Download difference (.asc)',
      title: 'Save the signed elevation difference as a georeferenced ESRI ASCII grid for QGIS / ArcGIS',
    }) as HTMLButtonElement;
    diff.style.display = 'none';
    diff.addEventListener('click', () => this._cb.onExportDifference?.());
    this._compareBtn = btn;
    this._compareResult = result;
    this._diffBtn = diff;
    this._layersSection.append(btn, result, diff);
  }

  /** Show the "Compare elevation" action only when exactly two layers are loaded. */
  setLayerCompareAvailable(on: boolean): void {
    this._ensureCompareUi();
    if (this._compareBtn) this._compareBtn.style.display = on ? '' : 'none';
    if (!on) {
      if (this._compareResult) this._compareResult.style.display = 'none';
      if (this._diffBtn) this._diffBtn.style.display = 'none';
    }
  }

  /** Show the "Download difference" action once a comparison has produced a grid. */
  setDifferenceAvailable(on: boolean): void {
    this._ensureCompareUi();
    if (this._diffBtn) this._diffBtn.style.display = on ? '' : 'none';
  }

  /** Render the two-epoch comparison result (cut/fill + co-registration lines). */
  setCompareResult(lines: readonly string[]): void {
    this._ensureCompareUi();
    if (!this._compareResult) return;
    this._compareResult.textContent = lines.join('\n');
    this._compareResult.style.display = lines.length ? '' : 'none';
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
    this._exportSection.style.display = hidden;
    // The Render-quality section (point size, point-size mode, EDL,
    // antialiasing) stays visible while streaming. Each control applies to the
    // resident streaming node materials and every newly-decoded node inherits
    // the current setting at build time, so they are fully functional — and
    // none has a StreamingPanel equivalent, so hiding the section removed
    // point-thickness control on a streaming COPC.
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

  /** Data-driven colour modes for the active cloud (gated chips are appended separately). */
  private _modes: ColorMode[] = [];
  /** The currently-selected colour mode, tracked so a re-render keeps the highlight. */
  private _activeMode: ColorMode = 'elevation';
  /**
   * Whether the analysis-gated chips ("Coverage" + its colourblind-safe twin
   * "Confidence") are enabled. False until a terrain analysis produces a
   * DTM-confidence grid; the chips are shown DISABLED (so the user learns the
   * features exist) with a "Run terrain analysis first" tooltip.
   */
  private _coverageAvailable = false;

  /** Render the color-mode chips, marking `active` as selected. */
  setColorModes(modes: ColorMode[], active: ColorMode): void {
    // The Coverage / Confidence modes are analysis-gated, not data-gated, so
    // they are never part of the per-cloud `availableModes` list — track the
    // data modes separately and always append the gated chips below.
    this._modes = modes.filter((m) => !ANALYSIS_GATED_MODES.includes(m));
    this._activeMode = active;
    this._renderColorChips();
  }

  /**
   * Enable / disable the analysis-gated colour chips (Coverage + Confidence —
   * both read the same grid). Called when a terrain analysis confidence grid
   * appears (enable) or the scan is closed (disable). Re-renders the chip
   * rail so the disabled state + tooltip update in place.
   */
  setCoverageAvailable(available: boolean): void {
    if (this._coverageAvailable === available) return;
    this._coverageAvailable = available;
    this._renderColorChips();
  }

  /** (Re)build the colour-mode chip rail from the tracked mode list + state. */
  private _renderColorChips(): void {
    this._chips.replaceChildren();
    const descriptors = buildColorChipModel(this._modes, this._activeMode, this._coverageAvailable);
    let anyGatedDisabled = false;
    for (const desc of descriptors) {
      const { mode, active, disabled } = desc;
      if (disabled) anyGatedDisabled = true;
      const title = disabled ? COVERAGE_DISABLED_TITLE : MODE_TITLES[mode];
      const chip = el('button', { className: 'olv-chip', text: MODE_LABELS[mode], title });
      if (active) chip.classList.add('olv-chip-active');
      if (disabled) {
        chip.disabled = true;
        chip.classList.add('olv-chip-disabled');
      }
      chip.addEventListener('click', () => {
        if (disabled) return; // a disabled (analysis-gated) chip is a no-op
        for (const other of this._chips.children) other.classList.remove('olv-chip-active');
        chip.classList.add('olv-chip-active');
        this._activeMode = mode;
        this._cb.onColorMode(mode);
        // v0.3.7 final-polish — show the trim slider when the analyst
        // picks Height. Other modes don't honour the slider so hiding
        // it removes the cognitive overhead.
        this._heightTrimRow.classList.toggle('olv-hidden', mode !== 'elevation');
      });
      this._chips.append(chip);
    }
    // Surface the gate reason in the flow (visible on touch, where the chip's
    // hover-only `title` never appears).
    this._chipsNote.textContent = anyGatedDisabled
      ? `${COVERAGE_DISABLED_TITLE} to enable Coverage and Confidence.`
      : '';
    this._chipsNote.classList.toggle('olv-hidden', !anyGatedDisabled);
    // Initial visibility for the trim row — track the active mode.
    this._heightTrimRow.classList.toggle('olv-hidden', this._activeMode !== 'elevation');
  }

  /**
   * Visuals Studio — reflect the Viewer's Visuals Studio state in the
   * chip rails + advanced sliders. Called on session restore, public-API
   * presets, and any external change so the UI never drifts from the
   * underlying renderer state.
   */
  syncVisuals(state: VisualsStudioState): void {
    for (const chip of this._visualsRgbRail.children) {
      const id = (chip as HTMLElement).dataset?.presetId;
      chip.classList.toggle('olv-chip-active', id === state.rgbAppearancePresetId);
    }
    for (const chip of this._visualsEdlRail.children) {
      const id = (chip as HTMLElement).dataset?.presetId;
      const wanted = state.edlPresetId === null ? 'off' : state.edlPresetId;
      chip.classList.toggle('olv-chip-active', id === wanted);
    }
    for (const chip of this._visualsSkyRail.children) {
      const id = (chip as HTMLElement).dataset?.presetId;
      chip.classList.toggle('olv-chip-active', id === state.skyPresetId);
    }
    // Workflow rail (v0.4.5): light the matched preset, or the "Custom"
    // state chip when the knobs match none. An absent/null field clears all.
    // aria-pressed mirrors the class so the active pill is announced, not
    // just coloured.
    for (const chip of this._visualsWorkflowRail.children) {
      const id = (chip as HTMLElement).dataset?.presetId;
      const active = state.workflowPresetId != null && id === state.workflowPresetId;
      chip.classList.toggle('olv-chip-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
    this._wbTemperatureSlider.value = String(Math.round(state.temperature * 100));
    this._wbTintSlider.value = String(Math.round(state.tint * 100));
  }

  /**
   * Show / hide the Advanced disclosure (Temperature, Tint, Auto-
   * balance). The host calls this with `true` after a streaming COPC
   * cloud attaches, and `false` after detach or when only a local LAZ
   * is loaded. The disclosure body stays in the DOM tree — only its
   * visibility flips so the open/closed state is preserved across
   * cloud swaps.
   */
  setAdvancedWbVisible(visible: boolean): void {
    if (!this._wbAdvancedDetails) return;
    this._wbAdvancedDetails.classList.toggle('olv-hidden', !visible);
  }

  /** Reflect the viewer's current render-quality state in the controls. */
  syncRendering(state: RenderingState): void {
    this._pointSizeSlider.value = String(state.pointSize);
    this._pointSizeValue.textContent = `${state.pointSize.toFixed(1)} px`;
    this._edlChip.classList.toggle('olv-chip-active', state.edlEnabled);
    this._edlStrengthRow.classList.toggle('olv-hidden', !state.edlEnabled);
    this._edlStrengthSlider.value = String(state.edlStrength);
    this._aaChip.classList.toggle('olv-chip-active', state.antialiasing);
    this._touchChip.classList.toggle('olv-chip-active', state.twoFingerTwistEnabled);
    for (const c of this._sizeModeChips) {
      c.chip.classList.toggle('olv-chip-active', c.mode === state.pointSizeMode);
    }
    for (const chip of this._visualsSplatRail.children) {
      const id = (chip as HTMLElement).dataset?.presetId;
      chip.classList.toggle('olv-chip-active', id === state.splatMode);
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
    const sourceStd: AnalysisRow[] = [];
    const sourceExt: AnalysisRow[] = [];
    for (const row of rows) {
      if (row.group === 'src-std') sourceStd.push(row);
      else if (row.group === 'src-ext') sourceExt.push(row);
      else if (row.advanced) advanced.push(row);
      else this._report.append(this._reportRow(row));
    }
    // Shared collapsible builder for the Advanced report and the declared
    // Source metadata sections.
    const fold = (title: string, children: (HTMLElement | string)[]): void => {
      this._report.append(
        el('details', { className: 'olv-advanced' }, [
          el('summary', { className: 'olv-advanced-summary', text: title }),
          el('div', { className: 'olv-advanced-body' }, children),
        ]),
      );
    };
    if (advanced.length > 0) {
      fold('Advanced report', advanced.map((row) => this._reportRow(row)));
    }
    // Declared source metadata — rendered only when the file declared
    // something. Values are verbatim declarations; the disclosure line keeps
    // the honesty boundary explicit ("declared, not verified").
    if (sourceStd.length > 0 || sourceExt.length > 0) {
      const children: HTMLElement[] = [
        el('div', {
          className: 'olv-report-empty',
          text: 'Declared by the file, not verified by OpenLiDARViewer.',
        }),
        ...sourceStd.map((row) => this._reportRow(row, true)),
      ];
      if (sourceExt.length > 0) {
        children.push(
          el('div', {
            className: 'olv-advanced-summary',
            text: 'Extended metadata (file-declared)',
          }),
          ...sourceExt.map((row) => this._reportRow(row, true)),
        );
      }
      fold('Source metadata', children);
    }
  }

  /**
   * Build a single status / label / value report row. `truncate` clips long
   * declared-metadata values for display, keeping the verbatim value one
   * hover away in the tooltip.
   */
  private _reportRow(row: AnalysisRow, truncate = false): HTMLElement {
    // Honesty stamp — when a metric was computed under a class filter (subset)
    // or is a header figure that can't be class-scoped (notScoped sentinel),
    // append the scope provenance after the value so no filtered readout is
    // shown unqualified. A full / absent scope yields an empty stamp and the
    // row renders exactly as it did before class scoping existed.
    const stamp = row.scope ? scopeStamp(row.scope, classificationLabel) : '';
    // Truncated declared values keep the verbatim text in the tooltip.
    const valueProps: Parameters<typeof el>[1] = { className: 'olv-report-value' };
    let shown = row.value;
    if (truncate && shown.length > 96) {
      valueProps.title = shown;
      shown = `${shown.slice(0, 96)}…`;
    }
    const valueChildren: (HTMLElement | string)[] = [shown];
    if (stamp) {
      valueChildren.push(
        el('span', {
          className: 'olv-report-scope',
          text: ` · ${stamp}`,
          title: 'Class scope this metric was computed under',
        }),
      );
    }
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
      el('span', valueProps, valueChildren),
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
    // v0.3.10 trust-pass — scan-close used to leave the Dataset
    // Intelligence card showing the previous scan's intel (density
    // bucket, coverage band, metric stability). Empty-state reset
    // should drop the card back to its hidden state so a fresh
    // load doesn't briefly flash stale numbers between paint and
    // the new cheap-summary push.
    this._datasetIntelligence.clear();
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
   * Push a fresh Dataset Intelligence summary into the card. Callers
   * compute the inputs from the Terrain Engine / Foundation outputs;
   * the card itself does no analysis.
   */
  setDatasetIntelligence(input: DatasetIntelligenceInput): void {
    this._datasetIntelligence.update(input);
  }

  /** Drop the Dataset Intelligence card back to its empty state. */
  clearDatasetIntelligence(): void {
    this._datasetIntelligence.clear();
  }

  /**
   * The Dataset Intelligence summary currently on the card, or null when the
   * card is empty. Read by the Terrain Intelligence Report (v0.4.5) so the
   * PDF's bucket labels are the card's own strings — never re-derived.
   */
  get datasetIntelligence(): DatasetIntelligence | null {
    return this._datasetIntelligence.current;
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

    // Privacy footer + Reset link. Confirms with the styled modal (not
    // window.confirm, which embedded WebViews can suppress) so a misclick
    // never wipes history.
    const reset = el('button', {
      className: 'olv-stats-reset',
      type: 'button',
      text: 'Reset',
      title: 'Clear every counter on this device. This cannot be undone.',
    });
    reset.addEventListener('click', () => {
      void openConfirm({
        title: 'Reset session stats?',
        message: 'Reset every session stat? This cannot be undone.',
        confirmLabel: 'Reset',
        returnFocusTo: reset,
      }).then((ok) => {
        if (!ok) return;
        resetUsage();
        this._refreshSessionStats();
      });
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
