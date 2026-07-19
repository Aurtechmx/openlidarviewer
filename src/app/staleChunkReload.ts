/**
 * staleChunkReload.ts  (v0.6 P3 — stale-chunk recovery)
 *
 * After a fresh deploy, a browser tab that has been open across the deploy still
 * holds the OLD index/module graph. The moment it lazy-imports a code-split
 * chunk whose hashed filename no longer exists on the server, the dynamic import
 * rejects — "Failed to fetch dynamically imported module" — and a feature that
 * worked a minute ago now throws. This is not a bug in the file the user opened
 * and not a bug in the app; it is a stale HTML shell pointing at swept-away
 * assets. The fix the browser needs is simply to reload the page so it fetches
 * the new shell + new chunk hashes.
 *
 * This module does exactly that, once, safely:
 *   - classifyLoadError distinguishes a genuine stale-chunk / preload failure
 *     from an ordinary feature exception, so we never reload the page to "fix"
 *     a normal error.
 *   - installStaleChunkRecovery performs ONE automatic reload guarded by a
 *     sessionStorage cooldown marker, so a chunk that is *still* missing after
 *     the reload surfaces an actionable error instead of trapping the user in a
 *     reload loop. reload() keeps the current URL + query, so the user lands
 *     back where they were.
 *
 * Time, reload, sessionStorage and the event target are all injectable, so the
 * whole decision is unit-tested in Node without a real browser.
 *
 * Pure-ish: the only side effects are the injected reload/storage/log and the
 * one addEventListener registration (skipped when no event target exists).
 */

/** Whether a caught failure is a swept-away code chunk, or an ordinary error. */
export type StaleChunkVerdict = 'stale-chunk' | 'other';

/**
 * sessionStorage key holding the epoch-ms timestamp of the last automatic
 * reload. sessionStorage (not localStorage) so the guard is scoped to this tab
 * and survives the reload but not a fresh tab.
 */
export const STALE_RELOAD_MARKER_KEY = 'olv:stale-reload-at';

/** Default cooldown: a second stale failure within this window will not reload. */
const DEFAULT_COOLDOWN_MS = 20_000;

/** The narrow slice of Storage this module touches — injectable for tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The narrow slice of an EventTarget this module touches — injectable. */
export interface EventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Everything the recovery needs from the outside world — all defaulted. */
export interface StaleChunkRecoveryOptions {
  /** Cooldown window in ms; a stale failure inside it will not reload again. */
  cooldownMs?: number;
  /** Wall clock, injectable for deterministic tests. Default: Date.now. */
  now?: () => number;
  /** Reload the page, preserving URL + query. Default: location.reload(). */
  reload?: () => void;
  /** Loop-guard marker store. Default: sessionStorage (null when unavailable). */
  storage?: StorageLike | null;
  /** Where the `vite:preloadError` handler is registered. Default: window. */
  eventTarget?: EventTargetLike | null;
  /**
   * Called when a stale-chunk failure recurs inside the cooldown (a reload
   * would loop). Wire this to a permanent, actionable error surface. If absent,
   * importOrReload rejects with the original error instead.
   */
  onUnrecoverable?: (err: unknown) => void;
  /** One-line diagnostic sink. Default: console.warn. */
  log?: (reason: string) => void;
}

/** The handle returned by installStaleChunkRecovery. */
export interface StaleChunkRecovery {
  /**
   * Run a dynamic import (or any loader). On success, resolves with its value.
   * On a classified stale-chunk rejection, triggers the one-shot guarded reload
   * (the returned promise then never settles — the page is going away). On an
   * ordinary rejection, rejects with the original error, untouched.
   */
  importOrReload<T>(loader: () => Promise<T>): Promise<T>;
}

/** Pull `message` (or a nested `payload`) out of any thrown / event-carried value. */
function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as { message?: unknown; payload?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    if (obj.payload != null && obj.payload !== err) return errorMessage(obj.payload);
  }
  return String(err ?? '');
}

