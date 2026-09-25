/**
 * observatoryRunner.ts — the Observatory's own state machine, next to
 * `terrainAnalysisRunner.ts` on purpose (ASK O9-1, option 3): a thin
 * `openObservatoryRun.ts` coordinator owns showing the panel, and this file
 * owns the run itself — snapshot, await, revalidate, commit, cancel — plus
 * the single teardown (`abortAndClearCache`) every derived overlay this
 * branch has ever added hooks into.
 *
 * STALE RESULTS ARE REFUSED. A run snapshots the active dataset id and CRS
 * revision before its (synchronous, but still snapshot-guarded so a future
 * async pipeline stage costs nothing to add) compute step, and only commits
 * when both still match afterwards — the same guard `terrainAnalysisRunner.ts`
 * documents as its own "A-1 stale-result guard". A superseding `run()` call,
 * or `abortAndClearCache()`, marks the in-flight token superseded so its
 * result is discarded even if the compute step still finishes.
 */
import type { ObservatoryCloudInput, ObservatoryRunOptions, ObservatoryRunOutcome } from './observatoryFromCloud';
import { runObservatoryOverCloud } from './observatoryFromCloud';
import { registerObservatoryOverlayInvalidator } from '../lazyChunks';

export type ObservatoryRunnerState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'committed'; readonly outcome: ObservatoryRunOutcome }
  | { readonly phase: 'stale' };

export interface ObservatoryRunnerDeps {
  readonly getActiveCloud: () => ObservatoryCloudInput | null;
  readonly getDatasetId: () => string | null;
  readonly getCrsRevision: () => number;
  readonly buildOptions: () => Omit<ObservatoryRunOptions, 'declaredStepBudget' | 'voxelEdge'> & {
    readonly voxelEdge?: number;
    readonly declaredStepBudget?: number;
  };
  /** Overridable for tests; defaults to the real O1-O8 pipeline. */
  readonly compute?: (cloud: ObservatoryCloudInput, options: ObservatoryRunOptions) => ObservatoryRunOutcome;
}

const DEFAULT_VOXEL_EDGE = 0.5;
const DEFAULT_STEP_BUDGET = 20_000_000;

export interface ObservatoryRunner {
  run(): ObservatoryRunnerState;
  getState(): ObservatoryRunnerState;
  subscribe(fn: (state: ObservatoryRunnerState) => void): () => void;
  /**
   * The one teardown seam: aborts any claim on the current token so a run
   * that raced past it lands as stale, drops the committed result, and clears
   * the presentation overlay it registered with `lazyChunks.ts`.
   *
   * Called by `terrainAnalysisRunner.ts`'s own `abortAndClearCache()` on
   * exactly the same event set as every other derived layer: scan close, a
   * different scan loading, a CRS change, a classification edit.
   */
  abortAndClearCache(): void;
  /** The panel calls this once, the moment it actually draws an overlay, so there is something for `abortAndClearCache` to clear. A no-op call before that (or after) is safe. */
  setOverlayClear(fn: (() => void) | null): void;
}

export function createObservatoryRunner(deps: ObservatoryRunnerDeps): ObservatoryRunner {
  let state: ObservatoryRunnerState = { phase: 'idle' };
  let token = 0;
  const listeners = new Set<(state: ObservatoryRunnerState) => void>();
  let overlayClear: (() => void) | null = null;

  function setState(next: ObservatoryRunnerState): void {
    state = next;
    for (const fn of listeners) fn(state);
  }

  function run(): ObservatoryRunnerState {
    const myToken = ++token;
    const cloud = deps.getActiveCloud();
    const datasetId = deps.getDatasetId();
    const crsRevision = deps.getCrsRevision();
    if (!cloud) {
      setState({ phase: 'idle' });
      return state;
    }
    setState({ phase: 'running' });

    const opts = deps.buildOptions();
    const options: ObservatoryRunOptions = {
      voxelEdge: opts.voxelEdge ?? DEFAULT_VOXEL_EDGE,
      declaredStepBudget: opts.declaredStepBudget ?? DEFAULT_STEP_BUDGET,
      filename: opts.filename,
      metresPerUnit: opts.metresPerUnit,
      buildTag: opts.buildTag,
    };
    const compute = deps.compute ?? runObservatoryOverCloud;
    const outcome = compute(cloud, options);

    // Revalidate (Snapshot -> Await -> Revalidate -> Commit): a superseding
    // run() or abortAndClearCache() bumped `token` past `myToken`, or the
    // active dataset/CRS moved on while this ran — either way, this result
    // is refused, never committed silently as if it were current.
    const stale = myToken !== token || deps.getDatasetId() !== datasetId || deps.getCrsRevision() !== crsRevision;
    if (stale) {
      setState({ phase: 'stale' });
      return state;
    }
    setState({ phase: 'committed', outcome });
    return state;
  }

  function getState(): ObservatoryRunnerState {
    return state;
  }

  function subscribe(fn: (state: ObservatoryRunnerState) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function abortAndClearCache(): void {
    token++; // supersede any in-flight run so it lands as stale, not committed
    setState({ phase: 'idle' });
    overlayClear?.();
  }

  // Registered once, at construction, so `terrainAnalysisRunner.ts`'s
  // `abortAndClearCache()` can reach this runner's overlay teardown through
  // the same near-zero-cost seam the Flow Pulse Lab uses
  // (`registerFlowOverlayInvalidator`) — a no-op call if the panel never
  // attached an overlay this session.
  registerObservatoryOverlayInvalidator(() => abortAndClearCache());

  function setOverlayClear(fn: (() => void) | null): void {
    overlayClear = fn;
  }

  return { run, getState, subscribe, abortAndClearCache, setOverlayClear };
}
