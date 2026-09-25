/**
 * contourStudioLaunchState.ts
 *
 * Pure launch-state model for Contour Studio (v0.5.9 spec §4).
 *
 * This module answers ONE question with no side effects: given the facts a
 * scan analysis already produced, should the "Create Contour Deliverable"
 * launcher be hidden, disabled, offered as exploratory, or offered as a full
 * deliverable — and if disabled, why?
 *
 * It is deliberately decoupled from `AnalyseContoursResult` and the UI layer.
 * A caller (PR1's Terrain Products launcher) maps the analysis result into a
 * `ContourStudioPrerequisites` value and renders the returned state. Keeping
 * the evaluation pure makes every visibility/disabled rule unit-testable
 * without a DOM, a worker, or a GPU, and keeps `terrain/` free of UI imports
 * (enforced by lint:layer-boundaries).
 *
 * STATUS: PR1 foundation. This is the pure core; wiring it to the real
 * analysis result and rendering the launcher outside the analysis panel is the
 * remainder of PR1 and is NOT done here. A tested leaf module with no
 * production caller is not a shipped feature — this file is explicitly the
 * former until the launcher lands.
 */

/**
 * The facts the launcher needs, lifted out of the analysis result. Every field
 * is something the v0.5.8 pipeline already knows; nothing here is fabricated.
 */
export interface ContourStudioPrerequisites {
  /** A scan is loaded in the viewer. */
  readonly scanLoaded: boolean;
  /** Scan analysis has completed (terrain core computed, not mid-stream). */
  readonly analysisComplete: boolean;
  /** The scan is still streaming; analysis is provisional. */
  readonly streaming: boolean;

  /** A usable terrain surface (DTM) exists or was computed. */
  readonly terrainSurfaceAvailable: boolean;
  /**
   * The DTM quality gate's own reasons when it blocked a surface that exists
   * (too little measured ground, no reliable interval). Empty or omitted when
   * the gate did not block. Kept apart from `terrainSurfaceAvailable` so a
   * blocked surface is not reported as a missing one.
   */
  readonly surfaceBlockedReasons?: readonly string[];
  /** A ground source exists (classified) or could be derived. */
  readonly groundSourceAvailable: boolean;

  /** A contour interval could be recommended for this surface. */
  readonly intervalRecommended: boolean;

  /** Vertical units are known (metre/foot) vs unknown/local. */
  readonly verticalUnitsKnown: boolean;
  /** The CRS is a projected (linear) frame rather than geographic (degrees). */
  readonly crsProjected: boolean;
  /**
   * Which frame it is, when the caller knows. `crsProjected` alone is false for
   * a geographic frame, a local frame and no CRS at all, and the reason string
   * named only the first of those. Optional: a caller that cannot say leaves it
   * out and gets a reason that names the requirement instead of guessing.
   */
  readonly crsKind?: 'local' | 'projected' | 'geographic' | 'unknown';
  /**
   * How much of the scan the analysis read, as the capability model states it.
   * A sample or a resident streaming set can build a surface for inspection;
   * a whole-dataset deliverable is not claimed until the full cloud is read.
   * Optional so a caller with no coverage fact states nothing; the export
   * permit treats a missing capability verdict as a shortfall regardless.
   */
  readonly coverage?: 'full' | 'sampled' | 'resident-only';
  /**
   * The ground the surface stands on was derived by the filter, not read from
   * a producer class. The capability model rates that product `review`; the
   * launcher must not say "available" over it.
   */
  readonly groundIsDerived?: boolean;

  /**
   * Fraction of the selected surface that is unsupported (no measured or
   * bounded-interpolated support), 0..1. Used to block deliverables built
   * mostly on void.
   */
  readonly unsupportedFraction: number;

  /**
   * Whether terrain support is dense enough for a deliverable at all. This is
   * the pipeline's own readiness verdict (e.g. `contoursRecommended`), not a
   * new threshold invented here.
   */
  readonly supportSufficient: boolean;
}

/**
 * Maximum unsupported fraction tolerated before a deliverable is blocked as
 * built-mostly-on-void. Exploratory output above this must be explicitly
 * requested; a validated deliverable is never offered above it.
 */
export const MAX_UNSUPPORTED_FRACTION_FOR_DELIVERABLE = 0.5;

export type ContourStudioLaunchState =
  | {
      readonly status: 'not-analyzed';
      readonly title: string;
      readonly message: string;
      readonly visible: false;
    }
  | {
      readonly status: 'unavailable';
      readonly title: string;
      readonly message: string;
      readonly reasons: readonly string[];
      readonly visible: true;
      readonly actionEnabled: false;
    }
  | {
      readonly status: 'exploratory';
      readonly title: string;
      readonly message: string;
      readonly reasons: readonly string[];
      readonly visible: true;
      readonly actionEnabled: true;
      readonly actionLabel: string;
    }
  | {
      readonly status: 'available';
      readonly title: string;
      readonly message: string;
      readonly visible: true;
      readonly actionEnabled: true;
      readonly actionLabel: string;
    };

