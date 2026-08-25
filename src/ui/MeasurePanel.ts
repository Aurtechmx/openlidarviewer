/**
 * MeasurePanel.ts
 *
 * The Measurements panel — a compact list of every placed measurement plus a
 * footer to export / import a measurement session (measurements and saved
 * camera views together, as one JSON file). A dumb view: the controller
 * computes the summaries; the panel renders them and reports intents back.
 */

import { el } from './dom';
import { ICON_EXPAND } from './dockIcons';
import { openResultFocus } from './ResultFocus';
import { triggerDownload } from '../io/download';
// Guarded localStorage access — bare getItem/setItem throws in sandboxed
// iframes (the embed path) and some privacy modes; see safeStorage.ts.
import { storageGet, storageSet } from './safeStorage';
// Static import of the loader thunk — the dynamic import() itself lives in
// lazyChunks.ts (excluded from the live source-transform) so its literal is
// never scrambled. Importing the thunk pulls nothing heavy into the shell.
import { loadProfilePdf } from '../lazyChunks';
import { profilePdfInputFor } from './profilePdfInput';
import type { MeasurementSummary, ProfileResampleParams } from '../render/measure/MeasureController';
import {
  DIMENSION_LABEL,
  OPERATION_LABEL,
  formatChainResult,
  type ChainDimension,
  type ChainOperation,
  type ChainResult,
} from '../render/measure/measurementChains';
// Profile Intelligence (v0.4.5) — pure summary + CSV builder shared with the
// PDF so panel, sheet and data export can never disagree on a number. Light
// (no pdf-lib), so a static import keeps the panel a leaf module.
import {
  buildProfileCsv,
  computeProfileSummary,
  profileStationRows,
  profileSummaryRows,
  type ProfileStationRow,
} from '../render/measure/profileSummary';
// What surface a profile's heights are measured from. `profileDatumKnown`
// answers a different question — whether the loaded clouds share a render
// origin — so every heading resolves through here instead, and takes its word
// from `heightLabel`, where only an orthometric reference reads "Elevation".
import { resolveProfileVerticalReference } from '../render/measure/profileVerticalReference';
import { heightLabel } from '../geo/height';
import type { VerticalReference } from '../geo/height';
// Straight-polyline path builder shared with the profile PDF so the chart and
// the sheet draw the same geometry. Pure string assembly, no dependencies.
import { fitAxisLabels } from '../render/measure/profileAxes';
import { profilePolylinePath } from '../render/measure/profilePath';
// Δh in the chart tooltip goes through the shared formatter so it carries
// its unit in BOTH systems (B9 — it used to print a hardcoded "m" even in
// imperial mode).
import {
  DATUM_CONFLICT_MEASURE_NOTICE,
  formatAngle,
  formatArea,
  formatGrade,
  formatLength,
  GEOGRAPHIC_CRS_MEASURE_NOTICE,
} from '../render/measure/format';
import { breakdownParts } from './measureBreakdownRow';
// Measurement context state — every displayed value states what kind of
// number it is (viewer measurement with a resolved datum / approximate
// scene-local figure / no shared basis), so a screenshot of the panel can
// never imply a certified survey figure. Pure policy module; the panel is
// the dumb view that renders the state it derives.
import {
  confidenceForKind,
  UNRESOLVED_SCENE_CONTEXT,
  type MeasureSceneContext,
} from '../render/measure/measureConfidence';
// B7/B8 (v0.4.5) — sampler-control defaults + bounds, read from the sampler
// module so the inputs, the controller clamp and the tests share one rule.
import {
  DEFAULT_GROUND_PERCENTILE,
  MAX_CORRIDOR_HALF_WIDTH_M,
  MIN_CORRIDOR_HALF_WIDTH_M,
  PROFILE_SAMPLE_COUNT_OPTIONS,
} from '../render/measure/profileSampler';

/** Metres → feet — the same factor the chart's imperial labels use. */
const FT_PER_M = 3.28084;

/**
 * The profile chart used to be 36 px tall,
 * which was too small to read slope, pick out features, or treat as a
 * deliverable. The CSS now defaults to 280 px and lets the user drag
 * the south-east handle (CSS `resize: vertical`). We persist the
 * chosen height under this key so the panel doesn't snap back on every
 * re-render. One key shared across all profile rows — users want
 * consistent reading height, not per-profile memory.
 */
const PROFILE_CHART_HEIGHT_KEY = 'olv:measure:profile:chartHeightPx:v1';

/**
 * Lower bound on the user-resizable profile chart height, in CSS
 * pixels. Exported so the matching unit test (and any future code
 * path that needs to clamp a stored height) can read from the same
 * source of truth as the JS clamp below. Mirrored in `style.css`
 * (`.olv-mp-chart { min-height: 160px; }`); the
 * `profileChartHeightBounds.test.ts` spec pins the two against drift.
 */
/** Panel-width resize bounds (drag the SE handle to widen the profile chart).
 *  Mirror of the CSS min/max-width on `.olv-measure-panel`. */
export const MEASURE_PANEL_MIN_WIDTH_PX = 218;
export const MEASURE_PANEL_MAX_WIDTH_PX = 760;
const MEASURE_PANEL_WIDTH_KEY = 'olv:measure:panel:widthPx:v1';

export const PROFILE_CHART_MIN_HEIGHT_PX = 160;
/** Upper bound on the resizable profile chart height. See
 * `PROFILE_CHART_MIN_HEIGHT_PX` for the source-of-truth rationale. */
export const PROFILE_CHART_MAX_HEIGHT_PX = 640;

/**
 * v0.3.10 Profile-as-Deliverable — the profile chart exposes a vertical
 * stretch picker so an analyst can read slope discontinuities the fitted
 * chart would hide. Four canonical multipliers: Fit (1), 2×, 5×, 10×.
 * v0.4.5 honesty (B3): these are multiples of the FITTED elevation scale,
 * not "N:1" paper ratios — the resizable chart stretches X and Y
 * independently, so a true ratio is impossible to promise here (the PDF
 * export states real 1:N scales). Persisted globally across all profile
 * rows under the same key so the panel doesn't snap back between renders.
 * One key, all profiles — civil/survey users want consistent reading
 * scale, not per-profile memory.
 */
export const PROFILE_VEX_OPTIONS = [1, 2, 5, 10] as const;
const PROFILE_VEX_KEY = 'olv:measure:profile:vex:v1';

/**
 * Disclosure state for the two collapsible profile sections, remembered so the
 * panel doesn't reset a reader's chosen layout on every re-render. One key each,
 * panel-wide (the same "consistent reading state, not per-profile memory" rule
 * the chart-height and VEX keys follow). The Summary defaults OPEN — it is the
 * glanceable headline — and the station table defaults CLOSED so a 64-row table
 * never dominates the dock until asked for.
 */
const PROFILE_SUMMARY_OPEN_KEY = 'olv:measure:profile:summaryOpen:v1';
const PROFILE_STATIONS_OPEN_KEY = 'olv:measure:profile:stationsOpen:v1';

/**
 * Trailing-edge debounce for the sampler controls (B7/B8). Long enough to
 * coalesce a held number-spinner burst into one resample, short enough that
 * a single deliberate change still feels immediate.
 */
const SAMPLER_DEBOUNCE_MS = 250;

/**
 * Pick the largest "nice" station interval that produces no more
 * than ~10 stations across the given chainage. Civil convention
 * prefers multiples of 1/2/5/10/20/25/50/100/200/500 metres.
 * v0.3.10 Profile-as-Deliverable stream — used by the chart renderer
 * to draw station tick marks at a survey-shaped spacing instead of
 * picking arbitrary 8/10 divisions of the X axis.
 */
export function autoStationInterval(totalChainageM: number): number {
  if (!Number.isFinite(totalChainageM) || totalChainageM <= 0) return 1;
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const v of ladder) {
    if (totalChainageM / v <= 10) return v;
  }
  // Very long sections — keep scaling decade by decade.
  let v = 10_000;
  while (totalChainageM / v > 10) v *= 2;
  return v;
}

/**
 * "Nice" axis tick values inside [min, max] for the elevation (Y) axis.
 * Returns rounded values at a 1/2/5×10ⁿ step — the survey/engineering
 * convention — so the elevation axis reads as e.g. 120 · 125 · 130 rather
 * than the raw, ragged data min/max. At most `target` ticks (default 4);
 * always returns the two bounds when the band is degenerate so the axis is
 * never blank. Pure, deterministic — exported for testing.
 */
export function niceElevationTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return Number.isFinite(min) ? [min] : [];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let niceUnit: number;
  if (norm <= 1) {
    niceUnit = 1;
  } else if (norm <= 2) {
    niceUnit = 2;
  } else if (norm <= 5) {
    niceUnit = 5;
  } else {
    niceUnit = 10;
  }
  const step = niceUnit * mag;
  // Crash guard (v0.4.5): a denormal-tiny span underflows `mag` to 0, which
  // makes `step` 0 — and a `v += 0` loop pushes ticks forever until the tab
  // dies of OOM. An infinite `step` (span near Number.MAX_VALUE) is the same
  // class. Fall back to the two bounds: a degenerate axis, never a hang.
  if (!Number.isFinite(step) || step <= 0) return [min, max];
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // Belt-and-braces iteration cap — `target` is ~4, so 64 is far beyond any
  // legitimate tick count and bounds the loop even on adversarial floats.
  for (let v = first; v <= max + step * 1e-6 && ticks.length < 64; v += step) {
    // Snap to the step grid AND trim binary-float dust (e.g. 3 × 0.1 =
    // 0.30000000000000004) so labels read as clean 0.3 / 110 / 1200.
    const snapped = Math.round(v / step) * step;
    ticks.push(Number(snapped.toFixed(10)));
  }
  return ticks;
}

