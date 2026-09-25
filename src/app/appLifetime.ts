/**
 * appLifetime.ts — the root owner of every application-lifetime resource.
 *
 * Per-resource owners (the Viewer, the Stage, the decode worker clients, the
 * streaming session) each know how to release what they hold. This is the one
 * place that knows all of them and releases them together when the page goes
 * away.
 *
 * Contract:
 *   - `register(dispose, label)` returns an unregister function.
 *   - `disposeAll()` runs registrations newest first, each at most once. A
 *     throwing disposer does not stop the rest; errors are collected and
 *     reported once through `onErrors`.
 *   - `disposeAll()` is idempotent and safe to call from inside a disposer.
 *   - After `disposeAll()`, `register()` runs its disposer immediately.
 *   - `signal` aborts at the start of `disposeAll()`, so listeners added with
 *     `{ signal }` are removed with everything else.
 *   - `bindPagehide(target)` disposes on `pagehide` unless the page is entering
 *     the back/forward cache (`event.persisted`). `beforeunload` is not used: a
 *     handler on it makes the page ineligible for that cache.
 */

export type Disposer = () => void;

export interface DisposeFailure {
  readonly label: string;
  readonly error: unknown;
}

export interface AppLifetime {
  register(dispose: Disposer, label: string): () => void;
  disposeAll(): void;
  readonly disposed: boolean;
  /** Aborted when disposal starts; pass as `{ signal }` to addEventListener. */
  readonly signal: AbortSignal;
  /** Dispose on a non-persisted `pagehide`. Returns a detach function. */
  bindPagehide(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void;
}

interface Entry {
  readonly dispose: Disposer;
  readonly label: string;
}

const reportFailures = (failures: readonly DisposeFailure[]): void => {
  console.warn(`[lifetime] ${failures.length} disposer(s) threw:`, failures.map((f) => f.label).join(', '), failures);
};

export function createAppLifetime(onErrors: (failures: readonly DisposeFailure[]) => void = reportFailures): AppLifetime {
  const entries: Entry[] = [];
  const controller = new AbortController();
  let disposed = false;

  const run = (entry: Entry, failures: DisposeFailure[]): void => {
    try {
      entry.dispose();
    } catch (error) {
      failures.push({ label: entry.label, error });
    }
  };

  const lifetime: AppLifetime = {
    get disposed() {
      return disposed;
    },
    signal: controller.signal,
    register(dispose, label) {
      const entry: Entry = { dispose, label };
      if (disposed) {
        const failures: DisposeFailure[] = [];
        run(entry, failures);
        if (failures.length) onErrors(failures);
        return () => {};
      }
      entries.push(entry);
      return () => {
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    disposeAll() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      const failures: DisposeFailure[] = [];
      // Popped one at a time so a re-entrant call or an unregister from inside
      // a disposer sees the remaining list, and nothing runs twice.
      while (entries.length) run(entries.pop()!, failures);
      if (failures.length) onErrors(failures);
    },
    bindPagehide(target) {
      const onPagehide = (event: Event): void => {
        if ((event as PageTransitionEvent).persisted) return;
        lifetime.disposeAll();
      };
      target.addEventListener('pagehide', onPagehide);
      return () => target.removeEventListener('pagehide', onPagehide);
    },
  };
  return lifetime;
}
