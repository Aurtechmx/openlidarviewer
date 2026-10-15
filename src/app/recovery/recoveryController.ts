/**
 * recoveryController.ts — crash and reload recovery, loaded lazily after boot.
 *
 * Writes the current session (the Save session JSON) to the recovery journal
 * a few seconds after the last interaction and when the page is hidden. On
 * boot, a saved entry shows a small notice; once the user reopens a source,
 * the notice offers "Restore previous work" only if that source matches the
 * entry's fingerprint, and says the file differs otherwise. The journal keeps
 * several sources; the newest entry for the reopened one is offered. Restoring goes
 * through the normal session import, which checks the match again.
 *
 * Saved work waiting to be restored, and work kept before a Replace, is held
 * under its own key, so the open source's live entry keeps being written
 * beside it. Closing a scan removes only that source's live entry.
 *
 * A write refused for its size or the storage quota is skipped and noted;
 * other storage failures turn the journal off and record why for Copy
 * diagnostics.
 */
import type { AppLifetime } from '../appLifetime';
import { matchSessionToScan, type SessionScanSummary } from '../../io/session';
import {
  buildEntry,
  createDebouncer,
  DEBOUNCE_MS,
  isStale,
  newestMatch,
  fingerprintKey,
  heldKey,
  isSizeRefusal,
  openRecoveryStore,
  pruneStale,
  type RecoveryEntry,
  type RecoveryStore,
} from './recoveryJournal';
import { recoveryEnabled, setRecoveryEnabled, setRecoveryStatus } from './recoveryStatus';
import { appTransientLane } from '../../ui/transientLane';
import { seatClear, watchSeat } from '../../ui/hudSeat';

/**
 * What the notice lifts above at the bottom left: the dock, the phone strip
 * and sheet, the navigation row, a bottom toast, the first-run hint, the
 * active-tool pill and the hold-Space hint.
 */
const NOTICE_CLEAR_OF = ['.olv-dock', '.olv-state-strip', '.olv-mobile-sheet:not(.olv-hidden)', '.olv-navbar', '.olv-lasso-toast.olv-visible', '.olv-touch-hint.olv-visible', '.olv-ati:not(.olv-hidden)', '.olv-nav-prompt-tool.olv-visible'];

export interface RecoveryDeps {
  readonly lifetime: AppLifetime;
  /** The current session JSON, or null when no source is open. */
  serialize(): Promise<string | null>;
  /** Restore a session JSON through the normal import path. Resolves true once its work is applied. */
  restore(json: string): Promise<boolean | void>;
  /** True while a source is loading; writes wait until it settles. */
  isLoading(): boolean;
  /** Where the notice mounts. */
  readonly host?: HTMLElement;
}

export interface RecoveryHandle {
  /** Call after a source finishes opening. */
  onSourceLoaded(): void;
  /**
   * The open source closed: drop its live journal entry and the notice. Work
   * held for a restore (from an earlier visit, another file or a Replace) stays.
   */
  clear(): void;
  /** True while saved work from an earlier visit is waiting to be restored or discarded. */
  hasPending(): boolean;
  /**
   * Store the current session now, as saved work waiting to be restored, before
   * something replaces it. Resolves true once the entry is stored.
   */
  snapshotNow(): Promise<boolean>;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

function describe(e: RecoveryEntry): string {
  const parts = [
    e.measurements && plural(e.measurements, 'measurement'),
    e.annotations && plural(e.annotations, 'annotation'),
    e.views && plural(e.views, 'saved view'),
  ].filter(Boolean);
  return `${parts.join(', ')} on ${e.fileName}, saved ${new Date(e.savedAt).toLocaleString()}`;
}

const summaryOf = (json: string): SessionScanSummary | undefined => {
  try {
    return (JSON.parse(json) as { scanSummary?: SessionScanSummary }).scanSummary;
  } catch {
    return undefined;
  }
};

let activeHandle: RecoveryHandle | null = null;
let activeWipe: (() => Promise<void> | undefined) | null = null;

export function startRecovery(deps: RecoveryDeps): RecoveryHandle {
  let store: RecoveryStore | null = null;
  let pending: RecoveryEntry | null = null;
  // Fresh entries read on boot, newest first, not yet restored or discarded.
  // Writes never replace or delete one of these, and pass their keys to the
  // store so its count and byte caps never evict one.
  let saved: RecoveryEntry[] = [];
  const held = (key: string | null): boolean => saved.some((e) => e.key === key);
  // The same saved work, though a write may have moved it to its held key since.
  const sameWork = (a: RecoveryEntry, b: RecoveryEntry): boolean => a === b || (a.savedAt === b.savedAt && a.json === b.json);
  // The live entry this visit wrote for the open source; closing it removes only this.
  let liveKey: string | null = null;
  // The open source's scan summary, read when it was matched.
  let openSummary: SessionScanSummary | undefined;
  // Restored entries, deleted once the next live write for their source stores the work they brought back.
  let retired: RecoveryEntry[] = [];
  // A source finished opening. The store may still be opening.
  let sourceOpen = false;
  let notice: HTMLElement | null = null;
  let unseat: () => void = () => {};
  let off = false;
  // True while a restore runs, so a source that finishes loading meanwhile does not offer it again.
  let restoring = false;
  // Set by Clear all or Turn off. One asked for before the store opens is applied once it does.
  let cleared = false;
  // Clear, Turn off, closing a source and loading one each move this on. A
  // write reads it before it serializes and stores nothing once it has moved.
  let generation = 0;
  // Writes run one at a time in the order they were asked for, so a slow
  // snapshot taken earlier cannot land after a later write. Clears skip the
  // queue: a write still serializing sees the generation move and stores
  // nothing, and a put already sent reaches IndexedDB first, so it is applied
  // before the clear and then deleted by it.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<unknown> | undefined): void => {
    queue = queue.then(op).then(() => {}, () => {});
  };

