/**
 * scanRouteCoordinator.ts
 *
 * The scan-type route: what a freshly opened or still-streaming scan is read
 * as (terrain, an interior, a compact object), which panels that shows, and
 * the bookkeeping that keeps a streaming re-evaluation from thrashing or from
 * overturning a deliberate user choice. The decision mathematics stay in the
 * science modules (`classifyScanShape`, `planScanRoute`, `settleOneShotSpent`,
 * `spaceMetrics`, `objectMetrics`); this module orchestrates them over narrow
 * ports and owns the state the orchestration needs: the growth gate for
 * streaming re-routes, the settled one-shot and its retry counters, the
 * soft-commit flag of the "Treat as" control, and the export context behind
 * the on-screen space or object report.
 *
 * Ports describe capabilities. Geometry answers what is resident; the frame
 * answers units and identity; the verdict store keeps the composed capture
 * verdict; the view projects the route into panels it may or may not have
 * mounted yet; the analysis port starts a terrain run. None of them exposes a
 * Viewer, a panel or a service wholesale, so the whole route runs in Node
 * against fakes.
 */
import { truncationOf, truncationText, type Truncation } from '../io/truncation';
import { verticalMetresPerUnit, type SpatialContext } from '../geo/SpatialContext';
import { classifyScanShape, type ScanShape, type SpaceKind } from '../terrain/scanShape';
import {
  planScanRoute,
  settleOneShotSpent,
  settleTargetDepth,
  type ScanTypeOverride,
} from '../terrain/scanRoute';
import { objectMetrics, type ObjectMetrics } from '../terrain/objectMetrics';
import {
  spaceMetrics,
  resolveLinearUnitScale,
  positionsInMetres,
  type SpaceMetrics,
} from '../terrain/spaceMetrics';
import type { ScanRouteService } from './ScanRouteService';
import { hasHorizontalCrs, type LayerCrs } from '../geo/frame/layerUpFrame';
import { gatherDeclineCause } from '../terrain/gatherUpAxis';
import type { ScanTypeDisabledReasons } from '../ui/scanTypeControl';

/** Re-route only after the resident cloud grows by this factor (cheap gate). */
export const SCAN_REROUTE_GROWTH = 1.4;
/** Points the routing gather is capped at: enough to classify and measure. */
export const ROUTE_GATHER_POINTS = 60_000;
/** Debounce for a burst of node-ready events before a streaming re-route. */
export const REROUTE_DEBOUNCE_MS = 500;

/** The resident geometry a route reads. */
export interface RouteGeometry {
  readonly positions: Float32Array;
  readonly classification?: Uint8Array;
  readonly verticalAxisHint?: 'z';
  readonly residentOnly: boolean;
  readonly totalPoints: number;
}

export interface ScanRouteGeometryPort {
  /** Up to `maxPoints` resident points, or null when nothing can be gathered. */
  gatherForRouting(maxPoints: number): RouteGeometry | null;
  residentPointTotal(): number;
  /** Whether the scan carries RGB, asked of the streaming cloud first. */
  hasRgb(): boolean;
  /**
   * Why the last gather declined the scan's frame (the Viewer's
   * `terrainGatherDecline`), or null. Absent reads as no reason.
   */
  declineReason?(): string | null;
}

/**
 * The unit facts routing reads from the resolved frame.
 *
 * Space and object metrics scale the vertical axis by the vertical unit, which a
 * compound CRS states separately, and fall back to the horizontal factor when
 * none is declared. A vertical unit that IS declared but cannot be read is a
 * different case: the horizontal factor is not evidence about Z. The metrics
 * then run as for an unconfirmed unit, in source units and labelled so, rather
 * than printing metres that nothing established.
 */
