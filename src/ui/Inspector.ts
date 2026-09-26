import { el, iconButton, formatCount } from './dom';
import {
  renderStreamingDetail,
  clearStreamingDetail,
  type StreamingDetail,
} from './streamingDetail';
import { collapsibleSection } from './collapsibleSection';
import { loadInspectorSections, saveInspectorSection } from '../prefs';
import type { LayerGroupsPanel } from './LayerGroupsPanel';
import type { SessionLayerGroup } from '../io/session';
import {
  compatibilityNote,
  type LayerCompatibility,
} from '../model/layerCompatibility';
import { openConfirm } from './Modal';
import { announcePolite } from './politeAnnounce';
import { DatasetIntelligenceCard } from './DatasetIntelligenceCard';
import {
  loadLayerHealthCard,
  loadLayerGroupsPanel,
  loadRenderCrs,
  loadRenderProvenance,
  loadRenderReport,
} from '../lazyChunks';
import type { LayerHealthCard } from './LayerHealthCard';
import type {
  DatasetIntelligence,
  DatasetIntelligenceInput,
} from '../terrain/datasetIntelligence';
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { CrsOverride } from './inspector/renderCrs';
import type { ProvenanceCardModel } from '../render/scanCapability';
import type { ColorMode } from '../render/colorModes';
import {
  buildColorChipModel,
  buildColorChipNote,
  COVERAGE_DISABLED_TITLE,
  ANALYSIS_GATED_MODES,
} from './colorChipModel';
import type { PointSizeMode } from '../render/pointStyle';
import {
  navPresetSigns,
  DEFAULT_NAVIGATION_PREFERENCES,
  type NavigationPreferences,
  type NavigationPreset,
} from '../render/navPrefs';
import { EDL_DEFAULTS, EDL_STRENGTH_RANGE } from '../render/edl';
import type { EdlPresetId } from '../render/edlPresets';
import type { SplatMode } from '../render/splatShader';
import {
  snapshot as snapshotUsage,
  reset as resetUsage,
  describeCounter,
  isSuppressed as usageIsSuppressed,
} from '../diagnostics/usageCounters';
import type { ProvenanceFingerprint, CaptureType } from '../diagnostics/provenance';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
// Workflow presets (v0.4.5) — pure table; the rail renders it, main.ts
// applies it through the Viewer's existing setters.
import {
  listTerrainWorkflowPresets,
  type TerrainWorkflowPresetId,
} from '../render/terrainWorkflowPresets';

/** An EDL preset id, or `null` for "off". */
type EdlPresetSelection = EdlPresetId | null;

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
  splatMode: SplatMode;
}

export interface InspectorCallbacks {
  /** Open the add-a-dataset picker. Optional so a host without ingest omits it. */
  onAddDataset?: () => void;
  onColorMode: (mode: ColorMode) => void;
  /**
   * v0.3.7 final-polish — symmetric height percentile trim.
   * `trim = 5` clips to the 5 / 95 band (default), `trim = 0` uses
   * true min/max, `trim = 25` uses the 25 / 75 band for a very
   * dramatic gradient on field-only scans.
   */
  onHeightPercentileTrim: (trim: number) => void;
  /**
   * Project-shared elevation scale: `true` colours every frame-sharing layer
   * against one world-Z window (identical heights read identically), `false`
   * restores per-cloud windows. Only surfaced with ≥2 frame-sharing clouds.
   */
  onProjectSharedElevation?: (on: boolean) => void;
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
   * Orbit-handedness change (invert vertical / horizontal, preset, or reset).
   * The flags are the source of truth; the preset is a convenience setter.
   * main.ts applies it to the viewer and persists it through `prefs.navigation`.
   */
  onNavigationPrefsChange: (prefs: NavigationPreferences) => void;
  /**
   * Visuals Studio chip rails + Advanced sliders.
   *
   * Each callback maps a single chip / slider click to the Viewer's
   * matching setter. `main.ts` wires them through; the Inspector keeps
   * the highlight state in sync via `syncVisuals(state)` so an external
   * preset change (session restore, public API call) reflects in the UI.
   */
  onRgbAppearancePreset: (id: string) => void;
  onEdlPreset: (id: EdlPresetSelection) => void;
  onSkyPreset: (id: string) => void;
  /** Advanced (streaming COPC only) — white-balance sliders. */
  onWhiteBalance: (temperature: number, tint: number) => void;
  /** Advanced (streaming COPC only) — auto-balance button. */
  onAutoBalance: () => void;
  /** Rendering > Splat mode chip rail. */
  onSplatMode: (id: SplatMode) => void;
  /**
   * Visuals Studio > Workflow chip rail (v0.4.5) — apply a terrain workflow
   * preset (Terrain / Construction / Mining / Forestry / Hydrology /
   * Archaeology). A pure bundle over existing knobs; main.ts fans it out to
   * the Viewer's setters and re-syncs.
   */
  onTerrainWorkflowPreset: (id: TerrainWorkflowPresetId) => void;
  /** Open the Dataset Story modal (reuses the command-palette `story.dataset` action). */
  onOpenDatasetStory?: () => void;
}

const MODE_LABELS: Record<ColorMode, string> = {
  rgb: 'RGB',
  intensity: 'Intensity',
  elevation: 'Height',
  classification: 'Class',
  normal: 'Normal',
  density: 'Density',
  gpsTime: 'GPS time',
  returnNumber: 'Return',
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
  density: 'Colour points by local point density of the loaded sample — dark = sparse, bright = dense',
  gpsTime: 'Colour points by GPS acquisition time — dark early, bright late (Cividis)',
  returnNumber: 'Colour points by return number — dark first return, bright last (Cividis)',
  coverage:
    'Colour points by bare-earth trust — green strong (measured), yellow ' +
    'moderate (interpolated), red weak (extrapolated/gap). Approximate.',
  confidence:
    'Colour points by bare-earth trust on the colourblind-safe Cividis ramp — ' +
    'bright strong (measured), mid moderate (interpolated), dark weak ' +
    '(extrapolated/gap). Same buckets as Coverage. Approximate.',
};


/**
 * Visuals Studio — Visuals Studio state the Inspector keeps in sync
 * with the Viewer. When the active preset changes (chip click, session
 * restore, or public-API call) the Inspector flips the matching chip
 * highlight.
 */
export interface VisualsStudioState {
  readonly rgbAppearancePresetId: string | null;
  readonly edlPresetId: EdlPresetSelection;
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
  id: EdlPresetSelection;
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
  id: SplatMode;
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

/**
 * Route a message to the app's single polite live region (see
 * politeAnnounce.ts). A no-op where `document.querySelector` doesn't exist —
 * this file's unit-test DOM stubs cover only the element surface the panel
 * touches, not a full document.
 */
function announce(message: string): void {
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    announcePolite(message);
  }
}

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

/** A built range-filter section (elevation or intensity) plus its seed hook. */
interface RangeFilter {
  /** The `<section>` to mount in the panel. Hidden until an extent is seeded. */
  readonly section: HTMLElement;
  /**
   * Seed the Min/Max inputs from the data extent and reveal the section; pass
   * null to hide it (no cloud, or no channel). Clears the active-state cue.
   */
  setExtent(ext: { min: number; max: number } | null): void;
  /**
   * Restore a saved window (from a session): write it into the inputs and
   * re-run the apply path (fires `onApply`, refreshes the active cue). Null
   * reseeds to the full extent and clears the filter.
   */
  applyWindow(range: readonly [number, number] | null): void;
}

/**
 * Build one Min/Max range-filter section — the shared body behind the
 * elevation and intensity filters (v0.5.6). Owns the two numeric inputs, the
 * "Show all" reset, Enter-to-confirm, and the "· filtering" active-state cue
 * (shown only when the window is narrower than the seeded extent). `onApply`
 * receives the window `[min, max]`, or null when the user clears it.
 */
