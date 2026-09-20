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
  exportTargetId(): string | null;
  crsRevision(): number;
  /** The export basename for the current scan. */
  basename(): string;
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
  showSpace(space: SpaceMetrics | null, shape: ScanShape | null): void;
  showObject(object: ObjectMetrics | null, space: SpaceMetrics | null, shape: ScanShape | null): void;
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
}

/** What a settled streaming poll can tell the route about the resident cloud. */
export interface SettledStreamingFacts {
  readonly hierarchyDepth: number;
  readonly residentPointCount: number;
  residentAtDepth(depth: number): boolean;
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

  const clearPerScan = (): void => {
    streamingSettledRouted = false;
    settleAttempts = 0;
    lastSettleResident = -1;
    lastSettleUndecided = false;
    scanDetectionCommitted = false;
  };

  function applyRoute(initial: boolean, settled = false): boolean {
    // A pinned route (manual override or "run anyway") never moves for a
    // streaming re-evaluation; the one-shot is spent.
    if (!initial && routing.pinned) return true;
    let shape: ScanShape | null = null;
    let gathered: RouteGeometry | null = null;
    // One transport read of the gathered array serves the whole route.
    let routePositions: Float32Array | null = null;
    try {
      gathered = geometry.gatherForRouting(ROUTE_GATHER_POINTS);
      if (gathered) {
        const { positions } = gathered;
        routePositions = positions;
        shape = classify(positions, {
          classification: gathered.classification,
          verticalAxis: gathered.verticalAxisHint,
        });
      }
    } catch {
      shape = null; // classification is best effort; terrain analysis is the fallback
    }
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

    if (plan.showObjectPanel && shape && gathered && routePositions) {
      const unitToMetres = frame.linearUnitToMetres();
      const verticalUnitToMetres = frame.verticalUnitToMetres();
      const unitKnown = frame.linearUnitKnown();
      const spaceKind: 'interior' | 'object' = effective === 'interior' ? 'interior' : 'object';
      const space = spaceMetrics(routePositions, {
        upAxis: shape.up,
        spaceKind,
        unitToMetres,
        verticalUnitToMetres,
        unitKnown,
        hasRgb: geometry.hasRgb(),
        sourcePointCount: gathered.totalPoints,
        residentOnly: gathered.residentOnly,
      });
      const object =
        spaceKind === 'object'
          ? objectMetrics(
              positionsInMetres(routePositions, resolveLinearUnitScale(unitToMetres, unitKnown), {
                metresPerUnit: verticalUnitToMetres,
                axis: shape.up === 'x' ? 0 : shape.up === 'y' ? 1 : 2,
              }),
              { sourcePointCount: gathered.totalPoints },
            )
          : null;
      if (spaceKind === 'interior') view.showSpace(space, shape);
      else view.showObject(object, space, shape);
      // Copied, so a later streaming buffer reuse cannot corrupt the report's inputs.
      lastSpaceExport = {
        positions: Float32Array.from(routePositions),
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
      };
    } else if (plan.showObjectPanel) {
      // A forced non-terrain route with no usable geometry right now: the
      // panel stays alive with its empty state, which still carries the
      // "Treat as" control and the run-anyway hatch.
      lastSpaceExport = null;
      if (effective === 'interior') view.showSpace(null, null);
      else view.showObject(null, null, null);
    } else {
      lastSpaceExport = null;
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
      verdict.set(null);
    },
    spaceExport: () => lastSpaceExport,
    detectionCommitted: () => scanDetectionCommitted,
  };
}