export function routeUnitFrame(
  context: () => SpatialContext,
  /**
   * The active scan's resolved CRS, the record the routing gather settles its
   * up axis from. Read whole: the spatial context does not carry the WKT, and a
   * CRS whose horizontal part did not resolve still counts as a horizontal
   * reference there by its WKT. Omitted, no `horizontalCrs` is offered.
   */
  resolved?: () => LayerCrs | null | undefined,
): Pick<ScanRouteFramePort, 'linearUnitToMetres' | 'verticalUnitToMetres' | 'linearUnitKnown' | 'horizontalCrs'> {
  return {
    linearUnitToMetres: () => context().linearUnitToMetres,
    verticalUnitToMetres: () => {
      const c = context();
      return verticalMetresPerUnit(c, 'horizontal') ?? c.linearUnitToMetres;
    },
    linearUnitKnown: () => {
      const c = context();
      return c.linearUnitKnown && c.verticalScaleState !== 'invalid';
    },
    ...(resolved ? { horizontalCrs: () => hasHorizontalCrs(resolved()) } : {}),
  };
}

export interface ScanRouteFramePort {
  linearUnitToMetres(): number;
  /**
   * Metres per source unit on the VERTICAL axis, which a compound CRS states
   * separately (a metre grid over US-survey-foot heights). Space and object
   * metrics scaled every axis by the horizontal factor, so a 3.00 m ceiling
   * stored as 9.843 ft was reported as 9.84 m and a 50 m² room as 492 m³.
   * Equal to `linearUnitToMetres` on a single-unit CRS, which is every
   * ordinary scan, so those figures are unchanged.
   */
  verticalUnitToMetres(): number;
  linearUnitKnown(): boolean;
  /**
   * Whether the resolved CRS fixes a horizontal reference. The routing gather
   * settles its up axis by the same rule (`gatherUpAxis.ts`): under one, a glTF
   * is declined and a local PLY or OBJ is read as stored instead of rotated, so
   * the routed points can change while the unit factors do not. Absent reads as
   * no horizontal reference.
   */
  horizontalCrs?(): boolean;
  exportTargetId(): string | null;
  crsRevision(): number;
  /** The export basename for the current scan. */
  basename(): string;
  /** The active scan's truncation record, or null for a complete read. */
  truncation?(): Truncation | null | undefined;
}

/** The composed capture verdict the Inspector, report and exports state. */
export interface ScanRouteVerdictPort {
  get(): SpaceKind | null;
  set(verdict: SpaceKind | null): void;
}

export type ScanTypeArgs = readonly [ScanTypeOverride, SpaceKind | null, ScanTypeDisabledReasons | undefined, boolean];

/**
 * Where the route lands. A panel may not be mounted yet; the view records the
 * intent and replays it when the panel arrives, which is its concern, not the
 * route's.
 */
export interface ScanRouteViewPort {
  setObjectScanType(args: ScanTypeArgs): void;
  setAnalyseScanType(args: ScanTypeArgs): void;
  /** `unmeasured` is why an empty report has no figures, when the gather said why. */
  showSpace(space: SpaceMetrics | null, shape: ScanShape | null, unmeasured?: string): void;
  showObject(object: ObjectMetrics | null, space: SpaceMetrics | null, shape: ScanShape | null, unmeasured?: string): void;
  setObjectVisible(visible: boolean): void;
  /** Also drops any pending panel-visibility restore: the route owns panel state. */
  setAnalyseVisible(visible: boolean): void;
  setDockAnalyse(enabled: boolean, active: boolean): void;
  /** The explicit "run terrain anyway" hatch: mount, expand, then run. */
  expandAnalyseAndRunTerrain(): void;
}

/**
 * The exact inputs behind the on-screen space or object report, so the panel's
 * export buttons build from the same positions, metrics and unit factor.
 */
/** The component index each detected up-axis name refers to. */
const UP_AXIS_INDEX: Readonly<Record<'x' | 'y' | 'z', 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };

