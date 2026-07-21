/**
 * MeasureController.ts
 *
 * The measurement toolkit's orchestrator. It owns the placed measurements,
 * the in-progress draft, the active measurement kind, the live-preview
 * cursor, the kind-picker toolbar, and the instruction hint; it delegates
 * all SVG drawing to `MeasureOverlay`.
 *
 * The straight-line distance tool is preserved exactly as the `distance`
 * kind so its long-standing behaviour does not regress. Browser-bound
 * (DOM): not imported in Node tests. The measurement maths it relies on is
 * the pure, unit-tested `geometry.ts` / `format.ts`.
 */

import type * as THREE from 'three/webgpu';
import { el } from '../../ui/dom';
import {
  KIND_ICON,
  ICON_UNDO,
  ICON_UNITS,
  ICON_DONE,
  ICON_FINISH,
  ICON_CLEAR,
} from './measureIcons';
import type { Vec3 } from '../navMath';
import type {
  Measurement,
  MeasurementKind,
  ProfileChartSample,
  UnitSystem,
  VolumeRecord,
} from './types';
import { MIN_POINTS, isFull } from './types';
import {
  distance,
  bearingDegrees,
  polylineLength,
  polygonAreaPlanar,
  polygonAreaHorizontal,
  verticalDelta,
  slopeBetween,
  angleAtVertex,
  profileMetrics,
  boxFromCorners,
  boxMetrics,
  boxCorners,
  BOX_EDGES,
  elevationDatumOffset,
} from './geometry';
import {
  buildPointSnapIndex,
  snapToNearestPoint,
  snapBest,
  countPointsWithinRadius,
  type PointSnapIndex,
  type SnapResult,
  type Segments,
} from './snap';
import { gradeMeasurement, type MeasurementTrust } from './measurementTrust';
import {
  formatLengthRender,
  formatAreaRender,
  formatAngle,
  formatBearing,
  formatGrade,
  formatProfileHeadline,
  formatBoxHeadline,
  formatVolume,
  GEOGRAPHIC_CRS_MEASURE_NOTICE,
  VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE,
} from './format';
// B2 (v0.4.5) — one unit seam: the chart series is converted render-units →
// metres in `getSummaries` by the same module the panel/CSV/PDF read, so
// labels and raw numerals can never drift apart.
import { scaleProfileSamples } from './profileSummary';
import { stationsAlongLine } from './profileStations';
// B7/B8 (v0.4.5) — pure clamp + unit conversion for the resample path, read
// from the sampler module so panel inputs, clamp and tests share one rule.
// The encode/decode pair is the persistence seam: the user's last-applied
// sampler parameters survive a reload and shape the next profile drawn.
import {
  PROFILE_SAMPLER_DEFAULTS_KEY,
  decodeSamplerParams,
  encodeSamplerParams,
  normaliseResampleParams,
} from './profileSampler';
// Guarded localStorage access — the same seam every UI preference uses;
// storage failures degrade to "the preference doesn't persist", never throw.
import { storageGet, storageSet } from '../../ui/safeStorage';
import { autoReferenceZ } from './volume';
import { MeasureOverlay } from './MeasureOverlay';
import type {
  OverlayModel,
  OverlayVertex,
  OverlayEdge,
  OverlayPolygon,
  OverlayLabel,
} from './MeasureOverlay';

/** Touch devices say "Tap" rather than "Click" in the instruction hint. */
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const VERB = COARSE_POINTER ? 'Tap' : 'Click';
const VERB_LOWER = VERB.toLowerCase();

/** Inline crosshair glyph for the snap toggle (kept local to avoid touching the icon set). */
const SNAP_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
  'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="6"/><path d="M12 2v3"/><path d="M12 19v3"/>' +
  '<path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';

/** Display name per kind, for default measurement names and the picker. */
const KIND_LABEL: Record<MeasurementKind, string> = {
  distance: 'Distance',
  polyline: 'Polyline',
  area: 'Area',
  height: 'Height',
  angle: 'Angle',
  slope: 'Slope',
  profile: 'Profile',
  box: 'Box',
  volume: 'Volume',
};

/** Hover hints — what each tool measures + how to exit back to navigation. */
const KIND_TITLE: Record<MeasurementKind, string> = {
  distance:
    'Distance — straight line between two picked points.\n' +
    '• Click two points on the cloud.\n' +
    '• Click the kind again or press Esc to exit back to navigation.',
  polyline:
    'Polyline — total length of a multi-point path.\n' +
    '• Click points one by one.\n' +
    '• Finish: click the first vertex, double-click, press Enter, or use the Finish polygon button.\n' +
    '• Backspace removes the last vertex.\n' +
    '• Click the kind again or press Esc to exit.',
  area:
    'Area — polygon area, both plane (vector/Newell) and horizontal.\n' +
    '• Click 3+ points to outline the shape.\n' +
    '• Close: click the first vertex, double-click, press Enter, or use the Finish polygon button.\n' +
    '• Backspace removes the last vertex.\n' +
    '• Click the kind again or press Esc to exit.',
  height:
    'Height — vertical difference between two points.\n' +
    '• Click two points; the vertical separation is the height.\n' +
    '• Click the kind again or press Esc to exit.',
  angle:
    'Angle — the angle at a vertex between two arms.\n' +
    '• Click three points: arm 1 → vertex → arm 2.\n' +
    '• Click the kind again or press Esc to exit.',
  slope:
    'Slope — rise, run, grade and inclination between two points.\n' +
    '• Click two points; the slope of the line is computed.\n' +
    '• Click the kind again or press Esc to exit.',
  profile:
    'Profile — cross-section line: 3D length, horizontal distance, vertical drop, and grade.\n' +
    '• Click two points to define the profile line.\n' +
    '• Click the kind again or press Esc to exit.',
  box:
    'Box — axis-aligned slice: width × depth × height with volume, ready for clipping.\n' +
    '• Click two opposite corners of a diagonal.\n' +
    '• Click the kind again or press Esc to exit.',
  volume:
    'Volume — polygon footprint + reference height: cut, fill and net in cubic metres.\n' +
    '• Click 3+ points to outline a footprint.\n' +
    '• Close: click the first vertex, double-click, press Enter, or use the Finish polygon button.\n' +
    '• Backspace removes the last vertex.\n' +
    '• Or use the Lasso button to draw a freeform shape instead.\n' +
    '• Click the kind again or press Esc to exit.',
};

/** Short one-liners shown by the custom hover tooltip. */
const KIND_TIP: Record<MeasurementKind, string> = {
  distance: 'Distance · straight line',
  polyline: 'Polyline · path length',
  area: 'Area · polygon',
  height: 'Height · vertical Δ',
  angle: 'Angle · at vertex',
  slope: 'Slope · rise ∕ run',
  profile: 'Profile · cross-section',
  box: 'Box · slice volume',
  volume: 'Volume · cut & fill',
};

/** Kind order for the picker buttons. */
const KIND_ORDER: MeasurementKind[] = [
  'distance',
  'polyline',
  'area',
  'height',
  'angle',
  'slope',
  'profile',
  'box',
  'volume',
];

/** Hooks the controller calls back into. */
export interface MeasureCallbacks {
  /** The user dismissed the tool (the "Done" button). */
  onExit: () => void;
}

/**
 * The profile sampler's structured return shape. `samples` is the
 * height-vs-distance polyline in RENDER (source) units; `residentOnly` flags
 * a streaming-resident-only walk. `corridorWidth` (render units) and
 * `groundPercentile` are the sampler parameters that actually shaped the
 * estimate — stamped onto the measurement so the PDF/CSV provenance prints
 * real values (v0.4.5, B4). Both optional for older sampler wirings.
 */
export interface ProfileSamplerResult {
  samples: ProfileChartSample[];
  residentOnly: boolean;
  corridorWidth?: number;
  groundPercentile?: number;
}

/**
 * User overrides forwarded to the profile sampler (B7/B8, v0.4.5). All fields
 * are in RENDER (source) units / raw values — the controller converts the
 * panel's metre input before building this. Null/absent fields mean "use the
 * standing default" (auto 5 %-of-length corridor, p25, 64 bins).
 */
export interface ProfileSamplerOptions {
  corridorWidth?: number | null;
  groundPercentile?: number | null;
  sampleCount?: number | null;
}

/**
 * The MeasurePanel's resample request (B7/B8, v0.4.5). Corridor half-width is
 * in METRES (the display/CSV unit) — the controller converts it back to
 * render units through the same B2 factor the summaries apply forward, so a
 * foot-CRS scan resamples the corridor the user actually asked for. Null
 * fields reset that parameter to its default.
 */
export interface ProfileResampleParams {
  corridorWidthM?: number | null;
  groundPercentile?: number | null;
  sampleCount?: number | null;
}

