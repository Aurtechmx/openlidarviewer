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
 *   - With an open scan (hasOpenWork) the page is never reloaded automatically:
 *     onStaleWithWork says a new version is available, and a reload happens only
 *     after the user confirms what it discards.
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

/** Set by an automatic reload, and read once on the next boot to say why it happened. */
export const STALE_RELOAD_NOTICE_KEY = 'olv:stale-reload-notice';

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
  // Optional because the minimal shape a caller can pass is an adder; a target
  // without a remover simply cannot be detached, and dispose stays a no-op.
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
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
  /** Whether the browser reports a connection. Default: `navigator.onLine !== false`. */
  isOnline?: () => boolean;
  /**
   * Called with {@link OFFLINE_CHUNK_MESSAGE} when a chunk fails to load while
   * the browser is offline. The page is not reloaded: a reload offline lands on
   * an error page and drops the open scan.
   */
  onOffline?: (message: string) => void;
  /**
   * Ask the server whether a chunk URL still exists. Resolves 'missing' for a
   * 404 or 410 (a real deploy swept it away), 'present' when it is served, and
   * 'unreachable' when the request itself fails (a network blip). Default: a
   * no-store HEAD request in a browser, none elsewhere. Only a probe that
   * reports 'missing' lets the page reload. With no probe, or no URL in the
   * error, the failure is ambiguous and is reported through onAmbiguous.
   */
  probe?: ((url: string) => Promise<ChunkProbe>) | null;
  /**
   * Called when a chunk failed to load and nothing shows the deploy swept it
   * away: the error names no URL, there is no probe, or the probe could not
   * tell. The page is not reloaded, since that can discard unsaved work. Wire
   * this to a surface offering Retry, and a reload only after saying what it
   * would lose. If absent, importOrReload rejects with the original error.
   */
  onAmbiguous?: (message: string, actions: AmbiguousChunkActions) => void;
  /**
   * Whether a reload would lose anything: an open scan, a scan loading, unsaved
   * work. When true, a chunk proven gone does not reload the page. Absent means
   * nothing is open, so the automatic reload stands.
   */
  hasOpenWork?: () => boolean;
  /**
   * Called once per failure burst when a chunk is proven gone and hasOpenWork is
   * true. The import still rejects, so its caller reports it as well.
   */
  onStaleWithWork?: (message: string, actions: { reload(): void }) => void;
}

/** What the surface behind onAmbiguous can offer the user. */
export interface AmbiguousChunkActions {
  /** Run the failed import again. Resolves true when it loaded. */
  retry(): Promise<boolean>;
  /** Reload the page, through the same cooldown as an automatic reload. */
  reload(): void;
  /** How many times this failure has been reported without a successful load. */
  attempt: number;
}

/** What a HEAD request for a failed chunk URL found. */
export type ChunkProbe = 'missing' | 'present' | 'unreachable';

/** Shown when a lazy part of the app cannot load because there is no connection. */
export const OFFLINE_CHUNK_MESSAGE =
  'You are offline, this part could not load. Try again when back online. ' +
  'To use every tool offline, run Make available offline when connected.';

/** Shown when a lazy part of the app failed to load and the cause is unclear. */
export const AMBIGUOUS_CHUNK_MESSAGE =
  'This part of the app could not load. Try again; the page has not been reloaded.';

/** Shown when a deploy swept a chunk away while a scan is open. Retrying cannot help. */
export const STALE_WITH_WORK_MESSAGE =
  'A new version of the app is available. Some tools cannot load until the page is reloaded.';

/** Shown on the boot after an automatic reload, which only happens with nothing open. */
export const STALE_RELOADED_MESSAGE = 'The app was updated and reloaded. Open your file again.';

/** Said before an explicit reload: what it would lose. */
export const RELOAD_LOSS_MESSAGE =
  'Reloading the page discards anything not saved: open scans, measurements, annotations, ' +
  'class edits and results that are not in a saved session. Save your session first if you can.';

/** The script URL a failed dynamic import names, if its message carries one. */
export function chunkUrlFromError(err: unknown): string | null {
  const m = /(https?:\/\/[^\s'"]+?\.(?:m?js|css))(?:[?#][^\s'"]*)?(?=$|[\s'"])/i.exec(errorMessage(err));
  return m ? m[1] : null;
}

