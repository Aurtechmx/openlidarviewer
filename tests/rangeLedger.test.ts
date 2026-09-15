import { createRangeLedger } from '../src/io/range/rangeLedger';

/**
 * The ledger separates what a load asked for from what of the file that
 * covers: overlapping, nested, adjacent and repeated spans all collapse into
 * the union, and the difference is the re-read.
 */

describe('createRangeLedger', () => {
  test('an empty ledger reports zeroes', () => {
    expect(createRangeLedger().totals()).toEqual({ requests: 0, requestedBytes: 0, uniqueBytes: 0 });
  });

  test('disjoint spans add up on both counters', () => {
    const l = createRangeLedger();
    l.record(0, 100);
    l.record(500, 40);
    expect(l.totals()).toEqual({ requests: 2, requestedBytes: 140, uniqueBytes: 140 });
  });

  test('overlapping spans count once in the union', () => {
    const l = createRangeLedger();
    l.record(0, 100);
    l.record(60, 100);
    const t = l.totals();
    expect(t.requestedBytes).toBe(200);
    expect(t.uniqueBytes).toBe(160);
    expect(t.requestedBytes - t.uniqueBytes).toBe(40);
  });

  test('a nested span adds no unique bytes', () => {
    const l = createRangeLedger();
    l.record(0, 1000);
    l.record(200, 300);
    expect(l.totals().uniqueBytes).toBe(1000);
    expect(l.totals().requestedBytes).toBe(1300);
  });

  test('adjacent spans merge into one run', () => {
    const l = createRangeLedger();
    l.record(0, 64);
    l.record(64, 64);
    expect(l.totals().uniqueBytes).toBe(128);
  });

  test('a duplicated span is all re-read', () => {
    const l = createRangeLedger();
    l.record(4096, 2048);
    l.record(4096, 2048);
    const t = l.totals();
    expect(t.uniqueBytes).toBe(2048);
    expect(t.requestedBytes - t.uniqueBytes).toBe(2048);
  });

  test('order of recording does not change the totals', () => {
    const forward = createRangeLedger();
    const backward = createRangeLedger();
    const spans: [number, number][] = [[900, 50], [0, 100], [80, 60], [400, 10]];
    for (const [o, n] of spans) forward.record(o, n);
    for (const [o, n] of [...spans].reverse()) backward.record(o, n);
    expect(backward.totals()).toEqual(forward.totals());
  });

  test('empty and invalid spans count as requests but add no bytes', () => {
    const l = createRangeLedger();
    l.record(10, 0);
    l.record(-5, 20);
    l.record(Number.NaN, 20);
    l.record(0, Number.POSITIVE_INFINITY);
    expect(l.totals()).toEqual({ requests: 4, requestedBytes: 0, uniqueBytes: 0 });
  });

  test('re-read is never negative for any recorded set', () => {
    const l = createRangeLedger();
    for (let i = 0; i < 200; i++) l.record((i * 37) % 1000, 25);
    const t = l.totals();
    expect(t.requestedBytes - t.uniqueBytes).toBeGreaterThanOrEqual(0);
    expect(t.uniqueBytes).toBeLessThanOrEqual(t.requestedBytes);
  });
});
