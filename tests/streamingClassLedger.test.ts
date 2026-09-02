/**
 * The streaming classification ledger's session contract.
 *
 * The legend used to fold EVERY node arrival into its running total, and the
 * streaming node lifecycle deliberately re-decodes a node the camera comes back
 * to, so the same source points were added again on every return trip and the
 * displayed totals grew with navigation history. These tests pin the statistic
 * that replaces it: classification counts over the UNIQUE decoded nodes seen in
 * the current streaming session. First encounter counts, eviction keeps the
 * historical count, reload counts nothing further, and a dataset change clears
 * both the ids and the tally because a node id is unique only within a source.
 */

import { describe, it, expect } from 'vitest';
import { createStreamingClassLedger } from '../src/app/streamingClassLedger';

/** A classification buffer holding exactly the requested per-code counts. */
function classes(counts: Record<number, number>): Uint8Array {
  const codes: number[] = [];
  for (const [code, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) codes.push(Number(code));
  }
  return new Uint8Array(codes);
}

/** The aggregate as a plain object, so expectations read as class → count. */
function asObject(m: Map<number, number>): Record<number, number> {
  return Object.fromEntries(m);
}

const NODE_A = classes({ 2: 20, 5: 80 });
const NODE_B = classes({ 2: 10, 6: 30 });
const NODE_C = classes({ 9: 5 });

/** A ledger that has already seen nodes A and B, the shared starting point. */
function ledgerWithAandB() {
  const ledger = createStreamingClassLedger();
  ledger.record('0-0-0-0', NODE_A);
  ledger.record('1-0-0-0', NODE_B);
  return ledger;
}

/** The tally after A and B, asserted the same way wherever it must not move. */
function expectAandBTally(ledger: ReturnType<typeof createStreamingClassLedger>): void {
  expect(asObject(ledger.aggregate())).toEqual({ 2: 30, 5: 80, 6: 30 });
  expect(ledger.size()).toBe(2);
}

describe('streaming class ledger — unique nodes only', () => {
  it('counts the first node it sees', () => {
    const ledger = createStreamingClassLedger();
    expect(ledger.record('0-0-0-0', NODE_A)).not.toBeNull();
    expect(asObject(ledger.aggregate())).toEqual({ 2: 20, 5: 80 });
    expect(ledger.size()).toBe(1);
  });

  it('folds a second, distinct node into the same tally', () => {
    const ledger = ledgerWithAandB();
    expect(asObject(ledger.aggregate())).toEqual({ 2: 30, 5: 80, 6: 30 });
    expect(ledger.size()).toBe(2);
  });

  it('keeps an evicted node in the tally (the ledger is never told about eviction)', () => {
    const ledger = ledgerWithAandB();
    // Eviction happens in the scheduler and has NO entry point here: the
    // statistic is "unique nodes seen", not "nodes currently resident", so the
    // historical count stands after the node leaves the GPU.
    expectAandBTally(ledger);
  });

  it('adds nothing when an evicted node is decoded again', () => {
    const ledger = ledgerWithAandB();
    expect(ledger.record('0-0-0-0', NODE_A)).toBeNull();
    expectAandBTally(ledger);
  });

  it('adds nothing however many times the same node comes back', () => {
    const ledger = createStreamingClassLedger();
    ledger.record('0-0-0-0', NODE_A);
    for (let i = 0; i < 25; i++) {
      expect(ledger.record('0-0-0-0', NODE_A)).toBeNull();
    }
    expect(asObject(ledger.aggregate())).toEqual({ 2: 20, 5: 80 });
    expect(ledger.size()).toBe(1);
  });

  it('adds only the new node when a fresh id arrives among reloads', () => {
    const ledger = ledgerWithAandB();
    ledger.record('0-0-0-0', NODE_A); // reload
    expect(asObject(ledger.record('2-1-1-1', NODE_C) ?? new Map())).toEqual({ 9: 5 });
    expect(asObject(ledger.aggregate())).toEqual({ 2: 30, 5: 80, 6: 30, 9: 5 });
    expect(ledger.size()).toBe(3);
  });

  it('returns the new node own histogram, not the running total', () => {
    const ledger = createStreamingClassLedger();
    ledger.record('0-0-0-0', NODE_A);
    expect(asObject(ledger.record('1-0-0-0', NODE_B) ?? new Map())).toEqual({ 2: 10, 6: 30 });
  });

  it('hands back a detached aggregate a caller cannot mutate into the ledger', () => {
    const ledger = createStreamingClassLedger();
    ledger.record('0-0-0-0', NODE_A);
    ledger.aggregate().set(2, 9999);
    expect(asObject(ledger.aggregate())).toEqual({ 2: 20, 5: 80 });
  });
});

