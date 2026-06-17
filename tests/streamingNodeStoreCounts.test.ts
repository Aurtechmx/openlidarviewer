/**
 * streamingNodeStoreCounts.test.ts
 *
 * Locks the O(1) `counts()` refactor: the maintained queued / loading / error
 * counters (and the resident set size) must equal a ground-truth walk through
 * every transition — including the decrement-on-leave path that a naive
 * increment-only counter would get wrong.
 */

import { describe, it, expect } from 'vitest';
import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';

function rec(id: string): StreamingNodeRecord {
  return {
    id,
    key: { depth: 0, x: 0, y: 0, z: 0 },
    bounds: [0, 0, 0, 1, 1, 1],
    pointCount: 100,
    byteOffset: 0,
    byteSize: 10,
    spacing: 1,
  };
}

/** Ground-truth walk — what the old O(n) implementation returned. */
function walk(store: StreamingNodeStore) {
  let queued = 0, loading = 0, resident = 0, error = 0;
  for (const n of store.all()) {
    if (n.state === 'queued') queued++;
    else if (n.state === 'loading') loading++;
    else if (n.state === 'resident') resident++;
    else if (n.state === 'error') error++;
  }
  return { known: store.size, queued, loading, resident, error };
}

describe('StreamingNodeStore.counts() — O(1) counters track a ground-truth walk', () => {
  it('matches the walk across a full lifecycle including leave-decrements', () => {
    const store = new StreamingNodeStore();
    const a = store.add(rec('a'));
    const b = store.add(rec('b'));
    const c = store.add(rec('c'));

    // queue all three
    store.setState(a, 'queued');
    store.setState(b, 'queued');
    store.setState(c, 'queued');
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts().queued).toBe(3);

    // a: queued -> loading (queued must decrement, loading increment)
    store.setState(a, 'loading');
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts()).toMatchObject({ queued: 2, loading: 1 });

    // a: loading -> resident (loading must decrement)
    store.setState(a, 'resident', 100);
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts()).toMatchObject({ queued: 2, loading: 0, resident: 1 });

    // b: queued -> loading -> error (error increments; loading back to 0)
    store.setState(b, 'loading');
    store.setState(b, 'error');
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts()).toMatchObject({ loading: 0, error: 1 });

    // error -> resident must decrement the error counter
    store.setState(b, 'resident', 50);
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts().error).toBe(0);
    expect(store.counts().resident).toBe(2);

    // resident -> unloaded drops out of every bucket
    store.setState(a, 'unloaded');
    expect(store.counts()).toEqual(walk(store));
    expect(store.counts().resident).toBe(1);

    expect(store.counts().known).toBe(3);
  });

  it('starts at all-zero for a fresh store', () => {
    const store = new StreamingNodeStore();
    expect(store.counts()).toEqual({ known: 0, queued: 0, loading: 0, resident: 0, error: 0 });
  });
});
