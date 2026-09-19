/**
 * continuityFailure.ts
 *
 * What happens when a continuity pass cannot run.
 *
 * The field is a presentation layer over a viewer that already worked. Every
 * way it can fail has the same correct answer: do less of it. A render target
 * that will not allocate, a pass that throws, a backend that refuses a format,
 * all mean the same thing to a user, which is that the picture should be
 * simpler and the application should still be there.
 *
 * So nothing here rethrows. A pass is run through {@link runContinuityPass},
 * which returns what the pass returned or nothing at all, and a failure walks
 * the tier down one rung. Repeated failures reach source rendering and stop,
 * because there is nothing below the renderer that already worked.
 *
 * The guarantee is narrow and worth stating exactly. It is that a continuity
 * failure does not reach the render loop as an exception. It is not that the
 * picture is unaffected, which would be false, and it is not that the failure
 * is hidden, which would be worse: the outcome names what failed so a
 * diagnostics surface can say so.
 *
 * The dataset and the measurement tools need no protection here. Nothing in
 * this subsystem can reach them, which is held by the parity and authority
 * guards rather than by anything in this file, so a continuity failure cannot
 * put a measurement wrong however it fails.
 */
import { degrade, type ContinuityTier } from './continuityTier';

/** Why a continuity pass did not run. */
export type ContinuityFailure =
  /** The programme's typed failure: the pass could not run on this device. */
  | 'CONTINUITY_RENDER_UNAVAILABLE'
  /** History was declined before it was attempted, over the size ceiling. */
  | 'history-over-ceiling'
  /** Allocation was attempted and did not succeed. */
  | 'history-allocation-failed'
  /** The pass itself threw. */
  | 'pass-threw';

/** What to do after a failure. */
export interface FailureOutcome {
  /** The tier to run from now on. Never richer than the one that failed. */
  readonly tier: ContinuityTier;
  /** What went wrong, for a diagnostics surface rather than for a user. */
  readonly failure: ContinuityFailure;
  /** Whether anything was given up. False once there is nothing left to drop. */
  readonly degraded: boolean;
}

/**
 * The tier to run after a failure at `current`.
 *
 * One rung per failure rather than straight to the bottom: a device that cannot
 * keep a history may still close gaps, and dropping everything on the first
 * refusal would give up capabilities that were never implicated.
 */
export function afterFailure(
  current: ContinuityTier,
  failure: ContinuityFailure,
): FailureOutcome {
  const next = degrade(current);
  if (next === null) return { tier: current, failure, degraded: false };
  return { tier: next, failure, degraded: true };
}

/**
 * Run a continuity pass so that nothing it does can reach the render loop.
 *
 * Returns the pass's value, or null when it failed. The reporter is called with
 * the failure and is itself wrapped, because a diagnostics surface that throws
 * while recording a failure would turn a degraded frame into a broken one,
 * which is the failure this exists to prevent arriving through its own handler.
 */
export function runContinuityPass<T>(
  pass: () => T,
  report?: (failure: ContinuityFailure, cause: unknown) => void,
): T | null {
  try {
    return pass();
  } catch (cause) {
    try {
      report?.('pass-threw', cause);
    } catch {
      // A reporter that cannot record a failure is not a reason to lose a frame.
    }
    return null;
  }
}

/**
 * Whether the viewer still has something to draw with.
 *
 * Always true. The bottom of the ladder is the renderer as it shipped, so there
 * is no state in which continuity has failed badly enough to leave nothing.
 * Written as a function because a reader deserves to find the answer where they
 * look for it rather than infer it from an absence.
 */
export function sourceRenderingAvailable(_outcome: FailureOutcome): true {
  return true;
}