/** A compact, display-ready summary of one measurement, for the panel. */
export interface MeasurementSummary {
  id: string;
  kind: MeasurementKind;
  name: string;
  value: string;
  /**
   * The per-measurement honesty grade (red/yellow/green + reasons + refusal
   * flag). The Measurements panel renders it as a trust dot, a "why?" detail,
   * and — when not presentable — de-emphasises the number. Absent when no cloud
   * was loaded to grade against.
   */
  trust?: MeasurementTrust;
  /**
   * Profile only — height-vs-distance samples, used by the Measurements
   * panel to render a chart strip beneath the headline row. Optional; a
   * profile measurement loaded from a pre-chart session file omits this
   * field and the panel simply skips the chart.
   */
  profileChart?: ProfileChartSample[];
  /**
   * Profile only — when true, the chart was sampled from streaming
   * resident nodes only. The panel surfaces a coverage caption so the
   * analyst understands the line may refine as more nodes stream in.
   */
  profileChartResidentOnly?: boolean;
  /**
   * Profile only — false when the scene could not assert a vertical datum
   * (clouds recentred on conflicting origins), so `profileChart` heights are
   * LOCAL render heights rather than source elevations. Every consumer that
   * PRINTS an absolute height must name it accordingly; deltas are unaffected.
   * Absent on a summary built before the gate, which reads as "known" — the
   * pre-gate behaviour.
   */
  profileDatumKnown?: boolean;
  /**
   * Profile only — the corridor half-width the sampler actually used, in
   * METRES (already through the B2 unit factor). Feeds the PDF's provenance
   * rows/header so the sheet stops printing "auto (5 % of length)" when the
   * true value is known. Optional: pre-v0.4.5 measurements never stored it.
   */
  profileCorridorWidthM?: number;
  /** Profile only — the sampler's bare-earth percentile (dimensionless). */
  profileGroundPercentile?: number;
  /**
   * Volume only — when true, the cut/fill record was sampled from
   * streaming resident nodes only. The panel surfaces a coverage caption
   * beneath the volume headline so the analyst understands the cubic
   * metres figure may refine as more nodes stream in.
   */
  volumeResidentOnly?: boolean;
}

export class MeasureController {
  /** The SVG overlay element — append to the stage overlay. */
  readonly overlay: SVGSVGElement;
  /** The measurement toolbar shown while measuring — append to the overlay. */
  readonly hint: HTMLElement;

  private readonly _cb: MeasureCallbacks;
  private readonly _draw = new MeasureOverlay();
  private readonly _hintEl: HTMLElement;
  private readonly _clearBtn: HTMLButtonElement;
  private readonly _unitsBtn: HTMLButtonElement;
  /** Finish-polygon button — shown only while a polygon draft is open. */
  private _finishBtn: HTMLButtonElement | null = null;
  private readonly _kindButtons = new Map<MeasurementKind, HTMLButtonElement>();
  /**
   * The kind picker row container — exposed so the host can inject
   * complementary tool buttons (e.g. Lasso volume) next to the
   * built-in measurement kinds without forking the controller.
   * Populated in the constructor.
   */
  private _kindRow: HTMLElement | null = null;
  private _onChange: (() => void) | null = null;
  /** Called when the unit system changes — used to persist the preference. */
  private _onUnitChange: (() => void) | null = null;
  /** Called when the active measurement kind changes (e.g. user picks Profile). */
  private _onKindChange: ((kind: MeasurementKind) => void) | null = null;

  /** Re-picks a cloud point at the given NDC — injected by the Viewer. */
  private _picker: ((ndcX: number, ndcY: number) => Vec3 | null) | null = null;
  /**
   * Profile sampler — injected by the Viewer once a cloud is attached.
   * The controller calls this when a Profile measurement commits, and
   * the returned series is stamped onto the measurement record as
   * `profileChart`. `null` means "no cloud loaded" or "sampling failed";
   * the panel falls back to the scalar metrics row in that case.
   */
  /**
   * Profile sampler return shape. `samples` is the height-vs-distance
   * polyline; `residentOnly` is true when the cloud is streaming and the
   * walk only touched resident-node positions. The Measurements panel
   * surfaces the resident-only flag as a coverage caption so the analyst
   * knows the profile may refine as more nodes stream in.
   *
   * For backwards compatibility the sampler may also return a plain
   * sample array; the controller wraps it as `{samples, residentOnly: false}`.
   */
  private _profileSampler:
    | ((
        a: Vec3,
        b: Vec3,
        opts?: ProfileSamplerOptions,
      ) => ProfileChartSample[] | ProfileSamplerResult | null)
    | null = null;
  /**
   * Volume sampler — injected by the Viewer once a cloud is attached.
   * Called when a Volume measurement commits.
   *
   * Returns either:
   *   - a plain `VolumeRecord` (back-compat), or
   *   - `{ record, residentOnly }` so the panel can surface a
   *     "Resident-node analysis only — value may refine as streaming loads"
   *     caption when the cloud is still streaming.
   *
   * `null` means "no cloud loaded" or "sampling failed"; the panel shows
   * a "—" cut/fill.
   */
  private _volumeSampler:
    | ((
        polygon: ReadonlyArray<Vec3>,
        referenceZ: number,
      ) => VolumeRecord | { record: VolumeRecord; residentOnly: boolean } | null)
    | null = null;
  /** The handle being dragged: a measurement id and vertex index. */
  private _drag: { id: string; vi: number } | null = null;
  private _dragNdcX = 0;
  private _dragNdcY = 0;
  private _dragDirty = false;
  private readonly _onDragMove: (e: PointerEvent) => void;
  private readonly _onDragUp: () => void;

  /** Completed measurements. */
  private _measurements: Measurement[] = [];
  /** The measurement currently being placed, if any. */
  private _draft: Measurement | null = null;
  /** The active measurement kind new drafts are created as. */
  private _kind: MeasurementKind = 'distance';
  /** The live-preview point under the cursor, or null when off the cloud. */
  private _cursor: Vec3 | null = null;
  private _active = false;
  private _worldUp: Vec3 = [0, 0, 1];
  /**
   * The up-axis component of the scene's render origin — what a render-local
   * height must regain to become a source elevation (see
   * `elevationDatumOffset`). Applied at the `getSummaries` display boundary
   * only: measurement geometry stays local so the session importer's rebase
   * keeps working.
   *
   * `null` is the scene REFUSING a datum: clouds recentred on conflicting
   * origins share no frame, so no absolute elevation is defensible and the
   * profile surfaces fall back to naming their heights local. 0 until a cloud
   * arrives, which is also the honest answer for a scan at the world origin.
   */
  private _originUp: number | null = 0;
  private _units: UnitSystem = 'metric';
  /**
   * Render-units → metres factor from the scan's CRS (B2, v0.4.5). Render
   * space keeps SOURCE units — a foot-CRS LAS stores feet — so every readout
   * the controller emits passes through this factor exactly once: lengths
   * ×f, areas ×f², volumes ×f³, and the profile chart series at the
   * `getSummaries` boundary. 1 for metric / local / unknown CRSs (the
   * pre-B2 behaviour).
   */
  private _unitToMetres = 1;
  /**
   * Render-units → metres factor for the UP axis, from a COMPOUND CRS whose
   * vertical (height) unit differs from its horizontal linear unit — e.g. UTM
   * metres with a NAVD88 height in US survey feet. `null` means "no separate
   * vertical unit was supplied", so the up axis rides the horizontal
   * `_unitToMetres` exactly as before (the pre-fix behaviour, bit-identical).
   * When set and different, pure-vertical readouts (heights, box height,
   * cut/fill thickness) scale by THIS factor while the mixed 3D quantities
   * refuse — see {@link _verticalUnitMismatch}.
   */
  private _verticalUnitToMetres: number | null = null;
  // ── Snap (A1) ──────────────────────────────────────────────────────────────
  // Snapping a placed vertex to the nearest real return (honest default) or to
  // existing measurement geometry. `_snapIndex` is built from the resident
  // cloud on load; `_lastSnap` drives the disclosure in the hint. The camera +
  // canvas are cached each frame so the place handler can size the snap radius.
  private static readonly SNAP_RADIUS_PX = 14;
  private _snapMode: 'off' | 'point' | 'geometry' = 'off';
  private _snapIndex: PointSnapIndex | null = null;
  private _lastSnap: SnapResult | null = null;
  // Whether the active scan has a known CRS with real-world units. Separate from
  // `_unitToMetres` (which is 1 for a metric CRS AND a CRS-less cloud).
  private _crsKnown = false;
  /**
   * True when the active scan's CRS is GEOGRAPHIC (degrees). Degrees are not
   * a linear unit — X/Y in degrees with Z in metres means no scalar
   * `unitToMetres` can make lengths/areas/grades honest — so the stack keeps
   * measuring in raw render units (factor 1) but SAYS SO everywhere: the
   * hint bar carries {@link GEOGRAPHIC_CRS_MEASURE_NOTICE}, the panel shows
   * its persistent caveat, and every affected measurement's trust grade is
   * the red refusal (see {@link gradeMeasurement}).
   */
  private _geographicCrs = false;
  private _lastCamera: THREE.PerspectiveCamera | null = null;
  private _lastCanvas: HTMLCanvasElement | null = null;
  private _snapBtn: HTMLButtonElement | null = null;
  private readonly _counters: Record<MeasurementKind, number> = {
    distance: 0,
    polyline: 0,
    area: 0,
    height: 0,
    angle: 0,
    slope: 0,
    profile: 0,
    box: 0,
    volume: 0,
  };

