/**
 * recoveryControllerWrites.test.ts: when a recovery snapshot may reach the
 * journal, and when the restore offer goes away.
 *
 * A write serializes the session first, and serializing waits on two or three
 * lazy imports. The user can Clear, close the scan, open another one or turn
 * recovery off inside that wait. A snapshot taken before any of those no
 * longer describes work the user wants kept, so it must not be stored once it
 * resolves. Writes run one at a time, so a slow snapshot taken earlier cannot
 * land on top of a later one. Clears go out at once and never wait on a write.
 *
 * The store, the serializer and the restore are fakes driven by deferred
 * promises, so every interleaving here is chosen by the test rather than by a
 * timer. `drain` lets queued promise callbacks run and never waits on the
 * clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { RecoveryEntry, RecoveryStore } from '../src/app/recovery/recoveryJournal';

const fake = vi.hoisted(() => ({ store: null as unknown }));

vi.mock('../src/app/recovery/recoveryJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/recovery/recoveryJournal')>();
  return { ...actual, openRecoveryStore: async () => fake.store };
});

import { startRecovery, type RecoveryHandle } from '../src/app/recovery/recoveryController';
import { buildEntry, fingerprintKey } from '../src/app/recovery/recoveryJournal';
import { setRecoveryEnabled } from '../src/app/recovery/recoveryStatus';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Run every promise callback already queued, and those they queue in turn. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const SITE = { fileName: 'site.las', sourcePoints: 1000, width: 10, depth: 10, height: 2, epsg: 32614 };
const OTHER = { fileName: 'other.las', sourcePoints: 500, width: 4, depth: 4, height: 1, epsg: 32614 };
const SITE_KEY = fingerprintKey(SITE)!;

/** A Save session JSON over `summary` carrying `measurements` measurements. */
function session(measurements: number, summary = SITE): string {
  return JSON.stringify({
    scanSummary: summary,
    measurements: Array.from({ length: measurements }, (_, i) => ({ id: `m${i}` })),
  });
}

function entryFor(json: string): RecoveryEntry {
  const built = buildEntry(json, Date.now());
  if (!('entry' in built)) throw new Error('fixture has no work');
  return built.entry;
}

/**
 * A store that logs every call when it is made and can hold a put or a list
 * open until the test releases it. Like IndexedDB, it applies the changes in
 * the order the calls were made, so a held put also holds every change after it.
 */
function fakeStore(initial: RecoveryEntry[] = []) {
  const entries = new Map(initial.map((e) => [e.key, e]));
  const log: string[] = [];
  let heldPut: Deferred<void> | null = null;
  let heldList: Deferred<void> | null = null;
  let tail: Promise<void> = Promise.resolve();
  const inOrder = (apply: () => Promise<void> | void): Promise<void> => (tail = tail.then(apply));
  const store: RecoveryStore = {
    backend: 'indexeddb',
    put(e) {
      log.push(`put ${e.fileName} ${e.measurements}`);
      const held = heldPut;
      return inOrder(async () => {
        if (held) await held.promise;
        entries.set(e.key, e);
      });
    },
    remove(key) {
      log.push(`remove ${key.split('|')[0]}`);
      return inOrder(() => { entries.delete(key); });
    },
    clear() {
      log.push('clear');
      return inOrder(() => { entries.clear(); });
    },
    async list() {
      const read = [...entries.values()];
      if (heldList) await heldList.promise;
      return read;
    },
  };
  return {
    store,
    entries,
    log,
    holdPuts(): Deferred<void> {
      heldPut = deferred<void>();
      return heldPut;
    },
    holdLists(): Deferred<void> {
      heldList = deferred<void>();
      return heldList;
    },
  };
}

/** The smallest element the notice builder needs, keeping its text and buttons readable. */
class FakeElement {
  className = '';
  title = '';
  type = '';
  textContent = '';
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly clicks: Array<() => void> = [];
  removed = false;
  setAttribute(): void {}
  append(...els: FakeElement[]): void { this.children.push(...els); }
  addEventListener(_type: string, fn: () => void): void { this.clicks.push(fn); }
  remove(): void { this.removed = true; }
}

type Listener = () => void;
let windowListeners: Map<string, Listener[]>;
let documentListeners: Map<string, Listener[]>;
let visibility: 'visible' | 'hidden';
let storage: Map<string, string>;