/** The response facts {@link classifyProbeResponse} reads. */
export interface ProbeResponse {
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly contentType: string | null;
}

/**
 * Read a HEAD response for a chunk URL. Only a script or stylesheet counts as
 * the chunk being served: a host with a single-page-app fallback answers a
 * deleted chunk with index.html and 200, which is a stale deploy. A redirect
 * (a captive portal, a login wall) says nothing about the deploy.
 */
export function classifyProbeResponse(res: ProbeResponse): ChunkProbe {
  if (res.redirected) return 'unreachable';
  const type = (res.contentType ?? '').toLowerCase();
  if (res.ok && /javascript|ecmascript|text\/css/.test(type)) return 'present';
  return 'missing';
}

/** How long the default probe waits before treating the server as unreachable. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Default probe: a no-store HEAD request for a same-origin chunk, with a
 * timeout. A cross-origin URL is never probed and reads as unreachable.
 */
export function makeHeadProbe(
  fetchFn: typeof fetch,
  origin: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): (url: string) => Promise<ChunkProbe> {
  return async (url) => {
    try {
      if (new URL(url).origin !== origin) return 'unreachable';
      const res = await fetchFn(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      return classifyProbeResponse({ ok: res.ok, redirected: res.redirected, contentType: res.headers.get('content-type') });
    } catch {
      return 'unreachable';
    }
  };
}

export interface AmbiguousChunkDeps {
  showToast(message: string, action?: { label: string; onClick: () => void }): void;
  /** Resolves true when the user confirms. */
  confirmReload(title: string, message: string): Promise<boolean>;
}

/**
 * The surface behind onAmbiguous. The page is kept: the toast offers Retry,
 * and a reload is offered only through a dialog that says what it would discard.
 */
export function makeAmbiguousChunkHandler(deps: AmbiguousChunkDeps) {
  return (message: string, { attempt, retry, reload }: AmbiguousChunkActions): void => {
    const askReload = async (): Promise<void> => {
      if (await deps.confirmReload('Reload the page?', RELOAD_LOSS_MESSAGE)) reload();
    };
    if (attempt >= 2) {
      deps.showToast(message, { label: 'Reload…', onClick: () => { void askReload(); } });
      return;
    }
    deps.showToast(message, {
      label: 'Retry',
      onClick: () => {
        void retry().then((ok) => {
          if (ok) deps.showToast('Loaded.');
          else void askReload();
        });
      },
    });
  };
}

/** The surface behind onStaleWithWork. One action: a reload, after saying what it discards. */
export function makeStaleWithWorkHandler(deps: AmbiguousChunkDeps) {
  return (message: string, { reload }: { reload(): void }): void => {
    deps.showToast(message, {
      label: RELOAD_ACTION_LABEL,
      onClick: () => { void deps.confirmReload('Reload the page?', RELOAD_LOSS_MESSAGE).then((ok) => { if (ok) reload(); }); },
    });
  };
}

/** The label of every action that reloads the page after a confirm. */
export const RELOAD_ACTION_LABEL = 'Reload…';

/** How long one failure counts as already reported: one import can fail through several paths. */
const CHUNK_BURST_MS = 2000;

/** The app's toast and confirmed reload, for code that has neither to hand. */
export interface ChunkFailureSurface extends AmbiguousChunkDeps {
  reload(): void;
}
let surface: ChunkFailureSurface | null = null;
let clock: () => number = () => Date.now();
let lastReportAt = Number.NEGATIVE_INFINITY;
const failures = new Map<string, number>();

/** Wire the surface once, at startup. */
export function setChunkFailureSurface(next: ChunkFailureSurface | null, now?: () => number): void {
  surface = next;
  if (now) clock = now;
}

/** The action that asks, then reloads. Undefined until the surface is wired. */
export function chunkReloadAction(): { label: string; onClick: () => void } | undefined {
  const s = surface;
  if (!s) return undefined;
  return {
    label: RELOAD_ACTION_LABEL,
    onClick: () => { void s.confirmReload('Reload the page?', RELOAD_LOSS_MESSAGE).then((ok) => { if (ok) s.reload(); }); },
  };
}

/** A failed chunk, in words: what could not load, the next step, and what that step costs. */
export function chunkFailureText(what: string): string {
  return `${what} could not load. Reload the page to try again. A reload closes open scans, so save your session first if you can.`;
}

/** Note that a failure was shown, so the safety net does not repeat it. */
export function markChunkFailureReported(): void {
  lastReportAt = clock();
}

/** Toast a failed chunk with a confirmed reload. For a path with no place of its own to say so. */
export function reportChunkFailure(what: string): void {
  markChunkFailureReported();
  surface?.showToast(chunkFailureText(what), chunkReloadAction());
}

/**
 * Count a chunk failure for one surface and return which failure this is. A
 * same-page retry recovers in Firefox, while Chromium and WebKit replay the
 * failed import until a reload, so the first failure may offer Try again and a
 * repeat must offer the reload.
 */
export function countChunkFailure(key: string): number {
  const n = (failures.get(key) ?? 0) + 1;
  failures.set(key, n);
  return n;
}

/** That surface loaded: a later failure is a first failure again. */
export function clearChunkFailure(key: string): void {
  failures.delete(key);
}

export function resetChunkFailuresForTests(): void {
  failures.clear();
  surface = null;
  clock = () => Date.now();
  lastReportAt = Number.NEGATIVE_INFINITY;
}

/**
 * The last resort: a chunk failure nothing handled still gives a result. Only
 * chunk failures are recognised. The event is left as it is, so the console and
 * the error ledger see what they always saw.
 */
export function installChunkFailureNet(
  target: Pick<EventTargetLike, 'addEventListener'>,
  show: (message: string, action?: { label: string; onClick: () => void }) => void,
  now: () => number = () => Date.now(),
): void {
  target.addEventListener('unhandledrejection', (event) => {
    if (classifyLoadError((event as { reason?: unknown }).reason) !== 'stale-chunk') return;
    const at = now();
    if (at - lastReportAt < CHUNK_BURST_MS) return;
    lastReportAt = at;
    show(chunkFailureText('A part of the app'), chunkReloadAction());
  });
}

/**
 * A save the user pressed for: a failure says no file was written. The save
 * itself keeps rejecting for the close and replace guards, which say so themselves.
 */
export function guardUserSave(
  save: () => Promise<boolean>,
  show: (message: string, action?: { label: string; onClick: () => void }) => void,
): () => Promise<boolean> {
  return () => save().catch((err: unknown) => {
    markChunkFailureReported();
    if (classifyLoadError(err) === 'stale-chunk') {
      show('Session not saved. Part of the app could not load, so no file was written. Your work is still open.', chunkReloadAction());
    } else {
      show(`Session not saved. No file was written. ${errorMessage(err)}`);
    }
    return false;
  });
}

/** Read and clear the note an automatic reload left, for the boot that follows it. */
export function consumeStaleReloadNotice(store?: StorageLike | null): string | null {
  try {
    const storage = store === undefined ? sessionStorage : store;
    if (storage?.getItem(STALE_RELOAD_NOTICE_KEY) == null) return null;
    storage.removeItem(STALE_RELOAD_NOTICE_KEY);
    return STALE_RELOADED_MESSAGE;
  } catch {
    return null;
  }
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

  /** Reload now, after the user confirmed. The cooldown guards automatic reloads only. */
  reloadNow(): void;

  /**
   * Detach the `vite:preloadError` listener this installer registered.
   *
   * The other teardown paths in this codebase grew a disposer for the same
   * reason: a listener that outlives the thing that wanted it keeps that
   * closure, and its captured state, alive. Installing twice without this
   * leaves two handlers, so a single stale chunk would attempt recovery twice.
   * Safe to call more than once.
   */
  dispose(): void;
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

/** What one failed chunk came to: 'held' is a chunk proven gone with a scan open. */
type RecoveryOutcome = 'reloaded' | 'unrecoverable' | 'kept' | 'held';

/**
 * Install the one-shot stale-chunk recovery: registers a `vite:preloadError`
 * handler (when an event target exists) and returns { importOrReload }.
 */
export function installStaleChunkRecovery(
  opts: StaleChunkRecoveryOptions = {},
): StaleChunkRecovery {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const reload = opts.reload ?? deferredPageReload(typeof window !== 'undefined' ? window : null);
  let storage: StorageLike | null;
  if (opts.storage !== undefined) {
    storage = opts.storage;
  } else if (typeof sessionStorage !== 'undefined') {
    storage = sessionStorage;
  } else {
    storage = null;
  }
  let eventTarget: EventTargetLike | null;
  if (opts.eventTarget !== undefined) {
    eventTarget = opts.eventTarget;
  } else if (typeof window !== 'undefined') {
    eventTarget = window as unknown as EventTargetLike;
  } else {
    eventTarget = null;
  }
  const onUnrecoverable = opts.onUnrecoverable;
  const log = opts.log ?? ((reason: string) => console.warn('[staleChunkReload]', reason));
  const isOnline = opts.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const onOffline = opts.onOffline;
  const onAmbiguous = opts.onAmbiguous;
  let probe: ((url: string) => Promise<ChunkProbe>) | null;
  if (opts.probe !== undefined) probe = opts.probe;
  else probe = typeof window !== 'undefined' && typeof fetch === 'function' ? makeHeadProbe(fetch, window.location.origin) : null;

  // Vite reports one failed import twice: the vite:preloadError event, then the
  // rethrow into importOrReload. Both share one probe and one decision per URL,
  // and the offline note is shown once per failure burst.
  const decisions = new Map<string, Promise<RecoveryOutcome>>();
  let offlineNoted = false;
  function noteOffline(): void {
    if (offlineNoted) return;
    offlineNoted = true;
    onOffline?.(OFFLINE_CHUNK_MESSAGE);
    // A later failure, after this burst, may say so again.
    setTimeout(() => { offlineNoted = false; }, 2000);
  }

  /**
   * Reload only for a stale deploy. Offline, or when the probe shows the chunk
   * server is unreachable or still serving the chunk, report and keep the page.
   */
  function recoverIfStale(err: unknown): Promise<RecoveryOutcome> {
    const url = chunkUrlFromError(err);
    if (!url) return decide(err, null);
    let d = decisions.get(url);
    if (!d) {
      d = decide(err, url);
      decisions.set(url, d);
      // Forget the decision once settled, so a retry later probes afresh.
      void d.then(() => setTimeout(() => decisions.delete(url), 2000));
    }
    return d;
  }

  /** True unless the check says nothing is open: when it cannot tell, keep the page. */
  function openWork(): boolean {
    if (!opts.hasOpenWork) return false;
    try {
      return opts.hasOpenWork();
    } catch {
      return true;
    }
  }

  let staleNoted = false;
  function noteStale(): void {
    if (staleNoted) return;
    staleNoted = true;
    setTimeout(() => { staleNoted = false; }, CHUNK_BURST_MS);
    markChunkFailureReported();
    opts.onStaleWithWork?.(STALE_WITH_WORK_MESSAGE, { reload: reloadNow });
  }

  function reloadNow(): void {
    writeMarker(now());
    reload();
  }

  async function decide(err: unknown, url: string | null): Promise<RecoveryOutcome> {
    // Reload only on proof the chunk is gone. No URL or no probe proves nothing.
    const found: ChunkProbe | 'unknown' = url && probe ? await probe(url) : 'unknown';
    if (found === 'missing') {
      if (!openWork()) return attemptRecover(err);
      log('chunk is gone from the server but a scan is open; not reloading');
      noteStale();
      return 'held';
    }
    // The import rejects and its caller reports the failure.
    if (found === 'unknown') log('chunk load failed and the cause is unclear; not reloading');
    else log(`chunk load failed but the server ${found === 'present' ? 'still serves it' : 'is unreachable'}; not reloading`);
    return 'kept';
  }

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
    try {
      storage?.setItem(STALE_RELOAD_NOTICE_KEY, '1');
    } catch {
      // Same as the marker: losing the note costs only the sentence on next boot.
    }
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
    if (!isOnline()) {
      // Offline: a reload cannot fetch the new shell and would drop the open
      // scan. Leave the event alone so the import rejects and its caller can
      // report it and retry later.
      log('chunk load failed while offline; not reloading');
      noteOffline();
      return;
    }
    // The import rejects as usual; the page reloads only if the probe finds
    // the chunk gone from the server. An ambiguous failure is reported by
    // importOrReload, which holds the loader a retry needs.
    void recoverIfStale(payload);
  }

  eventTarget?.addEventListener('vite:preloadError', onPreloadError);

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    eventTarget?.removeEventListener?.('vite:preloadError', onPreloadError);
  }

  let ambiguousAttempts = 0;
  let ambiguousNoted = false;
  /** Offer Retry through onAmbiguous; the caller still sees the rejection. */
  function reportAmbiguous<T>(loader: () => Promise<T>): void {
    if (!onAmbiguous || ambiguousNoted) return;
    ambiguousNoted = true;
    setTimeout(() => { ambiguousNoted = false; }, 2000);
    ambiguousAttempts += 1;
    onAmbiguous(AMBIGUOUS_CHUNK_MESSAGE, {
      attempt: ambiguousAttempts,
      reload: reloadNow,
      retry: async () => {
        try {
          await loader();
          ambiguousAttempts = 0;
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  async function importOrReload<T>(loader: () => Promise<T>): Promise<T> {
    try {
      return await loader();
    } catch (err) {
      if (classifyLoadError(err) !== 'stale-chunk') {
        // An ordinary feature exception — never reload the page over it.
        throw err;
      }
      if (!isOnline()) {
        log('chunk load failed while offline; not reloading');
        noteOffline();
        throw err;
      }
      const outcome = await recoverIfStale(err);
      if (outcome === 'kept') {
        reportAmbiguous(loader);
        throw err;
      }
      if (outcome === 'held') throw err;
      if (outcome === 'unrecoverable' && !onUnrecoverable) {
        // No surface was wired — propagate so the caller can show the error.
        throw err;
      }
      // Either the page is reloading, or onUnrecoverable owns the surface:
      // never resolve, so no downstream `.then` runs against a doomed page.
      return new Promise<T>(() => {});
    }
  }

  return { importOrReload, reloadNow, dispose };
}

/** The slice of a window {@link deferredPageReload} uses. */
export interface ReloadWindowLike {
  addEventListener(type: string, listener: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  location: { reload(): void };
}

/**
 * A page reload that never races another navigation. When the viewer is
 * already leaving (a link, a typed URL, a test's `goto`), Firefox aborts the
 * in-flight module fetches and rejects them with the same "error loading
 * dynamically imported module" a swept-away chunk gives. Reloading then would
 * replace the navigation the viewer asked for. So the reload waits one task,
 * and is dropped when `pagehide` has fired in between; a page restored from
 * the back-forward cache (`pageshow`) can reload again. No argument to
 * reload(): it keeps the current URL and query.
 */
export function deferredPageReload(win: ReloadWindowLike | null): () => void {
  if (!win) return () => {};
  let leaving = false;
  win.addEventListener('pagehide', () => { leaving = true; });
  win.addEventListener('pageshow', () => { leaving = false; });
  return () => {
    win.setTimeout(() => {
      if (!leaving) win.location.reload();
    }, 0);
  };
}

/**
 * Feed uncaught errors (kind 0) and unhandled rejections (kind 1) into the
 * diagnostics error ledger's shared buffer as `[ms, kind, className]` tuples
 * (see app/diagnostics/errorLedger.ts, ERROR_LEDGER_KEY). It lives here, in the
 * shell's error-recovery owner, because a module of its own would cost the
 * startup chunk more than the code does; the ledger itself is lazy and turns
 * the tuples into sanitized entries when it is read. No message is kept.
 */
export function recordErrorLedger(kind: number, err: unknown): void {
  const g = globalThis as { __olvErrorLedger?: unknown[] };
  const b = (g.__olvErrorLedger ??= []);
  b.push([performance.now(), kind, err instanceof Error ? err.name : 0]);
  if (b.length > 50) b.shift();
}

export function captureWindowErrors(target: Pick<Window, 'addEventListener'>): void {
  const push = recordErrorLedger;
  target.addEventListener('error', (e) => push(0, (e as ErrorEvent).error));
  target.addEventListener('unhandledrejection', (e) => push(1, (e as PromiseRejectionEvent).reason));
}

if (typeof window !== 'undefined') captureWindowErrors(window);
