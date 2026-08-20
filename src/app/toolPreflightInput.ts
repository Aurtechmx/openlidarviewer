/**
 * toolPreflightInput.ts — assemble the live {@link PreflightInput} the tool
 * preflight model reads, and nothing else.
 *
 * `src/process/toolPreflight.ts` answers what limits a tool and what would lift
 * it, but only over plain data. This module is the seam between that model and
 * the running app: it gathers the four facts the model asks for from the
 * services that already own them, and hands them over. It applies NO rule of its
 * own — no unit test, no datum comparison, no coverage estimate — because a
 * second opinion assembled here is exactly the defect the model exists to avoid.
 *
 * Where each fact comes from:
 *
 *   • the active scan's signals ← the same `signalsFromLive` set Process Studio
 *     reads, normalised by the one fail-closed constructor `deriveScanFacts`
 *   • the frame description     ← `CrsService.context()`, the single boundary
 *     where a {@link SpatialContext} is built (never re-derived here)
 *   • the companion layers      ← the loaded clouds other than the active one
 *   • the shared origin datum   ← `MeasureController.datumResolved`
 *
 * TWO DELIBERATE OMISSIONS, both fail-closed:
 *
 *   1. `layerCompatibility` is not supplied. The model then reads every layer as
 *      `unknown`, which `layerContextOf` collapses to `mixed` over more than one
 *      scan — the same unproven answer the live measure wiring
 *      (`buildMeasureConfidenceContext`) already gives, never "compatible".
 *   2. `projectFrameCompatible` is not supplied, because no service in the shell
 *      establishes that verdict for a pair of epochs yet. Omitted reads as
 *      unproven, so a two-scan product is offered for review pending alignment
 *      rather than as ready.
 *
 * A companion layer contributes its declared CRS and point count only. Its
 * classification is not walked (that is a full array scan per layer, per
 * refresh) and a CRS override made on the active scan is not applied to it, so
 * every fact it carries can only make the verdict MORE conservative.
 *
 * Pure of the DOM and three.js: the shell passes plain accessors. Node-testable.
 */

import { deriveScanFacts, type RawScanSignals } from '../process/scanFacts';
import type { ScanFacts } from '../process/ProcessPlan';
import { preflightAll, type PreflightInput, type ToolPreflight } from '../process/toolPreflight';

/**
 * The live reads the preflight needs. Each is a thunk so the shell can close
 * over services that resolve late (the Viewer arrives from a lazy chunk), and
 * each is allowed to throw — a failing read degrades the answer, it never
 * propagates into a scan-change handler.
 */
export interface PreflightLiveReads {
  /** Loose signals for the ACTIVE scan, or null when none is loaded. */
  getActiveSignals(): RawScanSignals | null | undefined;
  /**
   * The active scan's spatial context — the unit authority, built by
   * `CrsService.context()`. Typed through {@link PreflightInput} so this module
   * never constructs one itself.
   */
  getSpatialContext(): PreflightInput['spatial'];
  /** Signals for every OTHER loaded layer; empty when the active scan is alone. */
  getCompanionSignals(): readonly RawScanSignals[];
  /** True when the scene resolved a shared origin datum. */
  getDatumResolved(): boolean;
}

/** Read a thunk, treating a throw as the fail-closed fallback. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Assemble the live preflight input, or `null` when it cannot be assembled at
 * all (the spatial context read threw — with no frame description there is no
 * honest verdict to give, and a guessed one would be worse than none).
 *
 * The active scan is always first: the capability model reads `scans[0]` as the
 * primary, so a companion layer must never displace it.
 */
export function buildPreflightInput(reads: PreflightLiveReads): PreflightInput | null {
  let spatial: PreflightInput['spatial'];
  try {
    spatial = reads.getSpatialContext();
  } catch {
    return null;
  }
  const active = safely(() => reads.getActiveSignals() ?? null, null);
  const scans: ScanFacts[] = [];
  if (active) {
    scans.push(deriveScanFacts(active));
    for (const companion of safely(() => reads.getCompanionSignals(), [])) {
      scans.push(deriveScanFacts(companion));
    }
  }
  return {
    scans,
    spatial,
    datumResolved: safely(() => reads.getDatumResolved(), false),
  };
}

/**
 * The preflight for every tool from live state, or an empty list when the input
 * could not be assembled. An empty list is "nothing to say", NOT "everything is
 * ready" — a surface must render no verdict rather than a permissive one.
 */
export function preflightSnapshot(reads: PreflightLiveReads): readonly ToolPreflight[] {
  const input = buildPreflightInput(reads);
  return input === null ? [] : preflightAll(input);
}