  constructor(callbacks: MeasureCallbacks) {
    this._cb = callbacks;
    this.overlay = this._draw.element;

    // ── Kind picker — one button per measurement kind ─────────────────────
    const kindRow = el('div', { className: 'olv-mkinds' });
    for (const k of KIND_ORDER) {
      const btn = el('button', {
        className: 'olv-mkind olv-mkind-icon',
        unsafeHtml: KIND_ICON[k] + `<span class="olv-mkind-name">${KIND_LABEL[k]}</span>`,
        title: KIND_TITLE[k],
        tip: KIND_TIP[k],
        ariaLabel: KIND_LABEL[k],
      });
      btn.addEventListener('click', () => {
        btn.blur();
        // Clicking the SAME kind that's already active exits the
        // measure mode entirely — this is the "Click the kind again
        // or press Esc to exit" affordance documented in the
        // tooltip. The user gets back to free navigation with one
        // click on a button they already know how to find.
        if (this._kind === k) {
          this._cb.onExit();
        } else {
          this.setKind(k);
        }
      });
      this._kindButtons.set(k, btn);
      kindRow.append(btn);
    }
    // Stash the row for the host to append complementary buttons.
    this._kindRow = kindRow;

    // ── Instruction text + action buttons ─────────────────────────────────
    this._hintEl = el('span', { className: 'olv-measure-hint-text' });

    const undoBtn = el('button', {
      className: 'olv-measure-undo olv-micon-btn',
      unsafeHtml: ICON_UNDO + '<span class="olv-mlabel">Undo</span>',
      title: 'Remove the last point you placed (or press Backspace).',
      tip: 'Undo last point · ⌫',
      ariaLabel: 'Undo last point',
    });
    undoBtn.addEventListener('click', () => {
      undoBtn.blur();
      this.undoLastPoint();
    });
    // Finish polygon — shown only while a polygon-kind draft is open
    // (area / volume / polyline / profile). The button is the touch
    // equivalent of double-click / Enter and the explicit
    // discoverability surface — desktop users with no tooltip
    // reading habit still see how to close the shape.
    this._finishBtn = el('button', {
      className: 'olv-measure-finish olv-micon-btn olv-hidden',
      unsafeHtml: ICON_FINISH + '<span class="olv-mlabel">Finish</span>',
      title:
        'Close the in-progress polygon and compute the result.\n' +
        '• Same as double-clicking the cloud or pressing Enter.',
      tip: 'Finish polygon · ↵',
      ariaLabel: 'Finish polygon',
    });
    this._finishBtn.addEventListener('click', () => {
      this._finishBtn?.blur();
      this.finishCurrent();
    });
    this._clearBtn = el('button', {
      className: 'olv-measure-clear olv-micon-btn olv-hidden',
      unsafeHtml: ICON_CLEAR + '<span class="olv-mlabel">Clear</span>',
      title: 'Delete every measurement on the scan',
      tip: 'Clear all measurements',
      ariaLabel: 'Clear all measurements',
    });
    this._clearBtn.addEventListener('click', () => {
      this._clearBtn.blur();
      this.clear();
    });
    this._unitsBtn = el('button', {
      className: 'olv-units-toggle olv-micon-btn',
      unsafeHtml: ICON_UNITS + '<span class="olv-mlabel">Metric</span>',
      title: 'Switch all readouts between metric and imperial units',
      tip: 'Units · metric ⇄ imperial',
      ariaLabel: 'Units: Metric',
    });
    this._unitsBtn.addEventListener('click', () => {
      this._unitsBtn.blur();
      this.setUnitSystem(this._units === 'metric' ? 'imperial' : 'metric');
    });
    // Snap toggle — cycles Off → Point → Geometry. "Point" snaps a placed
    // vertex to the nearest real return; "Geometry" also snaps to existing
    // measurement vertices / midpoints / intersections. The hint discloses what
    // each placement snapped to, so a snap never implies a return that isn't one.
    const snapBtn = el('button', {
      className: 'olv-measure-snap olv-micon-btn',
      unsafeHtml: SNAP_ICON + '<span class="olv-mlabel">Snap: Off</span>',
      title:
        'Snap placed points to the nearest scan return (Point) or also to ' +
        'existing measurement geometry (Geometry).',
      tip: 'Snap · off ⇄ point ⇄ geometry',
      ariaLabel: 'Snap: off',
    }) as HTMLButtonElement;
    snapBtn.addEventListener('click', () => {
      snapBtn.blur();
      this._cycleSnapMode();
    });
    this._snapBtn = snapBtn;
    const doneBtn = el('button', {
      className: 'olv-measure-done olv-micon-btn',
      unsafeHtml: ICON_DONE + '<span class="olv-mlabel">Done</span>',
      title:
        'Done — finish the current measurement and return to navigation.\n' +
        '• Same as pressing Esc, or clicking the active kind a second time.',
      tip: 'Done · exit to navigation · Esc',
      ariaLabel: 'Done measuring',
    });
    doneBtn.addEventListener('click', () => {
      doneBtn.blur();
      this.finishCurrent();
      this._cb.onExit();
    });

    this.hint = el('div', { className: 'olv-measure-bar olv-hidden' }, [
      kindRow,
      el('div', { className: 'olv-measure-hint-row' }, [
        el('span', { className: 'olv-measure-badge', text: 'Measure' }),
        this._hintEl,
      ]),
      el('div', { className: 'olv-measure-actions' }, [
        undoBtn,
        this._finishBtn,
        this._clearBtn,
        snapBtn,
        this._unitsBtn,
        doneBtn,
      ]),
    ]);

    // The toolbar uses a custom, styled hover tooltip (CSS `data-tip`). To stop
    // the browser's native `title` bubble from doubling up, strip `title` while
    // a control is hovered/focused and restore it on leave — the rich `title`
    // text stays the canonical accessible/help string the rest of the time.
    const stripNative = (e: Event): void => {
      const btn = (e.target as HTMLElement | null)?.closest('button') as
        | HTMLElement
        | null;
      if (btn && btn.title) {
        btn.dataset.nativeTitle = btn.title;
        btn.removeAttribute('title');
      }
    };
    const restoreNative = (e: Event): void => {
      const btn = (e.target as HTMLElement | null)?.closest('button') as
        | HTMLElement
        | null;
      if (btn && btn.dataset.nativeTitle != null) {
        btn.title = btn.dataset.nativeTitle;
        delete btn.dataset.nativeTitle;
      }
    };
    this.hint.addEventListener('pointerover', stripNative);
    this.hint.addEventListener('pointerout', restoreNative);
    this.hint.addEventListener('focusin', stripNative);
    this.hint.addEventListener('focusout', restoreNative);

    this._renderKindButtons();

    // Handle dragging: a pointerdown on a vertex handle starts an edit drag.
    this._onDragMove = (e) => this._handleDragMove(e);
    this._onDragUp = () => this._endDrag();
    this._draw.element.addEventListener('pointerdown', (e) => this._handlePointerDown(e));
  }

  /** Whether measurement mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /** The active measurement kind. */
  get kind(): MeasurementKind {
    return this._kind;
  }

  /** The active unit system. */
  get unitSystem(): UnitSystem {
    return this._units;
  }

  /** The render-units → metres factor currently applied (1 = metres/local). */
  get unitToMetres(): number {
    return this._unitToMetres;
  }

  /**
   * The VERTICAL render-units → metres factor (up-axis height unit). Equals
   * {@link unitToMetres} on a single-unit CRS; differs only for a compound CRS
   * (e.g. metre eastings over foot heights). Exporters scale vertical
   * quantities by this so a `.geojson`/`.csv`/`.kml` matches the panel headline.
   */
  get verticalUnitToMetres(): number {
    return this._verticalUnitToMetres ?? this._unitToMetres;
  }

  /** The world up vector measurements were placed against (for export derivations). */
  get worldUp(): Vec3 {
    return this._worldUp;
  }

  /**
   * Inject the scan CRS's linear-unit → metres factor — the SAME seam the
   * terrain/space paths read (`crsService.current().linearUnitToMetres`).
   * Applying it here, at the controller boundary, keeps headline labels,
   * overlay labels, the chart series, the summary block, the CSV and the
   * PDF in lockstep; a format-only seam would convert the labels while the
   * chart's raw numerals (ticks, stationing, CSV columns) stayed behind.
   * Invalid factors (NaN, 0, negative) fall back to 1 — mislabelled-as-
   * metres is the known pre-B2 behaviour; scaling by garbage is worse.
   */
  setUnitToMetres(factor: number): void {
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    if (f === this._unitToMetres) return;
    this._unitToMetres = f;
    // A late horizontal resolve can change whether the vertical factor now
    // mismatches, so re-grade alongside the label refresh.
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    // Stored geometry is untouched (render units stay the source of truth);
    // re-emit so every label and the panel re-derive through the new factor.
    this._updateHint();
    this._emitChange();
  }

