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
  register(dispose: Disposer, label: string): () => unknown;
  disposeAll(): void;
  readonly disposed: boolean;
  /** Aborted when disposal starts. The lifetime itself is valid addEventListener options. */
  readonly signal: AbortSignal;
  /** Dispose on a non-persisted `pagehide`. Returns a detach function. */
  bindPagehide(target: PagehideTarget): () => void;
  /** Register each owner in key order (key = label), then bind `pagehide` on `target`. */
  own(owners: Record<string, Disposer>, target: PagehideTarget): void;
}

type PagehideTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** A registration: its disposer and its label. */
type Entry = [dispose: Disposer, label: string];

export function createAppLifetime(
  onErrors: (failures: readonly DisposeFailure[]) => void = (failures) => console.warn('[lifetime]', failures),
): AppLifetime {
  const entries = new Set<Entry>();
  const controller = new AbortController();
  // Newest first. An entry is deleted before it runs, so a re-entrant call or
  // an unregister from inside a disposer cannot run anything twice.
  const drain = (list: Entry[]): void => {
    const failures: DisposeFailure[] = [];
    for (const e of list.reverse()) {
      if (!entries.delete(e)) continue;
      try {
        e[0]();
      } catch (error) {
        failures.push({ label: e[1], error });
      }
    }
    if (failures.length) onErrors(failures);
  };
  const lifetime: AppLifetime = {
    disposed: false,
    signal: controller.signal,
    register(dispose, label) {
      const entry: Entry = [dispose, label];
      entries.add(entry);
      if (lifetime.disposed) drain([entry]);
      return () => entries.delete(entry);
    },
    disposeAll() {
      if (lifetime.disposed) return;
      (lifetime as { disposed: boolean }).disposed = true;
      controller.abort();
      drain([...entries]);
    },
    bindPagehide(target) {
      const onPagehide = (event: Event): void => {
        if (!(event as PageTransitionEvent).persisted) lifetime.disposeAll();
      };
      target.addEventListener('pagehide', onPagehide);
      return () => target.removeEventListener('pagehide', onPagehide);
    },
    own(owners, target) {
      for (const [label, dispose] of Object.entries(owners)) lifetime.register(dispose, label);
      lifetime.bindPagehide(target);
    },
  };
  return lifetime;
}