/** Concise disabled/exploratory reasons (spec §4.3), computed from the facts. */
const REASON = {
  noGround: 'No usable ground points.',
  noSurface: 'No terrain surface has been computed.',
  unknownVertical:
    'Vertical units are unknown; metric-supported contour intervals cannot be claimed.',
  geographicCrs:
    'The current CRS is geographic; validated area and scale calculations require a projected frame.',
  localCrs:
    'The current CRS is a local frame; validated area and scale calculations require a projected frame.',
  unprojectedCrs:
    'Validated area and scale calculations require a projected frame, which this scan does not have.',
  sparseSupport: 'Terrain support is too sparse for a contour deliverable.',
  tooMuchUnsupported: 'The selected area has too much unsupported surface.',
  streaming:
    'The scan is still streaming; wait for analysis to complete or export exploratory output.',
  noInterval: 'No contour interval could be recommended for this surface.',
  sampled:
    'Only a sample of the scan was read; a whole-dataset deliverable cannot be claimed until the full cloud is analysed.',
  residentOnly:
    'Only the resident streaming set is loaded; a whole-dataset deliverable cannot be claimed until the full cloud is graded.',
  derivedGround:
    'Ground was derived by the filter, not read from a producer class; the surface carries lower confidence than one built from classified ground.',
} as const;

/**
 * Name the frame the scan has, not the one it most often has.
 *
 * `crsProjected` is a single boolean over four frame kinds, so a local frame
 * and a scan with no CRS were both reported as geographic. An unsupplied kind
 * states the requirement rather than naming a frame nobody established.
 */
function unprojectedReason(kind: ContourStudioPrerequisites['crsKind']): string {
  if (kind === 'geographic') return REASON.geographicCrs;
  if (kind === 'local') return REASON.localCrs;
  return REASON.unprojectedCrs;
}

/**
 * Evaluate the launcher state from prerequisites. Pure and total: every input
 * combination yields exactly one state.
 *
 * Rules (spec §4.1):
 *  - before analysis → hidden (a quiet hint lives in the panel, not here);
 *  - analyzed but no usable terrain → disabled with the blocking reasons;
 *  - terrain present but a scientific prerequisite is incomplete → exploratory;
 *  - terrain + ground + grid + interval + adequate support → available.
 */
export function evaluateContourStudioLaunchState(
  prereqs: ContourStudioPrerequisites,
): ContourStudioLaunchState {
  if (!prereqs.scanLoaded || !prereqs.analysisComplete) {
    return {
      status: 'not-analyzed',
      title: 'Analyze scan first',
      message: 'Run scan analysis to create terrain-derived contours.',
      visible: false,
    };
  }

  // Hard blockers: no surface or no ground means nothing to contour at all.
  const blocking: string[] = [];
  if (!prereqs.terrainSurfaceAvailable) blocking.push(REASON.noSurface);
  else if (prereqs.surfaceBlockedReasons?.length) blocking.push(...prereqs.surfaceBlockedReasons);
  if (!prereqs.groundSourceAvailable) blocking.push(REASON.noGround);
  const unsupported = clamp01(prereqs.unsupportedFraction);
  if (unsupported > MAX_UNSUPPORTED_FRACTION_FOR_DELIVERABLE) {
    blocking.push(REASON.tooMuchUnsupported);
  }

  if (blocking.length > 0) {
    return {
      status: 'unavailable',
      title: 'Contours unavailable',
      message: 'This scan cannot produce a contour deliverable yet.',
      reasons: blocking,
      visible: true,
      actionEnabled: false,
    };
  }

  // Soft prerequisites: terrain exists, but one or more scientific conditions
  // cap the result to exploratory (visual/inspection) rather than validated.
  const exploratoryReasons: string[] = [];
  if (prereqs.streaming) exploratoryReasons.push(REASON.streaming);
  if (prereqs.coverage === 'sampled') exploratoryReasons.push(REASON.sampled);
  if (prereqs.coverage === 'resident-only') exploratoryReasons.push(REASON.residentOnly);
  if (prereqs.groundIsDerived) exploratoryReasons.push(REASON.derivedGround);
  if (!prereqs.verticalUnitsKnown) exploratoryReasons.push(REASON.unknownVertical);
  if (!prereqs.crsProjected) exploratoryReasons.push(unprojectedReason(prereqs.crsKind));
  if (!prereqs.intervalRecommended) exploratoryReasons.push(REASON.noInterval);
  if (!prereqs.supportSufficient) exploratoryReasons.push(REASON.sparseSupport);

  if (exploratoryReasons.length > 0) {
    return {
      status: 'exploratory',
      title: 'Exploratory contours available',
      message:
        'Contours can be created for inspection, but they will be watermarked and ' +
        'exported with exploratory metadata because one or more scientific ' +
        'prerequisites are incomplete.',
      reasons: exploratoryReasons,
      visible: true,
      actionEnabled: true,
      actionLabel: 'Create Exploratory Contours',
    };
  }

  return {
    status: 'available',
    title: 'Contour deliverable available',
    message:
      'The analyzed terrain surface, recommended grid and interval, and validation ' +
      'limits are ready to export as a contour deliverable.',
    visible: true,
    actionEnabled: true,
    actionLabel: 'Create Contour Deliverable',
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1; // treat unknown support as fully unsupported (conservative)
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