/** Sanitise a measurement name into a safe download file stem. */
function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'measurement';
}

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
  /**
   * Aggregate the given measurement ids by dimension + operation. The
   * controller owns the measurement data and the unit system; the
   * panel is the dumb view that asks for the result.
   *
   * Returns `null` when no scan / measurements are loaded.
   */
  onChainAggregate?: (
    ids: ReadonlyArray<string>,
    dimension: ChainDimension,
    operation: ChainOperation,
  ) => ChainResult | null;
  /**
   * Current unit system — the panel needs it for the profile chart's
   * axis labels (metric → m / km, imperial → ft / mi). Returns
   * `'metric'` when no controller is wired (defensive default).
   * v0.3.10 Profile-as-Deliverable stream.
   */
  getUnitSystem?: () => 'metric' | 'imperial';
  /**
   * CRS provenance for the profile PDF header (v0.4.5, B4) — resolved by the
   * host from the CRS service AT EXPORT TIME, so a late CRS confirmation or
   * user override is reflected on the sheet. Optional; when absent (or when
   * the scan is local/unknown) the PDF keeps its honest
   * "— (not georeferenced)" fallback.
   */
  getProfileExportContext?: () => {
    crs: string | null;
    verticalDatum: string | null;
  };
  /**
   * Re-sample one profile with user-set sampler parameters (B7/B8, v0.4.5):
   * corridor half-width in METRES, elevation percentile, sample count. Null
   * fields reset that parameter to its default (auto corridor / p25 / 64).
   * The controller re-samples and emits a change; the panel re-renders with
   * the values that actually shaped the new chart. Optional — without it the
   * sampler controls are simply not rendered.
   */
  onProfileResample?: (id: string, params: ProfileResampleParams) => void;
  /**
   * Highlight (or clear) one scene profile-station dot as the reader hovers a
   * profile-chart tick or station-table row. `stationIndex` indexes the dots of
   * measurement `id` in `MeasurementSummary.profileStationChainages` order;
   * `null` (with either argument) clears the highlight. Purely a display
   * coupling — the host forwards it to the controller and requests a frame.
   * Optional: without it the profile panel renders exactly as before, inert.
   */
  onStationHover?: (id: string | null, stationIndex: number | null) => void;
  /**
   * Open the docked Profile Workbench for one measurement, resolving true when
   * a dock was mounted and false when it was not.
   *
   * The panel treats false as "use the surface you already have": `ResultFocus`
   * opens instead, so Expand works whether or not the workbench chunk arrives,
   * whether or not this viewport carries a dock, and whether or not the host
   * wired the callback at all. The panel decides nothing about which
   * measurements qualify — the host owns that rule — and never learns what a
   * dock, a stage or a Viewer is.
   */
  openProfileWorkbench?: (summary: MeasurementSummary) => Promise<boolean>;
}

/**
 * Coupling passed into the profile builders so a hovered chart tick / table
 * row can brighten the matching scene dot. `stationChainages` are the scene
 * dots' chainages (metres, dot order); `notify(i)` reports the resolved dot
 * index (or null on leave) up to the panel's `onStationHover`.
 */
interface StationHoverCoupling {
  readonly stationChainages: readonly number[];
  readonly notify: (stationIndex: number | null) => void;
}

