/**
 * clock.ts
 *
 * Monotonic stage timing.
 *
 * `Date.now()` is deliberately not used anywhere here. It reads the wall clock,
 * which NTP can step backwards mid-run: a stage that ran 40 ms can then report a
 * negative duration, and one that ran 40 ms across a leap adjustment can report
 * seconds. Either number lands in a paper table looking like a real result.
 * `process.hrtime.bigint()` is monotonic and nanosecond-resolution, so a stage
 * duration is a duration and nothing else.
 *
 * The ms conversion happens once, at the end, on the nanosecond DIFFERENCE — not
 * on each endpoint — so no precision is lost to the ~1e18 magnitude of an
 * absolute hrtime reading.
 */

import { measured, unavailable, type Metric } from './types';

export const CLOCK_UNAVAILABLE_REASON =
  'no monotonic clock: process.hrtime.bigint() is not available in this runtime';

/** Read the monotonic clock, or null where the runtime has none (e.g. a browser). */
export function readMonotonicNs(): bigint | null {
  const p = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process;
  const h = p?.hrtime?.bigint;
  if (typeof h !== 'function') return null;
  try {
    return h.call(p?.hrtime);
  } catch {
    // A runtime that exposes the symbol but refuses the call (a locked-down
    // sandbox) must report unavailable, never a fabricated 0.
    return null;
  }
}

/**
 * Turn two monotonic readings into a duration metric.
 *
 * Exported so the unavailable branch is reachable from a test without having to
 * simulate a runtime that lacks hrtime — the branch that would otherwise be the
 * easiest place for a `?? 0` to creep back in.
 */
export function elapsedMs(startNs: bigint | null, endNs: bigint | null): Metric {
  if (startNs === null || endNs === null) {
    return unavailable(CLOCK_UNAVAILABLE_REASON, { runtime: 'node', deterministic: false });
  }
  const ms = Number(endNs - startNs) / 1e6;
  // Timings never repeat exactly, so `deterministic` is false: a table built
  // from these must not present them as fixed properties of the software.
  return measured(ms, 'ms', { runtime: 'node', deterministic: false });
}

/**
 * Start timing a stage. Call the returned function to close it.
 *
 * Callable more than once (each call reads the clock again), which is what makes
 * a "so far" reading possible for a long-running stage without a second timer.
 */
export function startStageClock(): () => Metric {
  const startNs = readMonotonicNs();
  return () => elapsedMs(startNs, readMonotonicNs());
}