function buildRangeFilter(opts: {
  title: string;
  /** Optional one-line note under the fields naming what the seeded bounds are. */
  caption?: string;
  /** Noun for the input aria-labels, e.g. 'elevation' or 'intensity'. */
  unit: string;
  resetTitle: string;
  onApply: (range: [number, number] | null) => void;
}): RangeFilter {
  let extent: { min: number; max: number } | null = null;
  const mkInput = (bound: string): HTMLInputElement => {
    const i = el('input', { type: 'number', className: 'olv-elev-input' }) as HTMLInputElement;
    i.step = 'any';
    i.setAttribute('aria-label', `${bound} ${opts.unit}`);
    return i;
  };
  const minInput = mkInput('Minimum');
  const maxInput = mkInput('Maximum');
  const reset = el('button', { className: 'olv-elev-reset', text: 'Show all' });
  reset.setAttribute('type', 'button');
  reset.setAttribute('title', opts.resetTitle);
  const body = el('div', { className: 'olv-elev-body' }, [
    el('div', { className: 'olv-elev-row' }, [
      el('span', { className: 'olv-elev-cap', text: 'Min' }),
      minInput,
      el('span', { className: 'olv-elev-cap', text: 'Max' }),
      maxInput,
    ]),
    ...(opts.caption ? [el('p', { className: 'olv-chips-note', text: opts.caption })] : []),
    reset,
  ]);
  const sectionEl = section(opts.title, body);
  sectionEl.classList.add('olv-hidden');

  // Read a numeric field, or null when it's empty/blank. `Number('')` is 0
  // (and `Number.isFinite(0)` is true), so without the empty-string guard,
  // clearing a field to retype would momentarily apply a bogus `0` bound and
  // filter the scan to a sliver. Null means "no valid value yet" — leave the
  // current window untouched until both fields hold real numbers.
  const readField = (v: string): number | null => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const apply = (): void => {
    const lo = readField(minInput.value);
    const hi = readField(maxInput.value);
    if (lo === null || hi === null) return;
    opts.onApply([lo, hi]);
    // Flag "filtering" only when the window is narrower than the full extent —
    // a full-range window hides nothing, so it shouldn't read as active.
    sectionEl.classList.toggle('olv-filter-active', narrowsExtent(lo, hi, extent));
  };
  minInput.addEventListener('input', apply);
  maxInput.addEventListener('input', apply);
  enterConfirms(minInput);
  enterConfirms(maxInput);
  reset.addEventListener('click', () => {
    if (extent) {
      minInput.value = String(Math.floor(extent.min));
      maxInput.value = String(Math.ceil(extent.max));
    }
    opts.onApply(null);
    sectionEl.classList.remove('olv-filter-active');
  });

  return {
    section: sectionEl,
    setExtent(ext): void {
      // Only act when the extent actually CHANGES — a new (or first) scan.
      // Re-seeding with the same extent is a no-op so a streaming extent that
      // re-reports the same range can't stomp the user's current window.
      const changed =
        !extent || !ext || extent.min !== ext.min || extent.max !== ext.max;
      extent = ext;
      if (!ext || !Number.isFinite(ext.min) || !Number.isFinite(ext.max)) {
        sectionEl.classList.add('olv-hidden');
        // No usable extent ⇒ no scan to filter: clear any live GPU filter so the
        // renderer can't keep applying a stale window from a previous scan.
        if (changed) opts.onApply(null);
        return;
      }
      if (!changed) return;
      minInput.value = String(Math.floor(ext.min));
      maxInput.value = String(Math.ceil(ext.max));
      // A fresh seed is the full extent — visible, nothing filtered yet. Clear
      // any filter carried over from a previous scan so the reset fields and the
      // renderer agree (the "reseed leaves the old GPU filter active" bug).
      sectionEl.classList.remove('olv-hidden', 'olv-filter-active');
      opts.onApply(null);
    },
    applyWindow(range): void {
      if (range) {
        minInput.value = String(range[0]);
        maxInput.value = String(range[1]);
        apply();
      } else {
        if (extent) {
          minInput.value = String(Math.floor(extent.min));
          maxInput.value = String(Math.ceil(extent.max));
        }
        opts.onApply(null);
        sectionEl.classList.remove('olv-filter-active');
      }
    },
  };
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
 * point-size slider, the Detail readout, the Scan Report, and saved camera
 * views. The exports live in the Output panel.
 */
/**
 * Whether removing ONE layer closes the scan rather than dropping a layer.
 *
 * The distinction matters because the two are not the same action. Dropping a
 * layer from a multi-layer scene is reversible by reopening the file. The LAST
 * removal falls through to `resetToEmptyState` in main.ts, which also clears
 * placed measurements, saved views and annotations, and `MeasureController.clear()`
 * takes no snapshot, so the measurements are gone with no undo.
 *
 * Exported as a plain predicate so the rule can be read and tested without a
 * DOM, in the same shape as `shouldResetSavedWork` in the load path.
 */
export function removalClosesScan(layerCount: number): boolean {
  return layerCount <= 1;
}

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
  private readonly _sheetHead!: HTMLElement;
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
  private readonly _wbAdvancedDetails: HTMLDetailsElement | null = null;
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
  /**
   * Project-shared elevation toggle. Hidden unless colouring BY elevation AND
   * ≥2 layers share the project frame (`_projectScaleAvailable`).
   */
  private _projectScaleAvailable = false;
  private readonly _projectScaleRow = el('label', {
    className: 'olv-project-scale-row olv-hidden',
    title:
      'Colour every layer that shares the project frame against one shared ' +
      'height window, so the same world height reads the same colour across ' +
      'layers. Off colours each layer against its own range.',
  });
  private readonly _projectScaleCheckbox = el('input', {
    type: 'checkbox',
  }) as HTMLInputElement;
  // Range filters (v0.5.6) — an elevation (world-unit height) filter and an
  // intensity (raw-unit) filter, both built from the shared `buildRangeFilter`
  // so the DOM, the active-state cue, and the seed/reset logic live once.
  private readonly _elevFilter!: RangeFilter;
  private readonly _intenFilter!: RangeFilter;
  private readonly _detail = el('div', { className: 'olv-detail' });
  private readonly _report = el('div', { className: 'olv-report' });
  // Captured section refs — `setStreamingMode` toggles their visibility so
  // the static-cloud-only sections drop out when a streaming COPC / EPT is
  // active and their streaming-equivalents in StreamingPanel take over.
  private readonly _layersSection!: HTMLElement;
  private readonly _colorBySection!: HTMLElement;
  /** Stored open/closed state for the persisted collapsible sections. */
  private readonly _sectionState: Record<string, boolean> = loadInspectorSections();
  private readonly _renderingSection!: HTMLElement;
  private readonly _viewList = el('div', { className: 'olv-views' });
  /** Session-stats body — rebuilt lazily when the details section opens. */
  private readonly _sessionStatsBody: HTMLElement;
  /** Dataset Intelligence card — surfaced under the title, above Layers. */
  private readonly _datasetIntelligence: DatasetIntelligenceCard;
  /** Layer health card — per-layer spatial facts, under the Layers list.
   * Lazy (lazyChunks): the class and its wording load on first data. */
  private _layerHealth: LayerHealthCard | null = null;
  private readonly _layerHealthSlot: HTMLElement;
  private _layerHealthPending: Parameters<LayerHealthCard['update']> | null = null;
  /** Provenance fingerprint body — populated by setProvenance(). */
  private readonly _provenanceBody: HTMLElement;
  /**
   * Declared-by-the-file profile / provenance card (v0.5.7), rendered above the
   * classifier fingerprint. Populated by setDeclaredProvenance(); hidden until a
   * scan with a recognised display profile or an olv: provenance block loads.
   */
  private readonly _declaredProvenanceBody: HTMLElement;
  /** Caller registers this to be told when the user overrides the type. */
  private _onProvenanceOverride: ((type: CaptureType) => void) | null = null;
  /**
   * The lazy `renderProvenance` chunk, once loaded (module functions carry no
   * state, so this is cached across every `setProvenance()` call — the
   * dynamic import only ever runs once).
   */
  private _renderProvenanceFn:
    | ((body: HTMLElement, f: ProvenanceFingerprint, onOverride: (type: CaptureType) => void) => void)
    | null = null;
  /** In-flight import of the Provenance chunk, so a fast double scan-open dedupes. */
  private _provenanceChunkPromise: Promise<typeof this._renderProvenanceFn> | null = null;
  /** CRS section body — populated by setCrs(). */
  private readonly _crsBody: HTMLElement;
  /** The whole Coordinate-system collapsible — hidden for local-frame profiles. */
  private readonly _crsSection: HTMLElement | null = null;
  /** Caller registers this to react to user CRS overrides. */
  private _onCrsOverride: ((override: CrsOverride) => void) | null = null;
  /** The lazy `renderCrs` chunk, once loaded — see `_renderProvenanceFn`. */
  private _renderCrsFn:
    | ((body: HTMLElement, c: ResolvedCrs, onOverride: (override: CrsOverride) => void) => void)
    | null = null;
  /** In-flight import of the CRS chunk. */
  private _crsChunkPromise: Promise<typeof this._renderCrsFn> | null = null;
  /** The last CRS handed to setCrs(), for latest-wins and for the retry caption. */
  private _pendingCrs: ResolvedCrs | null = null;
  /** Set by focusCrsOverride() when the override control isn't rendered yet. */
  private _focusCrsOverrideOnHydrate = false;
  /** The last fingerprint handed to setProvenance(), for latest-wins and retry. */
  private _pendingProvenanceForChunk: ProvenanceFingerprint | null = null;
  /** The lazy `renderReport` chunk, once loaded. */
  private _renderReportFn: ((container: HTMLElement, rows: AnalysisRow[]) => void) | null = null;
  /** In-flight import of the Report chunk. */
  private _reportChunkPromise: Promise<typeof this._renderReportFn> | null = null;
  /** The last rows handed to setReport(), for latest-wins and retry. */
  private _pendingReportRows: AnalysisRow[] | null = null;
  /** The latest setReport() argument, rows or a pending computation. */
  private _reportSource: unknown = null;
  private readonly _layerRows = new Map<string, HTMLElement>();
  /** Per-layer facts the group panel reads: display name and stable identity. */
  private readonly _layerFacts = new Map<string, { name: string; stableId: string | null }>();
  /**
   * Each row's show/hide checkbox. It is the panel's rendering of the layer's
   * INTENT — the same value `LayerService.setVisible` records — so a group
   * header can roll its members up without a second store of visibility.
   */
  private readonly _layerVisibleBoxes = new Map<string, HTMLInputElement>();
  /**
   * Group rows over the layer list, lazily loaded (`ui/LayerGroupsPanel.ts`).
   * Null until the user makes a group or a session restores one; while it is
   * null there is no group state at all and the rows are the flat list they
   * have always been.
   */
  private _groups: LayerGroupsPanel | null = null;
  /** The "New group" control — eager, so grouping is discoverable at first paint. */
  private readonly _groupBar: HTMLElement;
  /** Visible "couldn't load groups" caption — hidden except right after a
   *  failed chunk load, so the failure is not only a console.warn. */
  private readonly _groupLoadError: HTMLElement;
  /** An arrangement restored before the chunk landed, applied when it does. */
  private _groupsPending: readonly SessionLayerGroup[] | null = null;

  /** The in-flight `_ensureGroups()` promise, so a second click before it
   *  resolves reuses it instead of starting a second dynamic import. */
  private _groupsPromise: Promise<LayerGroupsPanel | null> | null = null;
  /** Lazily-created one-line CRS-mismatch note under the layer list. */
  private _layerNote: HTMLElement | null = null;
  /** Lazily-created two-epoch compare button + result, shown with exactly 2 layers. */
  private _compareBtn: HTMLButtonElement | null = null;
  private _compareResult: HTMLElement | null = null;
  private _diffBtn: HTMLButtonElement | null = null;
  // ── Rendering controls ──
  private readonly _pointSizeSlider: HTMLInputElement;
  private readonly _pointSizeValue: HTMLElement;
  private readonly _edlChip: HTMLButtonElement;
  private readonly _edlStrengthSlider: HTMLInputElement;
  private readonly _edlStrengthRow: HTMLElement;
  private readonly _aaChip: HTMLButtonElement;
  private readonly _touchChip: HTMLButtonElement;
  private readonly _sizeModeChips: { mode: PointSizeMode; chip: HTMLButtonElement }[];
  // ── Navigation controls (orbit invert X / Y + preset) ──
  private readonly _navInvertYChip: HTMLButtonElement;
  private readonly _navInvertXChip: HTMLButtonElement;
  private readonly _navPresetSelect: HTMLSelectElement;
  /** Live copy of the navigation prefs the chips reflect; the flags are the
   *  behavioural source of truth, the preset a convenience label. */
  private _navPrefs: NavigationPreferences = { ...DEFAULT_NAVIGATION_PREFERENCES };

  constructor(callbacks: InspectorCallbacks) {
    this._cb = callbacks;

    // The "New group" control. The panel behind it loads on the first click, so
    // grouping is discoverable from the start without the startup shell paying
    // for a feature that is opt-in and has no default group.
    const newGroup = el('button', {
      className: 'olv-group-new',
      type: 'button',
      text: '+ New group',
      title: 'Collect layers into a named, collapsible group',
    });
    this._groupLoadError = el('p', { className: 'olv-group-load-error olv-hidden' });
    let creatingGroup = false;
    newGroup.addEventListener('click', () => {
      // `creatingGroup` guards a fast double-click from reaching this twice
      // before the first import settles: a real browser also stops firing
      // click on a disabled button, but this flag makes the guard explicit
      // rather than resting on that. Reusing one instance for both clicks
      // used to create two groups from one action (both `.then` callbacks
      // running createGroup() once the shared import resolved).
      if (creatingGroup) return;
      creatingGroup = true;
      newGroup.disabled = true;
      newGroup.setAttribute('aria-busy', 'true');
      const label = newGroup.textContent;
      newGroup.textContent = 'Adding group…';
      this._groupLoadError.classList.add('olv-hidden');
      void this._ensureGroups()
        .then((groups) => {
          if (groups) {
            groups.createGroup();
            return;
          }
          // The chunk failed to load — _ensureGroups already logged it;
          // surface it here too so the click was not silently a no-op.
          this._groupLoadError.textContent =
            'Could not load layer groups. Click "+ New group" to try again.';
          this._groupLoadError.classList.remove('olv-hidden');
          announce('Could not load layer groups.');
        })
        .finally(() => {
          creatingGroup = false;
          newGroup.disabled = false;
          newGroup.removeAttribute('aria-busy');
          newGroup.textContent = label;
        });
    });
    // "+ Add dataset" belongs to Layers, which is what it adds to. It used to
    // float over the canvas at bottom-left, where the tool dock sits one pixel
    // away with a higher z-index and covered it: the control was revealed
    // exactly when a scan loaded, which is exactly when the dock appeared, so
    // it was unreachable for the whole of its visible life.
    const addDataset = el('button', {
      className: 'olv-group-new olv-add-dataset-row',
      type: 'button',
      text: '+ Add dataset',
      title: 'Open another point-cloud file — it mounts alongside the current scan',
    });
    addDataset.addEventListener('click', () => this._cb.onAddDataset?.());
    this._groupBar = el('div', { className: 'olv-group-bar' }, [addDataset, newGroup]);

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

    const sizeModeLabel: Record<PointSizeMode, string> = {
      adaptive: 'Adaptive',
      fixed: 'Fixed',
      density: 'Density',
    };
    const sizeModeTitle: Record<PointSizeMode, string> = {
      adaptive: 'Points scale with camera distance — far points stay visible, near ones do not bloat',
      fixed: 'Every point keeps a constant on-screen size',
      density: 'Sparse areas get larger points and dense areas smaller ones, so thin regions read clearly — a display aid, not a measurement',
    };
    this._sizeModeChips = (['adaptive', 'fixed', 'density'] as PointSizeMode[]).map((mode) => {
      const chip = el('button', {
        // `olv-size-chip` disambiguates from the colour-mode chip that also
        // reads "Density" (the heatmap), for both CSS and test targeting.
        className: 'olv-chip olv-size-chip',
        type: 'button',
        text: sizeModeLabel[mode],
        title: sizeModeTitle[mode],
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

    // Navigation: independent invert of the vertical / horizontal orbit, plus
    // presets. Hand-toggling an axis keeps whatever preset was selected — the
    // flags win — so we spread the live prefs and flip only the one axis.
    this._navInvertYChip = toggleChip(
      'Invert vertical orbit',
      'Flip the up / down orbit direction — the common "feels inverted vs CAD" fix',
      (on) => {
        this._navPrefs = { ...this._navPrefs, invertOrbitY: on };
        this._cb.onNavigationPrefsChange(this._navPrefs);
      },
    );
    this._navInvertXChip = toggleChip(
      'Invert horizontal orbit',
      'Flip the left / right orbit direction',
      (on) => {
        this._navPrefs = { ...this._navPrefs, invertOrbitX: on };
        this._cb.onNavigationPrefsChange(this._navPrefs);
      },
    );
    this._navPresetSelect = el('select', {
      className: 'olv-report-select',
      ariaLabel: 'Navigation preset',
      tip: 'Choose how dragging orbits the view. A preset sets both orbit direction options.',
    }) as HTMLSelectElement;
    for (const [value, label] of [
      ['default', 'Default'],
      ['invert-vertical', 'Inverted vertical'],
      ['no-invert', 'No inversion'],
    ] as const) {
      const option = el('option', { text: label });
      option.value = value;
      this._navPresetSelect.append(option);
    }
    // Selecting a preset writes both invert flags from the pure sign table and
    // records the preset; the chips then reflect the new flags.
    this._navPresetSelect.addEventListener('change', () => {
      const preset = this._navPresetSelect.value as NavigationPreset;
      const signs = navPresetSigns(preset);
      this._navPrefs = { invertOrbitX: signs.invertOrbitX, invertOrbitY: signs.invertOrbitY, preset };
      this._syncNavChips();
      this._cb.onNavigationPrefsChange(this._navPrefs);
    });
    // "Reset to defaults" — NavBar already owns "Reset" for camera framing, so
    // this label is distinct. Confirms through the styled modal (embedded
    // WebViews suppress window.confirm) so a misclick never flips handedness.
    const navReset = el('button', {
      className: 'olv-stats-reset',
      type: 'button',
      text: 'Reset to defaults',
      title: 'Return orbit navigation to the shipped defaults',
    });
    navReset.addEventListener('click', () => {
      void openConfirm({
        title: 'Reset navigation?',
        message: 'Return orbit navigation to the shipped defaults?',
        confirmLabel: 'Reset to defaults',
        returnFocusTo: navReset,
      }).then((ok) => {
        if (!ok) return;
        this._navPrefs = { ...DEFAULT_NAVIGATION_PREFERENCES };
        this._syncNavChips();
        this._navPresetSelect.value = this._navPrefs.preset;
        this._cb.onNavigationPrefsChange(this._navPrefs);
      });
    });
    const navigationGroup = el('div', { className: 'olv-render-group' }, [
      el('div', { className: 'olv-render-sublabel', text: 'Navigation' }),
      el('div', { className: 'olv-chips' }, [this._navInvertYChip, this._navInvertXChip]),
      el('div', { className: 'olv-navpref-row' }, [
        el('span', { className: 'olv-render-label', text: 'Preset' }),
        this._navPresetSelect,
      ]),
      el('div', { className: 'olv-navpref-row' }, [navReset]),
    ]);

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
      navigationGroup,
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


    // The header carries the panel title and — on phones, where the panel is
    // a bottom sheet — a close control. The close handler stops propagation
    // so the head's own tap-to-toggle listener (wired below) doesn't fire a
    // second toggle and immediately re-open the sheet.
    const sheetClose = el('button', {
      className: 'olv-sheet-close',
      text: '×',
      ariaLabel: 'Close scan info',
      tip: 'Close scan info.',
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
    const head = el('div', {
      className: 'olv-panel-head',
      tip: 'Tap to expand or collapse the scan info panel.',
    }, [
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
    // Declared-by-the-file card sits above the classifier fingerprint, in the
    // same collapsible Provenance section. Kept a sibling of `_provenanceBody`
    // so the fingerprint's own render (`_renderProvenance`) is untouched.
    this._declaredProvenanceBody = el('div', { className: 'olv-declared-prov olv-hidden' });

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
    // are loaded once and re-read on demand, and Saved views starts
    // empty. First-paint cognitive load drops by ~60% without removing
    // any feature.
    // Per-section refs — captured so `setStreamingMode` can hide the
    // static-cloud-only sections during streaming (the StreamingPanel
    // owns the streaming-equivalents: streaming color modes, quality
    // control, saved views are mirrored there). The kept sections —
    // Detail, Provenance, Coordinate system, Scan report — work
    // uniformly against either source type.
    this._layersSection = section('Layers', this._layers);
    // The workspace re-parents this node into the Data mode, where it is a
    // top-level rail child with nothing painted behind it; the class is what
    // gives it a surface there. Inert inside the Inspector's own panel.
    this._layersSection.classList.add('olv-layers-section');
    // The group control sits above the rows, so "New group" is reachable
    // whether or not any group exists yet.
    this._layersSection.insertBefore(this._groupBar, this._layers);
    this._layersSection.insertBefore(this._groupLoadError, this._layers);
    // Height percentile-trim row, mounted inside "Color by" beneath the chip
    // rail and shown only while colouring BY elevation. It clips the top/bottom
    // N% of heights from the COLOUR RAMP so tall outliers (a bird, a mast) don't
    // wash out the gradient — it recolours, it does NOT hide points. Labelled
    // "Colour trim" and tooltip'd to keep it distinct from the Elevation filter
    // below, which is what actually hides points.
    this._heightTrimRow.title =
      'Clips the top and bottom of the elevation colour ramp (sets the colourbar ' +
      'window) so outliers don’t wash out the gradient. This only affects colour — ' +
      'to hide points by height, use the Elevation filter.';
    this._heightTrimSlider.setAttribute('aria-label', 'Elevation colour-ramp trim (percent)');
    this._heightTrimRow.replaceChildren(
      el('span', {
        className: 'olv-height-trim-name',
        text: 'Colour trim',
        title: 'Sets the colourbar window',
      }),
      this._heightTrimSlider,
      this._heightTrimLabel,
    );
    this._heightTrimSlider.addEventListener('input', () => {
      const trim = Number.parseInt(this._heightTrimSlider.value, 10);
      const safe = Number.isFinite(trim) ? trim : 5;
      this._heightTrimLabel.textContent = `${safe}%`;
      this._cb.onHeightPercentileTrim(safe);
    });
    this._projectScaleCheckbox.setAttribute('aria-label', 'Project-shared elevation scale');
    this._projectScaleRow.replaceChildren(
      this._projectScaleCheckbox,
      el('span', { className: 'olv-height-trim-name', text: 'Project elevation scale' }),
    );
    this._projectScaleCheckbox.addEventListener('change', () => {
      this._cb.onProjectSharedElevation?.(this._projectScaleCheckbox.checked);
    });
    const colorByBody = el('div', { className: 'olv-color-by-body' }, [
      this._chips,
      this._chipsNote,
      this._heightTrimRow,
      this._projectScaleRow,
    ]);
    this._colorBySection = section('Color by', colorByBody);

    // Range filters (v0.5.6): elevation (world-unit height) and intensity
    // (raw units). Both hide points outside the window and share one builder.
    const resetTitle = 'Clear the filter and show every point in this scan';
    this._elevFilter = buildRangeFilter({
      title: 'Elevation filter',
      caption: 'Loaded sample extent; colour window is trimmed separately (Colour trim).',
      unit: 'elevation',
      resetTitle,
      onApply: (r) => this._cb.onElevationFilter?.(r),
    });
    this._intenFilter = buildRangeFilter({
      title: 'Intensity filter (loaded sample range)',
      unit: 'intensity',
      resetTitle,
      onApply: (r) => this._cb.onIntensityFilter?.(r),
    });

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

    // Four bare rails stacked in one open section made the Studio a wall of
    // chips. Depth is the one people reach for by default and stays visible;
    // the other three collapse, and their state persists per user.
    const visualsBody = el('div', { className: 'olv-visuals-body' }, [
      this._persistSection('visuals.workflow', collapsibleSection('Workflow', this._visualsWorkflowRail)),
      this._persistSection('visuals.rgb', collapsibleSection('RGB', this._visualsRgbRail)),
      el('div', { className: 'olv-visuals-group-label', text: 'Depth (EDL)' }),
      this._visualsEdlRail,
      this._persistSection('visuals.background', collapsibleSection('Background', this._visualsSkyRail)),
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
    this._renderingSection = this._persistSection(
      'rendering',
      collapsibleSection('Rendering', renderingBody),
    );

    // Dataset Intelligence — informational summary of the Terrain
    // Foundation outputs. Lives directly under the Scan Intelligence
    // title and above the Visuals Studio preset rail. Empty-state by
    // default so the panel never lies on first paint.
    this._datasetIntelligence = new DatasetIntelligenceCard(this._cb.onOpenDatasetStory);
    // Empty slot; the card class loads on first data (never lies on first
    // paint — it simply is not there yet).
    this._layerHealthSlot = el('div');

    this._crsSection = collapsibleSection('Coordinate system', this._crsBody);
    this.element = el('aside', { className: 'olv-inspector' }, [
      head,
      this._datasetIntelligence.element,
      this._layersSection,
      this._layerHealthSlot,
      this._colorBySection,
      this._elevFilter.section,
      this._intenFilter.section,
      // Visuals Studio (presets, curator's tool) → Rendering (raw,
      // technician's tool). Point size is folded into Rendering as a
      // sub-group, so the panel keeps one slot per intent instead of
      // three overlapping ones.
      visualsStudioSection,
      this._renderingSection,
      this._persistSection('detail', collapsibleSection('Detail', this._detail)),
      this._persistSection(
        'provenance',
        collapsibleSection(
          'Provenance',
          el('div', { className: 'olv-provenance-wrap' }, [
            this._declaredProvenanceBody,
            this._provenanceBody,
          ]),
        ),
      ),
      this._crsSection,
      this._persistSection('scanReport', collapsibleSection('Scan report', this._report)),
      this._persistSection('savedViews', collapsibleSection('Saved views', views)),
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
   * Seed the elevation-filter inputs from a cloud's world extent and reveal the
   * section. Passing null hides it (no static cloud loaded).
   */
  setElevationExtent(ext: { min: number; max: number } | null): void {
    this._elevFilter.setExtent(ext);
  }

  /**
   * Seed the intensity-filter inputs from a cloud's intensity range and reveal
   * the section. Passing null hides it (no static cloud, or no intensity
   * channel).
   */
  setIntensityExtent(ext: { min: number; max: number } | null): void {
    this._intenFilter.setExtent(ext);
  }

  /** Restore a saved elevation window (session import) — applies + shows it. */
  restoreElevationFilter(range: readonly [number, number] | null): void {
    this._elevFilter.applyWindow(range);
  }

  /** Restore a saved intensity window (session import) — applies + shows it. */
  restoreIntensityFilter(range: readonly [number, number] | null): void {
    this._intenFilter.applyWindow(range);
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

  /**
   * Add a loaded cloud to the layer list. `crsLabel` shows the layer's CRS, when
   * known. `stableId` is the layer's source-fingerprint identity, recorded here
   * so a group's membership can be written to a session under an id that still
   * means the same scan next time; a layer with no proven identity passes null
   * and is simply left out of a written arrangement.
   */
  addCloud(
    id: string,
    name: string,
    pointCount: number,
    crsLabel?: string | null,
    stableId?: string | null,
  ): void {
    const visible = el('input', { type: 'checkbox', title: 'Show or hide this scan' });
    visible.type = 'checkbox';
    visible.checked = true;
    visible.addEventListener('change', () => {
      this._cb.onToggleVisible(id, visible.checked);
      // A row click changes what its group header rolls up to, so re-read the
      // headers straight away rather than waiting for the next full paint.
      this._groups?.syncHeaders();
    });

    // Isolate (solo): show only this layer. A second click clears isolate.
    const solo = iconButton({
      className: 'olv-layer-solo',
      text: '◉',
      title: `Isolate ${name} — hide the other layers`,
      ariaLabel: `Isolate ${name}`,
      onClick: () => this._cb.onToggleSolo?.(id),
    });

    // Lock: keep the layer drawn but exclude it from picking / measuring.
    // aria-pressed mirrors the class so the locked state is announced, not
    // just shown by the glyph/title flip — the same pattern the workflow
    // preset and scanType chips already use elsewhere in this file.
    let locked = false;
    const lock = iconButton({
      className: 'olv-layer-lock',
      text: '○',
      title: `Lock ${name} out of picking and measuring`,
      ariaLabel: `Lock ${name} out of picking`,
      ariaPressed: false,
      onClick: () => {
        locked = !locked;
        lock.classList.toggle('is-active', locked);
        lock.textContent = locked ? '●' : '○';
        lock.title = locked
          ? `${name} is locked — unlock to pick / measure it`
          : `Lock ${name} out of picking and measuring`;
        lock.setAttribute('aria-label', locked ? `${name} is locked — unlock to pick or measure it` : `Lock ${name} out of picking`);
        lock.setAttribute('aria-pressed', String(locked));
        this._cb.onToggleLock?.(id, locked);
      },
    });

    const remove = iconButton({
      className: 'olv-layer-x',
      text: '×',
      title: `Remove ${name} from the scene`,
      ariaLabel: `Remove ${name}`,
      onClick: () => {
        // Removing the LAST layer does more than remove a layer: `removeCloud`
        // in main.ts falls through to `resetToEmptyState`, which clears placed
        // measurements, saved views and annotations. Measurements do not
        // survive that — `MeasureController.clear()` takes no snapshot, so
        // there is no undo, unlike the annotation clear beside it. The
        // tooltip promises only a removal from the scene, so the confirm
        // states the rest. A removal that leaves another layer behind is not
        // destructive and stays one click.
        if (!removalClosesScan(this._layerRows.size)) {
          this._cb.onRemove(id);
          return;
        }
        void openConfirm({
          title: 'Close this scan?',
          message:
            `Removing ${name} closes the scan.\n` +
            'Placed measurements, saved views and annotations are cleared. Measurements cannot be restored.',
          confirmLabel: 'Remove and close',
          returnFocusTo: remove,
        }).then((ok) => {
          if (ok) this._cb.onRemove(id);
        });
      },
    });

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
    this._layerFacts.set(id, { name, stableId: stableId ?? null });
    this._notifySource();
    this._layerVisibleBoxes.set(id, visible);
    // The group panel decides where the row goes; with no groups in play it
    // lands at the end of the flat list exactly as it always has.
    this._refreshLayerRows();
  }

  /**
   * Ensure the group panel exists, loading its chunk on first use.
   *
   * Resolves to null when the chunk fails to load: grouping is additive, so a
   * failed import must leave the flat layer list working rather than take the
   * Layers section down with it.
   */
  private _ensureGroups(): Promise<LayerGroupsPanel | null> {
    if (this._groups) return Promise.resolve(this._groups);
    // Reuse the in-flight import rather than starting a second one: a
    // fast double-click used to reach this before the first `then` had
    // constructed `_groups`, so both callers' `.then` ran createGroup()
    // against the one instance the second resolution found already built.
    if (this._groupsPromise) return this._groupsPromise;
    this._groupsPromise = loadLayerGroupsPanel()
      .then(({ LayerGroupsPanel }) => {
        if (!this._groups) {
          // Every group action is written through `onToggleVisible` — the one
          // call a single row's checkbox already makes — so grouping adds no
          // second answer to "is this layer shown".
          this._groups = new LayerGroupsPanel(this._layers, {
            layerIds: () => [...this._layerRows.keys()],
            nameOf: (id) => this._layerFacts.get(id)?.name ?? id,
            rowFor: (id) => this._layerRows.get(id) ?? null,
            visibilityOf: (id) => this._layerVisibleBoxes.get(id)?.checked ?? true,
            setVisible: (id, visible) => {
              const box = this._layerVisibleBoxes.get(id);
              if (box) box.checked = visible;
              this._cb.onToggleVisible(id, visible);
            },
            stableIdOf: (id) => this._layerFacts.get(id)?.stableId ?? null,
          });
          const pending = this._groupsPending;
          this._groupsPending = null;
          if (pending) this._groups.restoreFromSession(pending);
          else this._groups.render();
        }
        return this._groups;
      })
      .catch((err) => {
        console.warn('[inspector] layer-groups chunk failed to load', err);
        return null;
      })
      .finally(() => {
        // Cleared on both outcomes: once `_groups` exists the guard above
        // short-circuits future calls anyway, and clearing it on failure is
        // what lets a retry actually re-attempt the import.
        this._groupsPromise = null;
      });
    return this._groupsPromise;
  }

  /** Re-lay the layer rows: through the group panel when it exists, else flat. */
  private _refreshLayerRows(): void {
    if (this._groups) {
      this._groups.render();
      return;
    }
    this._layers.replaceChildren(...this._layerRows.values());
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
  /** Feed the layer health card — same cadence as setLayerCrsFlags. */
  /**
   * Apply the stored open state to a collapsible section and record every
   * later toggle under `id`. Sections with no stored entry keep their own
   * default.
   */
  private _persistSection(id: string, section: HTMLDetailsElement): HTMLDetailsElement {
    const stored = this._sectionState[id];
    if (typeof stored === 'boolean') section.open = stored;
    section.addEventListener('toggle', () => {
      this._sectionState[id] = section.open;
      saveInspectorSection(id, section.open);
    });
    return section;
  }

  setLayerHealth(
    layers: Parameters<LayerHealthCard['update']>[0],
    report: Parameters<LayerHealthCard['update']>[1],
  ): void {
    if (this._layerHealth) {
      if (layers.length === 0) this._layerHealth.clear();
      else this._layerHealth.update(layers, report);
      return;
    }
    // Remember only the newest state; mount the card when its chunk lands.
    this._layerHealthPending = [layers, report];
    void loadLayerHealthCard().then(({ LayerHealthCard }) => {
      if (this._layerHealth) return;
      this._layerHealth = new LayerHealthCard();
      this._layerHealthSlot.append(this._layerHealth.root);
      const pending = this._layerHealthPending;
      this._layerHealthPending = null;
      if (pending && pending[0].length > 0) this._layerHealth.update(pending[0], pending[1]);
    })
      // Additive surface: a chunk-load failure must not become an unhandled
      // rejection (the caller is synchronous and can't catch this promise).
      .catch((err) => console.warn('[inspector] layer-health card chunk failed to load', err));
  }

  setLayerCrsFlags(
    mismatched: ReadonlySet<string>,
    summary: string,
    compatibility?: ReadonlyMap<string, LayerCompatibility>,
    unmounted?: ReadonlySet<string>,
  ): void {
    for (const [id, row] of this._layerRows) {
      const bad = mismatched.has(id);
      row.classList.toggle('olv-layer-crs-mismatch', bad);
      // A layer excluded from combined results has to SAY it is excluded.
      // Dropping it silently means the user reads a figure computed from
      // fewer inputs than they believe, which is worse than the merge the
      // exclusion prevents — that at least looked wrong eventually.
      const state = compatibility?.get(id);
      // Two reasons a layer sits out of combined results: it is not COMPATIBLE
      // with the frame, or it is not MOUNTED in one. The second was invisible —
      // a compatible pair reads `verified`, so nothing was flagged, while
      // neither could enter an estimator.
      const notMounted = unmounted?.has(id) === true;
      const excluded = (state !== undefined && state !== 'verified') || notMounted;
      row.classList.toggle('olv-layer-frame-excluded', excluded);
      if (state !== undefined && state !== 'verified') row.title = compatibilityNote(state);
      else if (notMounted) {
        row.title =
          'Shares the project’s reference, but layers are not co-registered in this build, '
          + 'so this layer is excluded from combined terrain, profile and volume results. '
          + 'Analyse it on its own by soloing it.';
      }
      else if (bad) row.title = 'This layer does not share the others’ coordinate system.';
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
   * Streaming-mode toggle.
   *
   * When `true`, hides the static-cloud-only sections (Layers, Color by). Their
   * streaming-equivalents — color modes, quality control, resident-points
   * stats — live in the StreamingPanel; the Inspector retains Detail,
   * Provenance, Coordinate system, Scan report and Saved views, which all work
   * uniformly against a streaming source.
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
    // The Render-quality section (point size, point-size mode, EDL,
    // antialiasing) stays visible while streaming. Each control applies to the
    // resident streaming node materials and every newly-decoded node inherits
    // the current setting at build time, so they are fully functional — and
    // none has a StreamingPanel equivalent, so hiding the section removed
    // point-thickness control on a streaming COPC.
    this.element.classList.toggle('olv-inspector-streaming', streaming);
    // Leaving streaming layout retires the streaming Detail readout with the
    // scan it measured. The static open writes its own through `setDetail`.
    if (!streaming) clearStreamingDetail(this._detail);
  }

  /**
   * The live Layers section, for the desktop workspace to re-parent into its
   * Data mode. The Inspector keeps updating the same node (addLayer,
   * setStreamingMode), so layer state stays here; the workspace only hosts it.
   * Layer Health is per-scan and stays in the Inspector, under the scan summary.
   */
  workspaceDataElements(): { layers: HTMLElement } {
    return { layers: this._layersSection };
  }

  private readonly _sourceListeners = new Set<() => void>();
  private _notifySource(): void {
    for (const fn of this._sourceListeners) fn();
  }

  /**
   * Called whenever the source summary may have changed: a layer added or
   * removed, a new CRS (including a user override, which arrives through
   * setCrs from the CRS service), or new provenance. Returns an unsubscribe.
   */
  onSourceChange(fn: () => void): () => void {
    this._sourceListeners.add(fn);
    return () => this._sourceListeners.delete(fn);
  }

  /** Format and coordinate system of the newest layer, for the Data home. */
  sourceSummary(): string {
    const facts = Array.from(this._layerFacts.values());
    const name = facts[facts.length - 1]?.name ?? '';
    const dot = name.lastIndexOf('.');
    const format = dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
    return [format, this._pendingCrs?.name].filter(Boolean).join(', ');
  }

  /** Bring the Layer Health card into view. False while it has no data yet. */
  focusLayerHealth(): boolean {
    return this._layerHealthSlot.childElementCount > 0 && this._revealSection(this._layerHealthSlot, null);
  }

  /** Bring the coordinate-system section into view, the source metadata home. */
  focusSource(): boolean {
    return this._revealSection(this._crsSection, null);
  }

  /**
   * Reveal the coordinate-system override control and put the keyboard on it.
   * The destination of the tool preflight's `set-coordinate-system` remediation:
   * a user told the physical unit is unconfirmed lands on the control that
   * confirms it, rather than being asked to go and find it.
   *
   * Returns false when the section is unavailable (it is hidden while a
   * streaming scan is mounted), so a caller can tell "done" from "nothing here".
   *
   * The override `<select>` lives behind the lazy `renderCrs` chunk: if the
   * chunk is still loading (or hasn't been requested — a rare race right
   * after scan-open), the reveal finds no control to focus yet. In that
   * case focus is deferred and delivered once `setCrs()`'s render actually
   * lands, rather than silently dropping to `<body>`.
   */
  focusCrsOverride(): boolean {
    const revealed = this._revealSection(this._crsSection, '.olv-crs-select');
    if (revealed && !this._crsBody.querySelector('.olv-crs-select')) {
      this._focusCrsOverrideOnHydrate = true;
    }
    return revealed;
  }

  /** Focus the CRS override `<select>` if `focusCrsOverride()` asked for it while loading. */
  private _deliverDeferredCrsFocus(): void {
    if (!this._focusCrsOverrideOnHydrate) return;
    this._focusCrsOverrideOnHydrate = false;
    const control = this._crsBody.querySelector('.olv-crs-select');
    if (control && typeof (control as HTMLElement).focus === 'function') {
      (control as HTMLElement).focus();
    }
  }

  /**
   * Reveal the layer list, where each layer's CRS label and compatibility flag
   * are shown — the destination of the `inspect-layer-crs` remediation.
   */
  focusLayers(): boolean {
    return this._revealSection(this._layersSection, null);
  }

  /**
   * Bring one Inspector section into view, expanding it when it is a collapsed
   * disclosure, and focus a control inside it when one is named. Opening the
   * bottom sheet is unconditional: the class it adds is scoped to the phone
   * media query, so it is inert on desktop and necessary on a phone, where the
   * section is otherwise behind a closed sheet.
   */
  private _revealSection(target: HTMLElement | null, focusSelector: string | null): boolean {
    if (!target || target.classList.contains('olv-hidden')) return false;
    this.openSheet();
    // Duck-typed rather than `instanceof HTMLDetailsElement`: this file is
    // built under recording-DOM stubs in the node test environment, where the
    // constructor does not exist.
    if ('open' in target) (target as HTMLDetailsElement).open = true;
    target.scrollIntoView?.({ block: 'nearest' });
    const control = focusSelector ? target.querySelector(focusSelector) : null;
    if (control && typeof (control as HTMLElement).focus === 'function') {
      (control as HTMLElement).focus();
    }
    return true;
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


  /** Remove a cloud's layer row. */
  removeCloud(id: string): void {
    this._layerRows.get(id)?.remove();
    this._layerRows.delete(id);
    this._layerFacts.delete(id);
    this._notifySource();
    this._layerVisibleBoxes.delete(id);
    // A group whose last scan just closed is KEPT, empty: it is still the
    // container the user made, and removing a layer must not delete it.
    this._refreshLayerRows();
  }

  /**
   * The Layers panel's groups as a session records them — stable layer ids, so
   * the arrangement re-attaches to the same scans and not to whichever ones
   * happen to occupy the same viewer slots.
   */
  layerGroupsForSession(): SessionLayerGroup[] {
    // No panel means no group has ever been made this session, so there is
    // nothing to write and the file keeps its no-groups byte-shape.
    return this._groups?.groupsForSession() ?? [];
  }

  /** Restore a session's group arrangement over the layers currently loaded. */
  restoreLayerGroups(groups: readonly SessionLayerGroup[]): void {
    if (this._groups) {
      this._groups.restoreFromSession(groups);
      return;
    }
    // Remember only the newest arrangement; apply it when the chunk lands.
    this._groupsPending = groups;
    void this._ensureGroups();
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

  /**
   * The recommender's one-line rationale for the mode the scan opened in, or
   * null once the analyst has picked a mode by hand (the sentence describes
   * the opening choice only).
   */
  private _openingReason: string | null = null;

  /**
   * Render the color-mode chips, marking `active` as selected. `openingReason`
   * is shown beneath the rail as one sentence until the user changes mode.
   */
  setColorModes(modes: ColorMode[], active: ColorMode, openingReason?: string): void {
    // The Coverage / Confidence modes are analysis-gated, not data-gated, so
    // they are never part of the per-cloud `availableModes` list — track the
    // data modes separately and always append the gated chips below.
    this._modes = modes.filter((m) => !ANALYSIS_GATED_MODES.includes(m));
    this._activeMode = active;
    this._openingReason = openingReason ?? null;
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
        this._openingReason = null;
        this._cb.onColorMode(mode);
        // v0.3.7 final-polish — show the trim slider when the analyst
        // picks Height. Other modes don't honour the slider so hiding
        // it removes the cognitive overhead.
        this._heightTrimRow.classList.toggle('olv-hidden', mode !== 'elevation');
        this._syncProjectScaleRow();
      });
      this._chips.append(chip);
    }
    // Surface the gate reason in the flow (visible on touch, where the chip's
    // hover-only `title` never appears), and qualify a derived colour whenever
    // one is active. The provenance line comes first: it describes what the
    // analyst is looking at right now, while the gate note describes a mode
    // they cannot select yet.
    const note = buildColorChipNote(
      this._activeMode,
      anyGatedDisabled,
      this._openingReason ?? undefined,
    );
    this._chipsNote.textContent = note;
    this._chipsNote.classList.toggle('olv-hidden', note === '');
    // Initial visibility for the trim row — track the active mode.
    this._heightTrimRow.classList.toggle('olv-hidden', this._activeMode !== 'elevation');
    this._syncProjectScaleRow();
  }

  /**
   * Report whether the project-shared elevation scale is applicable — ≥2 layers
   * colouring elevation in the shared frame — and reflect its current on/off
   * state. Called by main.ts after the cloud set or the flag changes.
   */
  setProjectSharedElevationAvailable(available: boolean, on: boolean): void {
    this._projectScaleAvailable = available;
    this._projectScaleCheckbox.checked = on;
    this._syncProjectScaleRow();
  }

  /** Show the toggle only while colouring by elevation with ≥2 in-frame layers. */
  private _syncProjectScaleRow(): void {
    const show = this._projectScaleAvailable && this._activeMode === 'elevation';
    this._projectScaleRow.classList.toggle('olv-hidden', !show);
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
      const wanted = state.edlPresetId ?? 'off';
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

  /** Reflect the current `_navPrefs` flags on the two invert chips. */
  private _syncNavChips(): void {
    this._navInvertYChip.classList.toggle('olv-chip-active', this._navPrefs.invertOrbitY);
    this._navInvertXChip.classList.toggle('olv-chip-active', this._navPrefs.invertOrbitX);
  }

  /**
   * Apply persisted navigation prefs on startup — sets the chip / select visual
   * state WITHOUT firing `onNavigationPrefsChange` (the host applies the prefs
   * to the viewer itself on load), mirroring `ClassLegendPanel.setColorblindSafe`.
   */
  syncNavigationPrefs(prefs: NavigationPreferences): void {
    this._navPrefs = { ...prefs };
    this._syncNavChips();
    this._navPresetSelect.value = prefs.preset;
  }

  /**
   * Show the streaming residency readout — what is resident now against what
   * the source declares, or the fact that it declares nothing.
   *
   * Separate from {@link setDetail} on purpose. That seam is positional and its
   * two arguments mean "shown of a cloud the viewer holds"; a streaming source
   * has a resident set, a source total and a current-view readiness that are
   * three different quantities, and passing the source total through the static
   * seam twice is what made an out-of-core scan read as 100 % held. The typed
   * object is what stops resident and source being transposed.
   *
   * Called on every streaming status tick, so the figure tracks the CURRENT
   * resident set rather than the one at attach; each call replaces the readout,
   * so a source that declares no total clears the previous source's.
   */
  setStreamingDetail(detail: StreamingDetail): void {
    renderStreamingDetail(this._detail, detail);
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
   * Render the report rows via the lazy `renderReport` chunk (`ui/inspector/
   * renderReport.ts`). Shows a loading placeholder synchronously, then swaps
   * in the real rows once the chunk resolves. Latest-wins: if a second
   * `setReport()` arrives before the chunk loads, only the newest rows are
   * painted.
   */
  setReport(rows: AnalysisRow[] | Promise<AnalysisRow[]>): void {
    this._reportSource = rows;
    if (!Array.isArray(rows)) {
      // Rows still being computed: the loading line stays until they land,
      // and a newer call made meanwhile wins.
      this._report.replaceChildren(
        el('div', { className: 'olv-report-empty', text: 'Loading scan report…' }),
      );
      rows.then(
        (r) => { if (this._reportSource === rows) this.setReport(r); },
        () => { if (this._reportSource === rows) this._showReportLoadError(); },
      );
      return;
    }
    this._pendingReportRows = rows;
    if (this._renderReportFn) {
      this._renderReportFn(this._report, rows);
      return;
    }
    this._report.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Loading scan report…' }),
    );
    void this._ensureReportChunk().then((renderReport) => {
      if (this._pendingReportRows !== rows) return; // a later call already won
      if (!renderReport) {
        this._showReportLoadError();
        return;
      }
      renderReport(this._report, rows);
    });
  }

  /** Load (and cache) the `renderReport` chunk. Dedupes concurrent calls. */
  private _ensureReportChunk(): Promise<typeof this._renderReportFn> {
    if (this._renderReportFn) return Promise.resolve(this._renderReportFn);
    if (this._reportChunkPromise) return this._reportChunkPromise;
    this._reportChunkPromise = loadRenderReport()
      .then(({ renderReport }) => {
        this._renderReportFn = renderReport;
        return renderReport;
      })
      .catch((err) => {
        console.warn('[inspector] scan-report chunk failed to load', err);
        return null;
      })
      .finally(() => {
        this._reportChunkPromise = null;
      });
    return this._reportChunkPromise;
  }

  private _showReportLoadError(): void {
    const retry = el('button', {
      className: 'olv-inline-retry',
      type: 'button',
      text: 'Try again',
      tip: 'Retry loading the scan report.',
    }) as HTMLButtonElement;
    retry.addEventListener('click', () => {
      if (this._pendingReportRows) this.setReport(this._pendingReportRows);
    });
    this._report.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Could not load the scan report.' }),
      retry,
    );
    announce('Could not load the scan report.');
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
    this._groups?.reset();
    this._groupsPending = null;
    this._layers.replaceChildren();
    this._layerRows.clear();
    this._layerFacts.clear();
    this._layerVisibleBoxes.clear();
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
    this.setDeclaredProvenance(null);
    this.setCrsSectionVisible(true);
    this.closeSheet();
  }

  private _showReportPlaceholder(): void {
    this._report.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Drop a scan to validate it.' }),
    );
  }

  private _showViewsPlaceholder(): void {
    this._viewList.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'No saved views yet. Save the current camera to return to it later.' }),
    );
  }

  // ── Provenance fingerprint ────────────────────────────────────────────────

  /**
   * Surface the classifier's verdict for the loaded scan, via the lazy
   * `renderProvenance` chunk. Shows a loading placeholder synchronously;
   * latest-wins if a second call arrives before the chunk resolves.
   */
  setProvenance(fingerprint: ProvenanceFingerprint): void {
    this._pendingProvenanceForChunk = fingerprint;
    this._notifySource();
    if (this._renderProvenanceFn) {
      this._renderProvenanceFn(this._provenanceBody, fingerprint, (type) => {
        this._onProvenanceOverride?.(type);
      });
      return;
    }
    this._provenanceBody.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Loading provenance…' }),
    );
    void this._ensureProvenanceChunk().then((renderProvenance) => {
      if (this._pendingProvenanceForChunk !== fingerprint) return;
      if (!renderProvenance) {
        this._showProvenanceLoadError();
        return;
      }
      renderProvenance(this._provenanceBody, fingerprint, (type) => {
        this._onProvenanceOverride?.(type);
      });
    });
  }

  /** Load (and cache) the `renderProvenance` chunk. Dedupes concurrent calls. */
  private _ensureProvenanceChunk(): Promise<typeof this._renderProvenanceFn> {
    if (this._renderProvenanceFn) return Promise.resolve(this._renderProvenanceFn);
    if (this._provenanceChunkPromise) return this._provenanceChunkPromise;
    this._provenanceChunkPromise = loadRenderProvenance()
      .then(({ renderProvenance }) => {
        this._renderProvenanceFn = renderProvenance;
        return renderProvenance;
      })
      .catch((err) => {
        console.warn('[inspector] provenance chunk failed to load', err);
        return null;
      })
      .finally(() => {
        this._provenanceChunkPromise = null;
      });
    return this._provenanceChunkPromise;
  }

  private _showProvenanceLoadError(): void {
    const retry = el('button', {
      className: 'olv-inline-retry',
      type: 'button',
      text: 'Try again',
      tip: 'Retry loading provenance.',
    }) as HTMLButtonElement;
    retry.addEventListener('click', () => {
      if (this._pendingProvenanceForChunk) this.setProvenance(this._pendingProvenanceForChunk);
    });
    this._provenanceBody.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Could not load provenance.' }),
      retry,
    );
    announce('Could not load provenance.');
  }

  /** Restore the placeholder when the active scan closes. */
  clearProvenance(): void {
    this._pendingProvenanceForChunk = null;
    this._showProvenancePlaceholder();
    this.setDeclaredProvenance(null);
  }

  /**
   * Show or hide the whole Coordinate-system section (v0.5.7). Local-frame
   * profiles (terrestrial-scan, handheld-scan, mesh) hide it: a scan with no
   * geodetic CRS has nothing but a "CRS unknown" row to show there, which reads
   * as a defect rather than a fact. The geo/survey path keeps it.
   */
  setCrsSectionVisible(visible: boolean): void {
    this._crsSection?.classList.toggle('olv-hidden', !visible);
  }

  /**
   * Render the declared-by-the-file profile / provenance card (v0.5.7), or hide
   * it when `model` is null (the unchanged geo path with no declared metadata).
   * Every value is shown verbatim under a "declared, not verified" qualifier —
   * nothing here is inferred. Sits above the classifier fingerprint.
   */
  setDeclaredProvenance(model: ProvenanceCardModel | null): void {
    const body = this._declaredProvenanceBody;
    body.replaceChildren();
    if (!model) {
      body.classList.add('olv-hidden');
      return;
    }
    body.classList.remove('olv-hidden');
    if (model.headline) {
      body.append(el('div', { className: 'olv-declared-prov-headline', text: model.headline }));
    }
    if (model.declaredRows.length > 0 || model.limitations) {
      body.append(
        el('div', {
          className: 'olv-declared-prov-qualifier',
          text: 'Declared by the file — not verified.',
        }),
      );
    }
    for (const row of model.declaredRows) {
      body.append(
        el('div', { className: 'olv-declared-prov-row' }, [
          el('span', { className: 'olv-declared-prov-key', text: row.label }),
          el('span', { className: 'olv-declared-prov-val', text: row.value }),
        ]),
      );
    }
    if (model.referenceGrade) {
      body.append(
        el('div', {
          className: 'olv-declared-prov-note',
          text: 'The file declares this is not survey grade.',
        }),
      );
    }
    if (model.limitations) {
      body.append(el('div', { className: 'olv-declared-prov-limits', text: model.limitations }));
    }
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

  /**
   * Surface the detected (or overridden) CRS for the loaded scan, via the
   * lazy `renderCrs` chunk (which also carries the CRS-catalog table the
   * override picker is built from). Shows a loading placeholder
   * synchronously; latest-wins if a second call arrives before the chunk
   * resolves.
   */
  setCrs(resolved: ResolvedCrs): void {
    this._pendingCrs = resolved;
    this._notifySource();
    if (this._renderCrsFn) {
      this._renderCrsFn(this._crsBody, resolved, (o) => this._onCrsOverride?.(o));
      this._deliverDeferredCrsFocus();
      return;
    }
    this._crsBody.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Loading coordinate system…' }),
    );
    void this._ensureCrsChunk().then((renderCrs) => {
      if (this._pendingCrs !== resolved) return;
      if (!renderCrs) {
        this._showCrsLoadError();
        return;
      }
      renderCrs(this._crsBody, resolved, (o) => this._onCrsOverride?.(o));
      this._deliverDeferredCrsFocus();
    });
  }

  /** Load (and cache) the `renderCrs` chunk. Dedupes concurrent calls. */
  private _ensureCrsChunk(): Promise<typeof this._renderCrsFn> {
    if (this._renderCrsFn) return Promise.resolve(this._renderCrsFn);
    if (this._crsChunkPromise) return this._crsChunkPromise;
    this._crsChunkPromise = loadRenderCrs()
      .then(({ renderCrs }) => {
        this._renderCrsFn = renderCrs;
        return renderCrs;
      })
      .catch((err) => {
        console.warn('[inspector] coordinate-system chunk failed to load', err);
        return null;
      })
      .finally(() => {
        this._crsChunkPromise = null;
      });
    return this._crsChunkPromise;
  }

  private _showCrsLoadError(): void {
    const retry = el('button', {
      className: 'olv-inline-retry',
      type: 'button',
      text: 'Try again',
      tip: 'Retry loading the coordinate system.',
    }) as HTMLButtonElement;
    retry.addEventListener('click', () => {
      if (this._pendingCrs) this.setCrs(this._pendingCrs);
    });
    this._crsBody.replaceChildren(
      el('div', { className: 'olv-report-empty', text: 'Could not load the coordinate system.' }),
      retry,
    );
    announce('Could not load the coordinate system.');
  }

  /** Restore the CRS placeholder when the active scan closes. */
  clearCrs(): void {
    this._pendingCrs = null;
    this._notifySource();
    this._showCrsPlaceholder();
  }

  /**
   * Register a callback the panel invokes when the user picks a CRS in
   * the override dropdown. Caller is responsible for persisting the
   * override (via `CrsOverrideStore.setOverride`) and re-resolving the
   * effective CRS, then feeding the result back through `setCrs`.
   */
  setOnCrsOverride(cb: (override: CrsOverride) => void): void {
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
