/**
 * waitClock.ts: elapsed time and an estimate of the time left for a long task.
 *
 * The estimate comes only from progress the task itself reported. It stays
 * hidden until the task has shown at least {@link ETA_MIN_FRACTION} of its
 * work and run for {@link ETA_MIN_ELAPSED_MS}; before that the rate is mostly
 * noise. From then on the raw estimate is spent * (1 - f) / (f - f0), where f0
 * and the time spent are measured from the first reading with a fraction (or
 * from the moment a host restarts its count), and the shown
 * value counts down with the clock and moves toward each new raw estimate with
 * a time constant of {@link ETA_SMOOTHING_MS}, so a burst or a pause in
 * progress bends the figure instead of throwing it about. During a stall the
 * raw estimate grows with elapsed time, so the shown value stops falling. A
 * task with no fraction gets elapsed time only.
 */

export const ETA_MIN_FRACTION = 0.05;
export const ETA_MIN_ELAPSED_MS = 1500;
export const ETA_SMOOTHING_MS = 3000;
/** A task shorter than this shows no wait text at all. */
export const WAIT_SHOWN_AFTER_MS = 1000;

export interface WaitReading {
  readonly elapsedMs: number;
  /** Estimated time left, or null when the task has not shown enough progress. */
  readonly remainingMs: number | null;
}

export interface WaitClock {
  /** Read the clock at `nowMs` with the fraction the task last reported. */
  read(fraction: number | null, nowMs: number): WaitReading;
}

export function createWaitClock(startMs: number): WaitClock {
  let shown: number | null = null;
  let shownAt = 0;
  let lastFraction = 0;
  // Where the rate is measured from: the first reading with a fraction, or the
  // moment progress went backwards (a host that restarted its count). A clock
  // that starts mid-task has not seen the earlier progress happen, so it must
  // not count that progress as instant.
  let baseMs = startMs;
  let baseFraction: number | null = null;
  return {
    read(fraction, nowMs) {
      const elapsedMs = Math.max(0, nowMs - startMs);
      const f = fraction != null && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
      if (f === null) shown = null;
      if (f !== null && (baseFraction === null || f < lastFraction)) {
        shown = null;
        baseMs = nowMs;
        baseFraction = f;
      }
      if (f !== null) lastFraction = f;
      const done = f === null || baseFraction === null ? 0 : f - baseFraction;
      const spent = nowMs - baseMs;
      if (f === null || done < ETA_MIN_FRACTION || spent < ETA_MIN_ELAPSED_MS) {
        return { elapsedMs, remainingMs: null };
      }
      if (f >= 1) {
        shown = 0;
        shownAt = nowMs;
        return { elapsedMs, remainingMs: 0 };
      }
      const raw = (spent * (1 - f)) / done;
      if (shown === null) {
        shown = raw;
      } else {
        const dt = Math.max(0, nowMs - shownAt);
        const predicted = Math.max(0, shown - dt);
        shown = predicted + (raw - predicted) * (1 - Math.exp(-dt / ETA_SMOOTHING_MS));
      }
      shownAt = nowMs;
      return { elapsedMs, remainingMs: shown };
    },
  };
}

function span(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function left(ms: number): string {
  if (ms < 10_000) return 'a few seconds left';
  if (ms < 60_000) return `about ${Math.ceil(ms / 5000) * 5} s left`;
  return `about ${Math.round(ms / 60_000)} min left`;
}

/** "12 s elapsed", or "12 s elapsed, about 30 s left" once there is an estimate. */
export function formatWait(r: WaitReading): string {
  const elapsed = `${span(r.elapsedMs)} elapsed`;
  return r.remainingMs === null ? elapsed : `${elapsed}, ${left(r.remainingMs)}`;
}
