/**
 * contourStudioLaunchStateFromResult.ts
 *
 * Adapter: derive the Contour Studio launcher state from a real
 * `AnalyseContoursResult` plus the two reference-frame facts that live in the
 * CRS service rather than the analysis result (whether the CRS is projected and
 * whether the vertical unit is known) and the runtime streaming flag.
 *
 * Everything else is read straight from the result the pipeline already
 * produced — no new thresholds are invented here. This is what makes the pure
 * `evaluateContourStudioLaunchState` core usable from `main.ts` without the
 * launcher having to understand the result internals.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import {
  evaluateContourStudioLaunchState,
  type ContourStudioLaunchState,
  type ContourStudioPrerequisites,
} from './contourStudioLaunchState';

/**
 * Facts the launcher needs that are NOT in the analysis result: the reference
 * frame (from the CRS service) and the live streaming flag. The caller
 * (main.ts) supplies these from `CrsService.current()` and the load state.
 */
export interface LaunchFrameContext {
  /** The scan is still streaming; analysis is provisional. */
  readonly streaming: boolean;
  /** The active CRS is a projected (linear) frame, not geographic degrees. */
  readonly crsProjected: boolean;
  /** The vertical unit (metre/foot) is known, not unknown/local. */
  readonly verticalUnitsKnown: boolean;
  /**
   * Metres per source vertical unit when the unit is known (≈0.3048 for feet,
   * 1 for metres), else null. This is the REAL scale from the CRS — Contour
   * Studio must use it so a foot interval is never presented as metres. Null
   * (or omitted) ⇒ unknown unit ⇒ no metric claim.
   */
  readonly verticalUnitToMetres?: number | null;
  /** Display label for the source vertical unit ('m' | 'ft' | 'units'), or null when unknown. */
  readonly verticalUnitLabel?: string | null;
  /**
   * Whether the ground classification was DERIVED by the viewer rather than
   * read from the source file. Omitted counts as derived downstream, so an
   * unwired path understates provenance instead of overstating it.
   */
  readonly groundIsDerived?: boolean;
}

/**
 * Map a completed analysis result + frame context into the prerequisite facts.
 * Pure. `readiness` drives surface availability and support sufficiency:
 * `blocked` → no usable surface, `previewOnly` → surface present but support is
 * only preview-grade (caps to exploratory), `ready` → full support.
 */
export function contourStudioPrerequisitesFromResult(
  result: AnalyseContoursResult,
  ctx: LaunchFrameContext,
): ContourStudioPrerequisites {
  const tally = result.cellStatusTally;
  const total = tally.total > 0 ? tally.total : 0;
  // Unsupported = empty cells over the whole grid. Conservative: unknown total
  // reads as fully unsupported so a degenerate grid can't look deliverable.
  const unsupportedFraction = total > 0 ? tally.empty / total : 1;

  const readiness = result.quality.readiness;

  return {
    scanLoaded: true,
    analysisComplete: true,
    streaming: ctx.streaming,
    // A blocked surface means the quality gate found nothing usable to contour.
    terrainSurfaceAvailable: readiness !== 'blocked',
    // Measured ground cells are the honest signal that a ground source exists.
    groundSourceAvailable: tally.measured > 0,
    intervalRecommended: result.gate.recommendedM != null,
    verticalUnitsKnown: ctx.verticalUnitsKnown,
    crsProjected: ctx.crsProjected,
    unsupportedFraction,
    // Only a fully-ready surface counts as sufficient support; previewOnly caps
    // the deliverable to exploratory rather than blocking it.
    supportSufficient: readiness === 'ready',
  };
}

/** Convenience: result + frame context → launcher state in one call. */
export function contourStudioLaunchStateFromResult(
  result: AnalyseContoursResult,
  ctx: LaunchFrameContext,
): ContourStudioLaunchState {
  return evaluateContourStudioLaunchState(
    contourStudioPrerequisitesFromResult(result, ctx),
  );
}
