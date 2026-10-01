/**
 * taskActivity.ts — the one record of what the app is working on right now.
 *
 * Every busy indicator registers here when it is created (`ui/busyScan.ts`
 * does it for every host), so the running task, its label and its progress
 * have a single owner that the state strip's processing provider reads. A task
 * is live while its host says so (`live()`); an indicator that was removed or
 * hidden stops counting without its host having to report the end. The store
 * holds no DOM of its own: the label is the text the host shows and the
 * progress is the fraction the host last set. The store times each task from
 * the moment it is first seen live until it settles or goes, through any time
 * it spends hidden, and estimates the time left from the host's progress (see
 * `waitClock.ts`).
 */

import { createWaitClock, type WaitClock } from './waitClock';

export interface TaskActivitySource {
  /** The text the host shows beside the indicator. */
  label(): string;
  /** The fraction the host last reported, 0..1, or null when not known. */
  progress(): number | null;
  /** True while the host is showing the indicator for a running task. */
  live(): boolean;
  /** True once the host can never show it again; the store then forgets it. */
  gone?(): boolean;
  /**
   * True once the host has finished this task, so a later live run is a new
   * task with a new clock. A task that is only hidden (its panel collapsed,
   * another mode shown) keeps its clock and is timed again when it returns.
   */
  settled?(): boolean;
  /**
   * Which run of a reused indicator this is. When it changes, the task is a
   * new one and its clock starts again, even if no poll saw it settle.
   */
  run?(): string;
}

export interface TaskActivity {
  readonly id: number;
  readonly label: string;
  readonly progress: number | null;
  /** Time since the task was first seen live. */
  readonly elapsedMs: number;
  /** Estimated time left, or null until the progress supports an estimate. */
  readonly remainingMs: number | null;
}

let nextId = 1;
const sources = new Map<number, TaskActivitySource>();
const clocks = new Map<number, WaitClock>();
const runs = new Map<number, string | undefined>();
const listeners = new Set<() => void>();

/** Tell subscribers a task started, moved or ended. */
export function notifyTaskActivity(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A failing subscriber never stops the others or the host.
    }
  }
}

/** Register a task source. Returns the id and a disposer that forgets it. */
export function registerTask(source: TaskActivitySource): { id: number; end(): void } {
  const id = nextId++;
  sources.set(id, source);
  notifyTaskActivity();
  return {
    id,
    end() {
      clocks.delete(id);
      runs.delete(id);
      if (sources.delete(id)) notifyTaskActivity();
    },
  };
}

/** The tasks live now, oldest first. A source whose read throws is dropped. */
export function liveTasks(nowMs: number = performance.now()): readonly TaskActivity[] {
  const out: TaskActivity[] = [];
  for (const [id, s] of sources) {
    try {
      if (s.gone?.()) {
        sources.delete(id);
        clocks.delete(id);
        continue;
      }
      if (s.settled?.()) {
        clocks.delete(id);
        continue;
      }
      const run = s.run?.();
      // A task already running in this run stays listed while its host is
      // hidden (panel closed, sheet lowered); a hidden one not yet seen is not.
      if (!s.live() && (!clocks.has(id) || runs.get(id) !== run)) {
        clocks.delete(id);
        continue;
      }
      if (runs.get(id) !== run) clocks.delete(id);
      runs.set(id, run);
      let clock = clocks.get(id);
      if (!clock) clocks.set(id, (clock = createWaitClock(nowMs)));
      const progress = s.progress();
      const { elapsedMs, remainingMs } = clock.read(progress, nowMs);
      out.push({ id, label: s.label(), progress, elapsedMs, remainingMs });
    } catch {
      sources.delete(id);
      clocks.delete(id);
    }
  }
  return out;
}

export function subscribeTaskActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: forget every source and listener. */
export function resetTaskActivityForTests(): void {
  sources.clear();
  clocks.clear();
  runs.clear();
  listeners.clear();
}
