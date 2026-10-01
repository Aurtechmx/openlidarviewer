/**
 * recoveryController.ts — crash and reload recovery, loaded lazily after boot.
 *
 * Writes the current session (the Save session JSON) to the recovery journal
 * a few seconds after the last interaction and when the page is hidden. On
 * boot, a saved entry shows a small notice; once the user reopens a source,
 * the notice offers "Restore previous work" only if that source matches the
 * entry's fingerprint, and says the file differs otherwise. Restoring goes
 * through the normal session import, which checks the match again.
 *
 * Storage failures turn the journal off and record why for Copy diagnostics.
 */
import type { AppLifetime } from '../appLifetime';
import { matchSessionToScan, type SessionScanSummary } from '../../io/session';
import {
  buildEntry,
  createDebouncer,
  DEBOUNCE_MS,
  entryMatchesSource,
  fingerprintKey,
  openRecoveryStore,
  pruneStale,
  type RecoveryEntry,
  type RecoveryStore,
} from './recoveryJournal';
import { recoveryEnabled, setRecoveryEnabled, setRecoveryStatus } from './recoveryStatus';

export interface RecoveryDeps {
  readonly lifetime: AppLifetime;
  /** The current session JSON, or null when no source is open. */
  serialize(): Promise<string | null>;
  /** Restore a session JSON through the normal import path. */
  restore(json: string): Promise<void>;
  /** True while a source is loading; writes wait until it settles. */
  isLoading(): boolean;
  /** Where the notice mounts. */
  readonly host?: HTMLElement;
}

export interface RecoveryHandle {
  /** Call after a source finishes opening. */
  onSourceLoaded(): void;
  /** Explicit close: drop every journal entry and the notice. */
  clear(): void;
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

export function startRecovery(deps: RecoveryDeps): RecoveryHandle {
  let store: RecoveryStore | null = null;
  let pending: RecoveryEntry | null = null;
  let notice: HTMLElement | null = null;
  let off = false;
  // Clear, Turn off, closing a source and loading one each move this on. A
  // write reads it before it serializes and stores nothing once it has moved.
  let generation = 0;
  // Writes and clears run one at a time in the order they were asked for, so
  // a slow snapshot taken earlier cannot land after a later write or a clear.
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
    notice?.remove();
    notice = null;
  };

  const showNotice = (text: string, actions: ReadonlyArray<[label: string, run: () => void, tip: string]>): void => {
    hideNotice();
    const el = document.createElement('div');
    el.className = 'olv-toast olv-recovery-notice';
    el.setAttribute('role', 'status');
    Object.assign(el.style, { position: 'fixed', top: 'auto', bottom: '16px', left: '16px', transform: 'none', zIndex: '40', maxWidth: 'min(360px, calc(100vw - 32px))' });
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
  };

  /** Drop the pending entry and the notice, and void every write in flight. */
  const invalidate = (): void => {
    generation += 1;
    pending = null;
    hideNotice();
  };

  const discard = (): void => {
    const e = pending;
    pending = null;
    hideNotice();
    if (e) enqueue(() => store?.remove(e.key).catch(() => disable('remove-failed')));
  };

  const clearAll = (): void => {
    invalidate();
    enqueue(() => store?.clear().then(() => {
      // Confirm in place of the notice, then let it go.
      showNotice('Recovery data in this browser was deleted.', []);
      const shown = notice;
      setTimeout(() => { if (notice === shown) hideNotice(); }, 4000);
    }, () => disable('clear-failed')));
  };

  const DISCARD_TIP = 'Delete this unsaved work from the browser.';
  const CLEAR_TIP = 'Delete all work saved for recovery in this browser now.';

  const turnOff = (): void => {
    setRecoveryEnabled(false);
    invalidate();
    enqueue(() => store?.clear().catch(() => {}));
    disable('user');
  };

  const offerReopen = (e: RecoveryEntry): void =>
    showNotice(`Unsaved work found: ${describe(e)}. Open ${e.fileName} again (the same file or URL) to restore it.`, [
      ['Discard', discard, DISCARD_TIP],
      ['Clear', clearAll, CLEAR_TIP],
      ['Turn off recovery', turnOff, 'Stop saving work for recovery in this browser and delete what is saved.'],
    ]);

  /**
   * A snapshot taken at `gen` no longer describes what the user wants kept:
   * the journal was cleared or turned off, a source closed, loaded or is
   * loading, or the app is shutting down.
   */
  const stale = (gen: number): boolean =>
    gen !== generation || off || !recoveryEnabled() || deps.isLoading() || deps.lifetime.signal.aborted;

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
      if (key && key !== pending?.key) await s.remove(key).catch(() => {});
      return;
    }
    // Never overwrite work that is waiting to be restored or discarded.
    if (built.entry.key === pending?.key) return;
    try {
      await s.put(built.entry);
      setRecoveryStatus(`on:${s.backend}`);
    } catch (err) {
      disable(`write-failed:${err instanceof Error ? err.name : 'error'}`);
    }
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
        // Entries past the age limit are deleted before anything is offered.
        const [latest] = await pruneStale(s, Date.now());
        if (latest && !off) {
          pending = latest;
          offerReopen(latest);
        }
      })
      .catch(() => disable('storage-unavailable'));
  }

  const offerRestore = (e: RecoveryEntry): void =>
    showNotice(`This file matches your unsaved work: ${describe(e)}.`, [
      ['Restore previous work', () => void restoreEntry(e), 'Put the saved measurements, annotations, views and camera back on this file.'],
      ['Discard', discard, DISCARD_TIP],
      ['Clear', clearAll, CLEAR_TIP],
    ]);

  const restoreEntry = async (e: RecoveryEntry): Promise<void> => {
    hideNotice();
    // The entry stays pending, so no write can replace or delete it, until its
    // work is on screen. The session import reports its own errors and
    // resolves, so this reads the outcome from the session it leaves behind.
    const json = await deps.restore(e.json).then(() => deps.serialize()).catch(() => null);
    if (pending !== e) return;
    const built = json ? buildEntry(json, 0, Infinity) : null;
    if (built && 'entry' in built && built.entry.key === e.key) pending = null;
    else offerRestore(e);
  };

  activeHandle = {
    onSourceLoaded() {
      generation += 1;
      const e = pending;
      if (!e || off) return;
      void deps.serialize().then((json) => {
        if (pending !== e) return;
        const loaded = json ? summaryOf(json) : undefined;
        if (entryMatchesSource(e, loaded, matchSessionToScan)) {
          offerRestore(e);
        } else {
          showNotice(
            `The open file differs from ${e.fileName}, so the unsaved work (${describe(e)}) was not restored. Open ${e.fileName} to restore it.`,
            [['Discard', discard, DISCARD_TIP], ['Clear', clearAll, CLEAR_TIP]],
          );
        }
      }, () => {});
    },
    clear() {
      invalidate();
      debounce.cancel();
      enqueue(() => store?.clear().catch(() => {}));
    },
  };
  return activeHandle;
}

/** Delete every journal entry, whatever store holds them. Used by Clear recovery data and when the user turns recovery off. */
export async function clearRecoveryJournal(): Promise<void> {
  activeHandle?.clear();
  const store = await openRecoveryStore({
    indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    localStorage: (() => { try { return localStorage; } catch { return undefined; } })(),
  }).catch(() => null);
  await store?.clear().catch(() => {});
}
