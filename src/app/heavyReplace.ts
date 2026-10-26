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
import { guardReplacedWork, settleReplacedWork, type ReplaceDecision } from './openStreaming';
import type { HeavyLasBridgeDeps } from './heavyLasTypes';

/** The decision taken before the open, applied after its commit. */
export interface HeavyReplacePlan {
  /** A committed stream was on screen, so the open replaces it. */
  readonly replacingStream: boolean;
  /** The guard's answer; `none` when nothing was asked. */
  readonly outcome: ReplaceOutcome;
  /** What the question saw, so a Replace removes only the work it named. Null when nothing was asked. */
  readonly decision: ReplaceDecision | null;
  /** Stable ids of the static layers open at the start; they stay open. */
  readonly staticOwners: readonly string[];
  /** How many static layers were open at the start. */
  readonly staticCount: number;
}

/** Work owned by one of the static layers that stay open. */
function ownedByStatic(item: OwnedItem, staticOwners: readonly string[]): boolean {
  return ownerIdsOf(item).some((id) => staticOwners.includes(id));
}

/** The stores a replace reads and prunes. */
export interface ReplaceWorkStores {
  measure: { getMeasurements(): readonly (OwnedItem & { id: string })[]; removeMeasurement(id: string): unknown; claimUnowned(owner: string): void };
  annotate: { getAnnotations(): readonly (OwnedItem & { id: string })[]; remove(id: string): void; claimUnowned(owner: string): void; resetHistory(): void };
}

/** The stable ids of the open static layers that stay open through a replace. */
export function staticOwnersOf(statics: readonly string[], stableLayerId: (id: string) => string | null): string[] {
  return statics.map((id) => stableLayerId(id)).filter((id): id is string => id !== null);
}

/**
 * Narrow the replace question to the stream's work when static layers stay
 * open: work owned by a static layer stays, and so do the saved views.
 */
export function staticWorkScope(viewer: ReplaceWorkStores, staticOwners: readonly string[]): (work: DiscardableWork) => DiscardableWork {
  return (work) => ({
    ...work,
    measurements: viewer.measure.getMeasurements().filter((m) => !ownedByStatic(m, staticOwners)).length,
    annotations: viewer.annotate.getAnnotations().filter((a) => !ownedByStatic(a, staticOwners)).length,
    views: 0,
  });
}

/**
 * A confirmed Replace with static layers staying open: remove only the work
 * the question named (anything placed while the file was being prepared was
 * never offered for discard), forget the annotation undo history those items
 * sat in, and stamp what is left unowned as the retired scan's.
 */
export function removeReplacedStreamWork(
  viewer: ReplaceWorkStores,
  staticOwners: readonly string[],
  seen: { measurements: ReadonlySet<string>; annotations: ReadonlySet<string> } | null,
): void {
  for (const m of viewer.measure.getMeasurements()) {
    if (!ownedByStatic(m, staticOwners) && (!seen || seen.measurements.has(m.id))) viewer.measure.removeMeasurement(m.id);
  }
  for (const a of viewer.annotate.getAnnotations()) {
    if (!ownedByStatic(a, staticOwners) && (!seen || seen.annotations.has(a.id))) viewer.annotate.remove(a.id);
  }
  viewer.annotate.resetHistory();
  viewer.measure.claimUnowned(RETIRED_SCAN_OWNER);
  viewer.annotate.claimUnowned(RETIRED_SCAN_OWNER);
}

/**
 * Decide before any work starts. Resolves null on Cancel: the caller then
 * returns `cancelled` with nothing changed.
 */
export async function askHeavyReplace(deps: HeavyLasBridgeDeps, name: string): Promise<HeavyReplacePlan | null> {
  await deps.viewerReady;
  const viewer = deps.getViewer();
  const statics = viewer.clouds();
  const staticOwners = staticOwnersOf(statics, (id) => deps.stableLayerId?.(id) ?? null);
  const replacingStream = viewer.hasStreamingCloud === true;
  if (!replacingStream) return { replacingStream, outcome: 'none', decision: null, staticOwners, staticCount: statics.length };
  const scope = statics.length === 0 ? undefined : staticWorkScope(viewer, staticOwners);
  try {
    const decision = await guardReplacedWork(
      {
        replaceGuard: deps.streaming.replaceGuard && ((req) => deps.streaming.replaceGuard!({ ...req, ...(scope ? { scope } : {}) })),
        getViewer: deps.streaming.getViewer,
      },
      name,
    );
    return { replacingStream, outcome: decision.outcome, decision, staticOwners, staticCount: statics.length };
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
    settleReplacedWork(deps.streaming, plan.decision ?? { outcome: plan.outcome, name: '', seen: null, replacesScene: true });
    return;
  }
  if (plan.outcome === 'replace') {
    removeReplacedStreamWork(viewer, plan.staticOwners, plan.decision?.seen ?? null);
    return;
  }
  viewer.measure.claimUnowned(RETIRED_SCAN_OWNER);
  viewer.annotate.claimUnowned(RETIRED_SCAN_OWNER);
}

/** The part of a resolved CRS the frame notice compares and names. */
export interface FrameSummary {
  readonly name: string;
  readonly epsg?: number;
  readonly linearUnit: string;
}

function frameLabel(f: FrameSummary | null): string {
  if (f === null) return 'no CRS';
  if (f.epsg != null) return `EPSG:${f.epsg}`;
  return f.name;
}

/**
 * A stream opened beside a static layer publishes its coordinate system while
 * the static layer stays the active scan, so that layer's measurements, report
 * and exports read in the stream's frame. Until the frames are kept apart, the
 * user is told when they differ. `before` is the published CRS before the
 * stream committed, `after` the one it published; null is a scan with no CRS.
 */
export function streamFrameNotice(before: FrameSummary | null, after: FrameSummary | null): string | null {
  if (before === null && after === null) return null;
  if (before !== null && after !== null) {
    const same = before.epsg != null || after.epsg != null
      ? before.epsg === after.epsg
      : before.name === after.name && before.linearUnit === after.linearUnit;
    if (same) return null;
  }
  return `The streamed scan's coordinate system (${frameLabel(after)}) differs from the open scan's (${frameLabel(before)}). Measurements on the earlier scan now read in the stream's units; check them before use.`;
}