  const disable = (why: string): void => {
    off = true;
    debounce.cancel();
    setRecoveryStatus(`off:${why}`);
  };

  const hideNotice = (): void => {
    if (notice) appTransientLane().release(notice);
    unseat();
    unseat = () => {};
    notice?.remove();
    notice = null;
  };

  const showNotice = (text: string, actions: ReadonlyArray<[label: string, run: () => void, tip: string]>): void => {
    hideNotice();
    const el = document.createElement('div');
    el.className = 'olv-toast olv-recovery-notice';
    el.setAttribute('role', 'status');
    Object.assign(el.style, { position: 'fixed', top: 'auto', bottom: 'calc(16px + var(--olv-seat, 0px))', left: '16px', transform: 'none', zIndex: '40', maxWidth: 'min(360px, calc(100vw - 32px))' });
    const p = document.createElement('div');
    p.className = 'olv-toast-text';
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'olv-toast-row';
    for (const [label, run, tip] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = tip;
      b.className = 'olv-toast-cancel';
      b.textContent = label;
      b.addEventListener('click', run);
      row.append(b);
    }
    el.append(p, row);
    (deps.host ?? document.body).append(el);
    notice = el;
    // On a phone the notice waits behind any other transient card.
    appTransientLane().claim(el);
    unseat = watchSeat(el, NOTICE_CLEAR_OF, () => seatClear(el, NOTICE_CLEAR_OF, 'up'));
  };

  /** Drop the pending entry and the notice, and void every write in flight. */
  const invalidate = (): void => {
    generation += 1;
    pending = null;
    saved = [];
    hideNotice();
  };

  /** Offer the next saved work that matches the open source, if any. */
  const offerNext = (): void => {
    const next = sourceOpen ? newestMatch(saved, openSummary, Date.now(), matchSessionToScan) : null;
    if (next) {
      pending = next;
      offerRestore(next);
    }
  };

  const discard = (): void => {
    const e = pending;
    pending = null;
    hideNotice();
    saved = saved.filter((x) => x !== e);
    // A write that moved the entry aside meanwhile stored the live entry under its old key.
    if (e) enqueue(() => (e.key === liveKey ? undefined : store?.remove(e.key).catch(() => disable('remove-failed'))));
    offerNext();
  };

  /** Delete the whole journal now, without waiting on queued writes. */
  const wipe = (): Promise<void> | undefined => {
    invalidate();
    cleared = true;
    return store?.clear();
  };

  const clearAll = (): void => {
    void (wipe() ?? Promise.resolve()).then(() => {
      // Confirm in place of the notice, then let it go.
      showNotice('Recovery data in this browser was deleted.', []);
      const shown = notice;
      setTimeout(() => { if (notice === shown) hideNotice(); }, 4000);
    }, () => disable('clear-failed'));
  };

  // The two delete actions differ in scope, so each label names it.
  const DISCARD = 'Discard this work';
  const CLEAR = 'Clear all saved work';
  const DISCARD_TIP = 'Delete only this unsaved work from the browser. Other saved work stays.';
  const CLEAR_TIP = 'Delete every piece of work saved for recovery in this browser, for all files.';

  const turnOff = (): void => {
    setRecoveryEnabled(false);
    void wipe()?.catch(() => {});
    disable('user');
  };

