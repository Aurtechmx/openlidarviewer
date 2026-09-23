/**
 * lazySurfaceLoad.ts
 *
 * Shared plumbing for every lazy-loaded overlay/panel entry point: a busy
 * cue on the trigger while its chunk fetches, and — should the load fail —
 * a visible error with a "Try again" action instead of an unhandled
 * rejection.
 *
 * Two failure shapes a stale chunk can take are both handled the same way
 * here: a rejected import (the ordinary case), and an import that RESOLVES
 * to `undefined` — the branch `installStaleChunkRecovery`
 * (`staleChunkReload.ts`) takes on a second `vite:preloadError` within its
 * 20s cooldown, where the event is defaulted-out without reloading and
 * without rethrowing. A caller's own `load` composes the chunk fetch with
 * whatever it does with the module (destructure, construct, mount), so that
 * `undefined` case surfaces as an ordinary thrown TypeError from the
 * destructure/construct step — no special-casing needed here.
 *
 * `main.ts`'s `importSession` wrapper already guards the session-restore
 * chunk against exactly this shape of failure; this module gives every
 * other lazy entry point the same guarantee from one place instead of a
 * bespoke try/catch at each call site.
 */

/** A trigger element that can carry a visible pending cue while its chunk loads. */
export interface LazyLoadTrigger {
  /**
   * Toggle the pending cue. Always paired: called `true` right before the
   * load starts, `false` once it settles (success or failure) — so a slow
   * retry never leaves the trigger stuck busy.
   */
  setBusy(busy: boolean): void;
}

/** Where a load failure is reported. Matches `panelChrome.ts`'s `ToastHost.show`. */
export interface LazyLoadToast {
  show(message: string, action?: { readonly label: string; readonly onClick: () => void }): void;
}

export interface LazyLoadOpts {
  /** A trigger to carry the busy cue. Omit when no persistent element fits (a keyboard-only surface, a transient context menu). */
  trigger?: LazyLoadTrigger;
  /**
   * What "Try again" does. Omit to show the failure with no action — right
   * for a surface the user can just as easily retry with the same gesture
   * that opened it (right-click again, press the shortcut again).
   */
  retry?: () => void;
}

/**
 * Bind a loader to one toast surface. Call the result with `load` (the
 * WHOLE operation — chunk fetch plus whatever the caller does with the
 * module — so a successful retry actually finishes the job, not just
 * refetches bytes nothing then consumes) and a `label` used in the default
 * failure message ("command palette", "shortcut sheet", …).
 *
 * Resolves to `load`'s result, or to `undefined` after already reporting
 * the failure through `toast` — callers check for `undefined` rather than
 * wrapping the call in their own try/catch.
 */
export function createLazySurfaceLoader(toast: LazyLoadToast) {
  function run<T>(load: () => Promise<T>, label: string, opts: LazyLoadOpts = {}): Promise<T | undefined> {
    opts.trigger?.setBusy(true);
    return load()
      .then((result) => {
        opts.trigger?.setBusy(false);
        return result;
      })
      .catch((err: unknown) => {
        opts.trigger?.setBusy(false);
        const message = err instanceof Error ? err.message : `Could not load the ${label}.`;
        toast.show(message, opts.retry ? { label: 'Try again', onClick: opts.retry } : undefined);
        return undefined;
      });
  }
  return run;
}

/** A lazily-built, cached-once value with the same busy/retry contract. */
export interface LazySingleton<T> {
  /** The already-built value, or `null` before the first successful build. */
  current(): T | null;
  /**
   * Resolve the value: the cached one once built, or the in-flight load, or
   * a fresh attempt. Never rejects — a failed attempt reports through the
   * bound toast and resolves to `undefined`.
   *
   * `onReady`, when given, runs with the value as soon as it is available —
   * from THIS call's own attempt, or from a LATER one (the toast's "Try
   * again" action), whichever resolves first. Only the most recently
   * requested `onReady` fires; this is what makes a successful retry
   * actually finish the job (open the panel, toggle it) instead of quietly
   * refetching bytes nothing then consumes.
   */
  ensure(onReady?: (value: T) => void): Promise<T | undefined>;
}

/**
 * `createLazySurfaceLoader` for the common "build it once, reuse it after"
 * shape every overlay/panel entry point shares (command palette, shortcut
 * sheet, help overlay, …). `build` runs at most once at a time; concurrent
 * `ensure()` calls share the same in-flight attempt, and a failure clears
 * the in-flight state so the next call — from the toast's retry action, or
 * from the user simply repeating the gesture — starts a fresh attempt.
 */
export function createLazySingleton<T>(
  build: () => Promise<T>,
  label: string,
  toast: LazyLoadToast,
  trigger?: LazyLoadTrigger,
): LazySingleton<T> {
  let value: T | null = null;
  let loading: Promise<T | undefined> | null = null;
  let pending: ((v: T) => void) | null = null;
  const run = createLazySurfaceLoader(toast);
  const ensure = (onReady?: (v: T) => void): Promise<T | undefined> => {
    if (value) {
      onReady?.(value);
      return Promise.resolve(value);
    }
    if (onReady) pending = onReady;
    loading ??= run(build, label, {
      trigger,
      retry: () => {
        loading = null;
        void ensure();
      },
    }).then((built) => {
      loading = null;
      // `pending` survives a failure — cleared only once actually consumed —
      // so a later retry (with no `onReady` of its own) still replays it.
      if (built) {
        value = built;
        pending?.(built);
        pending = null;
      }
      return built;
    });
    return loading;
  };
  return { current: () => value, ensure };
}

/**
 * A trigger backed by a real `<button>`: `disabled` (most dock/panel
 * buttons already dim on `:disabled`) plus `aria-busy` for assistive tech.
 * `null` is accepted so a lookup that finds nothing is a harmless no-op.
 */
export function buttonLazyTrigger(button: HTMLButtonElement | null): LazyLoadTrigger {
  return {
    setBusy(busy) {
      if (!button) return;
      button.disabled = busy;
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
  };
}