beforeEach(() => {
  windowListeners = new Map();
  documentListeners = new Map();
  visibility = 'visible';
  storage = new Map();
  const add = (into: Map<string, Listener[]>) => (type: string, fn: Listener) => {
    into.set(type, [...(into.get(type) ?? []), fn]);
  };
  vi.stubGlobal('window', { addEventListener: add(windowListeners) });
  vi.stubGlobal('document', {
    addEventListener: add(documentListeners),
    get visibilityState() { return visibility; },
    createElement: () => new FakeElement(),
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Start the controller over `store` with a serializer and a restore the test drives. */
async function start(store: RecoveryStore | Promise<RecoveryStore>) {
  fake.store = store;
  const lifetime = new AbortController();
  const host = new FakeElement();
  const snapshots: Array<Deferred<string | null>> = [];
  const restores: Array<Deferred<boolean>> = [];
  let loading = false;
  const handle: RecoveryHandle = startRecovery({
    lifetime: { signal: lifetime.signal, register: () => () => {} } as never,
    serialize: () => {
      const d = deferred<string | null>();
      snapshots.push(d);
      return d.promise;
    },
    restore: () => {
      const d = deferred<boolean>();
      restores.push(d);
      return d.promise;
    },
    isLoading: () => loading,
    host: host as unknown as HTMLElement,
  });
  await drain(); // the store opens and any saved entry is offered
  const notice = (): FakeElement | null => host.children.filter((el) => !el.removed).at(-1) ?? null;
  return {
    handle,
    snapshots,
    restores,
    lifetime,
    setLoading: (v: boolean) => { loading = v; },
    /** An interaction followed by the tab going to the background: the write starts now. */
    async editAndHide(): Promise<void> {
      for (const fn of windowListeners.get('pointerup') ?? []) fn();
      visibility = 'hidden';
      for (const fn of documentListeners.get('visibilitychange') ?? []) fn();
      visibility = 'visible';
      await drain();
    },
    noticeText: (): string => notice()?.children[0]?.textContent ?? '',
    buttons: (): string[] => notice()?.children[1]?.children.map((b) => b.textContent) ?? [],
    async click(label: string): Promise<void> {
      const button = notice()?.children[1]?.children.find((b) => b.textContent === label);
      if (!button) throw new Error(`no "${label}" button on the notice`);
      for (const fn of button.clicks) fn();
      await drain();
    },
  };
}

describe('a recovery snapshot that went out of date while it was being taken is never stored', () => {
  it('Clear (closing the scan) while the session serializes', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();
    expect(app.snapshots).toHaveLength(1);

    app.handle.clear();
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);
  });

  it('another source finishing its load while the session serializes', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();

    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual([]);
  });

  it('a load that is still running when the snapshot resolves', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();

    app.setLoading(true);
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual([]);
  });

  it('Turn off recovery while the session serializes', async () => {
    // An entry for another file puts the boot notice, and its Turn off button, on screen.
    const s = fakeStore([entryFor(session(2, OTHER))]);
    const app = await start(s.store);
    expect(app.buttons()).toContain('Turn off recovery');
    await app.editAndHide();

    await app.click('Turn off recovery');
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);
  });

  it('recovery turned off from the Help action while the session serializes', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();

    setRecoveryEnabled(false);
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual([]);
  });

  it('the app shutting down while the session serializes', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();

    app.lifetime.abort();
    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual([]);
  });

  it('stores a snapshot nothing invalidated', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();

    app.snapshots[0].resolve(session(1));
    await drain();

    expect(s.log).toEqual(['put site.las 1']);
  });
});

describe('clears go out at once, and writes run in the order they were asked for', () => {
  it('Clear deletes the journal while a snapshot is still being taken', async () => {
    const s = fakeStore([entryFor(session(2, OTHER))]);
    const app = await start(s.store);
    await app.editAndHide();
    expect(app.snapshots).toHaveLength(1);

    app.handle.clear();
    await drain();
    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);

    app.snapshots[0].resolve(session(1));
    await drain();
    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);
  });

  it('Turn off deletes the journal while a snapshot is still being taken', async () => {
    const s = fakeStore([entryFor(session(2, OTHER))]);
    const app = await start(s.store);
    await app.editAndHide();

    await app.click('Turn off recovery');
    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);
  });

  it('a Clear asked for while a put is in flight goes out at once and is applied after that put', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    const put = s.holdPuts();
    await app.editAndHide();
    app.snapshots[0].resolve(session(1));
    await drain();
    expect(s.log).toEqual(['put site.las 1']);

    app.handle.clear();
    await drain();
    expect(s.log).toEqual(['put site.las 1', 'clear']);

    put.resolve();
    await drain();
    expect(s.entries.size).toBe(0);
  });

  it('a second write waits for the first, so the later snapshot is the one kept', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    await app.editAndHide();
    await app.editAndHide();
    // The second snapshot waits until the first one is stored.
    expect(app.snapshots).toHaveLength(1);

    app.snapshots[0].resolve(session(1));
    await drain();
    expect(app.snapshots).toHaveLength(2);
    app.snapshots[1].resolve(session(2));
    await drain();

    expect(s.log).toEqual(['put site.las 1', 'put site.las 2']);
    expect(s.entries.get(SITE_KEY)?.measurements).toBe(2);
  });
});

