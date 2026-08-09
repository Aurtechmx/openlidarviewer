/**
 * processStudioMount.ts — wire the Process Studio panel to live scan state.
 *
 * Keeps two concerns out of the composition root:
 *   1. turning the loose live-scan signals the shell already tracks (kind, point
 *      count, resolved CRS, classification presence, attribute flags) into the
 *      panel's {@link ScanFacts} through the one fail-closed constructor,
 *      {@link deriveScanFacts} — so an unknown signal makes the panel MORE
 *      conservative, never falsely capable; and
 *   2. creating and mounting the panel and handing back one `refresh()` the
 *      caller invokes on any scan change.
 *
 * The signals themselves are read by the composition root, where the live
 * `viewer` / `scans` / `crsService` objects are, and handed in through the
 * `getSignals` seam. That keeps this module pure of three.js and the GPU and
 * Node-testable: a `null` signal set is the no-scan empty state, and a throwing
 * signal read is caught and treated as no-scan rather than propagating into a
 * scan-change handler.
 */

import { ProcessStudioPanel } from '../ui/ProcessStudioPanel';
import { deriveScanFacts } from '../process/scanFacts';
import type { RawScanSignals } from '../process/scanFacts';
import type { ScanFacts } from '../process/ProcessPlan';
import type { CrsInfo } from '../io/crs';

/** LAS standard classification codes the panel keys ground/building on. */
const CLASS_GROUND = 2;
const CLASS_BUILDING = 6;

/**
 * Granular reads of the live shell the composition root already holds. Each is
 * a plain getter so this stays Node-testable with fakes and never touches the
 * viewer or GPU directly.
 */
export interface LiveScanAccessors {
  /** Source point count when a streaming source is mounted; null/undefined otherwise (its presence marks the scan as streaming). */
  getStreamingPointCount(): number | null | undefined;
  /** Point count of the active static cloud; null/undefined when none is loaded. */
  getActivePointCount(): number | null | undefined;
  /** The resolved CRS, or null when unknown — never assumed. */
  getResolvedCrs(): CrsInfo | null | undefined;
  /** Classification codes currently present on the active scan (empty when none). */
  getPresentClassCodes(): readonly number[];
  /** True when the present classification was DERIVED by OLV (heuristic), not
   *  carried by the producer. Distinguishes trusted vs derived ground/buildings. */
  getClassificationDerived(): boolean;
}

/**
 * Build the loose signal set from live accessors, fail-closed. A streaming
 * source wins over a static cloud (it is the active scan when mounted). Returns
 * null when nothing is loaded. Classification is reported as `partial` whenever
 * any class code is present — the conservative floor, never `full` — and ground
 * / building trust follows only from the actual class-2 / class-6 codes.
 */
export function signalsFromLive(a: LiveScanAccessors): RawScanSignals | null {
  const streamPts = a.getStreamingPointCount();
  const staticPts = a.getActivePointCount();
  const isStreaming = streamPts != null;
  if (!isStreaming && staticPts == null) return null;
  const codes = a.getPresentClassCodes();
  const hasClasses = codes.length > 0;
  // Provenance: a classification OLV derived is `derived` (heuristic); one the
  // producer carried is `producer` (trusted). This keeps OLV-derived class-2
  // from reading as surveyed ground in the capability model.
  const classificationProvenance = !hasClasses
    ? 'none'
    : (a.getClassificationDerived() ? 'derived' : 'producer');
  return {
    kind: isStreaming ? 'streaming' : 'static',
    pointCount: isStreaming ? (streamPts as number) : (staticPts as number),
    crs: a.getResolvedCrs() ?? null,
    classification: hasClasses ? 'partial' : 'none',
    classificationProvenance,
    groundClassified: codes.includes(CLASS_GROUND),
    hasBuildingClass: codes.includes(CLASS_BUILDING),
  };
}

export interface ProcessStudioDeps {
  /** Live signals for the active scan, or null when none is loaded. */
  getSignals(): RawScanSignals | null | undefined;
}

/**
 * Resolve the active scan's facts from the live signals. Returns null when no
 * scan is loaded or the signal read throws — the panel renders its empty state.
 */
export function resolveActiveScanFacts(deps: ProcessStudioDeps): ScanFacts | null {
  let raw: RawScanSignals | null | undefined;
  try {
    raw = deps.getSignals();
  } catch {
    return null;
  }
  return raw ? deriveScanFacts(raw) : null;
}

export interface MountedProcessStudio {
  readonly panel: ProcessStudioPanel;
  /** Re-read live signals and repaint. Safe to call on every scan change. */
  refresh(): void;
}

/** Create the panel and return it plus a `refresh()` bound to `deps`. */
export function createProcessStudio(deps: ProcessStudioDeps): MountedProcessStudio {
  const panel = new ProcessStudioPanel();
  panel.update(null);
  // Start hidden: the shell reveals it on scan load (like the class legend) and
  // hides it on scan close, so the boot shell never shows an empty studio.
  panel.hide();
  return {
    panel,
    refresh() {
      panel.update(resolveActiveScanFacts(deps));
    },
  };
}

/** Convenience wiring for the composition root: create the studio straight from live accessors. */
export function createProcessStudioFromLive(accessors: LiveScanAccessors): MountedProcessStudio {
  return createProcessStudio({ getSignals: () => signalsFromLive(accessors) });
}
