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

import type { AnalysedBasis } from '../export/analysedBasis';
import type { ContourExportFrameFacts } from '../../export/contourExportPermit';
import type { AnalyseContoursResult } from '../contour/analyseContours';
import type { PrecisionPermit } from '../../geo/inMemoryPrecision';
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
  /**
   * Which frame the CRS service resolved. Carried so the launcher's reason can
   * name it: `crsProjected` is false for a geographic frame, a local frame and
   * no CRS alike, and the reason used to call all three geographic. Optional so
   * a caller without the kind states the requirement rather than a frame.
   */
  readonly crsKind?: 'local' | 'projected' | 'geographic' | 'unknown';
  /**
   * The scan's coverage as the capability model states it, from `ScanFacts`,
   * not from the grid's extent: a strided static read is `sampled` while its
   * DTM grid reads `full`.
   */
  readonly coverage?: 'full' | 'sampled' | 'resident-only';
  /**
   * The capability verdicts for `contours` and `dtm`, from the same facts the
   * coverage came from. The export permit reads the one its product exports
   * under; a frame without them caps every export to exploratory.
   */
  readonly capabilities?: ContourExportFrameFacts['capabilities'];
  /** Mints the state-bound authorization at click time; see the frame facts. */
  readonly authorizeFor?: ContourExportFrameFacts['authorizeFor'];
  /** Points analysed of points declared, under the facts' coverage; stamped into every export. */
  readonly analysedBasis?: AnalysedBasis;
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
  /**
   * The scan's in-memory Float32 precision permit (`app/scanPrecision.ts`), or
   * `null` when no scan frame was available to measure. Carried through the
   * mount into the export frame facts, where a refused permit blocks every
   * registered deliverable.
   *
   * Required rather than optional: this field travels three modules to reach
   * the gate, and an omitted precision term is indistinguishable from a passing
   * one at every stop along the way. Spelling `null` out is the point.
   */
  readonly precision: PrecisionPermit | null;
}

/** Stated when a blocked gate verdict arrives without its own reasons. */
const SURFACE_BLOCKED_FALLBACK = 'The terrain quality gate blocked this surface.';

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
  const total = Math.max(0, tally.total);
  // Unsupported = empty cells over the whole grid. Conservative: unknown total
  // reads as fully unsupported so a degenerate grid can't look deliverable.
  const unsupportedFraction = total > 0 ? tally.empty / total : 1;

  const readiness = result.quality.readiness;
  const covered = tally.measured + tally.interpolated + tally.lowConfidence + tally.edgeRisk;

  return {
    scanLoaded: true,
    analysisComplete: true,
    streaming: ctx.streaming,
    // A surface exists when any cell is measured or interpolated. The gate can
    // block a surface that exists; that verdict travels as its own reasons.
    terrainSurfaceAvailable: covered > 0,
    ...(readiness === 'blocked'
      ? { surfaceBlockedReasons: result.quality.reasons?.length ? result.quality.reasons : [SURFACE_BLOCKED_FALLBACK] }
      : {}),
    // Measured ground cells are the honest signal that a ground source exists.
    groundSourceAvailable: tally.measured > 0,
    intervalRecommended: result.gate.recommendedM != null,
    verticalUnitsKnown: ctx.verticalUnitsKnown,
    crsProjected: ctx.crsProjected,
    ...(ctx.crsKind != null ? { crsKind: ctx.crsKind } : {}),
    ...(ctx.coverage != null ? { coverage: ctx.coverage } : {}),
    ...(ctx.groundIsDerived != null ? { groundIsDerived: ctx.groundIsDerived } : {}),
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