describe('the restore offer stays until the saved work is back on screen', () => {
  /** Boot with saved work for site.las, reopen site.las, and reach the Restore offer. */
  async function offered() {
    const saved = entryFor(session(2));
    const s = fakeStore([saved]);
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0));
    await drain();
    expect(app.buttons()).toContain('Restore previous work');
    return { s, app, saved };
  }

  it('a restore that rejects puts the offer back and keeps the saved entry', async () => {
    const { s, app, saved } = await offered();

    await app.click('Restore previous work');
    app.restores[0].reject(new Error('session chunk failed to load'));
    await drain();

    expect(app.noticeText()).toContain('This file matches your unsaved work');
    expect(app.buttons()).toContain('Restore previous work');
    // The reopened scan still holds no work. That write would delete the entry
    // of an open source; the pending offer protects it.
    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(0));
    await drain();
    expect(s.log).toEqual([]);
    expect(s.entries.get(SITE_KEY)).toBe(saved);
  });

  it('a restore the import refused, which resolves with nothing applied, puts the offer back', async () => {
    const { s, app } = await offered();

    await app.click('Restore previous work');
    app.restores[0].resolve(false);
    await drain();

    expect(app.buttons()).toContain('Restore previous work');
    expect(s.entries.has(SITE_KEY)).toBe(true);
  });

  it('keeps writes off the saved entry while the restore runs', async () => {
    const { s, app } = await offered();

    await app.click('Restore previous work');
    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(0));
    await drain();

    expect(s.log).toEqual([]);
  });

  it('a restore that brings the work back releases the entry to later writes', async () => {
    const { s, app } = await offered();

    await app.click('Restore previous work');
    app.restores[0].resolve(true);
    await drain();
    expect(app.buttons()).toEqual([]);

    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(3));
    await drain();
    expect(s.log).toEqual(['put site.las 3']);
  });

  it('a refused restore keeps the entry when the file already holds work of its own', async () => {
    const { s, app, saved } = await offered();

    await app.click('Restore previous work');
    app.restores[0].resolve(false);
    await drain();
    // The user measured once before clicking Restore. That session has work and
    // the same source key, which is not the saved work coming back.
    app.snapshots.at(-1)!.resolve(session(1));
    await drain();
    expect(app.buttons()).toContain('Restore previous work');

    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(1));
    await drain();
    expect(s.log).toEqual([]);
    expect(s.entries.get(SITE_KEY)).toBe(saved);
  });

  it('a file that finishes opening during a restore does not offer it again', async () => {
    const { app } = await offered();

    await app.click('Restore previous work');
    app.handle.onSourceLoaded();
    app.snapshots.at(-1)!.resolve(session(0));
    await drain();
    expect(app.buttons()).toEqual([]);

    app.restores[0].resolve(true);
    await drain();
    expect(app.buttons()).toEqual([]);
    expect(app.restores).toHaveLength(1);
  });

  it('never overwrites an entry that is waiting to be restored', async () => {
    const { s, app, saved } = await offered();

    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(5));
    await drain();

    expect(s.log).toEqual([]);
    expect(s.entries.get(SITE_KEY)).toBe(saved);
  });
});

describe('a clear asked for before the journal is ready', () => {
  it('is applied when the store opens, and nothing is offered', async () => {
    const s = fakeStore([entryFor(session(2))]);
    const opening = deferred<RecoveryStore>();
    const app = await start(opening.promise);

    app.handle.clear();
    opening.resolve(s.store);
    await drain();

    expect(app.buttons()).toEqual([]);
    expect(s.log).toEqual(['clear']);
    expect(s.entries.size).toBe(0);
  });

  it('during the startup read keeps the entry it read from being offered', async () => {
    const s = fakeStore([entryFor(session(2))]);
    const list = s.holdLists();
    const app = await start(s.store);

    app.handle.clear();
    list.resolve();
    await drain();

    expect(app.buttons()).toEqual([]);
    expect(s.entries.size).toBe(0);
  });

  it('the Clear button confirms the deletion', async () => {
    const s = fakeStore([entryFor(session(2))]);
    const app = await start(s.store);

    await app.click('Clear all saved work');

    expect(s.entries.size).toBe(0);
    expect(app.noticeText()).toBe('Recovery data in this browser was deleted.');
  });
});