  const offerReopen = (e: RecoveryEntry): void =>
    showNotice(`Unsaved work found: ${describe(e)}. Open ${e.fileName} again (the same file or URL) to restore it.`, [
      [DISCARD, discard, DISCARD_TIP],
      [CLEAR, clearAll, CLEAR_TIP],
      ['Turn off recovery', turnOff, 'Stop saving work for recovery in this browser and delete what is saved.'],
    ]);

  /**
   * A snapshot taken at `gen` no longer describes what the user wants kept:
   * the journal was cleared or turned off, a source closed, loaded or is
   * loading, or the app is shutting down.
   */
  const stale = (gen: number): boolean =>
    gen !== generation || off || !recoveryEnabled() || deps.isLoading() || deps.lifetime.signal.aborted;

  /**
   * Saved work from an earlier visit sits under the live key of the source it
   * was saved over. Copy it to its held key before the first live write for
   * that source replaces it. Rejects, storing nothing, when it does not fit.
   */
  const moveAside = async (s: RecoveryStore, e: RecoveryEntry): Promise<void> => {
    const moved: RecoveryEntry = { ...e, key: heldKey(e) };
    // The copy replaces the entry, so the original need not be kept beside it.
    await s.put(moved, saved.filter((x) => x !== e).map((x) => x.key));
    if (saved.includes(e)) {
      saved = saved.map((x) => (x === e ? moved : x));
      if (pending === e) pending = moved;
    } else if (retired.includes(e)) {
      // Restored meanwhile: the copy goes once the live entry holds that work.
      retired = retired.map((x) => (x === e ? moved : x));
    } else {
      // Discarded meanwhile: the copy is not wanted either.
      await s.remove(moved.key).catch(() => {});
    }
  };

  const write = async (): Promise<void> => {
    if (!off && !recoveryEnabled()) disable('user');
    const gen = generation;
    const s = store;
    if (!s || stale(gen)) return;
    const json = await deps.serialize().catch(() => null);
    // Serializing waits on lazy imports. Everything from this check to the
    // store call below runs in one task, so nothing can change in between.
    if (!json || stale(gen)) return;
    const built = buildEntry(json, Date.now());
    if ('skip' in built) {
      if (built.skip === 'too-large') setRecoveryStatus(`on:${s.backend}:skipped-too-large`);
      // Work cleared on this source: drop its entry so an empty session is never offered.
      const key = built.skip === 'no-work' ? fingerprintKey(summaryOf(json)) : null;
      if (key && !held(key)) await s.remove(key).catch(() => {});
      return;
    }
    const live = built.entry;
    try {
      // Never overwrite work that is waiting to be restored or discarded.
      const occupant = saved.find((e) => e.key === live.key);
      if (occupant) {
        await moveAside(s, occupant);
        if (stale(gen)) return;
      }
      liveKey = live.key;
      await s.put(live, saved.map((e) => e.key));
      setRecoveryStatus(`on:${s.backend}`);
    } catch (err) {
      // The journal is full of work waiting to be restored: skip this write.
      if (err instanceof Error && err.message === 'held-full') return setRecoveryStatus(`on:${s.backend}:skipped-full`);
      // Too large for this store, or over the browser's quota: skip this write, keep journaling.
      if (isSizeRefusal(err)) return setRecoveryStatus(`on:${s.backend}:${(err as Error).message === 'too-large-for-localstorage' ? 'skipped-too-large' : 'skipped-quota'}`);
      return disable(`write-failed:${err instanceof Error ? err.name : 'error'}`);
    }
    // Restored work is now in the live entry: its held copy can go.
    const done = retired.filter((e) => fingerprintKey(e.summary) === live.key && e.key !== live.key && !held(e.key));
    retired = retired.filter((e) => !done.includes(e));
    for (const e of done) await s.remove(e.key).catch(() => {});
  };

