import { describe, expect, it, vi } from 'vitest';
import {
  buildEntry,
  createDebouncer,
  createLocalStore,
  entryMatchesSource,
  fingerprintKey,
  LOCAL_STORAGE_MAX_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_AGE_MS,
  isStale,
  pruneStale,
  openRecoveryStore,
  type RecoveryEntry,
} from '../src/app/recovery/recoveryJournal';
import { matchSessionToScan, serializeSession, type SessionScanSummary } from '../src/io/session';
import { RECOVERY_OFF_KEY, recoveryEnabled, recoveryStatus, setRecoveryEnabled, setRecoveryStatus } from '../src/app/recovery/recoveryStatus';

const summary: SessionScanSummary = { fileName: 'tiny.ply', sourcePoints: 10, width: 2, depth: 3, height: 1 };

function session(over: { scanSummary?: SessionScanSummary; measurements?: number } = {}): string {
  const n = over.measurements ?? 1;
  return serializeSession({
    upAxis: 'y',
    origin: [0, 0, 0],
    unitSystem: 'metric',
    views: [],
    measurements: Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      kind: 'distance',
      points: [[0, 0, 0], [1, 0, 0]],
    })) as never,
    annotations: [],
    scanSummary: 'scanSummary' in over ? over.scanSummary : summary,
  });
}

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

function entry(key: string, savedAt: number, json = '{}'): RecoveryEntry {
  return { v: 1, key, savedAt, fileName: key, summary, measurements: 1, annotations: 0, views: 0, json };
}

describe('fingerprintKey', () => {
  it('is stable for the same source and ignores file-name case', () => {
    expect(fingerprintKey(summary)).toBe(fingerprintKey({ ...summary, fileName: 'TINY.PLY' }));
  });
  it('changes with point count, extents or EPSG', () => {
    const k = fingerprintKey(summary);
    expect(fingerprintKey({ ...summary, sourcePoints: 11 })).not.toBe(k);
    expect(fingerprintKey({ ...summary, width: 2.001 })).not.toBe(k);
    expect(fingerprintKey({ ...summary, epsg: 32611 })).not.toBe(k);
  });
  it('refuses a summary with no name or no finite extents', () => {
    expect(fingerprintKey(undefined)).toBeNull();
    expect(fingerprintKey({ ...summary, fileName: '' })).toBeNull();
    expect(fingerprintKey({ ...summary, height: Number.NaN })).toBeNull();
  });
});

describe('entryMatchesSource', () => {
  const built = buildEntry(session(), 1000);
  if (!('entry' in built)) throw new Error('expected an entry');
  const e = built.entry;
  it('matches the same source', () => {
    expect(entryMatchesSource(e, { ...summary }, matchSessionToScan)).toBe(true);
  });
  it('refuses a different file', () => {
    expect(entryMatchesSource(e, { fileName: 'other.ply', sourcePoints: 900, width: 10, depth: 10, height: 3 }, matchSessionToScan)).toBe(false);
  });
  it('refuses the same name with different content', () => {
    expect(entryMatchesSource(e, { ...summary, width: 2.5 }, matchSessionToScan)).toBe(false);
    expect(entryMatchesSource(e, { ...summary, sourcePoints: 12 }, matchSessionToScan)).toBe(false);
  });
  it('refuses when nothing is loaded', () => {
    expect(entryMatchesSource(e, undefined, matchSessionToScan)).toBe(false);
  });
  it('refuses when the key agrees but the scan match is not strong', () => {
    const partial = () => ({ verdict: 'partial' as const, reasons: [] });
    expect(entryMatchesSource(e, { ...summary }, partial)).toBe(false);
  });
});

describe('buildEntry', () => {
  it('keeps the Save session JSON verbatim with counts and the key', () => {
    const json = session({ measurements: 2 });
    const r = buildEntry(json, 42);
    expect('entry' in r && r.entry).toMatchObject({ json, savedAt: 42, measurements: 2, fileName: 'tiny.ply', key: fingerprintKey(summary) });
  });
  it('skips a session over the size cap', () => {
    expect(buildEntry(session(), 0, 100)).toEqual({ skip: 'too-large' });
  });
  it('counts UTF-8 bytes, not characters, against the cap', () => {
    const json = session();
    const padded = json.replace('"tiny.ply"', `"${'é'.repeat(200)}"`);
    expect(buildEntry(padded, 0, padded.length + 50)).toEqual({ skip: 'too-large' });
  });
  it('skips a session with no source or no work', () => {
    expect(buildEntry(session({ scanSummary: undefined }), 0)).toEqual({ skip: 'no-source' });
    expect(buildEntry(session({ measurements: 0 }), 0)).toEqual({ skip: 'no-work' });
    expect(buildEntry('not json', 0)).toEqual({ skip: 'unreadable' });
  });
});

