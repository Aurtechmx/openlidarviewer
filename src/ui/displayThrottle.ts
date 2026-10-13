/**
 * displayThrottle.ts
 *
 * Paces repeated status updates so a fast stream of them (bytes read, records
 * decoded) does not rewrite the same line many times a second. An update
 * marked immediate (a stage change) runs at once, after the update still held
 * for the stage it ends, so that stage's last progress is not lost. Otherwise
 * an update inside the interval is held, and only the latest held one runs
 * when the interval ends. `cancel` (a terminal state, a new open) drops it.
 *
 * The owner cancels it on every terminal state and every new operation, and
 * each held update checks its own operation when it runs, so an update from
 * an earlier open can never land on a later one. Display only.
 */

/** The timer and clock the throttle runs on; tests pass their own. */
export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DisplayThrottle {
  /** Run `apply` now when `immediate` (after any held update) or the interval has passed; else hold it. */
  push(apply: () => void, immediate: boolean): void;
  /** Drop the held update and its timer. */
  cancel(): void;
  /** True while an update is held. */
  readonly pending: boolean;
}

/** The default pacing for status text: about seven updates a second. */
export const DISPLAY_THROTTLE_MS = 150;

const defaultClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export function createDisplayThrottle(
  intervalMs: number = DISPLAY_THROTTLE_MS,
  clock: ThrottleClock = defaultClock,
): DisplayThrottle {
  let last = Number.NEGATIVE_INFINITY;
  let held: (() => void) | null = null;
  let timer: unknown = null;
  const cancel = (): void => {
    held = null;
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };
  return {
    get pending() {
      return held !== null;
    },
    cancel,
    push(apply, immediate) {
      const t = clock.now();
      if (immediate || t - last >= intervalMs) {
        const flush = held;
        cancel();
        flush?.();
        last = t;
        apply();
        return;
      }
      held = apply;
      if (timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        const run = held;
        held = null;
        if (!run) return;
        last = clock.now();
        run();
      }, Math.max(0, intervalMs - (t - last)));
    },
  };
}
