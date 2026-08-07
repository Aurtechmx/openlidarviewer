/**
 * tests/cancelledRequestSet.test.ts
 *
 * The bounded set of cancelled request ids each decode worker keeps.
 *
 * The behaviour under test is the eviction policy, because the previous one was
 * wrong in a way nothing caught: the set was CLEARED wholesale once it passed
 * its bound, so a burst of more than 256 cancels — a fast camera sweep over a
 * dense cloud — threw away every id, including the ones whose decodes had not
 * started. Those decodes then ran to completion and the client dropped their
 * results, spending WASM time on work already abandoned. Evicting the oldest
 * ids instead keeps the recent cancels, which are the only ones that can still
 * stop work from happening.
 */

import { describe, it, expect } from 'vitest';
import {
  CancelledRequestSet,
  DEFAULT_CANCELLED_CAPACITY,
} from '../src/io/workerPool/cancelledRequestSet';

describe('CancelledRequestSet', () => {
  it('remembers a cancelled id and consumes it exactly once', () => {
    const set = new CancelledRequestSet();
    set.add(7);
    expect(set.has(7)).toBe(true);
    expect(set.consume(7)).toBe(true);
    // Consumed — a second decode with the same id is not skipped by a stale entry.
    expect(set.consume(7)).toBe(false);
    expect(set.size).toBe(0);
  });

  it('reports false for an id it never saw', () => {
    const set = new CancelledRequestSet();
    expect(set.has(1)).toBe(false);
    expect(set.consume(1)).toBe(false);
  });

  it('evicts only the OLDEST ids on overflow, never the whole set', () => {
    const capacity = 4;
    const set = new CancelledRequestSet(capacity);
    for (let id = 0; id < 10; id++) set.add(id);
    expect(set.size).toBe(capacity);
    // The four most recent cancels survive...
    for (const id of [6, 7, 8, 9]) expect(set.has(id)).toBe(true);
    // ...and only the older ones were dropped.
    for (const id of [0, 1, 2, 3, 4, 5]) expect(set.has(id)).toBe(false);
  });

  it('a burst far past the bound still remembers the newest cancels', () => {
    // The regression case. Under the old clear-on-overflow rule the set could
    // be empty right after a burst, so the freshest cancel — the one whose
    // decode is next in the queue — was forgotten.
    const set = new CancelledRequestSet();
    const burst = DEFAULT_CANCELLED_CAPACITY * 4;
    for (let id = 0; id < burst; id++) set.add(id);
    expect(set.size).toBe(DEFAULT_CANCELLED_CAPACITY);
    expect(set.has(burst - 1)).toBe(true);
    expect(set.consume(burst - 1)).toBe(true);
  });

  it('re-cancelling an id refreshes it rather than leaving it next to evict', () => {
    const set = new CancelledRequestSet(3);
    set.add(1);
    set.add(2);
    set.add(1); // 1 is cancelled again — it is now the newest, not the oldest
    set.add(3);
    set.add(4); // evicts the oldest, which is 2
    expect(set.has(2)).toBe(false);
    expect(set.has(1)).toBe(true);
    expect(set.has(3)).toBe(true);
    expect(set.has(4)).toBe(true);
  });

  it('a capacity below 1 still holds one id rather than dropping everything', () => {
    const set = new CancelledRequestSet(0);
    set.add(5);
    expect(set.size).toBe(1);
    expect(set.consume(5)).toBe(true);
  });
});
