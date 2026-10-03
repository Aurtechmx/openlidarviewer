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
  async function run<T>(load: () => Promise<T>, label: string, opts: LazyLoadOpts = {}): Promise<T | undefined> {
    opts.trigger?.setBusy(true);
    try {
      // Awaited inside the try, so a `load` that throws before it returns a
      // promise is reported the same way as one that rejects.
      return await load();
    } catch (err) {
      report(toast, err, label, opts.retry);
      return undefined;
    } finally {
      opts.trigger?.setBusy(false);
    }
  }
  return run;
}

/**
 * Share one load between every caller, and forget it if it fails. The first
 * call starts `load`; later calls get the same promise while it runs and once
 * it resolves. A rejection reaches the callers that shared it, and then this
 * drops it, so the next call (a Try again, or the same gesture repeated) starts
 * a fresh load rather than replaying the failure until the page reloads.
 */
export function retryableOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let attempt: Promise<T> | null = null;
  return () => (attempt ??= load().catch((err: unknown) => { attempt = null; throw err; }));
}

/**
 * Run `load` through a lazy-load toast whose Try again runs it again, for a
 * one-off action that has no singleton to cache.
 */
export function runWithRetry(toast: LazyLoadToast, load: () => Promise<unknown>, label: string): void {
  const run = createLazySurfaceLoader(toast);
  const attempt = (): void => void run(load, label, { retry: attempt });
  attempt();
}

/**
 * The lazy panel mount shared by the Analyse, Object and Measurements panels:
 * a concurrent caller may have built the panel while the import was in
 * flight, so `existing` wins; otherwise `build` makes it (and stores it where
 * `hydrate` reads it), `mount` places it in the DOM (absent in bare and embed
 * layouts), and `hydrate` replays what the scan route already asked for.
 */
export function mountPanelOnce<P extends { element: HTMLElement }>(
  existing: P | null,
  build: () => P,
  mount: ((el: HTMLElement) => void) | null,
  hydrate: () => void,
): P {
  if (!existing) {
    existing = build();
    mount?.(existing.element);
    hydrate();
  }
  return existing as P;
}

/** Show a failure: the error's own message, or a fallback naming the surface. */
function report(toast: LazyLoadToast, err: unknown, label: string, retry?: () => void): void {
  toast.show(err instanceof Error ? err.message : `Could not load the ${label}.`, retry ? { label: 'Try again', onClick: retry } : undefined);
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
 * The retry action is a plain `ensure()`, so a second click on the same toast
 * while that attempt runs joins it rather than starting another build.
 *
 * An `onReady` that throws is reported through the same toast; the built
 * value stays cached and `ensure()` still resolves to it.
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
  const ready = (fn: (v: T) => void, v: T): void => {
    try {
      fn(v);
    } catch (err) {
      report(toast, err, label);
    }
  };
  const ensure = (onReady?: (v: T) => void): Promise<T | undefined> => {
    if (value) {
      if (onReady) ready(onReady, value);
      return Promise.resolve(value);
    }
    if (onReady) pending = onReady;
    loading ??= run(build, label, { trigger, retry: () => void ensure() }).then((built) => {
      loading = null;
      // `pending` survives a failure — cleared only once actually consumed —
      // so a later retry (with no `onReady` of its own) still replays it.
      if (built) {
        value = built;
        const fn = pending;
        pending = null;
        if (fn) ready(fn, built);
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
 *
 * Accepts the element directly, or a getter for it — the getter form is for
 * a button built later than the trigger (a dock assembled after this call),
 * resolved fresh on every `setBusy`. Either form is a harmless no-op if the
 * lookup finds nothing.
 */
export function buttonLazyTrigger(
  button: HTMLButtonElement | null | (() => HTMLButtonElement | null),
): LazyLoadTrigger {
  const resolve = (): HTMLButtonElement | null => (typeof button === 'function' ? button() : button);
  // Overlapping loads share one button: the first records whether it was
  // already disabled, and only the last to settle restores that state.
  let depth = 0;
  let wasDisabled = false;
  // Disabling a focused button drops focus to the page, and a dialog the load
  // opens then has nowhere to return it on close. A trigger that held focus
  // when the load began gets it back when the load settles, before the
  // surface opens, if nothing else took focus meanwhile.
  let hadFocus = false;
  return {
    setBusy(busy) {
      const el = resolve();
      if (!el) return;
      if (busy) {
        if (depth++ === 0) {
          wasDisabled = el.disabled;
          hadFocus = typeof document !== 'undefined' && document.activeElement === el;
        }
      } else if (depth > 0 && --depth > 0) {
        return;
      }
      el.disabled = busy || wasDisabled;
      if (!busy && hadFocus) {
        hadFocus = false;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!el.disabled && (!active || active === document.body)) el.focus?.();
      }
      el.setAttribute('aria-busy', String(busy));
    },
  };
}