/** The scene dot whose chainage is nearest `target` (metres). Callers guard emptiness. */
function nearestStationIndex(stationChainages: readonly number[], target: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < stationChainages.length; i++) {
    const d = Math.abs(stationChainages[i] - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Attach a symmetric hover coupling to one element: pointer-enter reports
 * `stationIndex`, pointer-leave clears it. `mouseenter`/`mouseleave` don't
 * bubble, so a leave always pairs with its own enter and the highlight can't
 * get stuck when the pointer crosses between adjacent targets. The nodes are
 * discarded whole on the next `_renderList`, taking these listeners with them.
 */
function bindStationHover(
  node: EventTarget,
  stationIndex: number,
  coupling: StationHoverCoupling,
): void {
  node.addEventListener('mouseenter', () => coupling.notify(stationIndex));
  node.addEventListener('mouseleave', () => coupling.notify(null));
}

export class MeasurePanel {
  /** The panel element — append to the stage overlay. */
  readonly element: HTMLElement;
  private readonly _cb: MeasurePanelCallbacks;
  private readonly _list: HTMLElement;
  /** Chain mode state — owned by the panel. */
  private _chainOn = false;
  /** Set of measurement ids checked in chain mode. */
  private readonly _chainSelection = new Set<string>();
  /** Active chain operation. Defaults to 'sum'. */
  private _chainOp: ChainOperation = 'sum';
  /** Active chain dimension. Defaults to 'length'. */
  private _chainDim: ChainDimension = 'length';
  /** Chain UI surfaces, populated in the constructor. */
  private readonly _chainBar: HTMLElement;
  private readonly _chainResult: HTMLElement;
  /** Most recently rendered summaries — used by the chain redraw path. */
  private _summaries: MeasurementSummary[] = [];
  /** Persistent geographic-CRS caveat, toggled via {@link setGeographicNotice}. */
  private readonly _geoNotice: HTMLElement;
  /** Observer that persists the user's dragged panel width. */
  private _panelWidthObserver?: ResizeObserver;
  /**
   * Active `ResizeObserver` instances created for the profile-chart
   * persistence path. Each `_renderList()` call detaches and replaces
   * the existing chart DOM nodes; without an explicit teardown, the
   * observers they were attached to would leak (they still hold a
   * closure over the now-detached chart and over the localStorage
   * write callback). Tracking them here lets the next render
   * `disconnect()` every one before rebuilding the list.
   */
  private _chartObservers: ResizeObserver[] = [];
  /**
   * Pending debounced sampler-resample timer (B7/B8). One panel-wide handle
   * — the user can only interact with one control at a time, and a new edit
   * anywhere supersedes the pending one. Cancelled by `_renderList` so a
   * stale timer can never fire against torn-down inputs.
   */
  private _samplerTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Scene-level measurement-context facts, fed by the host via
   * {@link setConfidenceContext}. Null until the host speaks; the panel then
   * renders the FAIL-CLOSED default (approximate — shared datum unresolved),
   * so a value can never read as more than the scene has proven.
   */
  private _confidenceScene: MeasureSceneContext | null = null;

  constructor(callbacks: MeasurePanelCallbacks) {
    this._cb = callbacks;
    this._list = el('div', { className: 'olv-mp-list' });
    this._chainBar = this._buildChainBar();
    this._chainResult = this._chainBar.querySelector('.olv-mp-chain-result') as HTMLElement;

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
      // v0.3.10 — the .olvsession file is useful
      // standalone (it carries measurement coordinates, annotation text,
      // and named views the recipient can read as plain JSON in any text
      // editor or import into another tool). It is NOT a replay artefact
      // like .olvworkflow — the recipient does not need the same scan to
      // extract value. The tooltip below sets that expectation so users
      // don't conflate the two export paths.
      title:
        'Save this analysis as an .olvsession — measurements, annotations, ' +
        'named views, camera, render + colour settings, and the class filter. ' +
        'Readable JSON; nothing leaves your device.',
    });
    exportBtn.addEventListener('click', () => {
      exportBtn.blur();
      this._cb.onExport();
    });
    const importBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Open',
      title:
        'Open a saved .olvsession — restores measurements, annotations, views, ' +
        'camera, render + colour settings. You can also just drag the ' +
        '.olvsession onto the viewer, or use Open.',
    });
    importBtn.addEventListener('click', () => {
      importBtn.blur();
      fileInput.click();
    });

    // v0.3.9 — Chain toggle. Surfaces a per-row checkbox + a header bar
    // with operation/dimension chip rails and a live aggregate result.
    const chainBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Chain',
      title:
        'Aggregate selected measurements — sum / average / min / max across length, area, volume, height, grade, or angle.',
    });
    chainBtn.addEventListener('click', () => {
      chainBtn.blur();
      this._chainOn = !this._chainOn;
      chainBtn.classList.toggle('olv-mp-action-active', this._chainOn);
      this._chainBar.classList.toggle('olv-hidden', !this._chainOn);
      this._renderList();
      this._recomputeChain();
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
    // Honest-units notice for geographic (degree) CRSs — hidden by default,
    // toggled by the host from the same CrsService subscription that feeds
    // the controller's unit factor. Persistent (not per-row): the limitation
    // is a property of the scan's frame, not of any single measurement, and
    // it must stay visible while any measurement is read. Same copy as the
    // hint bar and the per-measurement trust reason, so the wording cannot
    // fork. Reuses the project-wide `.olv-caveat` honesty primitive.
    this._geoNotice = el('div', {
      className: 'olv-caveat olv-mp-geo-notice olv-hidden',
      text: GEOGRAPHIC_CRS_MEASURE_NOTICE,
    });
    this.element = el('aside', { className: 'olv-measure-panel olv-hidden' }, [
      head,
      this._geoNotice,
      this._chainBar,
      this._list,
      el('div', { className: 'olv-mp-footer' }, [
        chainBtn,
        exportBtn,
        importBtn,
        fileInput,
      ]),
    ]);
    // Explicit SE resize grip. The native `resize: horizontal` corner sits under
    // the rail's collapse tab (a z-index:20 handle pinned flush to the shared
    // right edge), which swallows the pointer-down before the drag can engage —
    // so the panel looked resizable but wasn't. This grip rides ABOVE the tab
    // and drives the same width the ResizeObserver already persists.
    this.element.append(this._buildResizeHandle());
    this._restorePanelWidth();
  }

  /**
   * The panel's own south-east resize grip, raised above the rail collapse tab
   * that covers the native handle. A pointer drag (or arrow keys) rewrites the
   * panel width within the CSS bounds; the width observer in `_restorePanelWidth`
   * picks up the change and persists it, so no separate save path is needed.
   */
  private _buildResizeHandle(): HTMLElement {
    const handle = el('div', {
      className: 'olv-mp-resize',
      title: 'Drag to resize the panel (← / → to nudge)',
      ariaLabel: 'Resize measurements panel',
    });
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.tabIndex = 0;

    const clamp = (w: number): number =>
      Math.min(
        MEASURE_PANEL_MAX_WIDTH_PX,
        Math.max(MEASURE_PANEL_MIN_WIDTH_PX, Math.round(w)),
      );

    let startX = 0;
    let startW = 0;
    const onMove = (e: PointerEvent): void => {
      this.element.style.width = `${clamp(startW + (e.clientX - startX))}px`;
    };
    const onUp = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer was never captured (older engines) — nothing to release. */
      }
      handle.classList.remove('olv-mp-resize-active');
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // primary button / pen / touch only
      startX = e.clientX;
      startW = this.element.offsetWidth;
      handle.classList.add('olv-mp-resize-active');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture unavailable — window listeners still track the drag. */
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
    // Keyboard parity — the native grip offers none, and a survey tool should be
    // driveable without a mouse. Shift takes a coarser step.
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === 'ArrowLeft') {
        this.element.style.width = `${clamp(this.element.offsetWidth - step)}px`;
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        this.element.style.width = `${clamp(this.element.offsetWidth + step)}px`;
        e.preventDefault();
      }
    });
    return handle;
  }

  /**
   * Show/hide the persistent geographic-CRS measurement caveat. Driven by
   * the host from the CrsService subscription (the same seam that feeds the
   * controller's `setGeographicCrs`), so the panel and the hint bar can
   * never disagree about the active frame.
   */
  setGeographicNotice(show: boolean): void {
    this._geoNotice.classList.toggle('olv-hidden', !show);
  }

  /**
   * Restore the user's last dragged panel width and persist any new width
   * (the panel is horizontally resizable so the profile chart can be widened
   * to read). One key, panel-wide; clamped to the CSS resize bounds.
   */
  private _restorePanelWidth(): void {
    const stored = Number(storageGet(MEASURE_PANEL_WIDTH_KEY));
    if (
      Number.isFinite(stored) &&
      stored >= MEASURE_PANEL_MIN_WIDTH_PX &&
      stored <= MEASURE_PANEL_MAX_WIDTH_PX
    ) {
      this.element.style.width = `${stored}px`;
    }
    if (typeof ResizeObserver === 'undefined') return;
    try {
      let primed = false;
      this._panelWidthObserver = new ResizeObserver(() => {
        // Skip the first (synchronous) callback so an untouched panel never
        // writes the default width back to storage.
        if (!primed) {
          primed = true;
          return;
        }
        const w = this.element.offsetWidth;
        if (!Number.isFinite(w) || w <= 0) return;
        const clamped = Math.min(
          MEASURE_PANEL_MAX_WIDTH_PX,
          Math.max(MEASURE_PANEL_MIN_WIDTH_PX, Math.round(w)),
        );
        storageSet(MEASURE_PANEL_WIDTH_KEY, String(clamped));
      });
      this._panelWidthObserver.observe(this.element);
    } catch {
      /* ResizeObserver unavailable — resizing still works, just isn't persisted. */
    }
  }

  /** Build the chain bar that sits above the list when chain mode is on. */
  private _buildChainBar(): HTMLElement {
    const ops: ChainOperation[] = ['sum', 'mean', 'min', 'max', 'count'];
    const dims: ChainDimension[] = [
      'length',
      'area',
      'volume-fill',
      'volume-cut',
      'volume-net',
      'height',
      'angle',
      'grade',
    ];

    const opRow = el('div', { className: 'olv-mp-chain-chips' });
    for (const op of ops) {
      const chip = el('button', {
        className: 'olv-mp-chain-chip',
        text: OPERATION_LABEL[op],
        title: `Aggregate by ${OPERATION_LABEL[op].toLowerCase()}.`,
      });
      chip.dataset.op = op;
      chip.addEventListener('click', () => {
        chip.blur();
        this._chainOp = op;
        this._paintChipActive(opRow, 'op', op);
        this._recomputeChain();
      });
      opRow.append(chip);
    }
    this._paintChipActive(opRow, 'op', this._chainOp);

    const dimRow = el('div', { className: 'olv-mp-chain-chips' });
    for (const dim of dims) {
      const chip = el('button', {
        className: 'olv-mp-chain-chip',
        text: DIMENSION_LABEL[dim],
        title: `Aggregate over ${DIMENSION_LABEL[dim].toLowerCase()}.`,
      });
      chip.dataset.dim = dim;
      chip.addEventListener('click', () => {
        chip.blur();
        this._chainDim = dim;
        this._paintChipActive(dimRow, 'dim', dim);
        this._recomputeChain();
      });
      dimRow.append(chip);
    }
    this._paintChipActive(dimRow, 'dim', this._chainDim);

    const result = el('div', {
      className: 'olv-mp-chain-result',
      text: '— · select rows below',
    });

    return el('div', { className: 'olv-mp-chain-bar olv-hidden' }, [
      el('div', { className: 'olv-mp-chain-label', text: 'Chain' }),
      opRow,
      dimRow,
      result,
    ]);
  }

  /** Paint the active chip in a row by data attribute. */
  private _paintChipActive(
    row: HTMLElement,
    attr: 'op' | 'dim',
    value: string,
  ): void {
    const chips = row.querySelectorAll<HTMLElement>('.olv-mp-chain-chip');
    chips.forEach((c) => {
      c.classList.toggle(
        'olv-mp-chain-chip-active',
        c.dataset[attr] === value,
      );
    });
  }

  /**
   * Recompute the chain aggregate against the current selection and
   * paint the result chip. No-op when chain mode is off or no
   * `onChainAggregate` callback is wired.
   */
  private _recomputeChain(): void {
    if (!this._chainOn) return;
    if (this._chainSelection.size === 0) {
      this._chainResult.textContent = '— · select rows below';
      return;
    }
    if (!this._cb.onChainAggregate) {
      this._chainResult.textContent = '—';
      return;
    }
    const result = this._cb.onChainAggregate(
      [...this._chainSelection],
      this._chainDim,
      this._chainOp,
    );
    if (!result) {
      this._chainResult.textContent = '—';
      return;
    }
    const opLabel = OPERATION_LABEL[result.operation];
    const dimLabel = DIMENSION_LABEL[result.dimension];
    const formatted = formatChainResult(result);
    // Caveat: when the operation skipped some rows because they don't
    // contribute to the chosen dimension, surface the gap.
    const coverage =
      result.contributingCount < result.totalCount
        ? ` · ${result.contributingCount}/${result.totalCount} rows`
        : '';
    this._chainResult.textContent = `${opLabel} ${dimLabel}: ${formatted}${coverage}`;
  }

  /** Show or hide the panel. */
  setVisible(visible: boolean): void {
    // Hiding the panel can strand a station hover (no `mouseleave` fires on a
    // now-hidden row), which would leave a scene dot lit; clear it on the way
    // out. The host no-ops when nothing was highlighted.
    if (!visible) this._cb.onStationHover?.(null, null);
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /**
   * Build and download a full-page PDF profile sheet for one profile
   * measurement. pdf-lib is dynamic-imported so it stays out of the
   * initial bundle; the button shows progress and a failure state rather
   * than failing silently.
   */
  /**
   * Export one profile by id, for a surface that has no summary in hand.
   *
   * The docked workbench's own Export PDF control comes through here rather
   * than assembling the builder's inputs a second time. A sheet states its
   * read scope and the classification basis of the heights on it, and those
   * are exactly the parameters a second call site drops; there is one
   * assembly, and both controls run it.
   *
   * Rejects when the id names nothing this panel is showing, so the control
   * that called it can report a failure instead of appearing to succeed.
   */
  async exportProfilePdf(id: string): Promise<void> {
    const s = this._summaries.find((x) => x.id === id);
    if (!s) throw new Error(`No measurement ${id} to export.`);
    await this._buildProfileSheet(s);
  }

  private async _exportProfilePdf(
    s: MeasurementSummary,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (!s.profileChart || s.profileChart.length < 2) return;
    const label = btn.textContent ?? 'Export PDF';
    btn.disabled = true;
    btn.textContent = 'Building…';
    try {
      await this._buildProfileSheet(s);
    } catch (err) {
      console.error('OpenLiDARViewer: profile PDF export failed.', err);
      btn.textContent = 'Export failed';
      setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 1800);
      return;
    }
    btn.textContent = label;
    btn.disabled = false;
  }

  /**
   * Assemble the sheet's inputs and download it. THE one assembly.
   *
   * Throws on failure rather than reporting it, so each control that calls it
   * shows the failure in its own vocabulary.
   */
  private async _buildProfileSheet(s: MeasurementSummary): Promise<void> {
    if (!s.profileChart || s.profileChart.length < 2) return;
    const { buildProfilePdf } = await loadProfilePdf();
    // Assembled in ONE place, shared with the docked workbench's own export
    // control. What a second assembly drops is the CRS, the unit system and
    // the provenance record, which is exactly what a reader of the file
    // cannot recover from anywhere else.
    const bytes = await buildProfilePdf(
      profilePdfInputFor(s, {
        context: this._cb.getProfileExportContext ? this._cb.getProfileExportContext() : null,
        unitSystem: this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric',
        // The clock is read HERE, at the app boundary. The builder takes the
        // stamp as a parameter so the same sheet is the same bytes.
        generatedAt: new Date(),
      }),
    );
    triggerDownload(
      new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      `${safeFileName(s.name)}-profile.pdf`,
    );
  }

  /**
   * The surface this profile's heights are measured from.
   *
   * Resolved rather than assumed. The summary carries `profileDatumKnown`,
   * which reports that the loaded clouds agree on a render origin — the fact
   * that makes a stored local height restorable, not a declared datum. Reading
   * it as a datum is what printed "Elevation" over heights no source ever tied
   * to a sea-level surface. The measurement's provenance record answers when
   * it has an answer; otherwise the datum the CRS service resolved is
   * classified, and an unrecognised one stays `unknown`.
   *
   * The CRS is read at RENDER time, like the PDF header, so a late CRS
   * confirmation or a user override reaches the headings on the next update.
   */
  private _verticalReference(s: MeasurementSummary): VerticalReference {
    const ctx = this._cb.getProfileExportContext ? this._cb.getProfileExportContext() : null;
    return resolveProfileVerticalReference({
      datumKnown: s.profileDatumKnown,
      provenance: s.profileProvenance,
      verticalDatum: ctx?.verticalDatum ?? null,
    });
  }

  /**
   * Download the profile's station data as a CSV (station, chainage, ground
   * height, corridor point count, grade-to-next), in the active unit
   * system. Synchronous — the builder is pure string assembly, so unlike the
   * PDF there is no chunk to load and no busy state to manage. v0.4.5,
   * closing the "no profile CSV, station table PDF-only" audit gap.
   */
  private _exportProfileCsv(s: MeasurementSummary): void {
    if (!s.profileChart || s.profileChart.length < 2) return;
    const system = this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric';
    const csv = buildProfileCsv(s.profileChart, system, this._verticalReference(s));
    triggerDownload(new Blob([csv], { type: 'text/csv' }), `${safeFileName(s.name)}-profile.csv`);
  }

  /**
   * Expand, for a profile row.
   *
   * The docked workbench is the surface when the host offers one and it opens;
   * `ResultFocus` is the surface otherwise. The choice is made per press rather
   * than once at construction, because a viewport can narrow and a chunk can
   * fail between one Expand and the next.
   */
  private _openProfileFocus(s: MeasurementSummary, trigger: HTMLElement): void {
    if (!s.profileChart || s.profileChart.length < 2) return;
    const dock = this._cb.openProfileWorkbench;
    if (!dock) {
      this._openResultFocus(s, trigger);
      return;
    }
    // A refusal, a failed chunk load and a host that threw on the way to the
    // plot are the same event here: all three leave Expand with the focus view
    // it has always had. The rejection arm is not decoration — the host runs
    // the whole extraction and render pass behind this promise.
    void dock(s).then(
      (opened) => {
        if (!opened) this._openResultFocus(s, trigger);
      },
      () => this._openResultFocus(s, trigger),
    );
  }

  /**
   * Escalate a profile result into the shared focus surface — the same chart,
   * stats and full station table the dock renders, given room to read. Pure
   * presentation: every node comes from the existing renderers/builders
   * (`renderProfileChart`, `profileSummaryRows`, `buildStationTable`) and the
   * export buttons reuse the panel's own CSV / PDF paths, so nothing here can
   * disagree with the in-dock numbers. `ResultFocus` owns the chrome + a11y.
   *
   * Also the fallback for every case the workbench declines.
   */
  private _openResultFocus(s: MeasurementSummary, trigger: HTMLElement): void {
    if (!s.profileChart || s.profileChart.length < 2) return;
    const samples = s.profileChart;
    const system = this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric';
    const datumKnown = s.profileDatumKnown !== false;
    const reference = this._verticalReference(s);
    const storedVex = Number(storageGet(PROFILE_VEX_KEY));
    const vex = PROFILE_VEX_OPTIONS.includes(storedVex as 1 | 2 | 5 | 10) ? storedVex : 1;

    openResultFocus({
      title: s.name,
      triggerEl: trigger,
      render: (container) => {
        // Chart — the SAME renderer, given the surface's larger reading height.
        const chart = renderProfileChart(samples, vex, system);
        chart.classList.add('olv-rf-chart');

        // Stats — the same summary rows, as a clean multi-column grid.
        const stats = el('dl', {
          className: 'olv-rf-stats',
          ariaLabel: `Profile summary for ${s.name}`,
        });
        for (const row of profileSummaryRows(computeProfileSummary(samples), system, reference)) {
          stats.append(
            el('div', { className: 'olv-rf-stat' }, [
              el('dt', { className: 'olv-rf-stat-label', text: row.label }),
              el('dd', { className: 'olv-rf-stat-value', text: row.value }),
            ]),
          );
        }

        // Station table — the same builder, materialised eagerly (the reader
        // opened the focus view precisely to read the whole table).
        const unitLabel = system === 'metric' ? 'm' : 'ft';
        const stationRows = profileStationRows(samples, system);
        const { table, build } = buildStationTable(
          stationRows,
          unitLabel,
          s.name,
          heightLabel(reference),
        );
        build();
        const stations = el('div', { className: 'olv-rf-stations' }, [
          el('div', {
            className: 'olv-rf-section-label',
            text: `Station table (${stationRows.length})`,
          }),
          el('div', { className: 'olv-mp-stations-wrap olv-rf-stations-wrap' }, [table]),
        ]);

        container.append(chart, stats, stations);

        // Streaming-resident caveat — the same honest coverage line as the dock.
        if (s.profileChartResidentOnly) {
          container.append(
            el('div', {
              className: 'olv-mp-chart-caveat',
              text: 'Resident-node analysis only — profile may refine as streaming loads.',
            }),
          );
        }
        if (!datumKnown) {
          container.append(
            el('div', { className: 'olv-mp-chart-caveat', text: DATUM_CONFLICT_MEASURE_NOTICE }),
          );
        }

        // Export actions reuse the panel's own builders (CSV → buildProfileCsv,
        // PDF → the scaled sheet), so the focus view is a place to work.
        const csvBtn = el('button', {
          className: 'olv-mp-profile-pdf',
          text: 'CSV',
          title: `Export ${s.name} station data as CSV`,
          ariaLabel: `Export profile ${s.name} station data as CSV`,
        });
        csvBtn.addEventListener('click', () => {
          csvBtn.blur();
          this._exportProfileCsv(s);
        });
        const pdfBtn = el('button', {
          className: 'olv-mp-profile-pdf',
          text: 'Export PDF',
          title: `Export ${s.name} as a scaled profile sheet (PDF)`,
          ariaLabel: `Export profile ${s.name} as PDF`,
        });
        pdfBtn.addEventListener('click', () => {
          pdfBtn.blur();
          void this._exportProfilePdf(s, pdfBtn);
        });
        container.append(el('div', { className: 'olv-rf-actions' }, [csvBtn, pdfBtn]));
      },
    });
  }

  /**
   * The profile sampler controls (B7/B8, v0.4.5): a `<details>` whose summary
   * is the live caption — "Corridor ±… · p… of corridor · N samples" — and
   * whose body holds the corridor / percentile / sample-count inputs plus a
   * Reset.
   * Corridor is entered in the display unit (m or ft) and converted to metres
   * before it reaches the controller, which clamps to the shared bounds.
   * Returns null when the host wired no resample callback or the row carries
   * no chart (pre-chart session imports).
   */
  private _buildSamplerControls(
    s: MeasurementSummary,
    system: 'metric' | 'imperial',
  ): HTMLElement | null {
    const resample = this._cb.onProfileResample;
    if (!resample || !s.profileChart || s.profileChart.length < 2) return null;
    const imperial = system === 'imperial';
    const corrM = s.profileCorridorWidthM;
    const pct = s.profileGroundPercentile ?? DEFAULT_GROUND_PERCENTILE;
    const nSamples = s.profileChart.length;

    // Caption — the chart's provenance line. "auto" only appears for
    // pre-v0.4.5 measurements whose record never stored the corridor.
    const caption =
      `Corridor ±${corrM != null ? formatLength(corrM, system) : 'auto'} · ` +
      `p${pct} of corridor · ${nSamples} samples`;

    const unitLabel = imperial ? 'ft' : 'm';
    const toDisplay = (m: number): number => (imperial ? m * FT_PER_M : m);
    const corrInput = el('input', {
      className: 'olv-mp-sampler-input',
      title:
        'Corridor half-width on each side of the line — points beyond it are ' +
        'ignored. Wider smooths; narrower follows micro-relief.',
      ariaLabel: `Corridor half-width (${unitLabel})`,
    }) as HTMLInputElement;
    corrInput.type = 'number';
    corrInput.min = String(toDisplay(MIN_CORRIDOR_HALF_WIDTH_M));
    corrInput.max = String(Math.round(toDisplay(MAX_CORRIDOR_HALF_WIDTH_M)));
    corrInput.step = 'any';
    if (corrM != null) corrInput.value = String(Number(toDisplay(corrM).toFixed(2)));
    else corrInput.placeholder = 'auto';

    const pctInput = el('input', {
      className: 'olv-mp-sampler-input',
      title:
        'Per-bin elevation percentile over the corridor returns: 25 is a ' +
        'lower-percentile surface, 50 the median, 100 the highest return. ' +
        'Known non-ground classes (vegetation, building, noise) are excluded ' +
        'only where a source supplies a classification; unclassified returns ' +
        'still count towards the percentile.',
      ariaLabel: 'Elevation percentile (0–100)',
    }) as HTMLInputElement;
    pctInput.type = 'number';
    pctInput.min = '0';
    pctInput.max = '100';
    pctInput.step = '5';
    pctInput.value = String(pct);

    const cntSelect = el('select', {
      className: 'olv-mp-sampler-input',
      title: 'Bins along the line — more bins resolve shorter features.',
      ariaLabel: 'Sample count',
    }) as HTMLSelectElement;
    for (const n of PROFILE_SAMPLE_COUNT_OPTIONS) {
      const opt = el('option', { text: String(n) }) as HTMLOptionElement;
      opt.value = String(n);
      cntSelect.append(opt);
    }
    // Pre-select the chart's actual bin count when it is one of the choices;
    // otherwise fall back to the default so the select never lies silently
    // (the caption above always states the true count).
    cntSelect.value = (PROFILE_SAMPLE_COUNT_OPTIONS as readonly number[]).includes(nSamples)
      ? String(nSamples)
      : '64';

    const apply = (): void => {
      const rawCorr = corrInput.value.trim();
      const corrVal = rawCorr === '' ? Number.NaN : Number(rawCorr);
      const cnt = Number(cntSelect.value);
      const pctVal = Number(pctInput.value);
      // Empty input = keep auto; the controller clamps out-of-range values.
      let corridorWidthM: number | null;
      if (Number.isFinite(corrVal)) {
        corridorWidthM = imperial ? corrVal / FT_PER_M : corrVal;
      } else {
        corridorWidthM = null;
      }
      resample(s.id, {
        corridorWidthM,
        groundPercentile: Number.isFinite(pctVal) ? pctVal : null,
        sampleCount: Number.isFinite(cnt) ? cnt : null,
      });
    };
    // Debounced apply — same timer-coalescing pattern the panel's resize
    // persistence uses. Every successful resample re-renders the whole list
    // (the controller emits a change), which REPLACES these inputs; holding
    // a number spinner therefore fires a burst of 'change' events against a
    // node that is being torn down per step. The trailing-edge debounce
    // coalesces the burst into one resample after the user settles. Pending
    // timers are tracked panel-wide so `_renderList` can cancel them before
    // rebuilding (the same hygiene `_chartObservers` gets) — a stale timer
    // firing after a re-render would resample with values that already
    // shaped the chart.
    const applyDebounced = (): void => {
      if (this._samplerTimer !== null) clearTimeout(this._samplerTimer);
      this._samplerTimer = setTimeout(() => {
        this._samplerTimer = null;
        apply();
      }, SAMPLER_DEBOUNCE_MS);
    };
    corrInput.addEventListener('change', applyDebounced);
    pctInput.addEventListener('change', applyDebounced);
    cntSelect.addEventListener('change', applyDebounced);

    const resetBtn = el('button', {
      className: 'olv-mp-sampler-reset',
      text: 'Reset',
      title: 'Back to the defaults — auto corridor (5% of length), p25, 64 samples',
      ariaLabel: `Reset sampling parameters for ${s.name}`,
    });
    resetBtn.addEventListener('click', () => {
      resetBtn.blur();
      // Reset is immediate and beats any pending debounced edit — a stale
      // timer firing after this would re-apply the values just discarded.
      if (this._samplerTimer !== null) {
        clearTimeout(this._samplerTimer);
        this._samplerTimer = null;
      }
      resample(s.id, { corridorWidthM: null, groundPercentile: null, sampleCount: null });
    });

    const field = (labelText: string, input: HTMLElement): HTMLElement =>
      el('label', { className: 'olv-mp-sampler-field' }, [
        el('span', { className: 'olv-mp-sampler-label', text: labelText }),
        input,
      ]);

    const body = el('div', { className: 'olv-mp-sampler-body' }, [
      field(`Corridor ± (${unitLabel})`, corrInput),
      field('Elevation percentile', pctInput),
      field('Samples', cntSelect),
      resetBtn,
    ]);
    return el('details', { className: 'olv-mp-sampler' }, [
      el('summary', {
        className: 'olv-mp-sampler-summary',
        text: caption,
        title: 'The sampling parameters that shaped this chart — open to adjust.',
      }),
      body,
    ]);
  }

  /**
   * Feed the scene-level measurement-context facts (datum resolved? layer set
   * proven? vertical reference known?). Until this is called the panel stays
   * on the fail-closed default — approximate, shared datum unresolved — so
   * silence can never look like verification. No-op on identical facts so the
   * host may call it on every refresh without churning the list DOM.
   */
  setConfidenceContext(scene: MeasureSceneContext): void {
    const prev = this._confidenceScene;
    if (
      prev &&
      prev.datumResolved === scene.datumResolved &&
      prev.layers === scene.layers &&
      prev.verticalReferenceKnown === scene.verticalReferenceKnown
    ) {
      return;
    }
    this._confidenceScene = scene;
    this._renderList();
  }

  /** Rebuild the measurement list from the controller's summaries. */
  update(summaries: MeasurementSummary[]): void {
    this._summaries = summaries;
    // Prune chain selection of any ids that no longer exist (a row
    // that the user deleted, or a session load that swapped the set).
    const valid = new Set(summaries.map((s) => s.id));
    for (const id of this._chainSelection) {
      if (!valid.has(id)) this._chainSelection.delete(id);
    }
    this._renderList();
    if (this._chainOn) this._recomputeChain();
  }

  /** Internal — rebuild the list DOM from `_summaries`. */
  private _renderList(): void {
    // Drop any live station-hover highlight BEFORE the old chart/table nodes are
    // replaced: their `mouseleave` will never fire once detached, so without
    // this an in-flight hover would leave a scene dot lit indefinitely. The
    // host no-ops (and skips the frame) when nothing was highlighted.
    this._cb.onStationHover?.(null, null);
    // Disconnect any ResizeObservers attached to the old chart
    // nodes BEFORE we drop those nodes on the floor. Otherwise
    // the observers keep their callbacks (and the chart elements
    // they close over) alive until GC happens to collect both —
    // see `_chartObservers` for the full rationale.
    for (const ro of this._chartObservers) ro.disconnect();
    this._chartObservers = [];
    // Cancel any pending debounced resample — its closure references inputs
    // this rebuild is about to replace, and the values it would apply
    // already shaped the chart being rendered (resample → change → here).
    if (this._samplerTimer !== null) {
      clearTimeout(this._samplerTimer);
      this._samplerTimer = null;
    }

    if (this._summaries.length === 0) {
      this._list.replaceChildren(
        el('div', { className: 'olv-mp-empty', text: 'No measurements yet.' }),
      );
      return;
    }
    this._list.replaceChildren(...this._summaries.map((s) => this._row(s)));
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

    // Chain mode adds a leading checkbox so the user can mark which
    // measurements feed the aggregate. Owned by the panel — the
    // controller is informed only at aggregate time.
    const children: HTMLElement[] = [dot, name, value, del];
    if (this._chainOn) {
      const check = el('input', {
        className: 'olv-mp-chain-check',
        ariaLabel: `Include ${s.name} in chain`,
      }) as HTMLInputElement;
      check.type = 'checkbox';
      check.checked = this._chainSelection.has(s.id);
      check.addEventListener('change', () => {
        if (check.checked) this._chainSelection.add(s.id);
        else this._chainSelection.delete(s.id);
        this._recomputeChain();
      });
      children.unshift(check);
    }
    // Per-measurement honesty badge (#2): a red/yellow/green trust dot whose
    // tooltip is the "show me why" — the caption plus every reason that shaped
    // the grade. A non-presentable (void-endpoint) measurement also de-emphasises
    // its number so the figure is never presented as an authoritative survey
    // value the data can't support.
    if (s.trust) {
      const t = s.trust;
      let colour: string;
      if (t.grade === 'green') {
        colour = '#38b058';
      } else if (t.grade === 'yellow') {
        colour = '#e8c440';
      } else {
        colour = '#d64c40';
      }
      const badge = el('span', {
        className: `olv-mp-trust olv-mp-trust-${t.grade}`,
        text: '●',
        title: [t.caption, ...t.reasons.map((r) => `• ${r}`)].join('\n'),
        ariaLabel: `Trust ${t.grade}: ${t.caption}`,
      });
      badge.style.color = colour;
      badge.style.cursor = 'help';
      if (!t.presentable) {
        value.style.opacity = '0.55';
        value.style.textDecoration = 'underline dotted';
        value.title = t.caption;
      }
      // Insert just after the value so the dot reads as the number's verdict.
      children.splice(children.indexOf(value) + 1, 0, badge);
    }

    const headRow = el('div', { className: 'olv-mp-row' }, children);

    // Measurement-context line: what kind of number the value above it is.
    // Complements the per-endpoint trust dot (which grades the DATA under the
    // endpoints) with the SCENE's frame facts — datum resolved, layer set
    // proven, vertical reference known — derived by the pure policy module.
    // The label is always visible; the reason rides on the tooltip.
    const conf = confidenceForKind(s.kind, this._confidenceScene ?? UNRESOLVED_SCENE_CONTEXT);
    const confLine = el('div', {
      className: `olv-mp-confidence olv-mp-confidence-${conf.level}`,
      text: conf.label,
      title: conf.level === 'verified' ? conf.label : `${conf.label} — ${conf.reason}`,
    });

    // Distance / Area: the values the same picks already fixed. Reading a run,
    // a rise or a grade used to mean placing a second measurement of another
    // kind over the same points. The parts are composed by a pure helper so the
    // panel decides layout, not arithmetic or wording.
    const breakdown = breakdownParts(
      s,
      this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric',
      { formatLength, formatArea, formatGrade, formatAngle },
    );
    const breakdownLine = breakdown
      ? el('div', {
          className: 'olv-mp-breakdown',
          text: breakdown.text,
          title: breakdown.title,
        })
      : null;

    // Profile-only: render a compact height-vs-distance chart strip
    // beneath the headline row. The chart is a single inline SVG, no
    // external libraries — keeps the Measurements panel a leaf module.
    if (s.kind === 'profile' && s.profileChart && s.profileChart.length >= 2) {
      // v0.3.10 Profile-as-Deliverable — VEX is persisted globally
      // across all profile rows; one key, all profiles. Clamp to a
      // member of the canonical 1/2/5/10 set so a hand-edited
      // localStorage value can't blow up the chart.
      const storedVex = Number(storageGet(PROFILE_VEX_KEY));
      const vex = PROFILE_VEX_OPTIONS.includes(storedVex as 1 | 2 | 5 | 10)
        ? storedVex
        : 1;
      const system = this._cb.getUnitSystem ? this._cb.getUnitSystem() : 'metric';
      // Hover coupling: a chart tick or table row highlights the scene dot at
      // the nearest chainage. Built once and shared by the chart and the table
      // so both speak the same dot index. Absent (inert) when the host wired no
      // `onStationHover`, or the profile has no intermediate station dots.
      const onStationHover = this._cb.onStationHover;
      const stationChainages = s.profileStationChainages ?? [];
      const stationCoupling: StationHoverCoupling | undefined =
        onStationHover && stationChainages.length > 0
          ? { stationChainages, notify: (i) => onStationHover(s.id, i) }
          : undefined;
      const chart = renderProfileChart(s.profileChart, vex, system, stationCoupling);
      // The chart is where the eye lands, so it carries the primary "expand"
      // affordance: click (or Enter / Space) anywhere on it to open the whole
      // result in the shared focus surface. An always-visible corner badge marks
      // it interactive — the faint header-row icon it replaces stayed invisible
      // until hovered, so nobody found it.
      // What Expand opens is not one surface any more, so the promise it makes
      // is not one sentence any more. A wide viewport with a stage gets the
      // docked section workbench, which carries neither the station table nor
      // the export buttons; everything else keeps the focus view, which does.
      // A host that wired no workbench at all can still promise only the one.
      const expandName = this._cb.openProfileWorkbench
        ? `Expand profile ${s.name}: a docked section workbench on a wide viewport, a focus view otherwise`
        : `Expand profile ${s.name} to a focus view`;
      const expandTitle = this._cb.openProfileWorkbench
        ? `Expand ${s.name}: a docked section workbench on a wide viewport, otherwise a focus view with the station table and export`
        : `Expand ${s.name} full size, with the station table and export`;
      const chartWrap = el(
        'div',
        {
          className: 'olv-mp-chart-wrap',
          title: expandTitle,
          ariaLabel: expandName,
        },
        [chart],
      );
      chartWrap.setAttribute('role', 'button');
      chartWrap.tabIndex = 0;
      const openProfileFocus = (): void => this._openProfileFocus(s, chartWrap);
      chartWrap.addEventListener('click', openProfileFocus);
      chartWrap.addEventListener('keydown', (e) => {
        // Only when the wrapper itself has focus. The expand button sits inside
        // it, and a bubbling Enter used to be preventDefault()ed here before the
        // browser could synthesise the button's click: the view still opened,
        // but through the wrapper, so focus returned to the wrapper instead of
        // the control the user actually activated.
        if (e.target !== chartWrap) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openProfileFocus();
        }
      });
      // The corner mark used to be a decorative span with `pointer-events: none`
      // — a hint that looked like a control and was not one. That is why a
      // labelled Expand button went into the chip strip below, and that button
      // needed 233px in a panel whose content box is 192px, so it clipped every
      // row it shared a panel with.
      //
      // Promoting the mark to a real button fixes both: the affordance people
      // look for is now the affordance that works, and the strip goes back to
      // holding only zoom chips. It sits top-right; the native resize grip is
      // bottom-right, so they do not compete for the same corner.
      const chartExpand = el('button', {
        className: 'olv-mp-chart-expand',
        unsafeHtml: ICON_EXPAND,
        title: expandTitle,
        ariaLabel: expandName,
      });
      chartExpand.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openProfileFocus(s, chartExpand);
      });
      chartWrap.append(chartExpand);
      // VEX chip strip — sits beneath the chart wrapper. Clicking a
      // chip writes the new VEX to localStorage and triggers a
      // re-render of the whole measurements list, so every profile
      // row picks up the new scale consistently.
      // B3 honesty (v0.4.5): the chips used to read "1:1 / 2:1 / …" but the
      // chart is NOT a true-ratio drawing — `preserveAspectRatio="none"`
      // stretches X and Y independently with the dragged panel size, so
      // "1:1" never meant 1:1. The control now says what it actually does:
      // "Fit" fills the height with the elevation band, and N× stretches
      // that fitted scale (clipping what leaves the band). True stated 1:N
      // scales live on the PDF export, which computes real paper ratios.
      const vexStrip = el('div', {
        className: 'olv-mp-vex-strip',
        title:
          'Vertical stretch — multiplies the fitted elevation scale. ' +
          'Not a true-ratio drawing (the chart stretches with the panel); ' +
          'use Export PDF for stated 1:N scales.',
        ariaLabel: 'Vertical stretch',
      });
      vexStrip.setAttribute('role', 'radiogroup');
      for (const v of PROFILE_VEX_OPTIONS) {
        const chip = el('button', {
          className: 'olv-mp-vex-chip' + (v === vex ? ' olv-mp-vex-chip-active' : ''),
          text: v === 1 ? 'Fit' : `${v}×`,
          title:
            v === 1
              ? 'Fit — the elevation band fills the chart height'
              : `${v}× vertical stretch of the fitted scale (relief outside the band is clipped)`,
          ariaLabel:
            v === 1
              ? 'Fit the elevation band to the chart height'
              : `Set vertical stretch to ${v} times the fitted scale`,
        });
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', v === vex ? 'true' : 'false');
        chip.addEventListener('click', () => {
          chip.blur();
          if (v === vex) return;
          storageSet(PROFILE_VEX_KEY, String(v));
          this._renderList();
        });
        vexStrip.append(chip);
      }

      // A named control for the focus view, sitting where the eye already is.
      //
      // The profile chart is resizable
      // (CSS `resize` on `.olv-mp-chart`). Restore the
      // user's last chosen height from localStorage and persist any
      // resize so the panel doesn't snap back to 140 px on every
      // re-render. One key shared across all profiles — users want
      // consistent reading height, not per-profile memory.
      if (chart.classList.contains('olv-mp-chart')) {
        const stored = Number(storageGet(PROFILE_CHART_HEIGHT_KEY));
        if (
          Number.isFinite(stored) &&
          stored >= PROFILE_CHART_MIN_HEIGHT_PX &&
          stored <= PROFILE_CHART_MAX_HEIGHT_PX
        ) {
          chart.style.height = `${stored}px`;
        }
        // ResizeObserver fires whenever the user drags the south-east
        // handle. Save the clamped height back to localStorage so the
        // next render starts at that size.
        //
        // `primed` skips the first callback, which fires synchronously
        // on `observe()` with the initial box size — without it, every
        // panel re-render would write the default 140 to localStorage
        // even when the user never touched the handle.
        //
        // The observer is pushed onto `_chartObservers` so the next
        // `_renderList()` can `disconnect()` it before replacing the
        // chart DOM nodes.
        try {
          let primed = false;
          const ro = new ResizeObserver(() => {
            if (!primed) {
              primed = true;
              return;
            }
            const h = chart.clientHeight;
            if (
              h >= PROFILE_CHART_MIN_HEIGHT_PX &&
              h <= PROFILE_CHART_MAX_HEIGHT_PX
            ) {
              storageSet(PROFILE_CHART_HEIGHT_KEY, String(Math.round(h)));
            }
          });
          ro.observe(chart);
          this._chartObservers.push(ro);
        } catch (err) {
          // ResizeObserver is unsupported (jsdom, very old browsers).
          // The chart still renders and resizes via CSS; only the
          // persistence path drops out — surface the diagnostic
          // instead of a silent swallow.
          console.warn(
            'OpenLiDARViewer: ResizeObserver unavailable; profile chart height will not persist across renders.',
            err,
          );
        }
      }
      // Sampler controls + caption (v0.4.5, B7/B8). The caption — the values
      // that ACTUALLY shaped the chart (corridor half-width, ground
      // percentile, sample count) — doubles as the disclosure summary so it
      // is always visible under the chart; opening it exposes the inputs.
      // Same provenance values the PDF header prints, so screen and sheet
      // can never disagree.
      const samplerBlock = this._buildSamplerControls(s, system);
      // Profile Intelligence summary (v0.4.5) — the civil headline numbers
      // beneath the chart, so length / gain / steepest section are readable
      // without exporting a PDF. Pure module computes; the panel only renders.
      // Description-list semantics so a screen reader pairs each label with
      // its value (the chart itself stays decorative/aria-hidden).
      const summary = computeProfileSummary(s.profileChart);
      const datumKnown = s.profileDatumKnown !== false;
      const reference = this._verticalReference(s);
      const summaryList = el('dl', {
        className: 'olv-mp-profile-summary',
        ariaLabel: `Profile summary for ${s.name}`,
      });
      for (const row of profileSummaryRows(summary, system, reference)) {
        summaryList.append(
          el('div', { className: 'olv-mp-summary-row' }, [
            el('dt', { className: 'olv-mp-summary-label', text: row.label }),
            el('dd', { className: 'olv-mp-summary-value', text: row.value }),
          ]),
        );
      }
      // In-panel station table (v0.4.5, B5) — collapsed by default so the
      // row stays compact, but the exact station/chainage/elevation values
      // are finally readable (and screen-reader reachable) WITHOUT exporting
      // a PDF. Built from `profileStationRows`, the same row model the CSV
      // writes, so the on-screen numbers and the export can never disagree.
      // This is also what makes the chart's aria-hidden honest: there is now
      // a real table in the DOM acting as the accessible source of truth.
      const stationRows = profileStationRows(s.profileChart, system);
      const unitLabel = system === 'metric' ? 'm' : 'ft';
      const heightHeader = heightLabel(reference);
      // Lazy <tbody> (v0.6 perf): the station table is collapsed by default and
      // most measurements are never expanded, yet a dense profile carries one
      // row per sample — building every <tr>/<td> up front spends DOM work on a
      // table the user usually never opens. The shared builder defers the row
      // build until the disclosure is first opened, then caches it (build
      // exactly once). The row MODEL (`stationRows`) is still computed eagerly
      // above so the summary count, the CSV and the PDF stay in lockstep.
      const { table: stationTable, build: buildStationRows } = buildStationTable(
        stationRows,
        unitLabel,
        s.name,
        heightHeader,
        stationCoupling,
        s.profileChart.map((sample) => sample.distance),
      );
      const stationDetails = el('details', { className: 'olv-mp-stations' }, [
        el('summary', {
          className: 'olv-mp-stations-summary',
          text: `Station table (${stationRows.length})`,
          title: 'Exact station / chainage / elevation / grade values — the same rows the CSV exports.',
        }),
        el('div', { className: 'olv-mp-stations-wrap' }, [stationTable]),
      ]);
      // Restore the reader's last disclosure state (default CLOSED). Setting
      // `.open` directly does not always dispatch `toggle` synchronously, so the
      // rows are built here rather than waited for.
      if (storageGet(PROFILE_STATIONS_OPEN_KEY) === '1') {
        stationDetails.open = true;
        buildStationRows();
      }
      // `toggle` fires on both open and close; build on open (self-guarded so the
      // body is materialised exactly once), and remember the state so a re-render
      // doesn't reset the reader's chosen layout. A collapsed <details> hides its
      // contents from the accessibility tree anyway, so deferring the rows costs
      // no screen-reader access — they exist by the time the table is read.
      stationDetails.addEventListener('toggle', () => {
        if (stationDetails.open) buildStationRows();
        storageSet(PROFILE_STATIONS_OPEN_KEY, stationDetails.open ? '1' : '0');
      });

      // Progressive disclosure: the Summary is the glanceable headline (open by
      // default), the station table the on-demand detail (closed). Both remember
      // their state per session so the panel reopens the way it was left.
      const summaryDetails = el('details', { className: 'olv-mp-summary-sec' }, [
        el('summary', {
          className: 'olv-mp-summary-sec-toggle',
          text: 'Summary',
          title: 'Length, gain and steepest section — the glanceable profile headline.',
        }),
        summaryList,
      ]);
      summaryDetails.open = storageGet(PROFILE_SUMMARY_OPEN_KEY) !== '0';
      summaryDetails.addEventListener('toggle', () => {
        storageSet(PROFILE_SUMMARY_OPEN_KEY, summaryDetails.open ? '1' : '0');
      });

      const children: HTMLElement[] = [
        headRow,
        confLine,
        chartWrap,
        vexStrip,
        ...(samplerBlock ? [samplerBlock] : []),
        summaryDetails,
        stationDetails,
      ];
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
      // A chart of local heights looks exactly like a chart of elevations, so
      // the only thing standing between the reader and a wrong number is this
      // line. Same slot and voice as the resident-node caveat above.
      if (!datumKnown) {
        children.push(
          el('div', {
            className: 'olv-mp-chart-caveat',
            text: DATUM_CONFLICT_MEASURE_NOTICE,
          }),
        );
      }
      // v0.3.10: explicit "Clear profile" action under the
      // chart. The per-row `×` delete button already removed any
      // measurement (including profiles), but it's a small icon at the
      // far right of the headline row and users reported they couldn't
      // find an obvious way to dismiss a finished profile. A bigger,
      // labelled button in the destructive rose vocabulary makes the
      // dismiss path discoverable at the moment of "I'm done with this
      // profile." Wires to the same controller delete callback.
      // v0.4.0 Profile-as-Deliverable — a full-page PDF (scaled chart +
      // station/elevation/grade table + civil summary) an engineer can
      // print and measure off. pdf-lib is dynamic-imported on click so it
      // stays out of the initial bundle.
      const pdfBtn = el('button', {
        className: 'olv-mp-profile-pdf',
        text: 'Export PDF',
        title: `Export ${s.name} as a scaled profile sheet (PDF)`,
        ariaLabel: `Export profile ${s.name} as PDF`,
      });
      pdfBtn.addEventListener('click', () => {
        pdfBtn.blur();
        void this._exportProfilePdf(s, pdfBtn);
      });
      // v0.4.5 — station-data CSV next to the PDF: the audit gap was "no
      // profile CSV, station table PDF-only". Pure builder, synchronous, no
      // lazy chunk needed.
      const csvBtn = el('button', {
        className: 'olv-mp-profile-pdf',
        text: 'CSV',
        title:
          `Export ${s.name} station data as CSV — ` +
          'station, chainage, ground height, corridor point count, grade.',
        ariaLabel: `Export profile ${s.name} station data as CSV`,
      });
      csvBtn.addEventListener('click', () => {
        csvBtn.blur();
        this._exportProfileCsv(s);
      });
      const clearAction = el('div', { className: 'olv-mp-row-action' }, [
        csvBtn,
        pdfBtn,
        el('button', {
          className: 'olv-mp-profile-clear',
          text: 'Clear profile',
          title: `Remove this profile (${s.name})`,
          ariaLabel: `Clear profile ${s.name}`,
        }),
      ]);
      const clearBtn = clearAction.lastElementChild as HTMLButtonElement;
      clearBtn.addEventListener('click', () => {
        clearBtn.blur();
        this._cb.onDelete(s.id);
      });
      children.push(clearAction);
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
      return el('div', { className: 'olv-mp-row-stack' }, [
        headRow,
        confLine,
        ...(breakdownLine ? [breakdownLine] : []),
        caveat,
      ]);
    }

    return el('div', { className: 'olv-mp-row-stack' }, [
      headRow,
      confLine,
      ...(breakdownLine ? [breakdownLine] : []),
    ]);
  }
}