describe('reopening a source offers the newest saved work for that source', () => {
  const OTHER_KEY = fingerprintKey(OTHER)!;
  const at = (json: string, savedAt: number): RecoveryEntry => {
    const built = buildEntry(json, savedAt);
    if (!('entry' in built)) throw new Error('fixture has no work');
    return built.entry;
  };

  it('save A then B, reopen A: offers A and keeps B', async () => {
    const a = at(session(2), Date.now() - 2000);
    const b = at(session(4, OTHER), Date.now() - 1000);
    const s = fakeStore([b, a]);
    const app = await start(s.store);
    expect(app.noticeText()).toContain('other.las');

    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0));
    await drain();
    expect(app.noticeText()).toContain('This file matches your unsaved work: 2 measurements on site.las');

    await app.click('Restore previous work');
    app.restores[0].resolve(true);
    await drain();
    expect(s.entries.get(OTHER_KEY)).toBe(b);
  });

  it('a source with no saved work says the file differs', async () => {
    const s = fakeStore([at(session(4, OTHER), Date.now())]);
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0));
    await drain();
    expect(app.noticeText()).toContain('The open file differs from other.las');
    expect(app.buttons()).not.toContain('Restore previous work');
  });

  it('an entry that expired after boot is not offered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000_000_000);
      const a = at(session(2), Date.now());
      const s = fakeStore([a]);
      const app = await start(s.store);
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      app.handle.onSourceLoaded();
      app.snapshots[0].resolve(session(0));
      await drain();
      expect(app.buttons()).not.toContain('Restore previous work');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a source that loads before the journal is ready is matched once it opens', async () => {
    const a = at(session(2), Date.now() - 2000);
    const s = fakeStore([at(session(4, OTHER), Date.now()), a]);
    const opening = deferred<RecoveryStore>();
    const app = await start(opening.promise);
    app.handle.onSourceLoaded();
    opening.resolve(s.store);
    await drain();
    app.snapshots.at(-1)!.resolve(session(0));
    await drain();
    expect(app.noticeText()).toContain('2 measurements on site.las');
    expect(app.buttons()).toContain('Restore previous work');
  });

  it('opening B while A is still being matched shows the match for B', async () => {
    const a = at(session(2), Date.now() - 2000);
    const b = at(session(4, OTHER), Date.now() - 1000);
    const s = fakeStore([b, a]);
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.handle.onSourceLoaded();
    app.snapshots[1].resolve(session(0, OTHER));
    await drain();
    app.snapshots[0].resolve(session(0));
    await drain();
    expect(app.noticeText()).toContain('This file matches your unsaved work: 4 measurements on other.las');
  });

  it('a failed restore keeps the entry and Discard removes that entry and keeps B', async () => {
    const a = at(session(2), Date.now() - 2000);
    const b = at(session(4, OTHER), Date.now() - 1000);
    const s = fakeStore([b, a]);
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0));
    await drain();
    await app.click('Restore previous work');
    app.restores[0].resolve(false);
    await drain();
    expect(s.entries.get(SITE_KEY)).toBe(a);
    await app.click('Discard this work');
    expect(s.log).toEqual(['remove site.las']);
    expect(s.entries.get(OTHER_KEY)).toBe(b);
  });

  it('writes on A never replace or delete the saved entry for A while B is the newest', async () => {
    const a = at(session(2), Date.now() - 2000);
    const s = fakeStore([at(session(4, OTHER), Date.now()), a]);
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0));
    await drain();
    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(0));
    await drain();
    expect(s.log).toEqual([]);
    expect(s.entries.get(SITE_KEY)).toBe(a);
  });
});

describe('a write for another source never evicts saved work', () => {
  it('passes every entry waiting to be restored to the store, and a full journal skips the write', async () => {
    const keys: RecoveryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      keys.push(entryFor(session(1, { ...SITE, fileName: `s${i}.las` })));
    }
    const s = fakeStore(keys);
    let passed: readonly string[] = [];
    s.store.put = ((orig) => (e: RecoveryEntry, keep?: readonly string[]) => {
      passed = keep ?? [];
      if ((keep ?? []).length >= 5) { s.log.push('skipped'); return Promise.reject(new Error('held-full')); }
      return orig(e, keep);
    })(s.store.put.bind(s.store));
    const app = await start(s.store);
    app.handle.onSourceLoaded();
    app.snapshots[0].resolve(session(0, OTHER));
    await drain();
    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(3, OTHER));
    await drain();
    expect([...passed].sort()).toEqual(keys.map((e) => e.key).sort());
    expect(s.log).toContain('skipped');
    expect(s.entries.size).toBe(5);
    // A full journal is not a storage failure: later writes still go out.
    await app.editAndHide();
    expect(app.snapshots.length).toBeGreaterThan(2);
  });
});
