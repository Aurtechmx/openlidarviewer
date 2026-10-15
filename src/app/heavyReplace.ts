/**
 * heavyReplace.ts — what an out-of-core LAS/LAZ open does to the scene it
 * opens over, and to the work on it.
 *
 * The out-of-core open attaches a stream. A viewer holds one stream, so the
 * open REPLACES a stream already on screen, exactly as a COPC open does, and
 * asks the same Save / Replace / Cancel question first. Unlike a COPC open it
 * does not clear the static layers: over static layers (or an empty viewer) it
 * is additive, so nothing is asked and nothing is cleared.
 *
 * The question is asked once, before any work starts, so Cancel costs no build
 * and the loader's own preview is never mistaken for a second replacement. The
 * answer is applied only after the new source commits ({@link settleHeavyReplace}).
 * A cancel or a failure before the commit leaves the previous stream and every
 * piece of work as it was.
 */
import { LoadCancelledError } from '../io/loadFile';
import type { DiscardableWork } from './closeScanGuard';
import type { ReplaceOutcome } from './discardGuard';
import { RETIRED_SCAN_OWNER, ownerIdsOf, type OwnedItem } from './measurementOwnership';
import { guardReplacedWork, settleReplacedWork } from './openStreaming';
import type { HeavyLasBridgeDeps } from './heavyLasTypes';

/** The decision taken before the open, applied after its commit. */
export interface HeavyReplacePlan {
  /** A committed stream was on screen, so the open replaces it. */
  readonly replacingStream: boolean;
  /** The guard's answer; `none` when nothing was asked. */
  readonly outcome: ReplaceOutcome;
  /** Stable ids of the static layers open at the start; they stay open. */
  readonly staticOwners: readonly string[];
  /** How many static layers were open at the start. */
  readonly staticCount: number;
}

/** Work owned by one of the static layers that stay open. */
function ownedByStatic(item: OwnedItem, staticOwners: readonly string[]): boolean {
  return ownerIdsOf(item).some((id) => staticOwners.includes(id));
}

/**
 * Decide before any work starts. Resolves null on Cancel: the caller then
 * returns `cancelled` with nothing changed.
 */
export async function askHeavyReplace(deps: HeavyLasBridgeDeps, name: string): Promise<HeavyReplacePlan | null> {
  await deps.viewerReady;
  const viewer = deps.getViewer();
  const statics = viewer.clouds();
  const staticOwners = statics
    .map((id) => deps.stableLayerId?.(id) ?? null)
    .filter((id): id is string => id !== null);
  const replacingStream = viewer.hasStreamingCloud === true;
  if (!replacingStream) return { replacingStream, outcome: 'none', staticOwners, staticCount: statics.length };
  // With static layers staying open, only the stream's work is at risk: work
  // owned by a static layer stays, and so do the saved views.
  const scope = statics.length === 0 ? undefined : (work: DiscardableWork): DiscardableWork => ({
    ...work,
    measurements: viewer.measure.getMeasurements().filter((m) => !ownedByStatic(m, staticOwners)).length,
    annotations: viewer.annotate.getAnnotations().filter((a) => !ownedByStatic(a, staticOwners)).length,
    views: 0,
  });
  try {
    const outcome = await guardReplacedWork(
      { replaceGuard: deps.streaming.replaceGuard && ((req) => deps.streaming.replaceGuard!({ ...req, ...(scope ? { scope } : {}) })) },
      name,
    );
    return { replacingStream, outcome, staticOwners, staticCount: statics.length };
  } catch (err) {
    if (err instanceof LoadCancelledError) return null;
    throw err;
  }
}

/**
 * After the new source committed. Replacing a stream: a confirmed Replace
 * clears the work the question named; anything else keeps it, stamped as the
 * retired scan's so a saved session never writes it under the new file. Over
 * static layers: their work and saved views stay; work taken while one static
 * layer was the whole scene is recorded as that layer's.
 */
export function settleHeavyReplace(deps: HeavyLasBridgeDeps, plan: HeavyReplacePlan): void {
  const viewer = deps.getViewer();
  if (!plan.replacingStream) {
    const sole = plan.staticCount === 1 ? plan.staticOwners[0] : undefined;
    if (sole) {
      viewer.measure.claimUnowned(sole);
      viewer.annotate.claimUnowned(sole);
    }
    return;
  }
  if (plan.staticCount === 0) {
    settleReplacedWork(deps.streaming, plan.outcome);
    return;
  }
  if (plan.outcome === 'replace') {
    for (const m of viewer.measure.getMeasurements()) {
      if (!ownedByStatic(m, plan.staticOwners)) viewer.measure.removeMeasurement(m.id);
    }
    for (const a of viewer.annotate.getAnnotations()) {
      if (!ownedByStatic(a, plan.staticOwners)) viewer.annotate.remove(a.id);
    }
    return;
  }
  viewer.measure.claimUnowned(RETIRED_SCAN_OWNER);
  viewer.annotate.claimUnowned(RETIRED_SCAN_OWNER);
}