/**
 * Render a profile chart as an inline SVG, deliverable-grade.
 *
 * v0.3.10 Profile-as-Deliverable stream — the prior renderer drew a
 * single line at 36 px tall with no grid, no axis labels, and no
 * station markers. That was fine for "confirm the profile exists" but
 * useless for "read the slope of segment 3." This version adds:
 *
 *   - Background grid (major + minor) keyed to a nice station
 *     interval (1 / 2 / 5 / 10 / 20 / 25 / 50 / 100 / … metres).
 *   - X-axis chainage labels at every major gridline.
 *   - Y-axis elevation labels at the top and bottom of the band.
 *   - Station tick marks above the X axis at every major chainage.
 *   - Vertical stretch applied to the Y mapping. v0.4.5 honesty (B3):
 *     this is a multiple of the FITTED scale, not a true paper ratio —
 *     `preserveAspectRatio="none"` stretches X and Y independently with
 *     the dragged panel size, so a stated "1:1" was never true. The
 *     control/badge now say "Fit / N× fit", relief leaving the band is
 *     clipped (SVG clip-path), and true 1:N scales live on the PDF.
 *   - The "what stretch is this" badge burned into the corner so a
 *     screenshot is unambiguous.
 *
 * NaN samples still split the line — a gap reads as a discontinuity,
 * not a phantom interpolation. The "no coverage" empty state is
 * preserved verbatim.
 *
 * Width is the panel's available column; vertical height comes from
 * the resizable wrapper (`.olv-mp-chart`). `preserveAspectRatio="none"`
 * stretches the viewBox to fill the box.
 */