/** The `name` of an error-like value, if it has a string one. */
function errorName(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/**
 * Is this failure a swept-away code chunk / failed module preload — the thing a
 * page reload actually fixes — rather than an ordinary feature exception?
 *
 * Matches the real phrasings across engines and bundlers:
 *   - "Failed to fetch dynamically imported module" (Chromium)
 *   - "error loading dynamically imported module"   (Firefox)
 *   - "importing a module script failed"            (Safari)
 *   - "Unable to preload CSS for …" / "unable to preload" (Vite module preloader)
 *   - a ChunkLoadError by name                      (Vite / webpack)
 * A Vite `vite:preloadError` event carries its Error under `.payload`, which is
 * unwrapped by errorMessage, so passing the event itself also classifies.
 */
export function classifyLoadError(err: unknown): StaleChunkVerdict {
  if (err == null) return 'other';

  // Tagged by name by the bundler — the most reliable signal when present.
  if (/chunkloaderror/i.test(errorName(err))) return 'stale-chunk';

  const m = errorMessage(err).toLowerCase();
  if (
    m.includes('dynamically imported module') || // Chromium + Firefox
    m.includes('importing a module script') || //   Safari
    m.includes('unable to preload') //              Vite preloader (CSS + JS)
  ) {
    return 'stale-chunk';
  }
  return 'other';
}

/**
 * Install the one-shot stale-chunk recovery: registers a `vite:preloadError`
 * handler (when an event target exists) and returns { importOrReload }.
 */
export function installStaleChunkRecovery(
  opts: StaleChunkRecoveryOptions = {},
): StaleChunkRecovery {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const reload =
    opts.reload ??
    (() => {
      // No argument: reload() re-requests the CURRENT URL + query, so the user
      // lands back exactly where they were.
      if (typeof location !== 'undefined') location.reload();
    });
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;
  const eventTarget =
    opts.eventTarget !== undefined
      ? opts.eventTarget
      : typeof window !== 'undefined'
        ? (window as unknown as EventTargetLike)
        : null;
  const onUnrecoverable = opts.onUnrecoverable;
  const log = opts.log ?? ((reason: string) => console.warn('[staleChunkReload]', reason));

  function readMarker(): number | null {
    try {
      const raw = storage?.getItem(STALE_RELOAD_MARKER_KEY);
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null; // A throwing store (private mode) just means no loop-guard.
    }
  }

  function writeMarker(at: number): void {
    try {
      storage?.setItem(STALE_RELOAD_MARKER_KEY, String(at));
    } catch {
      // Storage can throw (private mode / quota). Recovery still proceeds; the
      // worst case is we lose the loop-guard for this single reload.
    }
  }

  /**
   * The core decision, shared by importOrReload and the preloadError handler:
   * reload once, or — if we already reloaded inside the cooldown — surface the
   * error instead of reloading into a loop.
   */
  function attemptRecover(err: unknown): 'reloaded' | 'unrecoverable' {
    const at = now();
    const last = readMarker();
    if (last != null && at - last < cooldownMs) {
      log(
        `stale-chunk still failing ${at - last}ms after an auto-reload (< ${cooldownMs}ms cooldown) — surfacing error instead of reloading again`,
      );
      onUnrecoverable?.(err);
      return 'unrecoverable';
    }
    writeMarker(at);
    log(
      `stale-chunk detected ("${errorMessage(err)}") — reloading once to fetch fresh assets (URL preserved)`,
    );
    reload();
    return 'reloaded';
  }

  function onPreloadError(event: unknown): void {
    // Vite carries the failing Error under `event.payload`.
    const payload =
      event && typeof event === 'object'
        ? ((event as { payload?: unknown }).payload ?? event)
        : event;
    // We own recovery from here; stop Vite's default, which is to re-throw.
    if (event && typeof event === 'object') {
      const prevent = (event as { preventDefault?: unknown }).preventDefault;
      if (typeof prevent === 'function') prevent.call(event);
    }
    attemptRecover(payload);
  }

  eventTarget?.addEventListener('vite:preloadError', onPreloadError);

  async function importOrReload<T>(loader: () => Promise<T>): Promise<T> {
    try {
      return await loader();
    } catch (err) {
      if (classifyLoadError(err) !== 'stale-chunk') {
        // An ordinary feature exception — never reload the page over it.
        throw err;
      }
      const outcome = attemptRecover(err);
      if (outcome === 'unrecoverable' && !onUnrecoverable) {
        // No surface was wired — propagate so the caller can show the error.
        throw err;
      }
      // Either the page is reloading, or onUnrecoverable owns the surface:
      // never resolve, so no downstream `.then` runs against a doomed page.
      return new Promise<T>(() => {});
    }
  }

  return { importOrReload };
}
