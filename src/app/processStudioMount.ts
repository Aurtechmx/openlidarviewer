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
  return {
    panel,
    refresh() {
      panel.update(resolveActiveScanFacts(deps));
    },
  };
}