/**
 * Monotonic counter for per-chart SVG clip-path ids. Clip-path ids are
 * document-global, and several profile rows can be in the DOM at once —
 * a fixed id would make every chart clip against whichever <defs> the
 * browser resolves first.
 */
let chartClipSeq = 0;

/**
 * Build the station table — a `<thead>` plus a lazily-populated `<tbody>` —
 * shared by the in-panel disclosure and the focus surface so both render the
 * identical rows from `profileStationRows` (the same model the CSV writes).
 * `build()` fills the body exactly once: the in-panel path defers it to the
 * first open (dense profiles carry one row per sample), the focus surface — a
 * deliberate "read the whole table" gesture — calls it eagerly.
 */
function buildStationTable(
  stationRows: readonly ProfileStationRow[],
  unitLabel: string,
  name: string,
  heightHeader: string,
  coupling?: StationHoverCoupling,
  rowChainages?: readonly number[],
): { table: HTMLElement; build: () => void } {
  const headerCells = [
    'Station',
    `Chainage (${unitLabel})`,
    `${heightHeader} (${unitLabel})`,
    'Points',
    'Grade (%)',
  ].map((h) => {
    const th = el('th', { className: 'olv-mp-stations-th', text: h });
    th.setAttribute('scope', 'col');
    return th;
  });
  const tbody = el('tbody');
  let built = false;
  // Couple rows to scene dots only when the host wired the hover callback AND
  // the per-row chainages are available to resolve each row to its nearest dot.
  const couple = coupling && coupling.stationChainages.length > 0 ? coupling : undefined;
  const build = (): void => {
    if (built) return;
    built = true;
    stationRows.forEach((r, i) => {
      // '' is an honest gap (blank in the CSV); the table shows an em dash so a
      // gap reads as "no data", not an empty cell.
      const dash = (v: string): string => (v === '' ? '—' : v);
      const tr = el('tr', {}, [
        el('td', { className: 'olv-mp-stations-td', text: r.station }),
        el('td', { className: 'olv-mp-stations-td', text: dash(r.chainage) }),
        el('td', { className: 'olv-mp-stations-td', text: dash(r.elevation) }),
        el('td', { className: 'olv-mp-stations-td', text: dash(r.points) }),
        el('td', { className: 'olv-mp-stations-td', text: dash(r.grade) }),
      ]);
      const chainage = rowChainages?.[i];
      if (couple && chainage !== undefined && Number.isFinite(chainage)) {
        const si = nearestStationIndex(couple.stationChainages, chainage);
        tr.dataset.si = String(si);
        bindStationHover(tr, si, couple);
      }
      tbody.append(tr);
    });
  };
  const table = el(
    'table',
    { className: 'olv-mp-stations-table', ariaLabel: `Station table for ${name}` },
    [el('thead', {}, [el('tr', {}, headerCells)]), tbody],
  );
  return { table, build };
}