export interface SpaceExportContext {
  readonly positions: Float32Array;
  readonly space: SpaceMetrics;
  readonly object: ObjectMetrics | null;
  readonly spaceKind: 'interior' | 'object';
  readonly unitToMetres: number;
  /** Metres per source unit on the VERTICAL axis; see {@link ScanRouteFramePort}. */
  readonly verticalUnitToMetres: number;
  readonly unitKnown: boolean;
  readonly targetId: string | null;
  readonly crsRevision: number;
  readonly upAxis: SpaceMetrics['up'];
  readonly basename: string;
  /** Truncation note for the routed scan; absent for a complete read. */
  readonly coverageNote?: string;
}

/** What a settled streaming poll can tell the route about the resident cloud. */
export interface SettledStreamingFacts {
  readonly hierarchyDepth: number;
  readonly residentPointCount: number;
  residentAtDepth(depth: number): boolean;
}

/** What a space or object report is measured from. */
interface ReportInputs {
  /** The coordinator's own copy of the routed points, in the scan's source units. */
  readonly points: Float32Array;
  readonly shape: ScanShape;
  readonly spaceKind: 'interior' | 'object';
  readonly hasRgb: boolean;
  readonly totalPoints: number;
  readonly residentOnly: boolean;
}

/** The frame facts a report's figures depend on. */
interface ReportFrame {
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  readonly unitKnown: boolean;
  readonly horizontal: boolean;
}

/** The report the Object panel shows: its kind, its scan, the CRS revision and frame it was measured under. */
interface ShownReport {
  readonly spaceKind: 'interior' | 'object';
  readonly targetId: string | null;
  readonly crsRevision: number;
  /** Null for the empty state: nothing was measured. */
  readonly measured: ReportFrame | null;
}

/** The routing sample: the gather, its points and the shape read from them. */
interface RouteSample {
  readonly gathered: RouteGeometry | null;
  readonly points: Float32Array | null;
  readonly shape: ScanShape | null;
}

export interface ScanRouteCoordinatorDeps {
  readonly routing: ScanRouteService;
  readonly geometry: ScanRouteGeometryPort;
  readonly frame: ScanRouteFramePort;
  readonly verdict: ScanRouteVerdictPort;
  readonly view: ScanRouteViewPort;
  /** Diagnostic sink for the `?debug` verdict line; absent means silent. */
  readonly log?: (line: string) => void;
  /** The shape classifier; defaults to the real one, injectable for tests. */
  readonly classify?: typeof classifyScanShape;
}

export interface ScanRouteCoordinator {
  /**
   * Route the current geometry. `initial` bypasses the verdict-change and
   * pinned no-op guards (open, manual override); `settled` marks THE settled
   * verdict of a streaming scan. Returns whether the settled one-shot is spent.
   */
  applyRoute(initial: boolean, settled?: boolean): boolean;
  /** A manual "Treat as" choice: pins the route and re-applies at once. */
  setTypeOverride(override: ScanTypeOverride): void;
  /** A scan opened: clear per-scan state and route its open-time geometry. */
  beginScan(settled: boolean): void;
  /** A streaming node landed: growth-gated, debounced re-route. */
  onStreamingNodeReady(): void;
  /** The streaming scheduler reports a settled view: the one-shot re-evaluation. */
  onStreamingSettled(facts: SettledStreamingFacts): void;
  /** The scan closed: cancel and forget everything per-scan. */
  reset(): void;
  /**
   * The active scan's CRS changed. When the unit factors, the unit-known flag
   * or the horizontal reference moved, gather and measure the on-screen space
   * or object report again as a reopen would, keeping the route's kind; a
   * gather the new frame declines shows the empty report and drops the export
   * context. Otherwise the figures stand and only the export stamp moves. A
   * report for another scan, or one already stamped with this revision, is
   * left alone.
   */
  remeasureForFrame(): void;
  spaceExport(): SpaceExportContext | null;
  /** True once a settled auto-mode verdict soft-committed the control. */
  detectionCommitted(): boolean;
}

/**
 * The "Treat as" segments disabled for a detected verdict, with the reason:
 * running contours on a room or an object is misleading, and the explicit
 * "Run terrain contours anyway" hatch remains the way past it.
 */
