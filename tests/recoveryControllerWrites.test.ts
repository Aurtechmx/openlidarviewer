/**
 * recoveryControllerWrites.test.ts: when a recovery snapshot may reach the
 * journal, and when the restore offer goes away.
 *
 * A write serializes the session first, and serializing waits on two or three
 * lazy imports. The user can Clear, close the scan, open another one or turn
 * recovery off inside that wait. A snapshot taken before any of those no
 * longer describes work the user wants kept, so it must not be stored once it
 * resolves. Writes and clears also run one at a time, so a slow snapshot taken
 * earlier cannot land on top of a later one or after a clear.
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

/** A store that logs every call and can hold a put open until the test releases it. */
function fakeStore(initial: RecoveryEntry[] = []) {
  const entries = new Map(initial.map((e) => [e.key, e]));
  const log: string[] = [];
  let heldPut: Deferred<void> | null = null;
  const store: RecoveryStore = {
    backend: 'indexeddb',
    async put(e) {
      log.push(`put ${e.fileName} ${e.measurements}`);
      if (heldPut) await heldPut.promise;
      entries.set(e.key, e);
    },
    async remove(key) {
      log.push(`remove ${key.split('|')[0]}`);
      entries.delete(key);
    },
    async clear() {
      log.push('clear');
      entries.clear();
    },
    async list() {
      return [...entries.values()];
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
async function start(store: RecoveryStore) {
  fake.store = store;
  const lifetime = new AbortController();
  const host = new FakeElement();
  const snapshots: Array<Deferred<string | null>> = [];
  const restores: Array<Deferred<void>> = [];
  let loading = false;
  const handle: RecoveryHandle = startRecovery({
    lifetime: { signal: lifetime.signal, register: () => () => {} } as never,
    serialize: () => {
      const d = deferred<string | null>();
      snapshots.push(d);
      return d.promise;
    },
    restore: () => {
      const d = deferred<void>();
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

describe('recovery writes and clears run in the order they were asked for', () => {
  it('a Clear asked for while a put is in flight runs after that put', async () => {
    const s = fakeStore();
    const app = await start(s.store);
    const put = s.holdPuts();
    await app.editAndHide();
    app.snapshots[0].resolve(session(1));
    await drain();
    expect(s.log).toEqual(['put site.las 1']);

    app.handle.clear();
    await drain();
    expect(s.log).toEqual(['put site.las 1']);

    put.resolve();
    await drain();
    expect(s.log).toEqual(['put site.las 1', 'clear']);
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
    app.restores[0].resolve();
    await drain();
    app.snapshots.at(-1)!.resolve(session(0));
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
    app.restores[0].resolve();
    await drain();
    app.snapshots.at(-1)!.resolve(session(2));
    await drain();
    expect(app.buttons()).toEqual([]);

    await app.editAndHide();
    app.snapshots.at(-1)!.resolve(session(3));
    await drain();
    expect(s.log).toEqual(['put site.las 3']);
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
