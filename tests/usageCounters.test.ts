/**
 * usageCounters.test.ts
 *
 * Verifies the privacy + LRU + suppression contract of the local-first
 * usage counter module. These tests run in Node via vitest; the localStorage
 * shim below mimics the browser surface so the module exercises its real
 * read/write paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── localStorage shim ────────────────────────────────────────────────────
//
// vitest-in-Node has no localStorage by default. The shim installs a
// minimal Map-backed implementation BEFORE the module loads so the
// counter module's `typeof localStorage === 'undefined'` guard does NOT
// trigger and the real storage path is exercised.

class LocalStorageShim {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void { this.store.delete(key); }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null; }
}

// Install BEFORE the module is imported. The counter module reads
// `typeof localStorage` at function call time, not module load time, so
// late-installing this is fine.
(globalThis as { localStorage?: Storage }).localStorage =
  new LocalStorageShim() as unknown as Storage;

// Provide a `window.location.search` for the suppression check.
(globalThis as { window?: { location: { search: string } } }).window = {
  location: { search: '' },
};

import {
  increment,
  snapshot,
  reset,
  isSuppressed,
  describeCounter,
  type UsageCounter,
} from '../src/diagnostics/usageCounters';

beforeEach(() => {
  reset();
});

describe('usageCounters — basic increment + snapshot', () => {
  it('records a new counter on first increment', () => {
    increment('scan-open', 'laz');
    const rows = snapshot();
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('scan-open:laz');
    expect(rows[0].count).toBe(1);
    expect(rows[0].category).toBe('scan-open');
    expect(rows[0].subcategory).toBe('laz');
  });

  it('increments an existing counter', () => {
    increment('measurement', 'distance');
    increment('measurement', 'distance');
    increment('measurement', 'distance');
    const rows = snapshot();
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(3);
  });

  it('tracks distinct subcategories separately', () => {
    increment('scan-open', 'laz');
    increment('scan-open', 'copc');
    increment('scan-open', 'ply');
    const rows = snapshot();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.subcategory).sort()).toEqual(['copc', 'laz', 'ply']);
  });

  it('snapshot returns most-recently-used first', () => {
    increment('scan-open', 'laz');
    // Force the timestamp to advance — Date.now() resolution can collide
    // on fast hardware; the deterministic test pins it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    increment('scan-open', 'copc');
    vi.setSystemTime(new Date('2026-06-01T12:00:01Z'));
    increment('scan-open', 'ply');
    vi.useRealTimers();

    const rows = snapshot();
    expect(rows[0].subcategory).toBe('ply');
    expect(rows[1].subcategory).toBe('copc');
    expect(rows[2].subcategory).toBe('laz');
  });

  it('snapshot is a stable copy — later increments do not mutate it', () => {
    increment('scan-open', 'laz');
    const before = snapshot();
    increment('scan-open', 'laz');
    expect(before[0].count).toBe(1);
    const after = snapshot();
    expect(after[0].count).toBe(2);
  });
});

describe('usageCounters — privacy contract', () => {
  it('sanitises a subcategory string by lowercasing + stripping unsafe chars', () => {
    // A caller that accidentally passes a filename gets normalised tokens
    // rather than a filesystem leak.
    increment('scan-open', 'My-Survey-File.LAS');
    const rows = snapshot();
    expect(rows.length).toBe(1);
    // 'my-survey-file.las' — lowercased, hyphens + dots kept, no path
    // separator possible because '/' is stripped.
    expect(rows[0].subcategory).toBe('my-survey-file.las');
  });

  it('caps subcategory length at 32 characters', () => {
    increment('scan-open', 'a'.repeat(64));
    const rows = snapshot();
    expect(rows.length).toBe(1);
    expect(rows[0].subcategory.length).toBe(32);
  });

  it('drops an empty subcategory rather than recording a blank row', () => {
    increment('scan-open', '');
    increment('scan-open', '!!!@@@###'); // sanitises to ''
    const rows = snapshot();
    expect(rows.length).toBe(0);
  });

  it('never writes anything outside the olv.usage.v1 storage key', () => {
    increment('scan-open', 'laz');
    increment('measurement', 'distance');
    increment('export', 'height-map');

    const store = (globalThis as { localStorage: Storage }).localStorage;
    // The shim's `key(i)` walks the underlying Map; this enumerates every
    // key the module has written.
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null) keys.push(k);
    }
    expect(keys).toEqual(['olv.usage.v1']);
  });
});

describe('usageCounters — LRU cap', () => {
  it('caps the row count at 200 even under unbounded subcategory pressure', () => {
    // Simulate a buggy caller wiring per-file subcategories.
    vi.useFakeTimers();
    for (let i = 0; i < 250; i++) {
      vi.setSystemTime(new Date(2026, 5, 1, 0, 0, i));
      increment('scan-open', `key-${i}`);
    }
    vi.useRealTimers();

    const rows = snapshot();
    expect(rows.length).toBe(200);
    // The oldest entries are dropped; key-0 is gone, key-249 is in.
    const subs = rows.map((r) => r.subcategory);
    expect(subs).toContain('key-249');
    expect(subs).not.toContain('key-0');
  });
});

describe('usageCounters — reset', () => {
  it('reset() wipes every row', () => {
    increment('scan-open', 'laz');
    increment('measurement', 'distance');
    expect(snapshot().length).toBe(2);
    reset();
    expect(snapshot().length).toBe(0);
  });

  it('reset() removes the storage key entirely', () => {
    increment('scan-open', 'laz');
    reset();
    const store = (globalThis as { localStorage: Storage }).localStorage;
    expect(store.getItem('olv.usage.v1')).toBeNull();
  });
});

describe('usageCounters — defensive loading', () => {
  it('treats malformed JSON in localStorage as empty', () => {
    const store = (globalThis as { localStorage: Storage }).localStorage;
    store.setItem('olv.usage.v1', '{not valid json');
    expect(snapshot()).toEqual([]);
  });

  it('treats non-array JSON in localStorage as empty', () => {
    const store = (globalThis as { localStorage: Storage }).localStorage;
    store.setItem('olv.usage.v1', '{"hello": "world"}');
    expect(snapshot()).toEqual([]);
  });

  it('filters out malformed rows without throwing', () => {
    const store = (globalThis as { localStorage: Storage }).localStorage;
    store.setItem(
      'olv.usage.v1',
      JSON.stringify([
        { key: 'scan-open:laz', category: 'scan-open', subcategory: 'laz', count: 5, firstSeen: 0, lastSeen: 0 },
        { not: 'valid' },
        null,
        'string',
      ]),
    );
    const rows = snapshot();
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(5);
  });
});

describe('usageCounters — describeCounter labels', () => {
  it('renders friendly strings for every category', () => {
    const cases: UsageCounter[] = [
      { key: 'scan-open:laz', category: 'scan-open', subcategory: 'laz', count: 1, firstSeen: 0, lastSeen: 0 },
      { key: 'measurement:distance', category: 'measurement', subcategory: 'distance', count: 1, firstSeen: 0, lastSeen: 0 },
      { key: 'export:height-map', category: 'export', subcategory: 'height-map', count: 1, firstSeen: 0, lastSeen: 0 },
      { key: 'report:engineering-inspection', category: 'report', subcategory: 'engineering-inspection', count: 1, firstSeen: 0, lastSeen: 0 },
      { key: 'error:load', category: 'error', subcategory: 'load', count: 1, firstSeen: 0, lastSeen: 0 },
    ];
    expect(cases.map(describeCounter)).toEqual([
      'Scan opened (laz)',
      'Measurement: distance',
      'Export: height-map',
      'Report: engineering-inspection',
      'Error (load)',
    ]);
  });
});

describe('usageCounters — isSuppressed', () => {
  it('is false when the URL has no telemetry flag', () => {
    // The module read window.location.search at load time. In this suite
    // the search string was empty, so suppression must be off.
    expect(isSuppressed()).toBe(false);
  });
});