  /**
   * Inject the scan CRS's VERTICAL (up-axis) linear-unit → metres factor — the
   * companion to {@link setUnitToMetres} for a COMPOUND CRS. On the common
   * single-unit CRS this equals the horizontal factor and every readout is
   * bit-identical to the pre-compound behaviour; when it differs, heights and
   * other pure-vertical readouts scale by this factor and the mixed 3D
   * quantities refuse (see {@link _gradeMeasurement}). Invalid factors (NaN, 0,
   * negative) clear the override so the up axis rides the horizontal factor.
   */
  setVerticalUnitToMetres(factor: number): void {
    const next = Number.isFinite(factor) && factor > 0 ? factor : null;
    if (next === this._verticalUnitToMetres) return;
    this._verticalUnitToMetres = next;
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /** The effective up-axis factor — the vertical override, else the horizontal. */
  private _effVertical(): number {
    return this._verticalUnitToMetres ?? this._unitToMetres;
  }

  /**
   * True when a separate vertical unit was supplied AND it differs from the
   * horizontal one — the compound-CRS case where a 3D length / tilted area /
   * grade mixes two linear units. Pure-vertical readouts stay honest via
   * {@link _effVertical}; the mixed kinds refuse.
   */
  private _verticalUnitMismatch(): boolean {
    const v = this._verticalUnitToMetres;
    return v != null && Math.abs(v - this._unitToMetres) > 1e-12;
  }

  /**
   * Kinds whose headline NUMBER combines horizontal and vertical extent, so a
   * single vertical factor can't repair it under a compound CRS: 3D lengths
   * (distance / polyline / profile), a tilted planar area, and a slope grade.
   * Pure-vertical (height) and per-axis-monomial (box / volume) kinds are
   * exactly rescaled instead, so they are absent here — mirrors how the
   * geographic refusal spares heights and angles.
   */
  private static readonly VERTICAL_MISMATCH_KINDS: ReadonlySet<MeasurementKind> =
    new Set<MeasurementKind>(['distance', 'polyline', 'area', 'slope', 'profile']);

  /**
   * Whether the active scan has a known CRS with real-world units. Drives the
   * trust grade's "scale verified" signal — distinct from `unitToMetres`, which
   * is 1 for BOTH a metric CRS and a CRS-less cloud, so the factor alone can't
   * tell a georeferenced metre survey from an ungeoreferenced one.
   */
  setCrsKnown(known: boolean): void {
    if (known === this._crsKnown) return;
    this._crsKnown = known;
    // Re-grade existing measurements: the CRS-known signal feeds the trust
    // grade, so a measurement placed before the CRS resolved must not keep a
    // stale "no CRS — scale unverified" caption once it becomes known (or
    // gain one if a known CRS is later cleared). Mirrors the drag-end re-grade.
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._emitChange();
  }

  /** True when the active scan's CRS is geographic (degrees) — see the field doc. */
  get geographicCrs(): boolean {
    return this._geographicCrs;
  }

  /**
   * Flag the active scan's CRS as geographic (degrees). Fed from the same
   * CrsService subscription that injects `unitToMetres` / `crsKnown`.
   * Measurements keep working in raw render units, but every hint re-render
   * appends the honest geographic caveat and every affected measurement is
   * re-graded to the red refusal while this is set — mislabelling degrees as
   * metres is the audit-flagged failure mode. Symmetric on clear (a user
   * override to a projected CRS restores the ordinary grades).
   */
  setGeographicCrs(isGeographic: boolean): void {
    if (isGeographic === this._geographicCrs) return;
    this._geographicCrs = isGeographic;
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /** A snapshot of all completed measurements. */
  getMeasurements(): Measurement[] {
    return this._measurements;
  }

  /** Replace all measurements — used when importing a session. */
  loadMeasurements(measurements: Measurement[]): void {
    this._measurements = measurements;
    this._draft = null;
    this._endDrag();
    this._updateHint();
    this._emitChange();
  }

  /** Compact per-measurement summaries for the Measurements panel. */
  getSummaries(): MeasurementSummary[] {
    // B2 — the ONE place the profile series crosses from render space into the
    // numbers a reader is owed: local heights regain the scan's datum, then
    // everything crosses from render units into metres. Every consumer past
    // this line (chart axes, summary <dl>, station table, CSV, PDF) speaks
    // source elevations in metres, so neither step can be applied twice or
    // forgotten by one of them. Re-derived per call: a late CRS resolve or
    // user override re-emits change and the next refresh re-scales.
    const f = this._unitToMetres;
    return this._measurements.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      value: this._headlineText(m),
      profileChart: m.profileChart
        ? scaleProfileSamples(m.profileChart, f, this._originUp, this._effVertical())
        : undefined,
      profileDatumKnown: this._originUp !== null,
      profileChartResidentOnly: m.profileChartResidentOnly,
      profileCorridorWidthM:
        m.profileCorridorWidth != null ? m.profileCorridorWidth * f : undefined,
      profileGroundPercentile: m.profileGroundPercentile,
      volumeResidentOnly: m.volumeResidentOnly,
      trust: m.trust,
    }));
  }

  /** Register a callback fired whenever the completed-measurement list changes. */
  setOnChange(cb: () => void): void {
    this._onChange = cb;
  }

  /** Register a callback fired whenever the active measurement kind changes. */
  setOnKindChange(cb: (kind: MeasurementKind) => void): void {
    this._onKindChange = cb;
  }

  /**
   * Append a complementary tool button to the kind picker row.
   * Used by the host to mount sibling tools (e.g. Lasso volume) so
   * they sit visually next to the built-in measurement kinds — the
   * user reads the row as "things I can pick to measure with."
   *
   * When `anchorKind` is provided, the button is inserted DIRECTLY
   * AFTER the matching kind button so the eye reads it as a
   * sub-action of that kind (Gestalt proximity). Without an anchor
   * the button is appended to the end of the row.
   *
   * Returns the created button so the host can flip its active class
   * on/off via standard DOM manipulation.
   */
  addAuxKindButton(
    label: string,
    title: string,
    onClick: () => void,
    anchorKind?: MeasurementKind,
    icon?: string,
    tip?: string,
  ): HTMLButtonElement {
    // The label is built via textContent (escaped); only the trusted static
    // icon SVG is injected as raw markup, so a label can never inject HTML.
    const btn = el('button', {
      className: 'olv-mkind olv-mkind-icon olv-mkind-aux',
      title,
      tip: tip ?? label,
      ariaLabel: label,
    });
    if (icon) btn.append(el('span', { className: 'olv-mkind-glyph', unsafeHtml: icon }));
    btn.append(el('span', { className: 'olv-mkind-name', text: label }));
    btn.addEventListener('click', () => {
      btn.blur();
      onClick();
    });
    if (this._kindRow) {
      const anchorBtn = anchorKind
        ? this._kindButtons.get(anchorKind) ?? null
        : null;
      if (anchorBtn && anchorBtn.parentElement === this._kindRow) {
        anchorBtn.insertAdjacentElement('afterend', btn);
      } else {
        this._kindRow.append(btn);
      }
    }
    return btn;
  }

  /** Register a callback fired whenever the unit system changes. */
  setOnUnitChange(cb: () => void): void {
    this._onUnitChange = cb;
  }

  /** Inject the cloud-point picker used while dragging a vertex handle. */
  setPicker(pick: (ndcX: number, ndcY: number) => Vec3 | null): void {
    this._picker = pick;
  }

  /**
   * Inject the profile-sampler used when a Profile measurement commits.
   * The Viewer wires this once a cloud is attached and clears it on close.
   * Passing `null` disables the chart layer; the scalar metrics still render.
   */
  setProfileSampler(
    sampler:
      | ((
          a: Vec3,
          b: Vec3,
          opts?: ProfileSamplerOptions,
        ) => ProfileChartSample[] | ProfileSamplerResult | null)
      | null,
  ): void {
    this._profileSampler = sampler;
  }

  /**
   * Re-sample one profile measurement with user-set sampler parameters
   * (B7/B8, v0.4.5): corridor half-width (metres), bare-earth percentile and
   * sample count. Null/absent fields reset to the defaults (auto corridor,
   * p25, 64 bins). Inputs are clamped to the shared bounds, never rejected.
   * Returns true when the measurement was re-sampled and a change emitted;
   * false when the id is unknown / not a profile / no sampler is wired —
   * the panel leaves the row untouched in that case.
   */
  resampleProfile(id: string, params: ProfileResampleParams): boolean {
    if (!this._profileSampler) return false;
    const m = this._measurements.find((x) => x.id === id);
    if (!m || m.kind !== 'profile' || m.points.length < 2) return false;
    // Clamp in METRES (the user's input space), then convert to render units
    // through the same B2 factor the summary boundary applies forward — the
    // exact inverse, so what the user typed is what the sampler walks. The
    // normalisation is pure + tested in profileSampler.ts.
    const opts = normaliseResampleParams(params, this._unitToMetres);
    try {
      const result = this._profileSampler(m.points[0], m.points[1], opts);
      if (!result) return false;
      this._stampProfileSample(m, result);
    } catch {
      // Sampler errors must not poison the existing measurement — the row
      // keeps its previous chart and the panel stays consistent.
      return false;
    }
    // Persist the applied parameters (metre-space, pre-clamp — the clamp
    // re-runs at every use) so they survive a reload and become the standing
    // preference for the NEXT profile drawn (`_commitDraft` reads them). A
    // Reset persists the all-null record, which decodes back to "no
    // preference" — future commits return to the true defaults.
    storageSet(PROFILE_SAMPLER_DEFAULTS_KEY, encodeSamplerParams(params));
    this._emitChange();
    return true;
  }

  /**
   * Inject the volume-sampler used when a Volume measurement commits.
   * The Viewer wires this once a cloud is attached and clears it on
   * close. Passing `null` leaves the volume record unpopulated and the
   * panel shows "—" for cut/fill.
   */
  setVolumeSampler(
    sampler:
      | ((
          polygon: ReadonlyArray<Vec3>,
          referenceZ: number,
        ) =>
          | VolumeRecord
          | { record: VolumeRecord; residentOnly: boolean }
          | null)
      | null,
  ): void {
    this._volumeSampler = sampler;
  }

  /** Whether a vertex handle is currently being dragged. */
  get dragging(): boolean {
    return this._drag !== null;
  }

  /** Delete a measurement by id. */
  removeMeasurement(id: string): void {
    this._measurements = this._measurements.filter((m) => m.id !== id);
    this._updateHint();
    this._emitChange();
  }

  /**
   * Persist a lasso-driven volume result as a regular Volume
   * measurement in the session. Used by the lasso volume tool after
   * the user clicks "Save" on the result toast.
   *
   * The footprint polygon is the 3D convex hull of the selected XY
   * points lifted to the reference plane — what the lasso math
   * actually integrated over. Saving the polygon lets the
   * measurements panel render the lasso result identically to a
   * hand-drawn Volume measurement (same vertex handles, same drag,
   * same PDF report row).
   *
   * Returns the id of the created measurement so the host can echo
   * it in the toast or in workflow recorder events.
   */
  addLassoVolumeMeasurement(input: {
    /** The 3D convex-hull polygon, lifted to the reference plane. */
    readonly polygon: ReadonlyArray<Vec3>;
    /** The volume record from `volumeFromLasso`. */
    readonly volume: VolumeRecord;
    /** True if the cloud is streaming (resident-only). */
    readonly residentOnly?: boolean;
    /** Display name override. Default: "Lasso volume N". */
    readonly name?: string;
  }): string | null {
    if (input.polygon.length < 3) return null;
    const n = ++this._counters.volume;
    const id = freshId();
    const m: Measurement = {
      id,
      kind: 'volume',
      name: input.name ?? `Lasso volume ${n}`,
      points: input.polygon.map((p) => [p[0], p[1], p[2]] as Vec3),
      closed: true,
      volume: input.volume,
    };
    if (input.residentOnly) m.volumeResidentOnly = true;
    this._measurements.push(m);
    this._updateHint();
    this._emitChange();
    return id;
  }

  /** Rename a measurement. The overlay shows no names, so no redraw is needed. */
  renameMeasurement(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const m = this._measurements.find((x) => x.id === id);
    if (m) m.name = trimmed;
  }

  /** Enter or leave measurement mode. Completed measurements stay drawn. */
  setActive(on: boolean): void {
    this._active = on;
    this._draft = null;
    this._cursor = null;
    if (!on) this._endDrag();
    this.hint.classList.toggle('olv-hidden', !on);
    this._updateHint();
  }

  /** Choose which kind of measurement the next placement creates. */
  setKind(kind: MeasurementKind): void {
    if (kind === this._kind) return;
    this._kind = kind;
    this._draft = null; // switching kinds abandons an in-progress measurement
    this._renderKindButtons();
    this._updateHint();
    this._onKindChange?.(kind);
  }

  /**
   * Provide the scan's up-axis and the scene's render origin. The origin is
   * what turns a stored local height back into the elevation the source file
   * describes; only its up-axis component matters, so it is reduced once here
   * rather than kept as a vector nothing else reads. A `null` origin is the
   * caller reporting that the loaded clouds share no frame, and the refusal
   * travels to the display surfaces as `profileDatumKnown: false`.
   */
  setContext(ctx: { worldUp: Vec3; origin: Vec3 | null }): void {
    const nextUp = ctx.origin ? elevationDatumOffset(ctx.origin, ctx.worldUp) : null;
    // Guarded like every other presentational setter here: the viewer re-asks
    // for the datum on every change to the cloud set, and most of those leave
    // the frame alone — an unconditional emit would repaint the panel for a
    // colour change. Only the up axis and the datum itself are compared,
    // because only they can alter what a stored height MEANS; a cloud that
    // shifts east has not moved anyone's elevations.
    const changed =
      nextUp !== this._originUp ||
      ctx.worldUp[0] !== this._worldUp[0] ||
      ctx.worldUp[1] !== this._worldUp[1] ||
      ctx.worldUp[2] !== this._worldUp[2];
    this._worldUp = ctx.worldUp;
    this._originUp = nextUp;
    if (!changed) return;
    // Datum-known → refused renames the profile's columns and raises a caveat;
    // refused → known takes them away. That is the same class of change as a
    // late CRS resolve, and the panel repaints on THIS callback alone — without
    // it the gate reaches the screen only when some unrelated event happens to
    // repaint first, which is no guarantee at all.
    this._emitChange();
  }

  /** Switch the unit system; every label re-formats on the next frame. */
  setUnitSystem(units: UnitSystem): void {
    this._units = units;
    const unitLabel = units === 'metric' ? 'Metric' : 'Imperial';
    // The button holds an icon + a label span — update only the label so the
    // glyph survives (textContent would wipe the SVG).
    const labelSpan = this._unitsBtn.querySelector('.olv-mlabel');
    if (labelSpan) labelSpan.textContent = unitLabel;
    else this._unitsBtn.textContent = unitLabel;
    this._unitsBtn.setAttribute('aria-label', `Units: ${unitLabel}`);
    this._updateHint();
    this._emitChange();
    this._onUnitChange?.();
  }

  /** Place a vertex at a picked point. `null` means a click that missed. */
  addPoint(point: Vec3 | null): void {
    if (!this._active) return;
    if (!point) {
      this._setHintText(`No point there — ${VERB_LOWER} directly on the scan`);
      return;
    }
    if (!this._draft) this._draft = this._newDraft();
    // Snap the placed vertex to a real return or to existing measurement
    // geometry before committing it. `_lastSnap` records what it landed on so
    // the hint can disclose it (a snap never implies a return that isn't one).
    const snap = this._resolveSnap(point);
    this._lastSnap = snap;
    const placed = snap ? snap.position : point;
    this._draft.points.push([placed[0], placed[1], placed[2]]);
    if (isFull(this._draft)) this._commitDraft();
    this._updateHint();
  }

  /**
   * Provide (or clear) the resident cloud positions the point-snap index is
   * built from. Called on load with the display cloud's xyz array, and with
   * `null` on reset / for a streaming scan that has no resident array to snap to.
   */
  setSnapSource(positions: Float32Array | null): void {
    this._snapIndex =
      positions && positions.length >= 3 ? buildPointSnapIndex(positions) : null;
  }

  /** The active snap mode. */
  get snapMode(): 'off' | 'point' | 'geometry' {
    return this._snapMode;
  }

  /** Set the snap mode and re-label the toggle. */
  setSnapMode(mode: 'off' | 'point' | 'geometry'): void {
    this._snapMode = mode;
    if (mode === 'off') this._lastSnap = null;
    this._syncSnapBtn();
    this._updateHint();
  }

  private _cycleSnapMode(): void {
    const next: 'off' | 'point' | 'geometry' =
      this._snapMode === 'off' ? 'point' : this._snapMode === 'point' ? 'geometry' : 'off';
    this.setSnapMode(next);
  }

  private _syncSnapBtn(): void {
    if (!this._snapBtn) return;
    const label =
      this._snapMode === 'off' ? 'Snap: Off' : this._snapMode === 'point' ? 'Snap: Point' : 'Snap: Geom';
    const span = this._snapBtn.querySelector('.olv-mlabel');
    if (span) span.textContent = label;
    else this._snapBtn.textContent = label;
    this._snapBtn.setAttribute('aria-label', label.toLowerCase());
    this._snapBtn.classList.toggle('is-active', this._snapMode !== 'off');
  }

  /**
   * Resolve where a raw picked point should actually land. Returns null (free
   * placement) when snapping is off, no cloud index is available, or nothing is
   * within the screen-space radius. Point mode snaps to the nearest real return;
   * geometry mode also considers measurement vertices / midpoints / crossings.
   */
  private _resolveSnap(query: Vec3): SnapResult | null {
    if (this._snapMode === 'off' || !this._snapIndex) return null;
    const cam = this._lastCamera;
    const canvas = this._lastCanvas;
    if (!cam || !canvas) return null;
    const maxDistance = this._snapWorldRadius(query, cam, canvas);
    if (!(maxDistance > 0)) return null;
    if (this._snapMode === 'point') {
      return snapToNearestPoint(this._snapIndex, query, maxDistance);
    }
    return snapBest(this._snapIndex, this._snapSegments(), query, maxDistance);
  }

  /** Existing measurement polylines (committed + in-progress draft) for geometry snaps. */
  private _snapSegments(): Segments {
    const segs: Vec3[][] = this._measurements.map((m) => m.points);
    if (this._draft && this._draft.points.length > 0) segs.push(this._draft.points);
    return segs;
  }

  /**
   * Convert the fixed screen-space snap radius (px) to a world distance at the
   * query point's depth. Perspective only — returns 0 (no snap) under an
   * orthographic camera, where `fov` is undefined.
   */
  private _snapWorldRadius(
    query: Vec3,
    cam: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
  ): number {
    if (!cam.isPerspectiveCamera) return 0;
    const dx = query[0] - cam.position.x;
    const dy = query[1] - cam.position.y;
    const dz = query[2] - cam.position.z;
    const depth = Math.hypot(dx, dy, dz);
    const h = canvas.clientHeight || canvas.height || 1;
    const fov = (cam.fov * Math.PI) / 180;
    const worldPerPx = (2 * depth * Math.tan(fov / 2)) / h;
    return MeasureController.SNAP_RADIUS_PX * worldPerPx;
  }

  /** A disclosure of the last snap, prefixed onto the hint (never implies a return that isn't one). */
  private _snapHintPrefix(): string {
    if (this._snapMode === 'off' || !this._lastSnap) return '';
    const k = this._lastSnap.kind;
    const where =
      k === 'point'
        ? 'nearest point (measured return)'
        : k === 'endpoint'
          ? 'measurement vertex'
          : k === 'midpoint'
            ? 'segment midpoint'
            : 'segment intersection';
    return `Snapped to ${where} · `;
  }

  /** Update the live-preview cursor point (`null` = pointer off the cloud). */
  setCursor(point: Vec3 | null): void {
    // While dragging a handle, the placement preview is suppressed.
    this._cursor = this._drag ? null : point;
  }

  /** Finish an in-progress polyline / area, committing it when it is valid. */
  finishCurrent(): void {
    if (!this._draft) return;
    if (this._draft.points.length >= MIN_POINTS[this._draft.kind]) {
      if (this._draft.kind === 'area') this._draft.closed = true;
      this._commitDraft();
    } else {
      this._draft = null;
    }
    this._updateHint();
  }

  /**
   * The world-space first vertex of the in-progress polygon draft, or
   * null if there is no closable polygon draft yet. Used by the host
   * (Viewer) to test whether the next click is close enough to the
   * first vertex to snap-close — the canonical "click first point to
   * finish" affordance for area / volume / polyline / profile.
   *
   * Returns null for k-point kinds (distance / height / angle / slope /
   * box) — those don't close on a first-vertex click.
   */
  firstVertexForClose(): Vec3 | null {
    const d = this._draft;
    if (!d) return null;
    const isPolygonKind =
      d.kind === 'area' ||
      d.kind === 'volume' ||
      d.kind === 'polyline' ||
      d.kind === 'profile';
    if (!isPolygonKind) return null;
    if (d.points.length < MIN_POINTS[d.kind]) return null;
    const p = d.points[0];
    return [p[0], p[1], p[2]];
  }

  /** Remove the most recently placed vertex of the in-progress measurement. */
  undoLastPoint(): void {
    if (!this._draft) return;
    this._draft.points.pop();
    if (this._draft.points.length === 0) this._draft = null;
    this._updateHint();
  }

  /** Remove every measurement. */
  clear(): void {
    this._measurements = [];
    this._draft = null;
    this._updateHint();
    this._emitChange();
  }

  /** Project all measurements and redraw. Called once per frame by the Viewer. */
  render(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): void {
    // Cache the live camera + canvas so the place handler can size the snap
    // radius (a screen-space pixel radius → world distance at the hit's depth).
    this._lastCamera = camera;
    this._lastCanvas = canvas;
    this._applyDrag();
    this._draw.render(this._buildModel(), camera, canvas);
  }

  /** The current frame's geometry as a standalone SVG — used by the screenshot export. */
  overlaySVG(): string {
    return this._draw.toSVGString();
  }

  /** Free DOM references. */
  dispose(): void {
    this._endDrag();
    this._draw.dispose();
    this.hint.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _newDraft(): Measurement {
    const n = ++this._counters[this._kind];
    return {
      id: freshId(),
      kind: this._kind,
      name: `${KIND_LABEL[this._kind]} ${n}`,
      points: [],
      closed: false,
    };
  }

  /**
   * Stamp a profile-sampler result onto a measurement record. Normalises
   * both legacy (raw array) and current ({samples, residentOnly, …}) sampler
   * return shapes; keeps the B4 provenance fields (corridor / percentile, in
   * render units) so the PDF/CSV print the values that actually shaped the
   * estimate. Shared by the commit path and the resample path (B7/B8) so the
   * two can never stamp differently.
   */
  private _stampProfileSample(
    m: Measurement,
    result: ProfileChartSample[] | ProfileSamplerResult,
  ): void {
    const samples = Array.isArray(result) ? result : result.samples;
    const residentOnly = Array.isArray(result) ? false : result.residentOnly;
    if (!samples || samples.length === 0) return;
    m.profileChart = samples;
    // Resident-only reflects the LATEST sample — a re-sample after streaming
    // completes may clear the caveat, so assign rather than only-set-true.
    m.profileChartResidentOnly = residentOnly || undefined;
    if (!Array.isArray(result)) {
      if (
        typeof result.corridorWidth === 'number' &&
        Number.isFinite(result.corridorWidth)
      ) {
        m.profileCorridorWidth = result.corridorWidth;
      }
      if (
        typeof result.groundPercentile === 'number' &&
        Number.isFinite(result.groundPercentile)
      ) {
        m.profileGroundPercentile = result.groundPercentile;
      }
    }
  }

  private _commitDraft(): void {
    if (!this._draft) return;
    const m = this._draft;
    // Profile-only: stamp a sampled height-vs-distance chart onto the
    // measurement record. The sampler is allowed to fail (no cloud, empty
    // resident set on a streaming scan still warming up); a null return
    // leaves `profileChart` undefined and the panel falls back to the
    // scalar metrics row.
    if (m.kind === 'profile' && this._profileSampler && m.points.length >= 2) {
      try {
        // The user's persisted sampler preferences (B7/B8) apply to every
        // new profile, normalised through the same metre→render-unit clamp
        // the resample path uses. A missing / malformed / reset record
        // decodes to null and the standing defaults apply — exactly the
        // pre-preference behaviour.
        const stored = decodeSamplerParams(storageGet(PROFILE_SAMPLER_DEFAULTS_KEY));
        const opts = stored ? normaliseResampleParams(stored, this._unitToMetres) : undefined;
        const result = this._profileSampler(m.points[0], m.points[1], opts);
        if (result) this._stampProfileSample(m, result);
      } catch {
        // Sampler errors must not poison the measurement; the scalar
        // metrics still display correctly without the chart.
      }
    }
    // Volume-only: sample cut/fill against the loaded cloud, using the
    // polygon's auto-reference Z (median of vertex heights). The sampler
    // is allowed to fail; a null result leaves `m.volume` unset and the
    // panel shows the polygon area + "—" cut/fill.
    if (
      m.kind === 'volume' &&
      this._volumeSampler &&
      m.points.length >= MIN_POINTS.volume
    ) {
      try {
        const refZ = autoReferenceZ(m.points, this._worldUp);
        const result = this._volumeSampler(m.points, refZ);
        if (result) {
          // Normalise legacy (raw VolumeRecord) and current
          // ({record, residentOnly}) sampler return shapes. The detection
          // looks for the `record` field on the result, which exists only
          // on the wrapped shape — VolumeRecord has `fill` / `cut` / etc.
          if ('record' in result) {
            m.volume = result.record;
            if (result.residentOnly) m.volumeResidentOnly = true;
          } else {
            m.volume = result;
          }
        }
      } catch {
        // Same rationale as the profile branch — sampler errors must not
        // poison the commit; the polygon still appears as a measurement.
      }
    }
    m.trust = this._gradeMeasurement(m);
    this._measurements.push(m);
    this._draft = null;
    this._emitChange();
  }

  /**
   * Stamp the per-measurement honesty grade from the support under each
   * endpoint. Only graded when a snap index exists (no cloud → no grade). The
   * trust radius is a few nominal point spacings (the index's cell size ≈ one
   * point per cell), so a dense neighbourhood reads as well-supported and a
   * void reads as unsupported.
   */
  private _gradeMeasurement(m: Measurement): MeasurementTrust | undefined {
    const idx = this._snapIndex;
    if (!idx) return undefined;
    const useGrid = Number.isFinite(idx.cellSize) && idx.cellSize > 0;
    const radius = useGrid ? idx.cellSize * 4 : 0;
    // "On a real return" = a measured point within half a cell of the vertex.
    // Derived from the cloud, not a placement-time flag, so the grade stays
    // correct after a vertex is dragged (re-graded on drag-end).
    const onPointEps = useGrid ? idx.cellSize * 0.5 : 1e-6;
    const vertices = m.points.map((p) => ({
      snappedToPoint: snapToNearestPoint(idx, p, onPointEps) !== null,
      pointsWithinRadius: useGrid ? countPointsWithinRadius(idx, p, radius) : idx.count,
    }));
    return gradeMeasurement({
      vertices,
      crsKnown: this._crsKnown,
      residentOnly: m.volumeResidentOnly === true || m.profileChartResidentOnly === true,
      // Geographic (degree) frame: the refusal applies to every kind whose
      // NUMBER mixes degree X/Y with linear Z — lengths, areas, grades,
      // profiles, boxes, volumes. Pure-vertical heights (Δ along up, in the
      // Z unit) and unit-free angles keep their ordinary grade; the panel's
      // persistent caveat still covers them.
      geographicCrs:
        this._geographicCrs && m.kind !== 'height' && m.kind !== 'angle',
      // Compound CRS (height unit ≠ horizontal unit): refuse the kinds whose
      // number mixes the two axes. Heights, boxes and volumes are exactly
      // rescaled by the vertical factor, so they keep their ordinary grade.
      verticalUnitMismatch:
        this._verticalUnitMismatch() &&
        MeasureController.VERTICAL_MISMATCH_KINDS.has(m.kind),
    });
  }

  private _setHintText(text: string): void {
    this._hintEl.textContent = text;
    this._clearBtn.classList.toggle('olv-hidden', this._measurements.length === 0);
  }

  private _renderKindButtons(): void {
    for (const [k, btn] of this._kindButtons) {
      btn.classList.toggle('olv-mkind-active', k === this._kind);
    }
  }

  private _emitChange(): void {
    this._onChange?.();
  }

  /** A pointerdown on a vertex handle begins an edit drag. */
  private _handlePointerDown(e: PointerEvent): void {
    if (!this._active) return;
    const target = e.target as Element | null;
    const mid = target?.getAttribute('data-mid') ?? null;
    const viAttr = target?.getAttribute('data-vi') ?? null;
    if (mid === null || viAttr === null) return;
    e.preventDefault();
    this._drag = { id: mid, vi: Number(viAttr) };
    this._cursor = null;
    window.addEventListener('pointermove', this._onDragMove);
    window.addEventListener('pointerup', this._onDragUp);
  }

  /** Track the drag pointer; the actual re-pick is coalesced into `render`. */
  private _handleDragMove(e: PointerEvent): void {
    if (!this._drag) return;
    const rect = this._draw.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._dragNdcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._dragNdcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._dragDirty = true;
  }

  /** Re-pick the dragged handle's point — at most once per frame. */
  private _applyDrag(): void {
    const drag = this._drag;
    if (!drag || !this._dragDirty || !this._picker) return;
    this._dragDirty = false;
    const point = this._picker(this._dragNdcX, this._dragNdcY);
    if (!point) return;
    const m = this._measurements.find((x) => x.id === drag.id);
    if (m && drag.vi < m.points.length) {
      m.points[drag.vi] = [point[0], point[1], point[2]];
    }
  }

  /** End a handle drag, detaching the window listeners. */
  private _endDrag(): void {
    if (!this._drag) return;
    const draggedId = this._drag.id;
    this._drag = null;
    this._dragDirty = false;
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragUp);
    // A dragged endpoint changes the support under it — re-grade so the trust
    // badge can't keep claiming "well supported" after a vertex moved into a void.
    const m = this._measurements.find((x) => x.id === draggedId);
    if (m) m.trust = this._gradeMeasurement(m);
    this._emitChange();
  }

  // ── unit-aware formatting (B2) ──────────────────────────────────────────
  // Geometry math runs in render (source) units; these three wrappers are
  // the only way a length / area / volume becomes a label, so the CRS unit
  // factor is applied exactly once per readout and can't be missed by a
  // future call site.

  private _fmtLen(renderUnits: number): string {
    return formatLengthRender(renderUnits, this._unitToMetres, this._units);
  }

  /**
   * Format a PURE-VERTICAL length (a height / drop / box height) through the
   * up-axis factor. Equals {@link _fmtLen} on a single-unit CRS (bit-identical);
   * on a compound CRS it honours the height unit the horizontal factor can't.
   */
  private _fmtVertical(renderUnits: number): string {
    return formatLengthRender(renderUnits, this._effVertical(), this._units);
  }

  /**
   * Format a cut/fill volume — a horizontal footprint (linear²) times a
   * vertical thickness (up-axis unit). Scales linear²·vertical, so a compound
   * CRS reads honest cubic metres; on a single-unit CRS this is exactly the
   * uniform `f³` an equal vertical factor collapses to.
   */
  private _fmtCutFill(renderUnitsCu: number): string {
    const f = this._unitToMetres;
    return formatVolume(renderUnitsCu * f * f * this._effVertical(), this._units);
  }

  private _fmtArea(renderUnitsSq: number): string {
    return formatAreaRender(renderUnitsSq, this._unitToMetres, this._units);
  }

  /** The headline value string for a measurement, shown in the panel. */
  private _headlineText(m: Measurement): string {
    const p = m.points;
    switch (m.kind) {
      case 'distance': {
        if (p.length < 2) return '—';
        const len = this._fmtLen(distance(p[0], p[1]));
        const az = bearingDegrees(p[0], p[1], this._worldUp);
        // Append the compass bearing when the segment has a horizontal run —
        // a survey staple. Purely vertical pairs have no bearing, so just the
        // length shows.
        return Number.isFinite(az) ? `${len} · ${formatBearing(az)}` : len;
      }
      case 'polyline':
        return this._fmtLen(polylineLength(p).total);
      case 'area':
        return p.length >= 3 ? this._fmtArea(polygonAreaPlanar(p)) : '—';
      case 'height':
        return p.length >= 2
          ? this._fmtVertical(Math.abs(verticalDelta(p[0], p[1], this._worldUp).vertical))
          : '—';
      case 'angle':
        return p.length >= 3 ? formatAngle(angleAtVertex(p[0], p[1], p[2])) : '—';
      case 'slope': {
        if (p.length < 2) return '—';
        const s = slopeBetween(p[0], p[1], this._worldUp);
        return `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`;
      }
      case 'profile': {
        if (p.length < 2) return '—';
        const pm = profileMetrics(p[0], p[1], this._worldUp);
        return formatProfileHeadline(
          // Length through the horizontal factor; the vertical drop through the
          // up-axis factor (compound CRS). Grade is dimensionless.
          pm.length3d * this._unitToMetres,
          pm.verticalDrop * this._effVertical(),
          pm.gradePercent,
          this._units,
        );
      }
      case 'box': {
        if (p.length < 2) return '—';
        const m = boxMetrics(boxFromCorners(p[0], p[1]), this._worldUp);
        return formatBoxHeadline(
          // Horizontal axes ×f, the up axis (height) ×vertical factor, volume
          // f²·vertical — each a pure monomial, so a compound CRS reads honest.
          m.width * this._unitToMetres,
          m.depth * this._unitToMetres,
          m.height * this._effVertical(),
          m.volume * this._unitToMetres * this._unitToMetres * this._effVertical(),
          this._units,
        );
      }
      case 'volume': {
        if (p.length < MIN_POINTS.volume) return '—';
        // Polygon area always available; cut / fill / net come from the
        // sampler-stamped record. When the record is missing (no cloud,
        // pre-sampler session file) the headline still shows the area.
        const area = this._fmtArea(polygonAreaHorizontal(p, this._worldUp));
        const v = m.volume;
        if (!v) return `${area} footprint · cut/fill —`;
        const fill = this._fmtCutFill(Math.max(0, v.fill));
        const cut = this._fmtCutFill(Math.max(0, v.cut));
        const net = this._fmtCutFill(Math.abs(v.net));
        const netSign = v.net < 0 ? 'cut' : 'fill';
        return `${area} · +${fill} fill · −${cut} cut · net ${net} ${netSign}`;
      }
    }
  }

  private _updateHint(): void {
    if (this._active) {
      // Honest units: a geographic scan measures degrees, not metres — every
      // hint carries the caveat so a raw number is never read as a distance.
      let hint = this._snapHintPrefix() + this._composeHint();
      // Honest units: geographic degrees are the stronger caveat; a compound
      // CRS's vertical/horizontal unit clash is the next — a raw number never
      // reads as a trustworthy distance without its caveat.
      if (this._geographicCrs) {
        hint = `${hint} — ${GEOGRAPHIC_CRS_MEASURE_NOTICE}`;
      } else if (this._verticalUnitMismatch()) {
        hint = `${hint} — ${VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE}`;
      }
      this._setHintText(hint);
    }
    this._updateFinishBtnVisibility();
  }

  /**
   * Show the Finish-polygon button only when (a) the user is in a
   * polygon-kind (area / volume / polyline / profile) AND (b) the
   * draft has at least the minimum number of vertices to close. This
   * keeps the actions row uncluttered for k-point kinds (distance /
   * height / angle / slope / box) that don't need it.
   */
  private _updateFinishBtnVisibility(): void {
    if (!this._finishBtn) return;
    const d = this._draft;
    const isPolygonKind =
      this._kind === 'area' ||
      this._kind === 'volume' ||
      this._kind === 'polyline' ||
      this._kind === 'profile';
    const ready = !!d && isPolygonKind && d.points.length >= MIN_POINTS[d.kind];
    this._finishBtn.classList.toggle('olv-hidden', !ready);
  }

  private _composeHint(): string {
    const d = this._draft;
    const n = d ? d.points.length : 0;
    switch (this._kind) {
      case 'distance':
        if (n === 1) return `${VERB} the second point`;
        if (this._measurements.length > 0) return `${VERB} two more points to measure again`;
        return `${VERB} the first point on the scan`;
      case 'polyline': {
        if (!d || d.points.length < 2) return `${VERB} points along the path`;
        const total = this._fmtLen(polylineLength(d.points).total);
        return `${total} · ${VERB} more, click the first vertex or press Enter to finish`;
      }
      case 'area': {
        if (!d || d.points.length < 3) return `${VERB} polygon vertices — three or more`;
        const area = this._fmtArea(polygonAreaPlanar(d.points));
        return `${area} · ${VERB} more, click the first vertex or press Enter to close`;
      }
      case 'volume': {
        if (!d || d.points.length < 3)
          return `${VERB} the volume polygon — three or more vertices on the surface`;
        const area = this._fmtArea(polygonAreaHorizontal(d.points, this._worldUp));
        return `${area} footprint · click the first vertex or press Enter to compute cut/fill`;
      }
      case 'height':
      case 'slope':
      case 'profile':
        return n === 1 ? `${VERB} the second point` : `${VERB} the first point`;
      case 'box':
        return n === 1
          ? `${VERB} the opposite corner of the box`
          : `${VERB} one corner of the box`;
      case 'angle':
        if (n === 1) return `${VERB} the angle vertex`;
        if (n === 2) return `${VERB} the third point`;
        return `${VERB} the first point`;
    }
  }

  private _buildModel(): OverlayModel {
    const vertices: OverlayVertex[] = [];
    const edges: OverlayEdge[] = [];
    const polygons: OverlayPolygon[] = [];
    const labels: OverlayLabel[] = [];
    for (const m of this._measurements) {
      this._appendMeasurement(m, vertices, edges, polygons, labels);
    }
    if (this._draft) this._appendDraft(this._draft, vertices, edges, polygons, labels);
    return { polygons, edges, vertices, labels };
  }

  /** Add a committed measurement's geometry to the draw model. */
  private _appendMeasurement(
    m: Measurement,
    V: OverlayVertex[],
    E: OverlayEdge[],
    P: OverlayPolygon[],
    L: OverlayLabel[],
  ): void {
    const pts = m.points;
    pts.forEach((p, i) => {
      V.push({
        p,
        role: 'normal',
        handle: this._active ? { mid: m.id, vi: i } : undefined,
      });
    });

    if (m.kind === 'distance' && pts.length >= 2) {
      E.push({ a: pts[0], b: pts[1], style: 'solid' });
      L.push({
        anchor: midpoint(pts[0], pts[1]),
        text: this._fmtLen(distance(pts[0], pts[1])),
        primary: true,
      });
      return;
    }
    if (m.kind === 'polyline' && pts.length >= 2) {
      const r = polylineLength(pts);
      for (let i = 1; i < pts.length; i++) {
        E.push({ a: pts[i - 1], b: pts[i], style: 'solid' });
        L.push({
          anchor: midpoint(pts[i - 1], pts[i]),
          text: this._fmtLen(r.segments[i - 1]),
          primary: false,
        });
      }
      L.push({
        anchor: pts[pts.length - 1],
        text: this._fmtLen(r.total),
        primary: true,
      });
      return;
    }
    if (m.kind === 'area' && pts.length >= 3) {
      for (let i = 0; i < pts.length; i++) {
        E.push({ a: pts[i], b: pts[(i + 1) % pts.length], style: 'solid' });
      }
      P.push({ points: pts });
      const planar = this._fmtArea(polygonAreaPlanar(pts));
      const horiz = this._fmtArea(polygonAreaHorizontal(pts, this._worldUp));
      L.push({ anchor: centroid(pts), text: `${planar} · map ${horiz}`, primary: true });
      return;
    }
    if (m.kind === 'height' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const d = verticalDelta(a, b, this._worldUp);
      E.push({ a, b: elbow, style: 'solid' });
      E.push({ a: elbow, b, style: 'solid' });
      L.push({
        anchor: midpoint(elbow, b),
        text: this._fmtVertical(Math.abs(d.vertical)),
        primary: true,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: this._fmtLen(d.horizontal),
        primary: false,
      });
      return;
    }
    if (m.kind === 'slope' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const s = slopeBetween(a, b, this._worldUp);
      E.push({ a, b, style: 'solid' });
      E.push({ a, b: elbow, style: 'preview' });
      E.push({ a: elbow, b, style: 'preview' });
      L.push({
        anchor: midpoint(a, b),
        text: `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`,
        primary: true,
      });
      L.push({
        anchor: midpoint(elbow, b),
        text: this._fmtVertical(Math.abs(s.rise)),
        primary: false,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: this._fmtLen(s.run),
        primary: false,
      });
      return;
    }
    if (m.kind === 'angle' && pts.length >= 3) {
      const [a, vertex, c] = pts;
      E.push({ a, b: vertex, style: 'solid' });
      E.push({ a: vertex, b: c, style: 'solid' });
      L.push({
        anchor: vertex,
        text: formatAngle(angleAtVertex(a, vertex, c)),
        primary: true,
      });
    }
    if (m.kind === 'profile' && pts.length >= 2) {
      // Profile draws the 3D segment as the solid headline and an L-bent
      // preview that shows the horizontal run and vertical drop separately
      // — the same idiom the slope tool uses, so users transferring between
      // the two see consistent geometry. The headline label carries the
      // combined readout (length · Δh · grade).
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const pm = profileMetrics(a, b, this._worldUp);
      E.push({ a, b, style: 'solid' });
      E.push({ a, b: elbow, style: 'preview' });
      E.push({ a: elbow, b, style: 'preview' });
      L.push({
        anchor: midpoint(a, b),
        text: formatProfileHeadline(
          // Length ×horizontal factor; drop ×up-axis factor (compound CRS).
          pm.length3d * this._unitToMetres,
          pm.verticalDrop * this._effVertical(),
          pm.gradePercent,
          this._units,
        ),
        primary: true,
      });
      L.push({
        anchor: midpoint(elbow, b),
        text: this._fmtVertical(Math.abs(pm.verticalDrop)),
        primary: false,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: this._fmtLen(pm.lengthHorizontal),
        primary: false,
      });
      // Station markers on the cloud — small dim dots at evenly-spaced
      // chainages along the section line, so the profile's stations are visible
      // in 3D, not just on the chart. The endpoints already carry their own
      // vertices, so only the intermediate stations are drawn.
      const horizontal = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (horizontal > 0) {
        const stations = stationsAlongLine({ a, b, intervalM: horizontal / 7 });
        for (const s of stations.slice(1, -1)) {
          V.push({ p: s.position, role: 'station' });
        }
      }
    }
    if (m.kind === 'volume' && pts.length >= MIN_POINTS.volume) {
      // Volume renders as the same closed polygon idiom as `area` — the
      // ring edges + a translucent fill — with the headline label
      // anchored at the centroid carrying the cut/fill record.
      for (let i = 0; i < pts.length; i++) {
        E.push({ a: pts[i], b: pts[(i + 1) % pts.length], style: 'solid' });
      }
      P.push({ points: pts });
      L.push({ anchor: centroid(pts), text: this._headlineText(m), primary: true });
      return;
    }
    if (m.kind === 'box' && pts.length >= 2) {
      // Box renders as a 12-edge wireframe cube. The two pick points are
      // opposite diagonal corners; `boxFromCorners` normalises any axis
      // ordering so the same box reads identically regardless of pick
      // direction. The corner / edge tables in `geometry.ts` define a
      // stable index order so this overlay (and the future renderer
      // clipping uniform) read from one source of truth.
      const box = boxFromCorners(pts[0], pts[1]);
      const corners = boxCorners(box, this._worldUp);
      for (const [aI, bI] of BOX_EDGES) {
        E.push({ a: corners[aI], b: corners[bI], style: 'solid' });
      }
      const metrics = boxMetrics(box, this._worldUp);
      const centre: Vec3 = [
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5,
      ];
      L.push({
        anchor: centre,
        text: formatBoxHeadline(
          // Horizontal axes ×f, height ×vertical factor, volume f²·vertical.
          metrics.width * this._unitToMetres,
          metrics.depth * this._unitToMetres,
          metrics.height * this._effVertical(),
          metrics.volume * this._unitToMetres * this._unitToMetres * this._effVertical(),
          this._units,
        ),
        primary: true,
      });
    }
  }

  /** Add the in-progress draft, including its live preview toward the cursor. */
  private _appendDraft(
    d: Measurement,
    V: OverlayVertex[],
    E: OverlayEdge[],
    P: OverlayPolygon[],
    L: OverlayLabel[],
  ): void {
    const pts = d.points;
    // The first vertex of a closable polygon doubles as the
    // "click here to close" snap target. The overlay renders it with
    // a pulsing cyan ring so the user sees the affordance without
    // reading a hint (Gestalt similarity: the ring is the close cue).
    const isPolygonKind =
      d.kind === 'area' || d.kind === 'volume' || d.kind === 'polyline';
    const closable =
      isPolygonKind && pts.length >= MIN_POINTS[d.kind];
    pts.forEach((p, i) => {
      let role: OverlayVertex['role'];
      if (closable && i === 0) role = 'snap-target';
      else if (i === pts.length - 1) role = 'pending';
      else role = 'normal';
      V.push({ p, role });
    });
    for (let i = 1; i < pts.length; i++) {
      E.push({ a: pts[i - 1], b: pts[i], style: 'solid' });
    }

    const cur = this._cursor;
    if (!cur || pts.length === 0) return;
    const last = pts[pts.length - 1];

    if (d.kind === 'distance') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(last, cur),
        text: this._fmtLen(distance(last, cur)),
        primary: true,
      });
      return;
    }
    if (d.kind === 'polyline') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: cur,
        text: this._fmtLen(polylineLength([...pts, cur]).total),
        primary: true,
      });
      return;
    }
    if (d.kind === 'area') {
      E.push({ a: last, b: cur, style: 'preview' });
      const ring = [...pts, cur];
      if (ring.length >= 3) {
        E.push({ a: cur, b: pts[0], style: 'preview' });
        P.push({ points: ring });
        L.push({
          anchor: centroid(ring),
          text: this._fmtArea(polygonAreaPlanar(ring)),
          primary: true,
        });
      }
      return;
    }
    if (d.kind === 'volume') {
      // Same live-polygon preview idiom as `area`: each new vertex
      // closes back to the first point so the in-progress footprint
      // reads as a ring. The live label shows the horizontal-plane area
      // — the headline cut/fill numbers only land after commit, when
      // the sampler walks the cloud.
      E.push({ a: last, b: cur, style: 'preview' });
      const ring = [...pts, cur];
      if (ring.length >= 3) {
        E.push({ a: cur, b: pts[0], style: 'preview' });
        P.push({ points: ring });
        L.push({
          anchor: centroid(ring),
          text: this._fmtArea(polygonAreaHorizontal(ring, this._worldUp)),
          primary: true,
        });
      }
      return;
    }
    if (d.kind === 'height') {
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(elbow, cur),
        text: this._fmtVertical(Math.abs(verticalDelta(pts[0], cur, this._worldUp).vertical)),
        primary: true,
      });
      return;
    }
    if (d.kind === 'slope') {
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      const s = slopeBetween(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: cur, style: 'preview' });
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(pts[0], cur),
        text: `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`,
        primary: true,
      });
      return;
    }
    if (d.kind === 'angle') {
      E.push({ a: last, b: cur, style: 'preview' });
      if (pts.length === 2) {
        L.push({
          anchor: pts[1],
          text: formatAngle(angleAtVertex(pts[0], pts[1], cur)),
          primary: true,
        });
      }
    }
    if (d.kind === 'profile') {
      // Same preview idiom as `slope` — solid 3D segment with the L-bent
      // run/drop ghost — but the live label carries the combined profile
      // readout (length · Δh · grade).
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      const pm = profileMetrics(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: cur, style: 'preview' });
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(pts[0], cur),
        text: formatProfileHeadline(
          // Length ×horizontal factor; drop ×up-axis factor (compound CRS).
          pm.length3d * this._unitToMetres,
          pm.verticalDrop * this._effVertical(),
          pm.gradePercent,
          this._units,
        ),
        primary: true,
      });
    }
    if (d.kind === 'box') {
      // Live wireframe preview from the first corner to the cursor. Edges
      // are drawn in the same `preview` style as other in-progress tools
      // so the user sees the box take shape as they sweep the diagonal.
      const box = boxFromCorners(pts[0], cur);
      const corners = boxCorners(box, this._worldUp);
      for (const [aI, bI] of BOX_EDGES) {
        E.push({ a: corners[aI], b: corners[bI], style: 'preview' });
      }
      const metrics = boxMetrics(box, this._worldUp);
      const centre: Vec3 = [
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5,
      ];
      L.push({
        anchor: centre,
        text: formatBoxHeadline(
          // Horizontal axes ×f, height ×vertical factor, volume f²·vertical.
          metrics.width * this._unitToMetres,
          metrics.depth * this._unitToMetres,
          metrics.height * this._effVertical(),
          metrics.volume * this._unitToMetres * this._unitToMetres * this._effVertical(),
          this._units,
        ),
        primary: true,
      });
    }
  }
}

/** Midpoint of two points. */
function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * The right-angle elbow of a vertical pair: the point at `a`'s height and
 * `b`'s horizontal position, so a height / slope measurement can draw its
 * rise and run as separate legs. `up` must be a unit vector.
 */
function elbowPoint(a: Vec3, b: Vec3, up: Vec3): Vec3 {
  const rise =
    (b[0] - a[0]) * up[0] + (b[1] - a[1]) * up[1] + (b[2] - a[2]) * up[2];
  return [b[0] - rise * up[0], b[1] - rise * up[1], b[2] - rise * up[2]];
}

/** Average position of a set of points. */
function centroid(points: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length || 1;
  return [x / n, y / n, z / n];
}

/** A reasonably unique id — `crypto.randomUUID` when available, else a fallback. */
function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `m_${Math.random().toString(36).slice(2, 11)}`;
}