describe('streaming class ledger — session reset', () => {
  it('clears the ids and the tally when the dataset changes', () => {
    const ledger = ledgerWithAandB();
    ledger.reset();
    expect(asObject(ledger.aggregate())).toEqual({});
    expect(ledger.size()).toBe(0);
  });

  it('lets dataset B count ids identical to dataset A after the reset', () => {
    const ledger = createStreamingClassLedger();
    ledger.record('0-0-0-0', NODE_A); // dataset A
    ledger.reset(); // dataset B opens
    // A node id is only unique WITHIN a source, so B's "0-0-0-0" is a different
    // node and must not be suppressed by A's.
    expect(ledger.record('0-0-0-0', NODE_C)).not.toBeNull();
    expect(asObject(ledger.aggregate())).toEqual({ 9: 5 });
    expect(ledger.size()).toBe(1);
  });

  it('is idempotent, so repeated resets are safe from every teardown path', () => {
    const ledger = createStreamingClassLedger();
    ledger.record('0-0-0-0', NODE_A);
    ledger.reset();
    ledger.reset();
    expect(ledger.size()).toBe(0);
    expect(asObject(ledger.aggregate())).toEqual({});
  });
});

describe('streaming class ledger — failed decodes', () => {
  it('does not mark a node seen when counting its population throws', () => {
    const ledger = createStreamingClassLedger();
    // A buffer that fails part-way through the count stands in for a decode
    // whose classification population was never validly processed.
    const broken = {
      *[Symbol.iterator](): Generator<number> {
        yield 2;
        throw new Error('decode failed');
      },
    } as unknown as Uint8Array;
    expect(() => ledger.record('0-0-0-0', broken)).toThrow('decode failed');
    expect(ledger.size()).toBe(0);
    expect(asObject(ledger.aggregate())).toEqual({});
  });

  it('counts a node exactly once when a later decode of it succeeds', () => {
    const ledger = createStreamingClassLedger();
    const broken = {
      *[Symbol.iterator](): Generator<number> {
        throw new Error('decode failed');
      },
    } as unknown as Uint8Array;
    expect(() => ledger.record('0-0-0-0', broken)).toThrow();
    expect(ledger.record('0-0-0-0', NODE_A)).not.toBeNull();
    expect(ledger.record('0-0-0-0', NODE_A)).toBeNull();
    expect(asObject(ledger.aggregate())).toEqual({ 2: 20, 5: 80 });
    expect(ledger.size()).toBe(1);
  });

  it('records an empty classification buffer as a seen node with no counts', () => {
    const ledger = createStreamingClassLedger();
    expect(ledger.record('0-0-0-0', new Uint8Array(0))).not.toBeNull();
    expect(asObject(ledger.aggregate())).toEqual({});
    expect(ledger.size()).toBe(1);
  });
});

describe('streaming class ledger — denominator invariant', () => {
  it('never totals more than the points of the unique nodes it counted', () => {
    const ledger = createStreamingClassLedger();
    const arrivals: Array<[string, Uint8Array]> = [
      ['0-0-0-0', NODE_A],
      ['1-0-0-0', NODE_B],
      ['0-0-0-0', NODE_A], // reload
      ['1-0-0-0', NODE_B], // reload
      ['2-1-1-1', NODE_C],
      ['0-0-0-0', NODE_A], // reload again
    ];
    let uniquePoints = 0;
    const counted = new Set<string>();
    for (const [id, buf] of arrivals) {
      if (!counted.has(id)) {
        counted.add(id);
        uniquePoints += buf.length;
      }
      ledger.record(id, buf);
    }
    const total = [...ledger.aggregate().values()].reduce((a, b) => a + b, 0);
    // The comparison is against the UNIQUE decoded population, never against
    // whatever happens to be resident right now.
    expect(total).toBeLessThanOrEqual(uniquePoints);
    expect(total).toBe(uniquePoints); // every counted node carried classification
    expect(ledger.size()).toBe(counted.size);
  });
});