  const debounce = createDebouncer(() => enqueue(write), DEBOUNCE_MS);
  const opts = { capture: true, passive: true, signal: deps.lifetime.signal } as const;
  for (const type of ['pointerup', 'wheel', 'keyup', 'change', 'input']) {
    window.addEventListener(type, () => { if (!off) debounce.schedule(); }, opts);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') debounce.flush(); }, opts);
  deps.lifetime.register(() => { debounce.cancel(); hideNotice(); }, 'session recovery');

  if (!recoveryEnabled()) {
    setRecoveryStatus('off:user');
    off = true;
  } else {
    setRecoveryStatus('starting');
    void openRecoveryStore({
      indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
      localStorage: (() => { try { return localStorage; } catch { return undefined; } })(),
    })
      .then(async (s) => {
        if (!s) return disable('storage-unavailable');
        store = s;
        setRecoveryStatus(`on:${s.backend}`);
        // A clear asked for while the store was opening had nothing to delete yet.
        if (cleared) return void s.clear().catch(() => {});
        // Entries past the age limit are deleted before anything is offered.
        const fresh = await pruneStale(s, Date.now());
        // A clear during the prune deleted what it read.
        if (fresh.length && !off && !cleared) {
          saved = fresh;
          pending = fresh[0];
          if (sourceOpen) matchSource();
          else offerReopen(fresh[0]);
        }
      })
      .catch(() => disable('storage-unavailable'));
  }

  const offerRestore = (e: RecoveryEntry): void =>
    showNotice(`This file matches your unsaved work: ${describe(e)}.`, [
      ['Restore previous work', () => void restoreEntry(e), 'Put the saved measurements, annotations, views and camera back on this file.'],
      [DISCARD, discard, DISCARD_TIP],
      [CLEAR, clearAll, CLEAR_TIP],
    ]);

  /** Offer the newest saved work for the open source, or say it differs. */
  const matchSource = (): void => {
    const gen = generation;
    if (!saved.length || off) return;
    void deps.serialize().then((json) => {
      // Another load, a clear, Turn off or shutdown since: this answer is out of date.
      if (gen !== generation || restoring || off || deps.lifetime.signal.aborted) return;
      const now = Date.now();
      openSummary = json ? summaryOf(json) : undefined;
      const e = newestMatch(saved, openSummary, now, matchSessionToScan);
      const newest = saved.find((x) => !isStale(x, now));
      pending = e ?? newest ?? null;
      if (e) offerRestore(e);
      else if (newest) {
        showNotice(
          `The open file differs from ${newest.fileName}, so the unsaved work (${describe(newest)}) was not restored. Open ${newest.fileName} to restore it.`,
          [[DISCARD, discard, DISCARD_TIP], [CLEAR, clearAll, CLEAR_TIP]],
        );
      } else hideNotice();
    }, () => {});
  };

  const restoreEntry = async (e: RecoveryEntry): Promise<void> => {
    hideNotice();
    // The entry stays pending, so no write can replace or delete it, until the
    // import reports that it applied the saved work.
    restoring = true;
    const applied = await deps.restore(e.json).catch(() => false);
    restoring = false;
    // A write may have moved the entry to its held key meanwhile.
    const cur = pending;
    if (!cur || !sameWork(cur, e)) return;
    if (applied === true) {
      pending = null;
      saved = saved.filter((x) => x !== cur);
      retired.push(cur);
      hideNotice();
      offerNext();
    } else offerRestore(cur);
  };

  activeHandle = {
    onSourceLoaded() {
      generation += 1;
      sourceOpen = true;
      liveKey = null;
      openSummary = undefined;
      matchSource();
    },
    hasPending: () => saved.length > 0,
    async snapshotNow() {
      const s = store;
      if (!s || off || !recoveryEnabled()) return false;
      const json = await deps.serialize().catch(() => null);
      if (!json || off || !recoveryEnabled()) return false;
      const built = buildEntry(json, Date.now());
      if ('skip' in built) return false;
      // Under its held key, so live writes for this source go on beside it.
      const entry: RecoveryEntry = { ...built.entry, key: heldKey(built.entry) };
      if (held(entry.key)) return false;
      try {
        await s.put(entry, saved.map((e) => e.key));
      } catch {
        return false;
      }
      // Held from now on: later writes never replace it, and reopening the file offers it back.
      saved = [entry, ...saved];
      pending = entry;
      if (sourceOpen) matchSource();
      return true;
    },
    clear() {
      sourceOpen = false;
      openSummary = undefined;
      // Writes still serializing for the closed source store nothing.
      generation += 1;
      pending = null;
      hideNotice();
      debounce.cancel();
      // Goes out at once: a put already sent is applied first, then removed by this.
      const k = liveKey;
      liveKey = null;
      if (k && !held(k)) void store?.remove(k).catch(() => {});
    },
  };
  activeWipe = wipe;
  return activeHandle;
}

/** Delete every journal entry, whatever store holds them. Used by Clear recovery data and when the user turns recovery off. */
export async function clearRecoveryJournal(): Promise<void> {
  activeHandle?.clear();
  await activeWipe?.()?.catch(() => {});
  const store = await openRecoveryStore({
    indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    localStorage: (() => { try { return localStorage; } catch { return undefined; } })(),
  }).catch(() => null);
  await store?.clear().catch(() => {});
}