describe('createDebouncer', () => {
  it('runs once, after the quiet period following the last schedule', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = createDebouncer(run, 3000);
    d.schedule();
    vi.advanceTimersByTime(2000);
    d.schedule();
    vi.advanceTimersByTime(2999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('flush runs a pending write now and does nothing when idle', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = createDebouncer(run, 3000);
    d.flush();
    expect(run).not.toHaveBeenCalled();
    d.schedule();
    d.flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
    vi.useRealTimers();
  });
});

describe('local storage fallback', () => {
  it('stores newest first, replaces by key and prunes to the entry cap', async () => {
    const store = createLocalStore(new MemStorage());
    for (let i = 0; i < MAX_ENTRIES + 2; i++) await store.put(entry(`k${i}`, i));
    await store.put(entry('k6', 100));
    const list = await store.list();
    expect(list.map((e) => e.key)).toEqual(['k6', 'k5', 'k4', 'k3', 'k2']);
    await store.remove('k6');
    expect((await store.list())[0].key).toBe('k5');
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
  it('refuses an entry larger than the localStorage cap', async () => {
    const store = createLocalStore(new MemStorage());
    await expect(store.put(entry('big', 1, 'x'.repeat(LOCAL_STORAGE_MAX_BYTES + 1)))).rejects.toThrow();
  });
  it('reads a corrupt value as empty', async () => {
    const s = new MemStorage();
    s.setItem('olv:recovery:journal', '{broken');
    expect(await createLocalStore(s).list()).toEqual([]);
  });
});

describe('openRecoveryStore', () => {
  it('falls back to localStorage when IndexedDB throws', async () => {
    const idb = { open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory;
    const store = await openRecoveryStore({ indexedDB: idb, localStorage: new MemStorage() });
    expect(store?.backend).toBe('localstorage');
  });
  it('returns null when no storage works, without throwing', async () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
    expect(await openRecoveryStore({ indexedDB: undefined, localStorage: broken })).toBeNull();
    expect(await openRecoveryStore({})).toBeNull();
  });
});

describe('recovery preference and status', () => {
  it('defaults on, can be turned off, and reports it', () => {
    const s = new MemStorage();
    vi.stubGlobal('localStorage', s);
    expect(recoveryEnabled()).toBe(true);
    setRecoveryStatus('on:indexeddb');
    expect(recoveryStatus()).toBe('on:indexeddb');
    setRecoveryEnabled(false);
    expect(s.getItem(RECOVERY_OFF_KEY)).toBe('1');
    expect(recoveryStatus()).toBe('off:user');
    setRecoveryEnabled(true);
    expect(recoveryEnabled()).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('age limit', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('is seven days', () => {
    expect(MAX_ENTRY_AGE_MS).toBe(7 * DAY);
  });

  it('deletes entries older than seven days and returns only fresh ones (fake clock)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const store = createLocalStore(new MemStorage());
      const t0 = Date.now();
      await store.put(entry('old', t0));
      vi.setSystemTime(t0 + 6 * DAY);
      await store.put(entry('recent', Date.now()));
      vi.setSystemTime(t0 + 7 * DAY);
      // Exactly at the limit is still kept.
      expect((await pruneStale(store, Date.now())).map((e) => e.key)).toEqual(['recent', 'old']);
      vi.setSystemTime(t0 + 7 * DAY + 1);
      expect((await pruneStale(store, Date.now())).map((e) => e.key)).toEqual(['recent']);
      expect((await store.list()).map((e) => e.key)).toEqual(['recent']);
      vi.setSystemTime(t0 + 14 * DAY);
      expect(await pruneStale(store, Date.now())).toEqual([]);
      expect(await store.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never returns a stale entry even when deletion fails', async () => {
    const now = 100 * DAY;
    const stale = entry('stale', now - 8 * DAY);
    const fresh = entry('fresh', now - DAY);
    const store = {
      backend: 'localstorage' as const,
      put: async () => {},
      clear: async () => {},
      list: async () => [fresh, stale],
      remove: async () => { throw new Error('nope'); },
    };
    expect(await pruneStale(store, now)).toEqual([fresh]);
    expect(isStale(stale, now)).toBe(true);
    expect(isStale(entry('future', now + DAY), now)).toBe(false);
  });
});
