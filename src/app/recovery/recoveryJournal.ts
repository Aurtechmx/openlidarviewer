/**
 * recoveryJournal.ts — the storage and matching core of session recovery.
 *
 * The journal stores the same `.olvsession` JSON the Save session action
 * writes (never the point cloud), keyed by a fingerprint of the source it was
 * captured over. The fingerprint comes from the session's own `scanSummary`
 * (file name, source point count, extents, EPSG), so the journal adds no
 * second identity scheme: recovery offers a restore only when the reopened
 * source produces the same key AND `matchSessionToScan` calls it a strong
 * match.
 *
 * Storage is IndexedDB, falling back to localStorage for entries up to
 * {@link LOCAL_STORAGE_MAX_BYTES}. Any failure disables the journal; it never
 * throws into the app.
 */
import type { ScanMatch, SessionScanSummary } from '../../io/session';

/** Largest session JSON the journal keeps. A larger session is skipped with a note. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Largest entry the localStorage fallback accepts (its whole quota is often 5 MB). */
export const LOCAL_STORAGE_MAX_BYTES = 512 * 1024;
/** Entries kept, newest first; older ones are pruned on write. */
export const MAX_ENTRIES = 5;
/** Quiet period after the last interaction before a write. */
export const DEBOUNCE_MS = 3000;
/** Entries older than this are deleted on boot and never offered (7 days). */
export const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoveryEntry {
  readonly v: 1;
  readonly key: string;
  readonly savedAt: number;
  readonly fileName: string;
  readonly summary: SessionScanSummary;
  readonly measurements: number;
  readonly annotations: number;
  readonly views: number;
  /** The serialised session, exactly as Save session writes it. */
  readonly json: string;
}

export interface RecoveryStore {
  readonly backend: 'indexeddb' | 'localstorage';
  put(entry: RecoveryEntry): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  /** All entries, newest first. */
  list(): Promise<RecoveryEntry[]>;
}

const fmt = (n: number | undefined): string => (Number.isFinite(n) ? (n as number).toPrecision(9) : '');

/**
 * The source fingerprint key, or null when the summary is too thin to
 * identify a source (no name or no finite extents).
 */
export function fingerprintKey(s: Partial<SessionScanSummary> | undefined): string | null {
  if (!s || typeof s.fileName !== 'string' || s.fileName === '') return null;
  if (![s.width, s.depth, s.height].every((x) => Number.isFinite(x))) return null;
  return [s.fileName.toLowerCase(), s.sourcePoints ?? '', fmt(s.width), fmt(s.depth), fmt(s.height), s.epsg ?? ''].join('|');
}

export type BuildResult =
  | { readonly entry: RecoveryEntry }
  | { readonly skip: 'no-source' | 'no-work' | 'too-large' | 'unreadable' };

/** Turn a serialised session into a journal entry, or say why it is not kept. */
export function buildEntry(json: string, now: number, maxBytes = MAX_ENTRY_BYTES): BuildResult {
  // UTF-8 size is between length and 3 x length; encode only when it could matter.
  if (json.length > maxBytes || (json.length * 3 > maxBytes && new TextEncoder().encode(json).length > maxBytes)) {
    return { skip: 'too-large' };
  }
  let doc: { scanSummary?: SessionScanSummary; measurements?: unknown[]; annotations?: unknown[]; views?: unknown[] };
  try {
    doc = JSON.parse(json);
  } catch {
    return { skip: 'unreadable' };
  }
  const key = fingerprintKey(doc.scanSummary);
  if (!key || !doc.scanSummary) return { skip: 'no-source' };
  const measurements = doc.measurements?.length ?? 0;
  const annotations = doc.annotations?.length ?? 0;
  const views = doc.views?.length ?? 0;
  if (measurements + annotations + views === 0) return { skip: 'no-work' };
  return {
    entry: { v: 1, key, savedAt: now, fileName: doc.scanSummary.fileName, summary: doc.scanSummary, measurements, annotations, views, json },
  };
}

/**
 * Whether a journal entry may be restored onto the source that is open now.
 * Both the key and the full scan match must agree; anything short of a strong
 * match is a refusal.
 */
export function entryMatchesSource(
  entry: RecoveryEntry,
  loaded: SessionScanSummary | undefined,
  match: (summary: SessionScanSummary, loaded: SessionScanSummary) => ScanMatch,
): boolean {
  const key = fingerprintKey(loaded);
  if (!loaded || key === null || key !== entry.key) return false;
  return match(entry.summary, loaded).verdict === 'strong';
}

