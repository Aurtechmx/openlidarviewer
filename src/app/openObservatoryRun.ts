/**
 * openObservatoryRun.ts — one entry into the Observatory panel (ASK O9-1,
 * option 3): a thin coordinator beside `observatoryRunner.ts`'s own state
 * machine, mirroring `openTerrainAnalysis.ts`'s shape for terrain analysis.
 *
 * Unlike terrain analysis, no long-lived runner instance exists anywhere
 * else in the app for this to reuse — this module is where the ONE runner
 * for the session's lifetime is built, lazily, the first time the
 * Observatory is opened, from the deps the host (`main.ts`) hands in.
 */
import { createObservatoryRunner, type ObservatoryRunner, type ObservatoryRunnerDeps } from './observatoryRunner';
import { loadObservatoryPanel } from '../lazyChunks';
import type { ObservatoryOverlayHost } from '../render/ObservatoryOverlay';
import type { ObservatoryCloudInput } from './observatoryFromCloud';

export interface ObservatoryEntryDeps {
  readonly showAnalyseMode: () => void;
  readonly runnerDeps: ObservatoryRunnerDeps;
  readonly overlayHost: () => ObservatoryOverlayHost | null;
}

/**
 * WORLD -> LOCAL (render) frame: subtract the active cloud's own
 * `sourceOrigin`. Computed HERE, in the lazy chunk, from `runnerDeps`'s own
 * `getActiveCloud` — not threaded in from `main.ts` as a separate closure —
 * so the eager entry only ever hands over primitive accessors, never a
 * second bespoke frame-conversion function to inline there.
 */
function worldToLocalOf(cloud: ObservatoryCloudInput | null): (p: readonly [number, number, number]) => readonly [number, number, number] {
  return (p) => (cloud ? [p[0] - cloud.sourceOrigin[0], p[1] - cloud.sourceOrigin[1], p[2] - cloud.sourceOrigin[2]] : p);
}

let runner: ObservatoryRunner | null = null;

/** The session's one Observatory runner, built on first use. Exported for tests that need to inspect/reset it between cases. */
export function getObservatoryRunner(deps: ObservatoryRunnerDeps): ObservatoryRunner {
  if (!runner) runner = createObservatoryRunner(deps);
  return runner;
}

/** Test-only: drop the singleton so the next `getObservatoryRunner` builds a fresh one. */
export function resetObservatoryRunnerForTest(): void {
  runner = null;
}

/**
 * Open the Observatory panel, running once when the runner has nothing
 * committed yet — the same "reveal what's already there, otherwise run"
 * policy `openTerrainAnalysis` uses for terrain analysis and contours.
 */
export async function openObservatoryRun(deps: ObservatoryEntryDeps, rerun = false): Promise<void> {
  deps.showAnalyseMode();
  const r = getObservatoryRunner(deps.runnerDeps);
  const panel = await loadObservatoryPanel();
  panel.openObservatoryPanel({ runner: r, overlayHost: deps.overlayHost(), worldToLocal: worldToLocalOf(deps.runnerDeps.getActiveCloud()) });
  if (rerun || r.getState().phase !== 'committed') r.run();
}
