/**
 * syncFallbackRefusedError.ts
 *
 * The one error a worker bridge raises when it declines to rescue a failed
 * worker job on the main thread.
 *
 * Both bridges that own a synchronous fallback (`computeTerrainCoreAsync`,
 * `deriveClassificationAsync`) run a heavy pure-TS kernel inline when their
 * worker dies. That is a real rescue for a small workload and a multi-second
 * frozen page for a large one, so each bridge bounds the fallback by a measured
 * limit (docs/validation/sync-fallback-budget-baseline.json) and throws this
 * when the workload is over it.
 *
 * The type carries what a caller needs to render a useful surface without
 * parsing prose: which stage refused, the size it refused, and the limit it
 * measured against. `name` is pinned to 'SyncFallbackRefusedError' so the
 * abort checks in both bridges (which match on name / message) can never read a
 * refusal as a cancellation.
 */

/** Which bridge refused the main-thread fallback. */
export type SyncFallbackStage = 'terrain' | 'classify';

/** What the refusal was measured against: the point count or the grid cells. */
export type SyncFallbackMeasure = 'points' | 'cells';

/** Sentence shown to the user, per stage. Plain voice, no internal names. */
function messageFor(stage: SyncFallbackStage, points: number): string {
  if (stage === 'terrain') {
    return (
      `Analysis not run: the terrain worker is unavailable and this scan ` +
      `(${points} points) would freeze the page on the main thread. No result ` +
      `was produced. Reload to restore the worker, or analyse a smaller sample.`
    );
  }
  return (
    `Classification unavailable: the classifier worker failed and this cloud ` +
    `(${points} points) is too large for a safe main-thread fallback. No ` +
    `classification was changed. Reload to restore the worker.`
  );
}

/**
 * A recoverable refusal: the worker failed AND the workload is too large to
 * finish safely on the main thread, so nothing was computed and nothing was
 * changed.
 */
export class SyncFallbackRefusedError extends Error {
  override readonly name = 'SyncFallbackRefusedError';
  /** The bridge that refused. */
  readonly stage: SyncFallbackStage;
  /** The point count of the refused workload. */
  readonly points: number;
  /** The limit the workload exceeded, in the units of {@link measure}. */
  readonly limit: number;
  /** Whether the refusal tripped on points or on estimated grid cells. */
  readonly measure: SyncFallbackMeasure;
  /** The sentence to show the user. Identical to `message`. */
  readonly userMessage: string;

  constructor(args: {
    stage: SyncFallbackStage;
    points: number;
    limit: number;
    measure?: SyncFallbackMeasure;
  }) {
    const userMessage = messageFor(args.stage, args.points);
    super(userMessage);
    this.stage = args.stage;
    this.points = args.points;
    this.limit = args.limit;
    this.measure = args.measure ?? 'points';
    this.userMessage = userMessage;
  }
}

/** True when this value is a fallback refusal (survives a structured clone). */
export function isSyncFallbackRefused(err: unknown): err is SyncFallbackRefusedError {
  return err instanceof SyncFallbackRefusedError;
}

/**
 * Whether the fallback ceilings apply in THIS environment.
 *
 * The ceilings exist to stop a multi-second synchronous compute from freezing a
 * page. That hazard is specific to a browser main thread, which is also the only
 * environment that has `Worker` at all: where the global is absent (Node unit
 * tests, SSR) the "fallback" is the only compute path there is, and no UI can
 * block. So the guard follows the presence of `Worker` rather than firing
 * everywhere. A browser whose worker CHUNK fails to load still has
 * the global, so the guard applies exactly where the defect it fixes lives.
 *
 * Callers may force it either way through their `opts`, which is how the
 * refusal tests exercise the guard without stubbing a global.
 */
export function syncFallbackLimitsApply(): boolean {
  return typeof Worker !== 'undefined';
}