/** A trailing-edge debounce with injectable timers. One pending one-shot timeout at most. */
export function createDebouncer(
  run: () => void,
  ms: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, t) => setTimeout(fn, t),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): { schedule(): void; flush(): void; cancel(): void; readonly pending: boolean } {
  let handle: unknown = null;
  const fire = (): void => {
    handle = null;
    run();
  };
  return {
    schedule() {
      if (handle !== null) timers.clear(handle);
      handle = timers.set(fire, ms);
    },
    flush() {
      if (handle === null) return;
      timers.clear(handle);
      fire();
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}

function isEntry(x: unknown): x is RecoveryEntry {
  const e = x as RecoveryEntry;
  return !!e && e.v === 1 && typeof e.key === 'string' && typeof e.json === 'string' && Number.isFinite(e.savedAt) && !!e.summary;
}

const newestFirst = (a: RecoveryEntry, b: RecoveryEntry): number => b.savedAt - a.savedAt;

/** The localStorage fallback: one JSON array under one key. */
export function createLocalStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key = 'olv:recovery:journal'): RecoveryStore {
  const read = (): RecoveryEntry[] => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEntry).sort(newestFirst) : [];
    } catch {
      return [];
    }
  };
  const write = (list: RecoveryEntry[]): void => {
    if (list.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(list));
  };
  return {
    backend: 'localstorage',
    async put(entry) {
      if (entry.json.length > LOCAL_STORAGE_MAX_BYTES) throw new Error('too-large-for-localstorage');
      const rest = read().filter((e) => e.key !== entry.key);
      // Keep only what fits: the newest entry first, then older ones while the total stays under the cap.
      const kept: RecoveryEntry[] = [entry];
      let total = entry.json.length;
      for (const e of rest) {
        if (kept.length >= MAX_ENTRIES || total + e.json.length > LOCAL_STORAGE_MAX_BYTES) break;
        kept.push(e);
        total += e.json.length;
      }
      write(kept);
    },
    async remove(k) {
      write(read().filter((e) => e.key !== k));
    },
    async clear() {
      storage.removeItem(key);
    },
    async list() {
      return read();
    },
  };
}

/** Whether an entry is past {@link MAX_ENTRY_AGE_MS}. A future timestamp counts as fresh. */
export const isStale = (e: RecoveryEntry, now: number, maxAge = MAX_ENTRY_AGE_MS): boolean => now - e.savedAt > maxAge;

/**
 * Delete every entry older than the age limit and return the rest, newest
 * first. Deletion failures are ignored here; stale entries are still never
 * returned, so they are never offered.
 */
export async function pruneStale(store: RecoveryStore, now: number, maxAge = MAX_ENTRY_AGE_MS): Promise<RecoveryEntry[]> {
  const all = await store.list();
  const fresh: RecoveryEntry[] = [];
  for (const e of all) {
    if (isStale(e, now, maxAge)) await store.remove(e.key).catch(() => {});
    else fresh.push(e);
  }
  return fresh;
}

const DB_NAME = 'olv-recovery';
const STORE = 'entries';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** The IndexedDB store. Rejects when IndexedDB is absent or refuses to open. */
export async function openIndexedDbStore(idb: IDBFactory): Promise<RecoveryStore> {
  const open = idb.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'key' });
  };
  const db = await req(open);
  const tx = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    req(f(db.transaction(STORE, mode).objectStore(STORE)));
  const list = async (): Promise<RecoveryEntry[]> =>
    ((await tx('readonly', (s) => s.getAll())) as unknown[]).filter(isEntry).sort(newestFirst);
  return {
    backend: 'indexeddb',
    async put(entry) {
      await tx('readwrite', (s) => s.put(entry));
      for (const old of (await list()).slice(MAX_ENTRIES)) await tx('readwrite', (s) => s.delete(old.key));
    },
    async remove(key) {
      await tx('readwrite', (s) => s.delete(key));
    },
    async clear() {
      await tx('readwrite', (s) => s.clear());
    },
    list,
  };
}

/**
 * Open the best available store: IndexedDB, else localStorage, else null.
 * Each candidate is probed with a read so a store that opens but cannot be
 * used (some private modes) falls through instead of failing later.
 */
export async function openRecoveryStore(env: {
  indexedDB?: IDBFactory | undefined;
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}): Promise<RecoveryStore | null> {
  if (env.indexedDB) {
    try {
      const store = await openIndexedDbStore(env.indexedDB);
      await store.list();
      return store;
    } catch {
      // Fall through to localStorage.
    }
  }
  if (env.localStorage) {
    try {
      const probe = 'olv:recovery:probe';
      env.localStorage.setItem(probe, '1');
      env.localStorage.removeItem(probe);
      return createLocalStore(env.localStorage);
    } catch {
      // No usable storage.
    }
  }
  return null;
}