export function treatAsDisabledFor(detected: SpaceKind | null): ScanTypeDisabledReasons | undefined {
  return detected === 'interior' || detected === 'object'
    ? {
        terrain:
          (detected === 'interior'
            ? 'This scan reads as an interior'
            : 'This scan reads as a compact object') +
          ' — terrain analysis would be misleading. ' +
          "Use 'Run terrain contours anyway' to override.",
      }
    : undefined;
}

export function createScanRouteCoordinator(deps: ScanRouteCoordinatorDeps): ScanRouteCoordinator {
  const { routing, geometry, frame, verdict, view } = deps;
  const classify = deps.classify ?? classifyScanShape;
  let lastRouteResident = 0;
  let streamingSettledRouted = false;
  let settleAttempts = 0;
  let lastSettleResident = -1;
  let lastSettleUndecided = false;
  let scanDetectionCommitted = false;
  let lastSpaceExport: SpaceExportContext | null = null;
  // The report on screen, so a CRS change can tell whether it must be gathered
  // and measured again (see `remeasureForFrame`).
  let shownReport: ShownReport | null = null;

  const currentFrame = (): ReportFrame => ({
    unitToMetres: frame.linearUnitToMetres(),
    verticalUnitToMetres: frame.verticalUnitToMetres(),
    unitKnown: frame.linearUnitKnown(),
    horizontal: frame.horizontalCrs?.() ?? false,
  });
  const sameFrame = (a: ReportFrame, b: ReportFrame): boolean =>
    a.unitToMetres === b.unitToMetres && a.verticalUnitToMetres === b.verticalUnitToMetres
    && a.unitKnown === b.unitKnown && a.horizontal === b.horizontal;

  const clearPerScan = (): void => {
    streamingSettledRouted = false;
    settleAttempts = 0;
    lastSettleResident = -1;
    lastSettleUndecided = false;
    scanDetectionCommitted = false;
  };

  /**
   * Measure the routed points under the CURRENT unit frame, show the space or
   * object report and record its export context. A route and a CRS change on
   * the routed scan both come through here, so they cannot measure differently.
   */
  function measureReport(inputs: ReportInputs): void {
    const { points, shape, spaceKind } = inputs;
    const unitToMetres = frame.linearUnitToMetres();
    const verticalUnitToMetres = frame.verticalUnitToMetres();
    const unitKnown = frame.linearUnitKnown();
    const measured: ReportFrame = { unitToMetres, verticalUnitToMetres, unitKnown, horizontal: frame.horizontalCrs?.() ?? false };
    const space = spaceMetrics(points, {
      upAxis: shape.up,
      spaceKind,
      unitToMetres,
      verticalUnitToMetres,
      unitKnown,
      hasRgb: inputs.hasRgb,
      sourcePointCount: inputs.totalPoints,
      residentOnly: inputs.residentOnly,
    });
    const object =
      spaceKind === 'object'
        ? objectMetrics(
            positionsInMetres(points, resolveLinearUnitScale(unitToMetres, unitKnown), {
              metresPerUnit: verticalUnitToMetres,
              axis: UP_AXIS_INDEX[shape.up],
            }),
            { sourcePointCount: inputs.totalPoints },
          )
        : null;
    if (spaceKind === 'interior') view.showSpace(space, shape);
    else view.showObject(object, space, shape);
    shownReport = { spaceKind, targetId: frame.exportTargetId(), crsRevision: frame.crsRevision(), measured };
    lastSpaceExport = {
      positions: points,
      space,
      object,
      spaceKind,
      targetId: frame.exportTargetId(),
      crsRevision: frame.crsRevision(),
      unitToMetres,
      verticalUnitToMetres,
      unitKnown,
      upAxis: shape.up,
      basename: frame.basename() || 'scan',
      ...((t) => (t ? { coverageNote: truncationText(t) } : {}))(truncationOf({ metadata: { truncation: frame.truncation?.() ?? undefined } })),
    };
  }

  /** Gather the routing sample and read its shape. Both are best effort. */
  function routeSample(): RouteSample {
    let shape: ScanShape | null = null;
    let gathered: RouteGeometry | null = null;
    // One transport read of the gathered array serves the whole route.
    let points: Float32Array | null = null;
    try {
      gathered = geometry.gatherForRouting(ROUTE_GATHER_POINTS);
      if (gathered) {
        const { positions } = gathered;
        points = positions;
        shape = classify(positions, {
          classification: gathered.classification,
          verticalAxis: gathered.verticalAxisHint,
        });
      }
    } catch {
      shape = null; // classification is best effort; terrain analysis is the fallback
    }
    return { gathered, points, shape };
  }

  /**
   * Show the `spaceKind` report from a routing sample: measured when the sample
   * has points and a shape, else the empty state, which still carries the
   * "Treat as" control and the run-anyway hatch, with no export context.
   */
  function showReport(spaceKind: 'interior' | 'object', sample: RouteSample): void {
    const { gathered, points, shape } = sample;
    if (gathered && points && shape) {
      measureReport({
        // Copied, so a later streaming buffer reuse cannot corrupt the report's inputs.
        points: Float32Array.from(points),
        shape,
        spaceKind,
        hasRgb: geometry.hasRgb(),
        totalPoints: gathered.totalPoints,
        residentOnly: gathered.residentOnly,
      });
      return;
    }
    showEmpty(spaceKind, gathered);
  }

  /** The empty `spaceKind` report, with the gather's reason when it declined. */
  function showEmpty(spaceKind: 'interior' | 'object', gathered: RouteGeometry | null): void {
    lastSpaceExport = null;
    shownReport = { spaceKind, targetId: frame.exportTargetId(), crsRevision: frame.crsRevision(), measured: null };
    // A gather that declined the frame says why. The reason is worded for
    // terrain analysis, so the report states only its cause.
    const declined = gathered ? null : geometry.declineReason?.();
    const why: [] | [string] = declined ? [gatherDeclineCause(declined)] : [];
    if (spaceKind === 'interior') view.showSpace(null, null, ...why);
    else view.showObject(null, null, null, ...why);
  }

  function applyRoute(initial: boolean, settled = false): boolean {
    // A pinned route (manual override or "run anyway") never moves for a
    // streaming re-evaluation; the one-shot is spent.
    if (!initial && routing.pinned) return true;
    const sample = routeSample();
    const { shape } = sample;
    const routePositions = sample.points;
    if (deps.log && shape) {
      deps.log(
        `[scan-type] ${initial ? 'open' : 're-route'} verdict=${shape.nonTerrain ? shape.spaceKind : 'terrain'} ` +
          `up=${shape.up} aspect=${shape.aspect.toFixed(2)} overhang=${Math.round(shape.overhangFraction * 100)}% ` +
          `wall=${Math.round(shape.wallCoverage * 100)}% floor=${Math.round(shape.floorCoverage * 100)}% ` +
          `ceil=${Math.round(shape.ceilingCoverage * 100)}% topVeg=${Math.round(shape.topVegFraction * 100)}% ` +
          `sampled=${routePositions ? routePositions.length / 3 : 0} resident=${geometry.residentPointTotal()}`,
      );
    }
    const detected: SpaceKind | null = shape ? (shape.nonTerrain ? shape.spaceKind : 'terrain') : null;
    const plan = planScanRoute({
      detected,
      override: routing.typeOverride,
      initial,
      lastVerdict: verdict.get(),
      pinned: routing.overridden,
      settled,
    });
    if (plan.commitDetected !== null) scanDetectionCommitted = true;
    if (settled) lastSettleUndecided = detected === null;
    const oneShotSpent = settleOneShotSpent({
      detected,
      override: routing.typeOverride,
      pinned: routing.overridden,
      applied: plan.apply,
      committed: plan.commitDetected !== null,
      attempts: settleAttempts,
    });
    if (!plan.apply) {
      if (plan.commitDetected !== null) {
        const args: ScanTypeArgs = [routing.typeOverride, plan.commitDetected, treatAsDisabledFor(detected), true];
        view.setObjectScanType(args);
        view.setAnalyseScanType(args);
      }
      return oneShotSpent;
    }
    const effective = plan.effective;
    verdict.set(effective);

    if (plan.showObjectPanel) {
      // A forced non-terrain route with no usable geometry right now shows the
      // empty state (see `showReport`).
      showReport(effective === 'interior' ? 'interior' : 'object', sample);
    } else {
      // A report from an earlier route must not stay behind in the hidden
      // panel, where reopening it would show figures for another scan.
      if (shownReport) showEmpty(shownReport.spaceKind, sample.gathered);
      lastSpaceExport = null;
      shownReport = null;
    }
    view.setObjectVisible(plan.showObjectPanel);
    view.setAnalyseVisible(plan.showAnalysePanel);
    view.setDockAnalyse(true, plan.showAnalysePanel);
    const committed = routing.typeOverride === 'auto' && scanDetectionCommitted;
    const args: ScanTypeArgs = [routing.typeOverride, effective, treatAsDisabledFor(detected), committed];
    view.setObjectScanType(args);
    view.setAnalyseScanType(args);
    if (plan.runTerrain) view.expandAnalyseAndRunTerrain();
    return oneShotSpent;
  }

  return {
    applyRoute,
    setTypeOverride(override) {
      routing.setTypeOverride(override);
      // Any click clears the soft-commit: a pick shows that pick, Auto re-detects.
      scanDetectionCommitted = false;
      applyRoute(true);
    },
    beginScan(settled) {
      routing.reset();
      clearPerScan();
      verdict.set(null);
      lastRouteResident = geometry.residentPointTotal();
      applyRoute(true, settled);
    },
    onStreamingNodeReady() {
      if (routing.pinned) return;
      const resident = geometry.residentPointTotal();
      if (resident < lastRouteResident * SCAN_REROUTE_GROWTH) return;
      lastRouteResident = resident;
      routing.schedule(() => applyRoute(false), REROUTE_DEBOUNCE_MS);
    },
    onStreamingSettled(facts) {
      // Depth gate: the scheduler reads settled at the root long before the
      // cloud fills in, so the evaluation waits for the hierarchy's own depth.
      // Spend on a landed verdict only: a refused or undecidable frame keeps
      // the one-shot armed for a later poll, gated on the resident set
      // changing and bounded by the retry cap inside the spend rule.
      if (streamingSettledRouted) return;
      if (!facts.residentAtDepth(settleTargetDepth(facts.hierarchyDepth))) return;
      const resident = facts.residentPointCount;
      if (settleAttempts === 0 || resident !== lastSettleResident || lastSettleUndecided) {
        settleAttempts++;
        lastSettleResident = resident;
        streamingSettledRouted = applyRoute(false, true);
      }
    },
    reset() {
      routing.cancelScheduled();
      routing.reset();
      clearPerScan();
      lastRouteResident = 0;
      lastSpaceExport = null;
      shownReport = null;
      verdict.set(null);
    },
    remeasureForFrame() {
      const shown = shownReport;
      // A report for another scan, or one already stamped with this revision.
      if (!shown || shown.targetId !== frame.exportTargetId()) return;
      const revision = frame.crsRevision();
      if (shown.crsRevision === revision) return;
      const last = lastSpaceExport;
      if (last && shown.measured && sameFrame(shown.measured, currentFrame())) {
        // The same units and horizontal reference (a layer round trip, or a
        // pick with the same factors): the figures stand, so the panel is not
        // rebuilt and only the stamp moves.
        shownReport = { ...shown, crsRevision: revision };
        lastSpaceExport = { ...last, crsRevision: revision };
        return;
      }
      // The frame decides the gather as well as the units, so gather again as
      // a reopen would. The route itself does not move.
      showReport(shown.spaceKind, routeSample());
    },
    spaceExport: () => lastSpaceExport,
    detectionCommitted: () => scanDetectionCommitted,
  };
}