function renderProfileChart(
  samples: readonly { distance: number; height: number }[],
  vex: number,
  system: 'metric' | 'imperial',
  coupling?: StationHoverCoupling,
): HTMLElement {
  // viewBox proportioned to the (taller-than-wide) chart box so that
  // `preserveAspectRatio="none"` barely distorts the text — the prior
  // 220×60 box stretched ~3.5× horizontally and the labels were
  // unreadable. A near-square unit keeps fonts legible at the doubled
  // panel height. v0.4.0.
  const W = 200;
  const H = 300;
  const PAD_X = 30; // Room for Y-axis (elevation) labels on the left.
  const PAD_TOP = 16;
  const PAD_BOTTOM = 26; // Room for X-axis (chainage) labels below.

  // Find data bounds across hit samples only.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of samples) {
    // A non-finite DISTANCE is excluded too (v0.4.5 crash guard): an
    // Infinity chainage would make `xSpan` infinite, and the station /
    // minor-grid walks below would then push gridlines forever — a frozen
    // tab, not a chart. Such a sample is corrupt; treat it as a gap.
    if (!Number.isFinite(s.height) || !Number.isFinite(s.distance)) continue;
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
  // VEX multiplier: visually scale the elevation axis by the
  // requested factor. The mapped Y still fills the same pixel band
  // (the renderer doesn't actually grow the viewBox — instead it
  // shrinks the apparent ySpan, which has the same visual effect of
  // exaggerating the curve in the available height).
  const ySpan = Math.max((yMax - yMin) / Math.max(0.0001, vex), 1e-9);

  // Drawable plot area.
  const plotLeft = PAD_X;
  const plotRight = W - 2;
  const plotTop = PAD_TOP;
  const plotBottom = H - PAD_BOTTOM;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // Walk samples and collect one point-run per contiguous hit run; a
  // NaN (no-coverage) bin breaks the run so a gap stays a discontinuity.
  const midY = (yMin + yMax) * 0.5;
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (const s of samples) {
    // Same corrupt-sample rule as the bounds scan above: a non-finite
    // distance OR height is a gap, never a plotted point.
    if (!Number.isFinite(s.height) || !Number.isFinite(s.distance)) {
      if (run.length) {
        runs.push(run);
        run = [];
      }
      continue;
    }
    const x = plotLeft + ((s.distance - xMin) / xSpan) * plotW;
    // Centre the (yMax+yMin)/2 line vertically when VEX > 1 so the
    // exaggeration grows around the midline rather than collapsing
    // to the top or bottom of the band.
    const dyVisual = (s.height - midY) / ySpan; // dimensionless
    // Invert: SVG y grows downward, but elevation grows upward.
    const y = plotTop + plotH * 0.5 - dyVisual * plotH;
    run.push({ x, y });
  }
  if (run.length) runs.push(run);

  // Render each run as a straight polyline between adjacent samples. Every
  // point on a segment lies between that segment's two endpoints, so the
  // chart cannot draw an elevation the corridor never reported. Gaps are
  // never bridged: a non-finite sample already ended the run above.
  const paths = runs.map((pts) => profilePolylinePath(pts));

  // Station spacing — civil convention. The walks are iteration-capped
  // (v0.4.5 crash guard): `xSpan` is finite by the bounds scan above, but a
  // float-accumulator loop inside a render path must be bounded by
  // construction — an unbounded push here is a frozen tab.
  const stationInterval = autoStationInterval(xSpan);
  const stations: number[] = [];
  for (let c = 0; c <= xSpan + 1e-9 && stations.length < 256; c += stationInterval) {
    stations.push(c);
  }
  // Minor grid: 5 divisions per major.
  const minorInterval = stationInterval / 5;
  const minorTicks: number[] = [];
  for (let c = 0; c <= xSpan + 1e-9 && minorTicks.length < 1280; c += minorInterval) {
    minorTicks.push(c);
  }

  // Visible (VEX-scaled) elevation band — the labels must report the band
  // actually drawn, not the data extremes, or the numbers wouldn't match the
  // line. v0.4.0.
  const visTop = midY + 0.5 * ySpan;
  const visBot = midY - 0.5 * ySpan;
  // Nice-number elevation ticks within the visible band (survey convention),
  // replacing the old ragged min/max-only pair. visualization-expert: a
  // readable axis is rounded, not raw.
  const yTicks = niceElevationTicks(visBot, visTop, 4);
  const elevDecimals = (() => {
    if (yTicks.length >= 2) {
      const st = Math.abs(yTicks[1] - yTicks[0]);
      if (st >= 1) return 0;
      if (st >= 0.1) return 1;
      return 2;
    }
    return 1;
  })();

  const formatChainage = (m: number): string => {
    if (system === 'imperial') {
      const ft = m * 3.28084;
      return ft >= 5280 ? `${(ft / 5280).toFixed(1)} mi` : `${Math.round(ft)} ft`;
    }
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  };
  // Imperial tick decimals (B9): rounding to whole feet collapsed adjacent
  // labels on sub-metre relief (a 0.2 m step is 0.66 ft — every tick read
  // the same number). Derive the decimal count from the tick STEP in feet,
  // same rule the metric branch applies to metres.
  const elevDecimalsFt = (() => {
    if (yTicks.length >= 2) {
      const stepFt = Math.abs(yTicks[1] - yTicks[0]) * 3.28084;
      if (stepFt >= 1) return 0;
      if (stepFt >= 0.1) return 1;
      return 2;
    }
    return 1;
  })();
  // Named for its job, not its shape: this is the CHART TICK label, which
  // picks its decimals from the axis step. It is deliberately not the shared
  // `formatElevation` — a name it once shadowed by coincidence.
  const elevTickLabel = (m: number): string => {
    if (system === 'imperial') return `${(m * 3.28084).toFixed(elevDecimalsFt)} ft`;
    return `${m.toFixed(elevDecimals)} m`;
  };

  // viewBox → box-fraction helpers (preserveAspectRatio="none" stretches the
  // viewBox to fill the box, so a viewBox fraction equals a box fraction —
  // which lets the HTML label overlay sit exactly on the SVG geometry without
  // sharing the SVG's text distortion).
  const xPct = (c: number): number => ((plotLeft + (c / xSpan) * plotW) / W) * 100;
  const yPct = (v: number): number =>
    ((plotTop + plotH * 0.5 - ((v - midY) / ySpan) * plotH) / H) * 100;

  // ── SVG layer: grid + ticks + path only (no text — text lives in the
  //    non-distorting HTML overlay below). z-order: minor → major → y-grid →
  //    frame rules → station caps → profile path.
  const minorGridParts = minorTicks
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}" stroke="currentColor" stroke-opacity="0.04" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  const majorGridParts = stations
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}" stroke="currentColor" stroke-opacity="0.10" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  // Horizontal gridlines at the nice elevation ticks.
  const yGridParts = yTicks
    .map((v) => {
      const y = plotTop + plotH * 0.5 - ((v - midY) / ySpan) * plotH;
      return `<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="currentColor" stroke-opacity="0.07" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  const yAxisRules =
    `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotRight}" y2="${plotTop}" stroke="currentColor" stroke-opacity="0.10" stroke-width="0.5" vector-effect="non-scaling-stroke"/>` +
    `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="currentColor" stroke-opacity="0.18" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
  const stationCaps = stations
    .map((c) => {
      const x = plotLeft + (c / xSpan) * plotW;
      return `<line x1="${x.toFixed(2)}" y1="${plotBottom - 2}" x2="${x.toFixed(2)}" y2="${plotBottom + 1}" stroke="currentColor" stroke-opacity="0.4" stroke-width="0.7" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');
  const pathParts = paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');

  // Clip the curve to the plot box (B3). At >1× vertical stretch the mapped
  // Y runs outside the visible band by construction; without a clip-path the
  // curve silently overdrew the axis labels and chart frame, which made the
  // stretch look like a rendering bug rather than a deliberate crop. The id
  // is per-chart (module counter) — multiple profile rows share one DOM and
  // SVG clip-path ids are document-global.
  const clipId = `olv-mp-clip-${chartClipSeq++}`;
  const clipDef =
    `<defs><clipPath id="${clipId}">` +
    `<rect x="${plotLeft}" y="${plotTop}" width="${plotW}" height="${plotH}"/>` +
    `</clipPath></defs>`;

  // Station hover coupling (optional): one transparent hit-zone per visible
  // station tick, tiled to the midpoints of its neighbours so every x in the
  // plot maps to exactly one tick. Each zone's `data-si` is the SCENE dot
  // nearest that tick's chainage, so hovering the chart brightens the matching
  // 3D marker. Zones stop at `plotBottom`, clear of the X labels and the native
  // resize grip below. Rendered last so they sit above the grid/path for
  // pointer-events; visually invisible (transparent fill).
  let hitParts = '';
  if (coupling && coupling.stationChainages.length > 0 && stations.length > 0) {
    const tickX = stations.map((c) => plotLeft + (c / xSpan) * plotW);
    hitParts = stations
      .map((c, i) => {
        const cx = tickX[i];
        const left = i === 0 ? plotLeft : (tickX[i - 1] + cx) / 2;
        const right = i === stations.length - 1 ? plotRight : (cx + tickX[i + 1]) / 2;
        const si = nearestStationIndex(coupling.stationChainages, c);
        return `<rect class="olv-mp-chart-hit" data-si="${si}" x="${left.toFixed(2)}" y="${plotTop}" width="${Math.max(0, right - left).toFixed(2)}" height="${plotH}" fill="transparent" pointer-events="all"/>`;
      })
      .join('');
  }

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${clipDef}${minorGridParts}${majorGridParts}${yGridParts}${yAxisRules}${stationCaps}<g clip-path="url(#${clipId})">${pathParts}</g>${hitParts}
  </svg>`;

  // ── HTML overlay: every numeral, in the brand mono with tabular figures,
  //    positioned by box-fraction so it never inherits the SVG's horizontal
  //    stretch. Decorative (aria-hidden) — the collapsible station TABLE the
  //    panel renders beneath the summary (v0.4.5, B5) is the screen-reader
  //    source of truth for exact station/elevation values.
  const MAX_X_LABELS = 6;
  const lastIdx = stations.length - 1;
  const labelStride = Math.max(1, Math.ceil(stations.length / MAX_X_LABELS));
  // X labels sit just below the plot floor; expressed as a box-fraction so the
  // gap tracks the axis at any chart height.
  const xLabelTop = (((plotBottom + 6) / H) * 100).toFixed(2);
  // Stride first as a density cap, then fit, because the two answer different
  // questions: the stride is how many labels an axis should carry, and the fit
  // is which of those the axis has room for.
  //
  // The width below is a bound, not a measurement. This string is built before
  // the overlay is in a document, so the chart's real width cannot be read
  // here, and the two errors are not symmetric: believing the chart WIDER than
  // it is keeps a pair that then overprints, while believing it narrower costs
  // a tick mark the station table underneath still carries. So the fit runs
  // against the chart's CSS floor rather than its usual size. A wide chart
  // therefore carries fewer labels than it could, which is the price of never
  // overprinting at any width. `axisLabelWidth` errs wide for the same reason.
  const MIN_CHART_PX = 180;
  const AXIS_FONT_PX = 11;
  const candidates = stations
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => i === lastIdx || i % labelStride === 0);
  const texts = candidates.map(({ c }) => formatChainage(c));
  const keep = fitAxisLabels({
    labels: texts,
    pixels: candidates.map(({ c }) => (xPct(c) / 100) * MIN_CHART_PX),
    containerPx: MIN_CHART_PX,
    fontPx: AXIS_FONT_PX,
    // The overlay anchors its end labels inside the plot, so the fit has to
    // judge them the same way or it drops the label carrying the extent.
    ends: 'pulled-in',
  });
  const xLabelHtml = candidates
    .map(({ c, i }, k) => {
      if (!keep[k]) return '';
      // The end labels are pulled inside the plot so neither overhangs it.
      const tx = i === 0 ? '0' : i === lastIdx ? '-100%' : '-50%';
      return `<span class="olv-mp-axis olv-mp-axis-x" style="left:${xPct(c).toFixed(2)}%;top:${xLabelTop}%;transform:translateX(${tx})">${texts[k]}</span>`;
    })
    .join('');
  const yLabelHtml = yTicks
    .map(
      (v) =>
        `<span class="olv-mp-axis olv-mp-axis-y" style="top:${yPct(v).toFixed(2)}%">${elevTickLabel(v)}</span>`,
    )
    .join('');
  // Honest badge (B3): "VEX 5:1" implied a true paper ratio the resizable,
  // independently-stretched chart cannot promise. "5× fit" states what the
  // mapping really is — five times the fitted elevation scale.
  const vexLabel = vex === 1 ? 'Fit' : `${vex}× fit`;
  const vexBadge = `<span class="olv-mp-axis olv-mp-vex-badge">${vexLabel}</span>`;
  const overlay = `<div class="olv-mp-chart-labels" aria-hidden="true">${yLabelHtml}${xLabelHtml}${vexBadge}</div>`;

  const trueSpan = yMax - yMin;
  // Δh through the shared formatter so it carries its unit in both unit
  // systems (B9 — this tooltip used to hardcode "m" in imperial mode).
  const title =
    `${samples.length} samples · Δh ${formatLength(trueSpan, system)} · ` +
    `station interval ${formatChainage(stationInterval)} · vertical ${vexLabel} · ` +
    `drag bottom-right to resize`;
  const chartEl = el('div', { className: 'olv-mp-chart', unsafeHtml: svg + overlay, title });
  if (hitParts) {
    // The zones live in the just-assigned innerHTML; bind each to its `data-si`.
    for (const hit of Array.from(chartEl.querySelectorAll('.olv-mp-chart-hit'))) {
      const si = Number(hit.getAttribute('data-si'));
      if (Number.isInteger(si) && si >= 0) bindStationHover(hit, si, coupling!);
    }
  }
  return chartEl;
}
