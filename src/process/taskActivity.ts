/**
 * taskActivity.ts — the one record of what the app is working on right now.
 *
 * Every busy indicator registers here when it is created (`ui/busyScan.ts`
 * does it for every host), so the running task, its label and its progress
 * have a single owner that the state strip's processing provider reads. A task
 * is live while its host says so (`live()`); an indicator that was removed or
 * hidden stops counting without its host having to report the end. The store
 * holds no DOM of its own and computes nothing: the label is the text the host
 * shows and the progress is the fraction the host last set.
 */

export interface TaskActivitySource {
  /** The text the host shows beside the indicator. */
  label(): string;
  /** The fraction the host last reported, 0..1, or null when not known. */
  progress(): number | null;
  /** True while the host is showing the indicator for a running task. */
  live(): boolean;
  /** True once the host can never show it again; the store then forgets it. */
  gone?(): boolean;
}

export interface TaskActivity {
  readonly id: number;
  readonly label: string;
  readonly progress: number | null;
}

let nextId = 1;
const sources = new Map<number, TaskActivitySource>();
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
      if (sources.delete(id)) notifyTaskActivity();
    },
  };
}

/** The tasks live now, oldest first. A source whose read throws is dropped. */
export function liveTasks(): readonly TaskActivity[] {
  const out: TaskActivity[] = [];
  for (const [id, s] of sources) {
    try {
      if (s.gone?.()) {
        sources.delete(id);
        continue;
      }
      if (s.live()) out.push({ id, label: s.label(), progress: s.progress() });
    } catch {
      sources.delete(id);
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
  listeners.clear();
}
