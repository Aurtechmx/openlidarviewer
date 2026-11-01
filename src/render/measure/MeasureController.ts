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

import { areaRingVerdictCached } from './areaValidity';
import { listenToDragPointer } from './dragPointer';
import type * as THREE from 'three/webgpu';
import { el, politeStatus } from '../../ui/dom';
import { installNativeTitleStrip, setStrippableTitle } from './nativeTitleStrip';
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
import { GEOGRAPHIC_NOT_AVAILABLE, MIN_POINTS, UNRESOLVED_UNIT_FRAME, UP_AXIS_CONFLICT, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE, frameRefusalText, isFull, sameUnitFrame, sameUp, upAxisRefusesKind, type MeasureUnitFrame } from './types';
import type { WorkOwnership } from '../../model/workOwnership';
import type { ProfileProvenance } from './profileProvenance';
import type { WithheldReadCounts } from '../../science/withheldCounts';
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
  toMetricFrame, unresolvedHeadlineFor, unresolvedKeysFor, type AxisSteps,
} from './geometry';
import { flatBox } from './geometry';
import { resizeBoxByCorner, BOX_CORNER_INDICES, type BoxCornerIndex } from './boxEdit';
import { areaBreakdown, lineBreakdown } from './measureBreakdown';
import type { AreaBreakdown, LineBreakdown } from './measureBreakdown';
import type { SnapResult, Segments } from './snap';
import { ProjectSnapIndex, eligibleSnapLayers, type SnapLayerEntry } from './projectSnap';
import { gradeMeasurement, type MeasurementTrust } from './measurementTrust';
import {
  formatLengthRender,
  formatLengthsInSharedUnit,
  formatAreaRender,
  formatAngle,
  formatArmAngle,
  ANGLE_UNDEFINED_READOUT,
  formatFramedBearing,
  type BearingFrame,
  formatGrade,
  formatProfileHeadline,
  formatBoxHeadline,
  formatVolume,
  formatElevation,
  formatUnitUnverified,
  UNIT_UNVERIFIED_MEASURE_NOTICE,
  GEOGRAPHIC_CRS_MEASURE_NOTICE,
  volumeBaseLevelClause,
  volumeCaveatClauses,
  volumeFiguresWithheld,
  volumeWithheldClause,
} from './format';
// B2 (v0.4.5) — one unit seam: the chart series is converted render-units →
// metres in `getSummaries` by the same module the panel/CSV/PDF read, so
// labels and raw numerals can never drift apart.
import { scaleProfileSamples } from './profileSummary';
import { stationsAlongLine, type ProfileStation } from './profileStations';
import { buildProfileFrame } from './profileGeometry';
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
import { TOUCH_SLOP_PX } from '../touchTapGate';
import type {
  OverlayModel,
  OverlayVertex,
  OverlayEdge,
  OverlayPolygon,
  OverlayLabel,
} from './MeasureOverlay';

/** A press that travels further than this before release is a drag, not a click (CSS px). */
const CLICK_SLOP_PX = 4;
/** Clicking within this radius of a closable draft's first vertex finishes it (CSS px). */
const CLOSE_RADIUS_PX = 16;

/** Whether two box corners sit at one height along `up`, so the box has no volume. */
/** A deleted measurement and where it sat, for an Undo. */
export interface RemovedMeasurement {
  readonly measurement: Measurement;
  readonly index: number;
  readonly epoch: number;
}

/** Touch devices say "Tap" rather than "Click" in the instruction hint. */
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const VERB = COARSE_POINTER ? 'Tap' : 'Click';
const VERB_LOWER = VERB.toLowerCase();

const UNDO_TITLE = 'Remove the last point you placed (or press Backspace, or Ctrl/Cmd+Z).';
/** The Undo button while nothing is drafted: it is disabled, and the tooltip says why. */
const UNDO_DISABLED_TITLE = 'Undo last point (Backspace or Ctrl/Cmd+Z). Nothing to undo: the shape is finished.';
/** The hint when Undo is asked for with nothing drafted. */
export const NOTHING_TO_UNDO_HINT =
  'Nothing to undo here. To remove a finished measurement, use Delete on its result card or × in the Measurements list.';

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
  /** Points walked, Withheld left out, points read. Absent on older wirings. */
  withheld?: WithheldReadCounts;
  /** Method tag the series was sampled under. */
  method?: string;
  /** Truncation note when a static source read was truncated. */
  coverageNote?: string;
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
/** A picked point and the cloud it was picked on, when it came from one. */
export interface PickedPoint {
  readonly point: Vec3;
  readonly layer?: unknown;
}

export interface MeasurementSummary {
  id: string;
  kind: MeasurementKind;
  name: string;
  value: string;
  /** True when the horizontal unit is unknown, so no value may be read as metres. */
  unitUnverified?: boolean;
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
  /** Profile only — the sampler's corridor percentile (dimensionless). */
  profileGroundPercentile?: number;
  /**
   * Profile only — the measurement's provenance record, forwarded unchanged.
   *
   * Counts and stable layer ids, so it does not grow with the cloud and needs
   * no unit conversion at this seam. The PDF prints it because the reader of
   * an exported file cannot see the app state that produced the estimate.
   * Absent on a measurement recorded before the record existed.
   */
  profileProvenance?: ProfileProvenance;
  /**
   * Profile only — points walked, Withheld points left out, and points the
   * percentile read. Absent on a profile sampled before the exclusion
   * existed, which read every point.
   */
  profileWithheld?: WithheldReadCounts;
  /** Profile only — the method tag; absent on a profile sampled under v1. */
  profileMethod?: string;
  /** Profile only: the truncation note when a source file was truncated. */
  profileCoverageNote?: string;
  /**
   * Profile only — the cumulative chainages (in METRES, through the same B2
   * factor the chart/table read) of the intermediate station dots drawn on the
   * scene, in dot order. The panel uses these to couple a hovered chart tick or
   * station-table row to the matching scene dot by nearest chainage: index `i`
   * here is the same `i` the panel passes to `setHoveredStation`. Empty/absent
   * for a degenerate or non-profile measurement.
   */
  profileStationChainages?: number[];
  /**
   * Volume only — when true, the cut/fill record was sampled from
   * streaming resident nodes only. The panel surfaces a coverage caption
   * beneath the volume headline so the analyst understands the cubic
   * metres figure may refine as more nodes stream in.
   */
  /**
   * Distance only — the run, rise, slant and grade the SAME two picks already
   * fix. Surfaced so reading them no longer means placing a second measurement
   * of another kind over the same points. Absent for other kinds and for a
   * half-placed distance.
   */
  lineMetrics?: LineBreakdown;
  /**
   * Area only — planimetric area, best-fit plane area, perimeter and vertex
   * count for the closed ring. `planarM2` is the ring's own plane, NOT a draped
   * terrain surface; a consumer that labels it "surface area" overclaims.
   */
  areaMetrics?: AreaBreakdown;
  volumeResidentOnly?: boolean;
  /**
   * Volume only — the base level cut and fill are measured against, as the
   * row's clause: "Base level 412.35 m (median of the outline's vertex
   * heights)", marked local when the scene has no datum. The panel row, the
   * copied text and the PDF row all carry it.
   */
  volumeBaseLevel?: string;
}

/** Snap targeting mode: off, to real returns only, or to measurement geometry. */
export type SnapMode = 'off' | 'point' | 'geometry';

export class MeasureController {
  /** The SVG overlay element — append to the stage overlay. */
  readonly overlay: SVGSVGElement;
  /** The measurement toolbar shown while measuring — append to the overlay. */
  readonly hint: HTMLElement;

  private readonly _cb: MeasureCallbacks;
  private readonly _draw = new MeasureOverlay();
  private readonly _hintEl: HTMLElement;
  /** Phone-only copy of the instruction; shown beside the tool rail. */
  private readonly _phoneHintEl: HTMLElement;
  private readonly _clearBtn: HTMLButtonElement;
  private readonly _undoBtn: HTMLButtonElement;
  private readonly _unitsBtn: HTMLButtonElement;
  /** Finish-polygon button — shown only while a polygon draft is open. */
  private readonly _finishBtn: HTMLButtonElement | null = null;
  private readonly _kindButtons = new Map<MeasurementKind, HTMLButtonElement>();
  /**
   * The kind picker row container — exposed so the host can inject
   * complementary tool buttons (e.g. Lasso volume) next to the
   * built-in measurement kinds without forking the controller.
   * Populated in the constructor.
   */
  private readonly _kindRow: HTMLElement | null = null;
  private _onChange: (() => void) | null = null;
  /** Called when the unit system changes — used to persist the preference. */
  private _onUnitChange: (() => void) | null = null;
  /** Called when the active measurement kind changes (e.g. user picks Profile). */
  private _onKindChange: ((kind: MeasurementKind) => void) | null = null;

