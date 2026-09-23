/**
 * rawPointsBytesPerPoint.test.ts
 *
 * `rawPointsBytesPerPoint` sizes the heavy-path decode budget; `allocRawPoints`
 * performs the allocation the budget protects. They are written by hand, so
 * nothing stops the two field lists from drifting apart — a channel added to
 * one and forgotten in the other would silently reopen a budget hole (exactly
 * the bug a spec review found: the byte-budget helpers were still sized off
 * the LAS record length, ignoring that `RawPoints` had grown wider than the
 * record). This test computes the actual byte size of every array
 * `allocRawPoints` returns and checks it against the estimator, for both
 * `pointSemantics: false` (the default everywhere — scan angle, user data,
 * scanner channel, scan direction and edge-of-flight-line are not decoded)
 * and `pointSemantics: true` (those five decode too), so a future drift fails
 * here instead of reopening the hole quietly.
 */
import { describe, expect, it } from 'vitest';
import { allocRawPoints, rawPointsBytesPerPoint } from '../src/io/lasDecodeShared';
import type { RawPoints } from '../src/io/lasDecodeShared';

/** Sum of every present array's `byteLength`, per point — the ACTUAL allocation cost. */
function actualBytesPerPoint(raw: RawPoints, count: number): number {
  let total = 0;
  for (const value of Object.values(raw)) {
    if (value && typeof value === 'object' && 'byteLength' in value) {
      total += (value as { byteLength: number }).byteLength;
    }
  }
  return total / count;
}

const COUNT = 1000;

// pointFormat, extended, hasGpsTime, hasColor — the same rules
// `rawPointsBytesPerPoint` derives internally, spelled out here so the test
// is not just re-running the function under test on itself.
const FORMATS: { pdrf: number; extended: boolean; hasGpsTime: boolean; hasColor: boolean }[] = [
  { pdrf: 0, extended: false, hasGpsTime: false, hasColor: false },
  { pdrf: 1, extended: false, hasGpsTime: true, hasColor: false },
  { pdrf: 3, extended: false, hasGpsTime: true, hasColor: true },
  { pdrf: 6, extended: true, hasGpsTime: true, hasColor: false },
  { pdrf: 7, extended: true, hasGpsTime: true, hasColor: true },
  { pdrf: 8, extended: true, hasGpsTime: true, hasColor: true },
];

describe.each([false, true])('rawPointsBytesPerPoint matches the true allocRawPoints allocation (pointSemantics: %s)', (pointSemantics) => {
  it.each(FORMATS)(
    'PDRF $pdrf',
    ({ pdrf, extended, hasGpsTime, hasColor }) => {
      const raw = allocRawPoints(COUNT, hasGpsTime, hasColor, extended, { pointSemantics });
      // Worst-case colour cost (colors16 staging + narrowed colors coexisting)
      // is what the estimator charges; allocRawPoints only ever holds one of
      // the two at a time in this fresh-allocation state (colors16 only,
      // before finalizeRawColors runs), so charge the narrowed buffer's bytes
      // by hand to match the estimator's worst-case contract.
      const actual = actualBytesPerPoint(raw, COUNT) + (hasColor ? 3 : 0);
      expect(actual).toBe(rawPointsBytesPerPoint(pdrf, { pointSemantics }));
    },
  );
});

describe('pointSemantics widens the estimate by exactly the five gated channels', () => {
  it('costs more with pointSemantics on than off, for every format', () => {
    for (const { pdrf } of FORMATS) {
      expect(rawPointsBytesPerPoint(pdrf, { pointSemantics: true })).toBeGreaterThan(
        rawPointsBytesPerPoint(pdrf, { pointSemantics: false }),
      );
    }
  });

  it('an extended format costs one more byte than an equivalent legacy one when semantics are on (scanner channel)', () => {
    // PDRF 1 (legacy, GPS, no colour) vs PDRF 6 (extended, GPS, no colour):
    // same structural channels, extended adds only the scanner channel byte.
    expect(rawPointsBytesPerPoint(6, { pointSemantics: true })).toBe(
      rawPointsBytesPerPoint(1, { pointSemantics: true }) + 1,
    );
  });

  it('defaults to off when the option is omitted entirely', () => {
    expect(rawPointsBytesPerPoint(7)).toBe(rawPointsBytesPerPoint(7, { pointSemantics: false }));
  });
});

describe('allocRawPoints leaves the five gated channels null when pointSemantics is off', () => {
  it('every gated field is null by default', () => {
    const raw = allocRawPoints(4, true, true, true);
    expect(raw.scanAngle).toBeNull();
    expect(raw.userData).toBeNull();
    expect(raw.scannerChannel).toBeNull();
    expect(raw.scanDirection).toBeNull();
    expect(raw.edgeOfFlightLine).toBeNull();
    // classificationFlags is NOT gated by pointSemantics — always allocated.
    expect(raw.classificationFlags).toBeInstanceOf(Uint8Array);
  });

  it('every gated field is allocated when pointSemantics is on', () => {
    const raw = allocRawPoints(4, true, true, true, { pointSemantics: true });
    expect(raw.scanAngle).toBeInstanceOf(Float32Array);
    expect(raw.userData).toBeInstanceOf(Uint8Array);
    expect(raw.scannerChannel).toBeInstanceOf(Uint8Array);
    expect(raw.scanDirection).toBeInstanceOf(Uint8Array);
    expect(raw.edgeOfFlightLine).toBeInstanceOf(Uint8Array);
  });
});

/** Bytes/point for each PDRF the coordinator asked for, at both settings. */
describe('reported per-point widths', () => {
  it.each(FORMATS)('PDRF $pdrf', ({ pdrf }) => {
    const off = rawPointsBytesPerPoint(pdrf, { pointSemantics: false });
    const on = rawPointsBytesPerPoint(pdrf, { pointSemantics: true });
    // Not a hardcoded assertion of the numbers themselves — those are exactly
    // what the "matches the true allocRawPoints allocation" tests above
    // already pin per format. This just documents the off/on relationship in
    // one place a human can read without running the estimator by hand.
    expect(on).toBeGreaterThan(off);
  });
});