  /** Re-picks a cloud point at the given NDC — injected by the Viewer. */
  private _picker: ((ndcX: number, ndcY: number) => PickedPoint | null) | null = null;
  /** Stable layer id of a picked cloud, or null for a single-layer scene. */
  private _layerOf: ((layer: unknown) => string | null) | null = null;
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
        up?: Vec3,
      ) => VolumeRecord | { record: VolumeRecord; residentOnly: boolean } | null)
    | null = null;
  /**
   * Owner provider — injected by the app once identity is wired. Consulted when
   * a measurement is created, so the record names which layer it belongs to (by
   * stable id, in that layer's source-local frame). Returns undefined for a
   * single-layer scene, where the session's one origin already anchors the work
   * and stamping an owner would break the byte-identical round trip; null until
   * set, so a controller with no app wiring behaves exactly as before.
   */
  private _ownerProvider: (() => WorkOwnership | undefined) | null = null;
  /** The handle being dragged: a measurement id and vertex index. */
  // `x`/`y` are where the press began; `moved` turns true past the drag slop,
  // and only then does the press edit the vertex. A press released inside the
  // slop is a click on the vertex, which places a point there.
  /** `start` and `layers` are the dragged measurement's points and pick layers as they were, for a cancelled drag. */
  private _drag: { id: string; vi: number; x: number; y: number; moved: boolean; start: Vec3[]; layers: string[] | undefined } | null = null;
  /** Detaches the drag's window listeners (see `listenToDragPointer`). */
  private _detachDrag: (() => void) | null = null;
  /** Set while the tool is paused for navigation (hold Space): handles take no presses. */
  private _navPaused = false;
  /** Where the last canvas press began, so a click that ended a drag places nothing. */
  private _press: { x: number; y: number; slop: number } | null = null;
  /** Bumped by every whole-list replace, so an Undo never restores into another list. */
  private _epoch = 0;
  /** Overlay rect captured at drag start — fixed for the drag, so it isn't
   *  re-read (a forced reflow) on every pointermove. */
  private _dragRect: DOMRect | null = null;
  private _dragNdcX = 0;
  private _dragNdcY = 0;
  private _dragDirty = false;

  /** Completed measurements. */
  private _measurements: Measurement[] = [];
  /** The measurement currently being placed, if any. */
  private _draft: Measurement | null = null;
  /**
   * The one profile-station dot currently highlighted, as a pure
   * `{ measurement id, dot index }` pair — never a DOM reference. Set by the
   * panel when a profile-chart tick or station-table row is hovered, cleared on
   * mouse-leave / panel re-render / panel close. A stale pair (a deleted
   * measurement, or an index past the current dot count) simply matches nothing
   * in `_appendMeasurement`, so it can never light the wrong dot.
   */
  private _activeStation: { id: string; index: number } | null = null;
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
  /** The scene's render origin as `setContext` last gave it (undefined: never), so a layer's own up can reduce it. */
  private _origin: Vec3 | null | undefined = undefined;
  /**
   * While `_inFrameOf` holds work with no shared, resolved up axis (layers with
   * different up axes, or a layer whose axis is unresolved): what an
   * axis-dependent figure prints instead. Null otherwise.
   */
  private _upRefusalText: string | null = null;
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
  /**
   * The file declares a valid vertical unit. Read only on a geographic frame,
   * where the horizontal factor is not a linear unit and a height without a
   * declared vertical unit therefore has none.
   */
  private _verticalUnitKnown = false;
  /**
   * The file declares a vertical unit that cannot be read (an angular unit, a
   * zero, negative or non-finite factor). Every figure that reads Z is then
   * refused with {@link VERTICAL_SCALE_NOT_AVAILABLE}; the up axis draws with
   * the horizontal factor but no height is ever converted by it.
   */
  private _verticalUnitInvalid = false;
  // ── Snap (A1) ──────────────────────────────────────────────────────────────
  // Snapping a placed vertex to the nearest real return (honest default) or to
  // existing measurement geometry. `_snapIndex` is built from the resident
  // cloud on load; `_lastSnap` drives the disclosure in the hint. The camera +
  // canvas are cached each frame so the place handler can size the snap radius.
  private static readonly SNAP_RADIUS_PX = 14;
  private _snapMode: SnapMode = 'off';
  private readonly _snap = new ProjectSnapIndex((task) => { setTimeout(task, 0); });
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
  private _verticalRefused = false;
  /**
   * True when the active scan's CRS is PROJECTED with an EPSG code, so +Y is
   * grid north. A local engineering CRS can declare metres (`_crsKnown`) and
   * still have no north at all; the distance bearing reads "grid" only here.
   */
  private _projectedCrs = false;
  /**
   * The unit frame of the layer with this stable id, or null to use the active
   * scan's (the fields above). Null resolver: every measurement uses them.
   */
  private _unitResolver: ((layerId: string) => MeasureUnitFrame | null) | null = null;
  private _positionSteps: ((m: Measurement) => AxisSteps | null) | null = null; // per-layer position step (setPositionStepResolver); null: none withheld
  /** True while the fields above hold one measurement's own frame (see {@link _inFrameOf}). */
  private _inOwnFrame = false;
  private _lastCamera: THREE.PerspectiveCamera | null = null;
  private _lastCanvas: HTMLCanvasElement | null = null;
  private readonly _snapBtn: HTMLButtonElement | null = null;
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
    this._hintEl = politeStatus(el('span', { className: 'olv-measure-hint-text' }));
    this._phoneHintEl = politeStatus(el('div', { className: 'olv-measure-phone-hint olv-hidden' }));

    const undoBtn = el('button', {
      className: 'olv-measure-undo olv-micon-btn',
      unsafeHtml: ICON_UNDO + '<span class="olv-mlabel">Undo</span>',
      title: UNDO_DISABLED_TITLE,
      tip: 'Undo last point · ⌫ or Ctrl/⌘ Z',
      ariaLabel: 'Undo last point (Backspace, or Ctrl+Z)',
    });
    undoBtn.disabled = true;
    undoBtn.addEventListener('click', () => {
      undoBtn.blur();
      this.undoLastPoint();
    });
    this._undoBtn = undoBtn;
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
      title: 'Delete every measurement on the scan. Undo is offered for 8 seconds.',
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

    installNativeTitleStrip(this.hint);

    this._renderKindButtons();

    // Handle dragging: a pointerdown on a vertex handle starts an edit drag.
    this._draw.element.addEventListener('pointerdown', (e) => this._handlePointerDown(e));
  }

  /** Whether measurement mode is currently on. */
  get active(): boolean { return this._active; }

  /** Whether a measurement is open for editing (at least one point placed). */
  get drafting(): boolean { return this._draft !== null; }

  /** Set while a clipping box is drawn: the clip keeps its footprint at the scan's full height (clipFlow.ts). */
  boxFootprint = false;

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
   * Whether the scene asserted a shared datum — false when `setContext`
   * received a null origin (clouds recentred on conflicting origins share no
   * frame). Read by the host to feed the Measurements panel's per-value
   * context line (`MeasurePanel.setConfidenceContext`).
   */
  get datumResolved(): boolean {
    return this._originUp !== null;
  }

  /** The scene's datum along up (`elevationDatumOffset` of its render origin), or null when the clouds share none. */
  get elevationDatum(): number | null { return this._originUp; }
  /** The scene's render origin, or null when the clouds share none: a render position plus this is its source coordinate. */
  get sceneOrigin(): Vec3 | null { return this._origin ?? null; }

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
   * quantities refuse (see {@link _gradeMeasurement}). An invalid factor (NaN,
   * 0, negative) is a declared vertical unit that cannot be read: the up axis
   * draws with the horizontal factor, and every figure that reads Z is refused
   * rather than converted by that factor.
   */
  setVerticalUnitToMetres(factor: number): void {
    const valid = Number.isFinite(factor) && factor > 0;
    const next = valid ? factor : null;
    if (next === this._verticalUnitToMetres && valid !== this._verticalUnitInvalid) return;
    this._verticalUnitToMetres = next;
    this._verticalUnitInvalid = !valid;
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /** True when the file declares a vertical unit that cannot be read (see the field doc). */
  get verticalUnitInvalid(): boolean {
    return this._verticalUnitInvalid;
  }

  /** Flag whether the file declares a valid vertical unit (see the field doc). */
  setVerticalUnitKnown(known: boolean): void {
    if (known === this._verticalUnitKnown) return;
    this._verticalUnitKnown = known;
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._emitChange();
  }

  /** The effective up-axis factor — the vertical override, else the horizontal. */
  private _effVertical(): number {
    return this._verticalUnitToMetres ?? this._unitToMetres;
  }

  /**
   * The points in an ISOTROPIC frame: the up component rescaled so it shares
   * the horizontal render unit. This is the export's metre frame
   * (`toMetricFrame`, as `measurementMetrics` uses) divided by the horizontal
   * factor, so a figure computed here and formatted through `_fmtLen` /
   * `_fmtArea` equals the exported one. The identity (same array) whenever
   * the two units agree, which is every single-unit CRS.
   */
  private _iso(pts: readonly Vec3[]): Vec3[] {
    if (!this._verticalUnitMismatch()) return pts as Vec3[];
    const k = this._effVertical() / this._unitToMetres;
    return pts.map((p) => toMetricFrame(p, this._worldUp, 1, k));
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
   * Whether the active scan has a known CRS with real-world units. Drives the
   * trust grade's "scale verified" signal — distinct from `unitToMetres`, which
   * is 1 for BOTH a metric CRS and a CRS-less cloud, so the factor alone can't
   * tell a georeferenced metre survey from an ungeoreferenced one.
   */
  /**
   * True when the scan's linear scale is KNOWN (a resolved CRS unit), so a
   * measurement's `_m` value genuinely means metres. False for a local /
   * unknown-unit cloud, where `unitToMetres` is an inert 1 — the export path
   * reads this to caveat its metre labels (pass-6 M1).
   */
  get crsKnown(): boolean {
    return this._crsKnown;
  }

  setCrsKnown(known: boolean): void {
    if (known === this._crsKnown) return;
    this._crsKnown = known;
    // Re-grade existing measurements: the CRS-known signal feeds the trust
    // grade, so a measurement placed before the CRS resolved must not keep a
    // stale "no CRS — scale unverified" caption once it becomes known (or
    // gain one if a known CRS is later cleared). Mirrors the drag-end re-grade.
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /** Flag the active scan's CRS as projected with an EPSG code (see the field doc). */
  setProjectedCrs(projected: boolean): void {
    if (projected === this._projectedCrs) return;
    this._projectedCrs = projected;
    this._emitChange();
  }

  /** True when the active scan's CRS is geographic (degrees) — see the field doc. */
  get geographicCrs(): boolean {
    return this._geographicCrs;
  }

  /**
   * True when the active frame has no valid local vertical (geocentric, or a
   * depth-positive-down reference): heights, grades, profiles and volumes are
   * refused. `SpatialContext.verticalMetricRefused`, set with the horizontal
   * flag by {@link setGeographicCrs}.
   */
  get verticalRefused(): boolean {
    return this._verticalRefused;
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
  setGeographicCrs(isGeographic: boolean, verticalRefused = false): void {
    if (isGeographic === this._geographicCrs && verticalRefused === this._verticalRefused) return;
    this._geographicCrs = isGeographic;
    this._verticalRefused = verticalRefused;
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /**
   * Resolve a layer's unit frame by its stable id. With it set, a measurement
   * that names the layer(s) it was taken on (`pickLayers`, else its owner)
   * reads out in that layer's units and frame verdicts, whichever scan is
   * active; one spanning layers whose frames differ reads as unverified
   * ({@link UNRESOLVED_UNIT_FRAME}). A null answer, or work naming no layer,
   * keeps the active scan's factors.
   */
  setPositionStepResolver(resolve: ((m: Measurement) => AxisSteps | null) | null): void { this._positionSteps = resolve; this._emitChange(); }
  setUnitResolver(resolve: ((layerId: string) => MeasureUnitFrame | null) | null): void {
    this._unitResolver = resolve;
    this.refreshUnitFrames();
  }

  /** Re-read every measurement's unit frame: re-grade and re-emit. */
  refreshUnitFrames(): void {
    this._rederiveMovedUp();
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._updateHint();
    this._emitChange();
  }

  /** The active scan's unit frame (the controller-wide fields). */
  private _activeUnitFrame(): MeasureUnitFrame {
    return {
      unitToMetres: this._unitToMetres,
      verticalUnitToMetres: this._verticalUnitToMetres,
      verticalUnitKnown: this._verticalUnitKnown,
      verticalUnitInvalid: this._verticalUnitInvalid,
      crsKnown: this._crsKnown,
      geographic: this._geographicCrs,
      verticalRefused: this._verticalRefused,
      projected: this._projectedCrs,
      up: this._worldUp,
    };
  }

  /** The frame of the layer(s) `m` was taken on, or null to use the active scan's. */
  private _ownUnitFrame(m: Measurement): MeasureUnitFrame | null {
    const resolve = this._unitResolver;
    if (!resolve) return null;
    const ids = m.pickLayers && m.pickLayers.length > 0 ? m.pickLayers : m.owner?.layerId ? [m.owner.layerId] : [];
    const frames = ids.map((id) => resolve(id));
    if (frames.every((f) => f === null)) return null;
    const active = this._activeUnitFrame();
    const own = frames.map((f) => f ?? active);
    const units = own.every((f) => sameUnitFrame(f, own[0]!)) ? own[0]! : UNRESOLVED_UNIT_FRAME;
    // The up axis is the layers' own, never the scene's: a Z-up survey keeps Z
    // while a Y-up scan drives navigation. Layers that disagree share no vertical.
    // A layer with no resolved up axis withholds every axis-dependent figure.
    const ups = own.map((f) => f.up ?? this._worldUp);
    if (!ups.every((u) => sameUp(u, ups[0]!))) return { ...units, up: this._worldUp, upConflict: true };
    const upRefusal = own.find((f) => f.upRefusal)?.upRefusal;
    const { upRefusal: _drop, ...rest } = units;
    return { ...rest, up: ups[0]!, upConflict: false, ...(upRefusal ? { upRefusal } : {}) };
  }

  /**
   * The up vector `m`'s figures are read along: its layer's own up, else the
   * scene's (also when `m` is omitted). Exports use it so a file agrees with the panel.
   */
  upFor(m?: Measurement): Vec3 {
    return (m && !this._inOwnFrame ? this._ownUnitFrame(m)?.up : null) ?? this._worldUp;
  }

  /**
   * The unit frame `m`'s readouts are converted with (the active scan's when
   * `m` is omitted). Chain totals read it so a sum agrees with the panel rows.
   */
  unitFrameOf(m?: Measurement): MeasureUnitFrame {
    return (m && !this._inOwnFrame ? this._ownUnitFrame(m) : null) ?? this._activeUnitFrame();
  }

  /**
   * Run `fn` with the unit fields holding `m`'s own frame, restored after.
   * Every readout path (formatters, grade, frame refusals, profile scaling)
   * reads those fields, so one swap covers them all. Synchronous only.
   */
  private _inFrameOf<T>(m: Measurement, fn: () => T): T {
    const own = this._inOwnFrame ? null : this._ownUnitFrame(m);
    if (!own) return fn();
    const saved = this._activeUnitFrame();
    const savedOriginUp = this._originUp;
    const set = (f: MeasureUnitFrame): void => {
      // Up and the datum it reduces the origin along travel with the frame.
      this._worldUp = f.up ?? saved.up!;
      this._upRefusalText = f.upConflict === true ? UP_AXIS_CONFLICT : f.upRefusal ?? null;
      this._originUp = f === saved || !this._origin ? savedOriginUp : elevationDatumOffset(this._origin, this._worldUp);
      this._unitToMetres = f.unitToMetres;
      this._verticalUnitToMetres = f.verticalUnitToMetres;
      this._verticalUnitKnown = f.verticalUnitKnown;
      this._verticalUnitInvalid = f.verticalUnitInvalid;
      this._crsKnown = f.crsKnown;
      this._geographicCrs = f.geographic;
      this._verticalRefused = f.verticalRefused;
      this._projectedCrs = f.projected;
    };
    set(own);
    this._inOwnFrame = true;
    try {
      return fn();
    } finally {
      set(saved);
      this._inOwnFrame = false;
    }
  }

  /** A snapshot of all completed measurements. */
  getMeasurements(): Measurement[] {
    return this._measurements;
  }

  /** Replace all measurements — used when importing a session. */
  loadMeasurements(measurements: Measurement[]): void {
    this._epoch++;
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
    // Each row in the frame of the layer it was taken on (see `_inFrameOf`).
    return this._measurements.map((m) => this._inFrameOf(m, () => this._summaryOf(m)));
  }

  private _summaryOf(m: Measurement): MeasurementSummary {
    const f = this._unitToMetres;
    // The row, its breakdown and the overlay obey one refusal: a frame whose axes are not ground
    // distances prints the reason, and a figure withheld on the position step leaves no breakdown.
    const refusal = this._upRefusalText !== null && upAxisRefusesKind(m.kind) ? this._upRefusalText : this._frameRefusal(m.kind);
    const metricsOk = refusal === null && this._upRefusalText === null && this._unresolved(m).length === 0;
    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      value: refusal ?? this._headlineText(m),
      ...(this._unitUnverified() || (m.kind === 'height' && this._heightUnverified()) ? { unitUnverified: true } : {}),
      // An unreadable vertical unit has no metres for the chart's elevations.
      profileChart: m.profileChart && !this._verticalUnitInvalid && this._unresolved(m).length === 0
        ? scaleProfileSamples(m.profileChart, f, this._originUp, this._effVertical())
        : undefined,
      profileDatumKnown: this._originUp !== null,
      profileChartResidentOnly: m.profileChartResidentOnly,
      profileCorridorWidthM:
        m.profileCorridorWidth != null ? m.profileCorridorWidth * f : undefined,
      profileGroundPercentile: m.profileGroundPercentile,
      profileProvenance: m.profileProvenance,
      profileWithheld: m.profileWithheld,
      profileMethod: m.profileMethod,
      ...(m.profileCoverageNote ? { profileCoverageNote: m.profileCoverageNote } : {}),
      // Station-dot chainages in metres (× the same B2 factor as the samples),
      // in dot order, so the panel can couple a hovered tick/row to the scene
      // dot at the matching index. Only meaningful for profiles.
      profileStationChainages:
        m.kind === 'profile'
          ? this._profileStations(m).map((s) => s.chainage * f)
          : undefined,
      // The values the pick already fixed, through the SAME factor split the
      // headline uses: horizontal quantities by `f`, the rise by the up-axis
      // factor. No geometry is recomputed here.
      lineMetrics:
        m.kind === 'distance' && m.points.length >= 2 && metricsOk
          ? lineBreakdown(m.points[0], m.points[1], this._worldUp, f, this._effVertical())
          : undefined,
      areaMetrics:
        m.kind === 'area' && m.points.length >= 3 && areaRingVerdictCached(m.points).ok && metricsOk
          ? areaBreakdown(m.points, this._worldUp, f, this._effVertical())
          : undefined,
      volumeResidentOnly: m.volumeResidentOnly,
      volumeBaseLevel: this._volumeBaseLevel(m),
      trust: m.trust,
    };
  }

  /** The volume's base level as an elevation, through the datum offset the profile rows use; local without a datum. */
  private _volumeBaseLevel(m: Measurement): string | undefined {
    const v = m.volume;
    if (m.kind !== 'volume' || !v || !Number.isFinite(v.referenceZ) || this._verticalRefused || this._verticalUnitInvalid) return undefined;
    const level = (v.referenceZ + (this._originUp ?? 0)) * this._effVertical();
    const text = this._unitUnverified() || this._heightUnverified() ? formatUnitUnverified(level) : formatElevation(level, this._units);
    return volumeBaseLevelClause(text, this._originUp !== null);
  }

  /**
   * Highlight a single profile-station dot on the scene, or clear the
   * highlight. `index` indexes the intermediate station dots of measurement
   * `id`, in the same order as `MeasurementSummary.profileStationChainages` —
   * the panel resolves a hovered chart tick / table row to that index and calls
   * this. Passing a null id or index (or an out-of-range index) clears the
   * highlight; a stale pair simply matches no dot next frame.
   *
   * Returns `true` only when the active dot actually changed, so the host can
   * skip a redraw request on a redundant hover event. The controller does not
   * own the render loop — the caller pairs a `true` result with its own
   * `requestFrame()`; the next rendered frame reprojects the overlay and the
   * `is-active` class appears or clears.
   */
  setHoveredStation(id: string | null, index: number | null): boolean {
    const next =
      id != null && index != null && Number.isInteger(index) && index >= 0
        ? { id, index }
        : null;
    const cur = this._activeStation;
    const same =
      (cur === null && next === null) ||
      (cur !== null && next !== null && cur.id === next.id && cur.index === next.index);
    if (same) return false;
    this._activeStation = next;
    return true;
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
      if (anchorBtn?.parentElement === this._kindRow) {
        anchorBtn.after(btn);
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
  setPicker(pick: (ndcX: number, ndcY: number) => PickedPoint | null): void {
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
   * (B7/B8, v0.4.5): corridor half-width (metres), corridor percentile and
   * sample count. Null/absent fields reset to the defaults (auto corridor,
   * p25, 64 bins). Inputs are clamped to the shared bounds, never rejected.
   * Returns true when the measurement was re-sampled and a change emitted;
   * false when the id is unknown / not a profile / no sampler is wired —
   * the panel leaves the row untouched in that case.
   */
  resampleProfile(id: string, params: ProfileResampleParams): boolean {
    if (!this._profileSampler) return false;
    const m = this._measurements.find((x) => x.id === id);
    if (m?.kind !== 'profile' || m.points.length < 2) return false;
    // Clamp in METRES (the user's input space), then convert to render units
    // through the same B2 factor the summary boundary applies forward — the
    // exact inverse, so what the user typed is what the sampler walks. The
    // normalisation is pure + tested in profileSampler.ts.
    const opts = normaliseResampleParams(params, this.unitFrameOf(m).unitToMetres);
    const sampler = this._profileSampler;
    try {
      const result = this._inFrameOf(m, () => sampler(m.points[0], m.points[1], opts));
      if (!result) return false;
      this._stampProfileSample(m, result);
      this._noteDerivedUp(m);
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
   * Re-sample every profile measurement with the parameters it was last
   * sampled with. The host calls this when streaming residency changes, so a
   * resident-only profile is re-drawn over the full stream once it is in. It
   * writes no stored preference, unlike `resampleProfile`.
   */
  resampleProfilesInPlace(): void {
    let changed = false;
    for (const m of this._measurements) changed = this._resampleInPlace(m) || changed;
    if (changed) this._emitChange();
  }

  /** Re-sample one profile with the parameters it was last sampled with; true when it was. */
  private _resampleInPlace(m: Measurement): boolean {
    const sampler = this._profileSampler;
    if (!sampler || m.kind !== 'profile' || m.points.length < 2) return false;
    // A chart withheld for a moved axis is re-cut with the default sample count.
    if (!m.profileChart && m.derivedWithheld === undefined) return false;
    try {
      const result = this._inFrameOf(m, () => sampler(m.points[0], m.points[1], {
        corridorWidth: m.profileCorridorWidth ?? null,
        groundPercentile: m.profileGroundPercentile ?? null,
        sampleCount: m.profileChart?.length ?? null,
      }));
      if (!result) return false;
      this._stampProfileSample(m, result);
      this._noteDerivedUp(m);
      return true;
    } catch {
      // A failed re-sample keeps the previous chart, as in `resampleProfile`.
      return false;
    }
  }

  /** Record the up axis `m`'s profile chart or volume was just cut along. */
  private _noteDerivedUp(m: Measurement): void {
    const axis = axisOfUp(this.upFor(m));
    if (axis && (m.profileChart || m.volume)) {
      m.derivedUpAxis = axis;
      delete m.derivedWithheld;
    }
  }

  /**
   * Re-cut every profile chart and volume record that was cut along an up axis
   * its layer no longer resolves to: a session saved under another frame and
   * reopened, or a CRS assigned, replaced or cleared after the measurement was
   * taken. Stored points never move. A result that cannot be re-cut here (no
   * sampler, no points under it) is withheld with the reason rather than kept
   * along the old axis, and is retried on the next frame change. Returns how
   * many were re-cut and how many are withheld.
   */
  recutDerived(): { readonly recut: number; readonly withheld: number } {
    const r = this._rederiveMovedUp();
    for (const m of this._measurements) m.trust = this._gradeMeasurement(m);
    this._emitChange();
    return r;
  }

  private _rederiveMovedUp(): { recut: number; withheld: number } {
    let recut = 0;
    let withheld = 0;
    for (const m of this._measurements) {
      if (m.kind !== 'profile' && m.kind !== 'volume') continue;
      const now = axisOfUp(this.upFor(m));
      const was = m.derivedUpAxis;
      if (now === null || (m.derivedWithheld === undefined && (was === undefined || was === now))) continue;
      if (m.kind === 'profile' ? this._resampleInPlace(m) : this._resampleVolume(m)) {
        recut++;
        continue;
      }
      withheld++;
      if (m.derivedWithheld !== undefined) continue;
      const what = m.kind === 'profile' ? 'Profile chart' : 'Cut and fill';
      m.derivedWithheld =
        `${what} withheld: it was cut along ${was!.toUpperCase()}, and this layer's up axis is now ${now.toUpperCase()}. ` +
        `It could not be re-cut here; ${m.kind === 'profile' ? 'resample the profile' : 'redraw the volume'} once the layer's points are loaded.`;
      if (m.kind === 'profile') m.profileChart = undefined;
      else {
        m.volume = undefined;
        m.volumeResidentOnly = undefined;
      }
    }
    return { recut, withheld };
  }

  /** Re-sample one volume along its own up; true when a record was written. */
  private _resampleVolume(m: Measurement): boolean {
    const before = { volume: m.volume, residentOnly: m.volumeResidentOnly };
    m.volume = undefined;
    m.volumeResidentOnly = undefined;
    this._sampleVolume(m);
    if (m.volume) {
      this._noteDerivedUp(m);
      return true;
    }
    m.volume = before.volume;
    m.volumeResidentOnly = before.residentOnly;
    return false;
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
          up?: Vec3,
        ) =>
          | VolumeRecord
          | { record: VolumeRecord; residentOnly: boolean }
          | null)
      | null,
  ): void {
    this._volumeSampler = sampler;
  }

  /**
   * Inject the owner provider consulted when a measurement is created. The app
   * sets it once identity is wired; passing `null` restores the unowned default.
   */
  setOwnerProvider(provider: (() => WorkOwnership | undefined) | null): void {
    this._ownerProvider = provider;
  }

  /**
   * Give every measurement without an owner, and an open draft, this owner.
   * Called when a second layer joins: work placed while one layer was open
   * was taken on that layer, in the frame it still anchors.
   */
  claimUnowned(layerId: string): void {
    const owner: WorkOwnership = { layerId, frame: 'project' };
    // Every point placed while one layer was open was picked on that layer.
    for (const m of [...this._measurements, ...(this._draft ? [this._draft] : [])]) {
      if (!m.owner) m.owner = owner;
      if (!m.pickLayers) m.pickLayers = [layerId];
    }
  }

  /** The owner to stamp on a freshly created measurement, when one is provided. */
  private _newOwner(): WorkOwnership | undefined {
    return this._ownerProvider ? this._ownerProvider() : undefined;
  }

  /** Whether a vertex handle is currently being dragged. */
  get dragging(): boolean {
    return this._drag !== null;
  }

  /** Delete a measurement by id; the result restores it through {@link restoreMeasurement}. */
  removeMeasurement(id: string): RemovedMeasurement | null {
    const index = this._measurements.findIndex((m) => m.id === id);
    if (index < 0) return null;
    const [measurement] = this._measurements.splice(index, 1);
    this._updateHint();
    this._emitChange();
    return { measurement, index, epoch: this._epoch };
  }

  /**
   * Put a deleted measurement back at its old place in the list, with its id,
   * name and owner. False when the list was replaced or cleared since, or the
   * id is back already.
   */
  restoreMeasurement(r: RemovedMeasurement): boolean {
    if (r.epoch !== this._epoch || this._measurements.some((m) => m.id === r.measurement.id)) return false;
    this._measurements.splice(Math.min(r.index, this._measurements.length), 0, r.measurement);
    this._updateHint();
    this._emitChange();
    return true;
  }

  /** Record where a canvas press began; `touch` widens the slop to the tap slop. */
  notePress(x: number, y: number, touch: boolean): void {
    this._press = { x, y, slop: touch ? TOUCH_SLOP_PX : CLICK_SLOP_PX };
  }

  /**
   * A canvas click while measuring, in canvas pixels. A click that ended a
   * drag (an orbit) places nothing. A click on the first vertex of a closable
   * draft finishes it; any other click places the point under the cursor.
   */
  clickAt(x: number, y: number): void {
    const press = this._press;
    this._press = null;
    if (press && Math.hypot(x - press.x, y - press.y) > press.slop) return;
    const canvas = this._lastCanvas;
    if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    if (this._closesAt(x, y)) return;
    const hit = this._picker?.((x / canvas.clientWidth) * 2 - 1, -(y / canvas.clientHeight) * 2 + 1) ?? null;
    this.addPoint(hit?.point ?? null, hit?.layer);
  }

  /** Finish the draft when (x, y) lands on its first vertex. */
  private _closesAt(x: number, y: number): boolean {
    const first = this.firstVertexForClose();
    const cam = this._lastCamera;
    const canvas = this._lastCanvas;
    if (!first || !cam || !canvas) return false;
    const s = this._draw.project(first, cam, canvas.clientWidth, canvas.clientHeight);
    if (Math.hypot(x - s.x, y - s.y) > CLOSE_RADIUS_PX) return false;
    this.finishCurrent();
    return true;
  }

  /** A click on an existing vertex handle: place a point exactly on that vertex. */
  private _placeOnVertex(id: string, vi: number, clientX: number, clientY: number): void {
    const m = this._measurements.find((x) => x.id === id);
    let p: Vec3 | undefined;
    if (m?.kind === 'box' && m.points.length >= 2) p = boxCorners(boxFromCorners(m.points[0], m.points[1]), this.upFor(m))[vi];
    else p = m?.points[vi];
    if (!p) return;
    const r = this._lastCanvas?.getBoundingClientRect();
    if (!this._active || (r && this._closesAt(clientX - r.left, clientY - r.top))) return;
    this._draft ??= this._newDraft();
    this._lastSnap = { kind: 'endpoint', position: [p[0], p[1], p[2]], distance: 0 };
    this._draft.points.push([p[0], p[1], p[2]]);
    if (m) this._noteSourceOf(this._draft, m);
    if (isFull(this._draft)) this._commitDraft();
    this._updateHint();
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
    // Same source-local ownership a hand-drawn volume gets (see `_commitDraft`).
    const owner = this._newOwner();
    if (owner) m.owner = owner;
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

  private _noticeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Enter or leave measurement mode. Completed measurements stay drawn. */
  setActive(on: boolean): void {
    // Leaving the mode abandons the draft; an Area ring that was refused says
    // why on the measure bar, which stays visible briefly after the mode ends.
    let refusal: string | null = null;
    if (!on && this._draft?.kind === 'area' && this._draft.points.length >= MIN_POINTS.area) {
      const v = areaRingVerdictCached(this._draft.points);
      if (!v.ok) refusal = `Area polygon not saved. ${v.text}`;
    }
    if (this._noticeTimer !== undefined) clearTimeout(this._noticeTimer);
    this._noticeTimer = undefined;
    this._active = on;
    this._snap.setWarming(on);
    this._draft = null;
    this._cursor = null;
    if (!on) this.cancelDrag(); // a drag the tool change interrupted goes back, as Esc would
    this.hint.classList.toggle('olv-hidden', !on);
    this._syncPhoneHint();
    this._updateHint();
    if (refusal) {
      this._setHintText(refusal);
      this.hint.classList.remove('olv-hidden');
      this._syncPhoneHint();
      this._noticeTimer = setTimeout(() => {
        this._noticeTimer = undefined;
        if (!this._active) {
          this.hint.classList.add('olv-hidden');
          this._syncPhoneHint();
        }
      }, 6000);
    }
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
    this._origin = ctx.origin;
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
  /**
   * Resolve a picked cloud to its stable layer id. The id is recorded on the
   * measurement so its export places each point through the layer it was
   * picked on, not the active one.
   */
  setLayerResolver(resolve: ((layer: unknown) => string | null) | null): void {
    this._layerOf = resolve;
  }

  private _notePick(m: Measurement, layer: unknown): void {
    const id = layer !== undefined && this._layerOf ? this._layerOf(layer) : null;
    if (!id) return;
    if (!m.pickLayers) m.pickLayers = [id];
    else if (!m.pickLayers.includes(id)) m.pickLayers.push(id);
  }

  /** Record the scans `src`'s points were picked on (or its owner's) on `m`. */
  private _noteSourceOf(m: Measurement, src: Measurement): void {
    const ids = src.pickLayers && src.pickLayers.length > 0 ? src.pickLayers : src.owner?.layerId ? [src.owner.layerId] : [];
    for (const id of ids) {
      if (!m.pickLayers) m.pickLayers = [id];
      else if (!m.pickLayers.includes(id)) m.pickLayers.push(id);
    }
  }

  /** Committed measurements with a vertex or segment through `p`. */
  private _measurementsAt(p: Vec3): Measurement[] {
    const near = (a: Vec3, b: Vec3): boolean => {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2)) : 0;
      const d = Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]);
      return d <= 1e-6 * Math.max(1, Math.hypot(p[0], p[1], p[2]));
    };
    return this._measurements.filter((m) => {
      const pts = m.points;
      if (pts.length === 1) return near(pts[0], pts[0]);
      for (let i = 1; i < pts.length; i++) if (near(pts[i - 1], pts[i])) return true;
      return m.closed === true && pts.length > 2 && near(pts[pts.length - 1], pts[0]);
    });
  }

  addPoint(point: Vec3 | null, layer?: unknown): void {
    if (!this._active) return;
    if (!point) {
      this._setHintText(`No point there — ${VERB_LOWER} directly on the scan`);
      return;
    }
    this._draft ??= this._newDraft();
    // Snap the placed vertex to a real return or to existing measurement
    // geometry before committing it. `_lastSnap` records what it landed on so
    // the hint can disclose it (a snap never implies a return that isn't one).
    const snap = this._resolveSnap(point);
    this._lastSnap = snap;
    const placed = snap ? snap.position : point;
    this._draft.points.push([placed[0], placed[1], placed[2]]);
    // A snap onto measurement geometry takes its point from the measurements
    // under it, so it records their scans rather than the cloud clicked.
    const sources = snap && snap.kind !== 'point' ? this._measurementsAt(placed) : [];
    if (sources.length > 0) for (const src of sources) this._noteSourceOf(this._draft, src);
    else this._notePick(this._draft, layer);
    if (isFull(this._draft)) this._commitDraft();
    this._updateHint();
  }

  /**
   * Where the snap layers come from: every visible, unlocked static layer with
   * its placement offset (none for a streaming scan, which has no resident
   * array, so snapping stays off). Pulled lazily after {@link invalidateSnap}.
   */
  setSnapLayers(
    entries: () => Iterable<readonly [string, SnapLayerEntry]>,
    streaming: () => boolean,
  ): void {
    this._snap.setProvider(() => eligibleSnapLayers(entries(), streaming()));
  }

  /** The eligible layer set, a layer's visibility or lock, or a placement changed. */
  invalidateSnap(): void {
    this._snap.invalidate();
  }

  /** The active snap mode. */
  get snapMode(): SnapMode {
    return this._snapMode;
  }

  /** Set the snap mode and re-label the toggle. */
  setSnapMode(mode: SnapMode): void {
    this._snapMode = mode;
    if (mode === 'off') this._lastSnap = null;
    this._syncSnapBtn();
    this._updateHint();
  }

  private _cycleSnapMode(): void {
    let next: SnapMode;
    if (this._snapMode === 'off') next = 'point';
    else if (this._snapMode === 'point') next = 'geometry';
    else next = 'off';
    this.setSnapMode(next);
  }

  private _syncSnapBtn(): void {
    if (!this._snapBtn) return;
    let label: string;
    if (this._snapMode === 'off') label = 'Snap: Off';
    else if (this._snapMode === 'point') label = 'Snap: Point';
    else label = 'Snap: Geom';
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
    if (this._snapMode === 'off' || !this._snap.available) return null;
    const cam = this._lastCamera;
    const canvas = this._lastCanvas;
    if (!cam || !canvas) return null;
    const maxDistance = this._snapWorldRadius(query, cam, canvas);
    if (!(maxDistance > 0)) return null;
    if (this._snapMode === 'point') {
      return this._snap.nearest(query, maxDistance);
    }
    return this._snap.best(this._snapSegments(), query, maxDistance);
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
    let where: string;
    if (k === 'point') where = 'nearest point (measured return)';
    else if (k === 'endpoint') where = 'measurement vertex';
    else if (k === 'midpoint') where = 'segment midpoint';
    else where = 'segment intersection';
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
      if (this._draft.kind === 'area') {
        // A ring that establishes no area is not committed; the draft stays
        // open so a vertex can be moved or removed.
        const v = areaRingVerdictCached(this._draft.points);
        if (!v.ok) {
          this._setHintText(`${v.text} Undo a vertex or adjust it, then finish.`);
          return;
        }
        this._draft.closed = true;
      }
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

  /** Remove the most recently placed vertex of the in-progress measurement; with none, say so. */
  undoLastPoint(): void {
    if (!this._draft) {
      this._setHintText(NOTHING_TO_UNDO_HINT);
      return;
    }
    this._draft.points.pop();
    if (this._draft.points.length === 0) this._draft = null;
    this._updateHint();
  }

  /** Called after Clear with every removed measurement, for an Undo. Set by the panel mount. */
  onClearAll: ((removed: RemovedMeasurement[]) => void) | null = null;

  /** Remove every measurement at once; {@link onClearAll} receives them for an Undo. */
  clear(): void {
    const removed = this._measurements;
    this._epoch++;
    this._measurements = [];
    this._draft = null;
    this._updateHint();
    this._emitChange();
    if (removed.length > 0) this.onClearAll?.(removed.map((measurement, index) => ({ measurement, index, epoch: this._epoch })));
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
    if (this._noticeTimer !== undefined) clearTimeout(this._noticeTimer);
    this.cancelDrag();
    this._draw.dispose();
    this.hint.remove();
    this._phoneHintEl.remove();
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
    // Assigned, not only set: a resample replaces the counts with its own.
    m.profileWithheld = Array.isArray(result) ? undefined : result.withheld;
    m.profileMethod = Array.isArray(result) ? undefined : result.method;
    m.profileCoverageNote = Array.isArray(result) ? undefined : result.coverageNote;
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
    // An angle with a zero-length arm has no defined value; like a refused Area
    // ring it is not committed. The coincident point is dropped so the draft
    // stays open for a different third point.
    if (m.kind === 'angle' && !Number.isFinite(this._inFrameOf(m, () => angleAtVertex(...(this._iso(m.points) as [Vec3, Vec3, Vec3]))))) {
      m.points.pop();
      this._setHintText(`Angle not saved. ${ANGLE_UNDEFINED_READOUT}: a point coincides with the vertex. Pick a different point.`);
      return;
    }
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
        const opts = stored ? normaliseResampleParams(stored, this.unitFrameOf(m).unitToMetres) : undefined;
        // In the owner's frame: the profile is cut along its layer's own up.
        const sampler = this._profileSampler;
        const result = this._inFrameOf(m, () => sampler(m.points[0], m.points[1], opts));
        if (result) this._stampProfileSample(m, result);
      } catch {
        // Sampler errors must not poison the measurement; the scalar
        // metrics still display correctly without the chart.
      }
    }
    this._sampleVolume(m);
    // The up these derived results were cut along; a later change of the
    // layer's resolved frame (a CRS assigned, replaced or cleared) re-cuts.
    this._noteDerivedUp(m);
    m.trust = this._gradeMeasurement(m);
    // Record which layer this measurement belongs to, by stable id, in that
    // layer's source-local frame. Undefined for a single-layer scene, so the
    // pre-identity byte shape is preserved exactly (see LayerIdentityService).
    const owner = this._newOwner();
    if (owner && !m.owner) m.owner = owner;
    if (m.kind === 'box' && this.boxFootprint) m.clipRegion = true;
    this._measurements.push(m);
    this._draft = null;
    this._emitChange();
  }

  /**
   * Volume-only: sample cut/fill against the loaded cloud, using the
   * polygon's auto-reference Z (median of vertex heights), along the
   * measurement's own up. The sampler is allowed to fail; a null result
   * leaves `m.volume` unset and the panel shows the polygon area + "—" cut/fill.
   */
  private _sampleVolume(m: Measurement): void {
    if (
      m.kind === 'volume' &&
      this._volumeSampler &&
      m.points.length >= MIN_POINTS.volume
    ) {
      try {
        const up = this.upFor(m);
        const result = this._volumeSampler(m.points, autoReferenceZ(m.points, up), up);
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
  }

  /**
   * Stamp the per-measurement honesty grade from the support under each
   * endpoint. Only graded when a snap index exists (no cloud → no grade). The
   * trust radius is a few nominal point spacings (the index's cell size ≈ one
   * point per cell), so a dense neighbourhood reads as well-supported and a
   * void reads as unsupported.
   */
  private _gradeMeasurement(m: Measurement): MeasurementTrust | undefined {
    if (!this._snap.available) return undefined;
    return this._inFrameOf(m, () => this._gradeInFrame(m));
  }

  private _gradeInFrame(m: Measurement): MeasurementTrust {
    const snap = this._snap;
    const vertices = m.points.map((p) => snap.support(p));
    return gradeMeasurement({
      vertices,
      crsKnown: this._crsKnown,
      frameGeographic: this._geographicCrs,
      verticalUnitKnown: this._verticalUnitKnown,
      residentOnly: m.volumeResidentOnly === true || m.profileChartResidentOnly === true,
      // Geographic (degree) frame: the refusal applies to every kind whose
      // NUMBER mixes degree X/Y with linear Z — lengths, areas, grades,
      // profiles, boxes, volumes, AND angles. Only a pure-vertical height (Δ
      // along up, in the Z unit) keeps its ordinary grade. A 3D angle is NOT
      // unit-free unless the axes share a scale: it is invariant under UNIFORM
      // scaling only, so an arm mixing degree horizontal with linear vertical
      // gives a raw-coordinate angle that is physically wrong (pass-6 M3).
      geographicCrs: this._frameRefusal(m.kind) === GEOGRAPHIC_NOT_AVAILABLE,
      verticalRefused: this._frameRefusal(m.kind) === VERTICAL_NOT_AVAILABLE,
      verticalScaleInvalid: this._frameRefusal(m.kind) === VERTICAL_SCALE_NOT_AVAILABLE,
      ...(m.derivedWithheld ? { derivedWithheld: m.derivedWithheld } : {}),
      upConflict: this._upRefusalText === UP_AXIS_CONFLICT && upAxisRefusesKind(m.kind),
      ...(this._upRefusalText !== null && this._upRefusalText !== UP_AXIS_CONFLICT && upAxisRefusesKind(m.kind) ? { upRefusal: this._upRefusalText } : {}),
    });
  }

  /** Keep the phone line beside the bar and shown exactly when the bar is. */
  private _syncPhoneHint(): void {
    if (!this._phoneHintEl.isConnected && this.hint.parentElement) {
      this.hint.parentElement.insertBefore(this._phoneHintEl, this.hint.nextSibling);
    }
    this._phoneHintEl.classList.toggle('olv-hidden', this.hint.classList.contains('olv-hidden'));
  }

  private _setHintText(text: string): void {
    // Write only on a real change so a polite live region announces once.
    if (this._hintEl.textContent !== text) this._hintEl.textContent = text;
    if (this._phoneHintEl.textContent !== text) this._phoneHintEl.textContent = text;
    this._clearBtn.classList.toggle('olv-hidden', this._measurements.length === 0);
  }

  private _renderKindButtons(): void {
    for (const [k, btn] of this._kindButtons) {
      btn.classList.toggle('olv-mkind-active', k === this._kind);
      btn.setAttribute('aria-pressed', String(k === this._kind)); // the chosen kind, for a screen reader
    }
  }

  private _holds = 0;
  private _owed = false;

  private _emitChange(): void {
    if (this._holds > 0) this._owed = true;
    else this._onChange?.();
  }

  /** Run `fn` with change notifications held, then notify once if any fired: a frame change is several writes, and a subscriber must not see the first beside results still cut along the old axis. */
  holdChange<T>(fn: () => T): T {
    this._holds++;
    try { return fn(); } finally { if (--this._holds === 0 && this._owed) { this._owed = false; this._onChange?.(); } }
  }

  /**
   * Pause or resume the tool for navigation. While paused the handles let
   * presses through to the camera, and a press cannot start a vertex edit.
   */
  setNavigationPaused(paused: boolean): void {
    if (paused) this.cancelDrag(); // the pointer goes to the camera, so a drag it began ends unedited
    this._navPaused = paused;
    this._draw.element.classList.toggle('olv-nav-paused', paused);
  }

  /** A pointerdown on a vertex handle begins an edit drag. */
  private _handlePointerDown(e: PointerEvent): void {
    if (!this._active || this._navPaused || this._drag) return;
    const target = e.target as SVGElement | null;
    const mid = target?.dataset.mid ?? null;
    const viAttr = target?.dataset.vi ?? null;
    if (mid === null || viAttr === null) return;
    const m = this._measurements.find((x) => x.id === mid);
    if (!m) return;
    e.preventDefault();
    const start = m.points.map((p): Vec3 => [p[0], p[1], p[2]]);
    this._drag = { id: mid, vi: Number(viAttr), x: e.clientX, y: e.clientY, moved: false, start, layers: m.pickLayers?.slice() };
    this._dragRect = this._draw.element.getBoundingClientRect();
    this._cursor = null;
    // Only this pointer moves or ends the drag; its cancel, a focus loss or Esc puts the vertex back.
    this._detachDrag = listenToDragPointer(e.pointerId, { move: (ev) => this._handleDragMove(ev), up: (ev) => this._endDrag(ev), cancel: () => this.cancelDrag() });
  }

  /** End a handle drag with the measurement as it was before it. True when a drag was open. */
  cancelDrag(): boolean {
    const drag = this._drag;
    if (!drag) return false;
    const m = this._measurements.find((x) => x.id === drag.id);
    if (m && drag.moved) { drag.start.forEach((p, i) => { m.points[i] = [p[0], p[1], p[2]]; }); m.pickLayers = drag.layers?.slice(); } // a scan the drag passed over is not one the points came from
    this._endDrag();
    return true;
  }

  /** Track the drag pointer; the actual re-pick is coalesced into `render`. */
  private _handleDragMove(e: PointerEvent): void {
    const drag = this._drag;
    if (!drag) return;
    if (!drag.moved) {
      const slop = e.pointerType === 'touch' ? TOUCH_SLOP_PX : CLICK_SLOP_PX;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= slop) return;
      drag.moved = true;
    }
    // Reuse the rect captured at drag start; re-reading per pointermove forces a
    // synchronous reflow. Fall back if it was somehow not captured.
    const rect = this._dragRect ?? this._draw.element.getBoundingClientRect();
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
    const picked = this._picker(this._dragNdcX, this._dragNdcY);
    if (!picked) return;
    const point = picked.point;
    const m = this._measurements.find((x) => x.id === drag.id);
    if (!m) return;
    this._notePick(m, picked.layer);
    if (m.kind === 'box' && m.points.length >= 2 && drag.vi >= 0 && drag.vi <= 7) {
      // A box handle names a wireframe corner, not a stored point. Resizing
      // keeps the diagonally opposite corner fixed and re-normalises, so the
      // stored pair stays a valid min/max diagonal and every derived figure
      // (dimensions, volume, surface area) recomputes from the edited box on
      // the next model build.
      const next = resizeBoxByCorner(
        boxFromCorners(m.points[0], m.points[1]),
        drag.vi as BoxCornerIndex,
        [point[0], point[1], point[2]],
        this.upFor(m),
      );
      m.points[0] = [next.min[0], next.min[1], next.min[2]];
      m.points[1] = [next.max[0], next.max[1], next.max[2]];
      return;
    }
    if (drag.vi < m.points.length) {
      m.points[drag.vi] = [point[0], point[1], point[2]];
    }
  }

  /** End a handle drag, detaching the window listeners. */
  private _endDrag(e?: PointerEvent): void {
    const drag = this._drag;
    if (!drag) return;
    // A release can land before the frame that re-picks the last move: apply that move, then the release point if it hits (a cancel passes no event).
    if (e && drag.moved) { this._applyDrag(); this._handleDragMove(e); this._applyDrag(); }
    const draggedId = drag.id;
    this._drag = null;
    this._dragRect = null;
    this._dragDirty = false;
    this._detachDrag?.();
    this._detachDrag = null;
    // Released without moving: a click on the vertex, not an edit.
    if (!drag.moved) {
      if (e) this._placeOnVertex(draggedId, drag.vi, e.clientX, e.clientY);
      return;
    }
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

  /**
   * No resolved horizontal unit (and not a geographic frame, which carries its
   * own caveat): the factor is an inert 1, so values print in source units
   * marked unverified rather than as metres.
   */
  /** The frame refusal for `kind` in the current frame (see `frameRefusalText`). */
  private _frameRefusal(kind: MeasurementKind): string | null {
    return frameRefusalText(kind, this._geographicCrs, this._verticalRefused, this._verticalUnitInvalid);
  }

  private _unitUnverified(): boolean {
    return !this._crsKnown && !this._geographicCrs;
  }

  /**
   * No known unit for a height. On a geographic frame the horizontal factor
   * is degrees (an inert 1), so only a declared vertical unit makes a height
   * metres; elsewhere a height follows the horizontal verdict.
   */
  private _heightUnverified(): boolean {
    return this._geographicCrs ? !this._verticalUnitKnown : this._unitUnverified();
  }

  private _fmtLen(renderUnits: number): string {
    if (this._unitUnverified()) return formatUnitUnverified(renderUnits);
    return formatLengthRender(renderUnits, this._unitToMetres, this._units);
  }

  /**
   * Format a PURE-VERTICAL length (a height / drop / box height) through the
   * up-axis factor. Equals {@link _fmtLen} on a single-unit CRS (bit-identical);
   * on a compound CRS it honours the height unit the horizontal factor can't.
   */
  private _fmtVertical(renderUnits: number): string {
    if (this._heightUnverified()) return formatUnitUnverified(renderUnits);
    return formatLengthRender(renderUnits, this._effVertical(), this._units);
  }

  /**
   * Format a cut/fill volume — a horizontal footprint (linear²) times a
   * vertical thickness (up-axis unit). Scales linear²·vertical, so a compound
   * CRS reads honest cubic metres; on a single-unit CRS this is exactly the
   * uniform `f³` an equal vertical factor collapses to.
   */
  private _fmtCutFill(renderUnitsCu: number): string {
    if (this._unitUnverified()) return formatUnitUnverified(renderUnitsCu);
    const f = this._unitToMetres;
    return formatVolume(renderUnitsCu * f * f * this._effVertical(), this._units);
  }

  /** Formatted area when the ring establishes one, otherwise the stated reason. */
  private _areaFmt(ring: Vec3[], area: () => number): string {
    const v = areaRingVerdictCached(ring);
    return v.ok ? this._fmtArea(area()) : `no area: ${v.text}`;
  }

  private _fmtArea(renderUnitsSq: number): string {
    if (this._unitUnverified()) return formatUnitUnverified(renderUnitsSq);
    return formatAreaRender(renderUnitsSq, this._unitToMetres, this._units);
  }

  /** The headline value string for a measurement, shown in the panel. */
  /** The figures of `m` withheld on its scan's position step, in its own frame. */ private _unresolved(m: Measurement): string[] { return unresolvedKeysFor(m, this._positionSteps?.(m) ?? null, this.upFor(m), this._ownUnitFrame(m) ?? this._activeUnitFrame()); }
  private _headlineText(m: Measurement): string {
    const p = m.points;
    // Every figure that combines the horizontal and vertical axes is computed
    // on the isotropic points, so a compound CRS reads what the export writes.
    const q = this._iso(p);
    if (this._upRefusalText !== null && upAxisRefusesKind(m.kind)) return this._upRefusalText;
    const unresolved = unresolvedHeadlineFor(m, this._positionSteps?.(m) ?? null, this.upFor(m), this._ownUnitFrame(m) ?? this._activeUnitFrame()); if (unresolved !== null) return unresolved;
    switch (m.kind) {
      case 'distance': {
        if (p.length < 2) return '—';
        const len = this._fmtLen(distance(q[0], q[1]));
        // A bearing is taken in the plane normal to up; mixed ups have none.
        if (this._upRefusalText !== null) return len;
        const az = bearingDegrees(p[0], p[1], this._worldUp);
        // Append the bearing when the segment has a horizontal run, labelled
        // with what it is measured from. It is taken against +Y, which is grid
        // north only for a projected CRS in a Z-up frame; any other frame
        // gets "(local axes)", and a geographic CRS none (see BearingFrame).
        // Purely vertical pairs have no bearing, so just the length shows.
        const u = this._worldUp;
        const zUp = Math.abs(u[2]) / (Math.hypot(u[0], u[1], u[2]) || 1) > 0.99;
        const frame: BearingFrame = this._geographicCrs
          ? 'none'
          : this._projectedCrs && zUp ? 'grid' : 'local';
        const bearing = formatFramedBearing(az, frame);
        return bearing ? `${len} · ${bearing}` : len;
      }
      case 'polyline':
        return this._fmtLen(polylineLength(q).total);
      case 'area':
        return p.length >= 3 ? this._areaFmt(p, () => polygonAreaPlanar(q)) : '—';
      case 'height':
        return p.length >= 2
          ? this._fmtVertical(Math.abs(verticalDelta(p[0], p[1], this._worldUp).vertical))
          : '—';
      case 'angle':
        return p.length >= 3 ? formatArmAngle(angleAtVertex(q[0], q[1], q[2])) : '—';
      case 'slope': {
        if (p.length < 2) return '—';
        const s = slopeBetween(q[0], q[1], this._worldUp);
        return `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`;
      }
      case 'profile': {
        if (p.length < 2) return '—';
        const pm = profileMetrics(q[0], q[1], this._worldUp);
        return formatProfileHeadline(
          // Isotropic points: both the length and the drop are in the
          // horizontal render unit. Grade is dimensionless.
          pm.length3d * this._unitToMetres,
          pm.verticalDrop * this._unitToMetres,
          pm.gradePercent,
          this._units,
          ...(this._unitUnverified() ? [formatUnitUnverified] as const : []),
        );
      }
      case 'box': {
        if (p.length < 2) return '—';
        const clip = m.clipRegion === true || (this.boxFootprint && !this._measurements.includes(m));
        const mb = boxMetrics(boxFromCorners(p[0], p[1]), this._worldUp);
        return formatBoxHeadline(
          // Horizontal axes ×f, the up axis (height) ×vertical factor, volume
          // f²·vertical — each a pure monomial, so a compound CRS reads honest.
          mb.width * this._unitToMetres,
          mb.depth * this._unitToMetres,
          clip ? Number.NaN : mb.height * this._effVertical(),
          clip || flatBox(p[0], p[1], this._worldUp) ? Number.NaN : mb.volume * this._unitToMetres * this._unitToMetres * this._effVertical(),
          this._units,
          ...(this._unitUnverified() ? [formatUnitUnverified, formatUnitUnverified] as const : []),
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
        // A withheld grid figure carries no fill/cut/net at all — never a
        // borrowed cut-and-fill number under the grid's name. The point-sample
        // cross-check is not shown either: the grid refused that footprint.
        // The clauses come from the builders the PDF report row uses.
        const { fill: vf, cut: vc, net: vn } = v;
        if (volumeFiguresWithheld(v) || vf === undefined || vc === undefined || vn === undefined) {
          return `${area} · ${volumeWithheldClause(v)}`;
        }
        const fill = this._fmtCutFill(Math.max(0, vf));
        const cut = this._fmtCutFill(Math.max(0, vc));
        const net = this._fmtCutFill(Math.abs(vn));
        const netSign = vn < 0 ? 'cut' : 'fill';
        const caveats = volumeCaveatClauses(v).map((c) => ` · ${c}`).join('');
        return `${area} · +${fill} fill · −${cut} cut · net ${net} ${netSign}${caveats}`;
      }
    }
  }

  private _updateHint(): void {
    if (this._active) {
      // Honest units: a geographic scan measures degrees, not metres — every
      // hint carries the caveat so a raw number is never read as a distance.
      // The draft's running figures in the frame of the layer it is picked on.
      const d = this._draft;
      let hint = this._snapHintPrefix() + (d ? this._inFrameOf(d, () => this._composeHint()) : this._composeHint());
      // Honest units: geographic degrees are the stronger caveat; a compound
      // CRS's vertical/horizontal unit clash is the next — a raw number never
      // reads as a trustworthy distance without its caveat.
      if (this._geographicCrs) {
        hint = `${hint} — ${GEOGRAPHIC_CRS_MEASURE_NOTICE}`;
      } else if (this._unitUnverified()) {
        hint = `${hint} · ${UNIT_UNVERIFIED_MEASURE_NOTICE}`;
      }
      // No local vertical (geocentric, depth-down): heights are refused too.
      if (this._verticalRefused) hint = `${hint} — Heights ${VERTICAL_NOT_AVAILABLE}.`;
      else if (this._verticalUnitInvalid) hint = `${hint} — Figures ${VERTICAL_SCALE_NOT_AVAILABLE}.`;
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
    // Undo has a point to remove only while a draft holds one.
    const canUndo = !!d && d.points.length > 0;
    this._undoBtn.disabled = !canUndo;
    setStrippableTitle(this._undoBtn, canUndo ? UNDO_TITLE : UNDO_DISABLED_TITLE);
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
        const total = this._fmtLen(polylineLength(this._iso(d.points)).total);
        return `${total} · ${VERB} more, click the first vertex or press Enter to finish`;
      }
      case 'area': {
        if (!d || d.points.length < 3) return `${VERB} polygon vertices — three or more`;
        const area = this._areaFmt(d.points, () => polygonAreaPlanar(this._iso(d.points)));
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
      case 'box': {
        if (n === 1) return `${VERB} the opposite corner. ${this.boxFootprint ? "The clip keeps this footprint at the scan's full height" : 'The box spans the height between the two corners'}`;
        const last = this._measurements[this._measurements.length - 1];
        if (!this.boxFootprint && last?.kind === 'box' && last.points.length >= 2 && flatBox(last.points[0], last.points[1], this._worldUp)) {
          return `That box is flat: both corners are at one height, so it has no volume. ${VERB} the second corner on a higher surface`;
        }
        return `${VERB} one corner of the box`;
      }
      case 'angle':
        if (n === 1) return `${VERB} the angle vertex`;
        if (n === 2) return `${VERB} the third point`;
        return `${VERB} the first point`;
    }
  }

  /**
   * The intermediate station dots of a profile measurement, in dot order —
   * the single source both the scene dots (`_appendMeasurement`) and the
   * panel-coupling chainages (`getSummaries`) read, so the two can never
   * disagree on how many stations exist or where they sit. The endpoints carry
   * their own vertices, so they are dropped (`slice(1, -1)`). Empty for a
   * non-profile or horizontally-degenerate measurement.
   *
   * The horizontal span comes from the shared section frame under the scene's
   * real up axis, so the dot chainages index the same x-axis `sampleProfile`
   * emits and the same horizontal length `measurementMetrics` reports.
   */
  private _profileStations(m: Measurement): ProfileStation[] {
    if (m.kind !== 'profile' || m.points.length < 2) return [];
    const [a, b] = m.points;
    const up = this._worldUp;
    const horizontal = buildProfileFrame(a, b, up).horizontalLength;
    if (!(horizontal > 0)) return [];
    return stationsAlongLine({ a, b, up, intervalM: horizontal / 7 }).slice(1, -1);
  }

  private _buildModel(): OverlayModel {
    const vertices: OverlayVertex[] = [];
    const edges: OverlayEdge[] = [];
    const polygons: OverlayPolygon[] = [];
    const labels: OverlayLabel[] = [];
    // Each measurement's labels in the frame of the layer it was taken on.
    for (const m of this._measurements) {
      const from = labels.length;
      this._inFrameOf(m, () => {
        this._appendMeasurement(m, vertices, edges, polygons, labels);
        this._refuseGeographicLabels(m, labels, from); if (this._unresolved(m).length > 0) labels.splice(from, labels.length - from, ...labels.slice(from).filter((l) => l.primary));
      });
      if (this._drag?.id === m.id) for (let i = from; i < labels.length; i++) labels[i] = { ...labels[i]!, priority: true };
    }
    const d = this._draft;
    if (d) {
      const from = labels.length;
      this._inFrameOf(d, () => {
        this._appendDraft(d, vertices, edges, polygons, labels);
        this._refuseGeographicLabels(d, labels, from);
      });
      for (let i = from; i < labels.length; i++) labels[i] = { ...labels[i]!, priority: true };
    }
    return { polygons, edges, vertices, labels };
  }

  /**
   * On a geographic (degree) frame, replace the labels a refused measurement
   * just added. The overlay feeds snapshot PNGs and Studio images, so a grade,
   * angle, length or area the grade refuses must not be drawn as a number:
   * the headline reads the refusal and the secondary labels are dropped.
   */
  private _refuseGeographicLabels(m: Measurement, labels: OverlayLabel[], from: number): void {
    const refusal = this._upRefusalText !== null && upAxisRefusesKind(m.kind) ? this._upRefusalText : this._frameRefusal(m.kind);
    if (labels.length <= from) return;
    if (refusal === null) {
      if (!this._geographicCrs) return;
      // A height keeps its vertical figure; its horizontal leg is degrees,
      // which the panel never shows, so the scene drops it too.
      const kept = labels.splice(from).filter((l) => l.primary);
      labels.push(...kept);
      return;
    }
    const added = labels.splice(from);
    const head = added.find((l) => l.primary) ?? added[0];
    labels.push({ ...head, text: refusal, primary: true });
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
    // A box draws its handles on all 8 wireframe corners below, not on the two
    // stored pick points: only two of a box's corners are stored, and offering
    // a handle on just those two would leave six corners that look identical
    // and behave differently.
    if (m.kind !== 'box') {
      pts.forEach((p, i) => {
        V.push({
          p,
          role: 'normal',
          handle: this._active ? { mid: m.id, vi: i } : undefined,
        });
      });
    }

    if (m.kind === 'distance' && pts.length >= 2) {
      E.push({ a: pts[0], b: pts[1], style: 'solid' });
      L.push({
        anchor: midpoint(pts[0], pts[1]),
        text: this._fmtLen(distance(...this._iso(pts.slice(0, 2)) as [Vec3, Vec3])),
        primary: true,
      });
      return;
    }
    if (m.kind === 'polyline' && pts.length >= 2) {
      const r = polylineLength(this._iso(pts));
      for (let i = 1; i < pts.length; i++) {
        E.push({ a: pts[i - 1], b: pts[i], style: 'solid' });
        L.push({
          anchor: midpoint(pts[i - 1], pts[i]),
          text: this._fmtLen(r.segments[i - 1]),
          primary: false,
        });
      }
      L.push({
        anchor: pts.at(-1)!,
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
      const ok = areaRingVerdictCached(pts).ok;
      const text = ok
        ? `${this._fmtArea(polygonAreaPlanar(this._iso(pts)))} · map ${this._fmtArea(polygonAreaHorizontal(pts, this._worldUp))}`
        : 'no area';
      L.push({ anchor: centroid(pts), text, primary: true });
      return;
    }
    if (m.kind === 'height' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const d = verticalDelta(a, b, this._worldUp);
      E.push(
        { a, b: elbow, style: 'solid' },
        { a: elbow, b, style: 'solid' },
      );
      L.push(
        {
          anchor: midpoint(elbow, b),
          text: this._fmtVertical(Math.abs(d.vertical)),
          primary: true,
        },
        {
          anchor: midpoint(a, elbow),
          text: this._fmtLen(d.horizontal),
          primary: false,
        },
      );
      return;
    }
    if (m.kind === 'slope' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const [ia, ib] = this._iso([a, b]);
      const s = slopeBetween(ia, ib, this._worldUp);
      E.push(
        { a, b, style: 'solid' },
        { a, b: elbow, style: 'preview' },
        { a: elbow, b, style: 'preview' },
      );
      L.push(
        {
          anchor: midpoint(a, b),
          text: `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`,
          primary: true,
        },
        {
          anchor: midpoint(elbow, b),
          text: this._fmtLen(Math.abs(s.rise)),
          primary: false,
        },
        {
          anchor: midpoint(a, elbow),
          text: this._fmtLen(s.run),
          primary: false,
        },
      );
      return;
    }
    if (m.kind === 'angle' && pts.length >= 3) {
      const [a, vertex, c] = pts;
      E.push(
        { a, b: vertex, style: 'solid' },
        { a: vertex, b: c, style: 'solid' },
      );
      L.push({
        anchor: vertex,
        text: formatArmAngle(angleAtVertex(...this._iso([a, vertex, c]) as [Vec3, Vec3, Vec3])),
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
      const [ia, ib] = this._iso([a, b]);
      const pm = profileMetrics(ia, ib, this._worldUp);
      E.push(
        { a, b, style: 'solid' },
        { a, b: elbow, style: 'preview' },
        { a: elbow, b, style: 'preview' },
      );
      // The drop and run share the headline's unit (the 3D length bounds both).
      const f = this._unitToMetres;
      const [dropText, runText] = this._unitUnverified()
        ? [Math.abs(pm.verticalDrop), pm.lengthHorizontal].map(formatUnitUnverified)
        : formatLengthsInSharedUnit(
            [pm.length3d * f, Math.abs(pm.verticalDrop) * f, pm.lengthHorizontal * f],
            this._units,
          ).slice(1);
      L.push(
        // The panel's own headline, so the scene shows the same units.
        { anchor: midpoint(a, b), text: this._headlineText(m), primary: true },
        { anchor: midpoint(elbow, b), text: dropText, primary: false },
        { anchor: midpoint(a, elbow), text: runText, primary: false },
      );
      // Station markers on the cloud — small dim dots at evenly-spaced
      // chainages along the section line, so the profile's stations are visible
      // in 3D, not just on the chart. The endpoints already carry their own
      // vertices, so only the intermediate stations are drawn. The one dot whose
      // (measurement, index) matches `_activeStation` brightens (`is-active`) —
      // the scene half of the chart/table hover coupling.
      this._profileStations(m).forEach((s, idx) => {
        V.push({
          p: s.position,
          role: 'station',
          active: this._activeStation?.id === m.id && this._activeStation.index === idx,
        });
      });
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
      // The handle index IS the corner index in `boxCorners` order, so the
      // drag resolves the anchor from the same table the wireframe drew.
      for (const ci of BOX_CORNER_INDICES) {
        V.push({
          p: corners[ci],
          role: 'normal',
          handle: this._active ? { mid: m.id, vi: ci } : undefined,
        });
      }
      for (const [aI, bI] of BOX_EDGES) {
        E.push({ a: corners[aI], b: corners[bI], style: 'solid' });
      }
      // The panel's own headline, so the scene shows the same units.
      L.push({ anchor: boxCentre(box), text: this._headlineText(m), primary: true });
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
    const last = pts.at(-1)!;

    if (d.kind === 'distance') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(last, cur),
        text: this._fmtLen(distance(...this._iso([last, cur]) as [Vec3, Vec3])),
        primary: true,
      });
      return;
    }
    if (d.kind === 'polyline') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: cur,
        text: this._fmtLen(polylineLength(this._iso([...pts, cur])).total),
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
          text: this._areaFmt(ring, () => polygonAreaPlanar(this._iso(ring))),
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
      E.push(
        { a: pts[0], b: elbow, style: 'preview' },
        { a: elbow, b: cur, style: 'preview' },
      );
      L.push({
        anchor: midpoint(elbow, cur),
        text: this._fmtVertical(Math.abs(verticalDelta(pts[0], cur, this._worldUp).vertical)),
        primary: true,
      });
      return;
    }
    if (d.kind === 'slope') {
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      const s = slopeBetween(...this._iso([pts[0], cur]) as [Vec3, Vec3], this._worldUp);
      E.push(
        { a: pts[0], b: cur, style: 'preview' },
        { a: pts[0], b: elbow, style: 'preview' },
        { a: elbow, b: cur, style: 'preview' },
      );
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
          text: formatArmAngle(angleAtVertex(...this._iso([pts[0], pts[1], cur]) as [Vec3, Vec3, Vec3])),
          primary: true,
        });
      }
    }
    if (d.kind === 'profile') {
      // Same preview idiom as `slope` — solid 3D segment with the L-bent
      // run/drop ghost — but the live label carries the combined profile
      // readout (length · Δh · grade).
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      E.push(
        { a: pts[0], b: cur, style: 'preview' },
        { a: pts[0], b: elbow, style: 'preview' },
        { a: elbow, b: cur, style: 'preview' },
      );
      L.push({
        anchor: midpoint(pts[0], cur),
        text: this._headlineText({ ...d, points: [pts[0], cur] }),
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
      L.push({
        anchor: boxCentre(box),
        text: this._headlineText({ ...d, points: [pts[0], cur] }),
        primary: true,
      });
    }
  }
}

/** Centre of an axis-aligned box. */
function boxCentre(box: { min: Vec3; max: Vec3 }): Vec3 {
  return [
    (box.min[0] + box.max[0]) * 0.5,
    (box.min[1] + box.max[1]) * 0.5,
    (box.min[2] + box.max[2]) * 0.5,
  ];
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

/**
 * A unique id — `crypto.randomUUID` when available, else random bytes.
 *
 * `randomUUID` needs a secure context, which a viewer served over plain http on
 * a field laptop does not have. `getRandomValues` works there, so the fallback
 * keeps full entropy instead of leaving two tabs able to mint the same id.
 */
function freshId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint32Array(2);
  c.getRandomValues(bytes);
  return `m_${bytes[0].toString(36).padStart(7, '0')}${bytes[1].toString(36).padStart(7, '0')}`;
}

/** 'z' or 'y' for an axis-aligned up vector; null for any other (a rotating frame's tangent up). */
function axisOfUp(u: Vec3): 'y' | 'z' | null {
  if (u[0] === 0 && u[1] === 0 && u[2] === 1) return 'z';
  if (u[0] === 0 && u[1] === 1 && u[2] === 0) return 'y';
  return null;
}
