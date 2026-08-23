/**
 * validateCount.test.ts
 *
 * The allocation guard's floor, and the false rejection it used to carry.
 *
 * The guard bounds a header-declared count by the bytes that back it, which is
 * what stops a remote file claiming 10^12 points from driving a multi-terabyte
 * allocation. The floor it used was one byte per point for every LAZ stream,
 * and that is not one rule: a twenty-byte PDRF 0 record was refused above 20x
 * compression while a thirty-six-byte PDRF 7 record was allowed to 36x. LAZ
 * reaches those ratios on content that is uniform rather than malformed, so the
 * guard could refuse a valid file, and it was strictest on the formats carrying
 * least per point.
 */

import { describe, it, expect } from 'vitest';
import {
  validateDeclaredPointCount,
  compressedBytesPerPointFloor,
  MIN_BYTES_PER_POINT_FLOOR,
  MAX_LAZ_COMPRESSION_RATIO,
  UNKNOWN_RECORD_BYTES_PER_POINT,
} from '../src/io/validateCount';
import { LoadError } from '../src/io/loadErrors';

describe('compressedBytesPerPointFloor', () => {
  it('admits the same compression ratio for every point format', () => {
    for (const recordLength of [20, 26, 28, 30, 34, 36]) {
      const floor = compressedBytesPerPointFloor(recordLength);
      expect(recordLength / floor).toBeCloseTo(MAX_LAZ_COMPRESSION_RATIO, 9);
    }
  });

  it('is below one byte per point for every LAS record format', () => {
    // The whole point: the flat one-byte floor sat above these.
    for (const recordLength of [20, 28, 30, 36]) {
      expect(compressedBytesPerPointFloor(recordLength)).toBeLessThan(1);
    }
  });

  it('falls back to one byte per point for a missing or nonsense record length', () => {
    // Not to MIN_BYTES_PER_POINT_FLOOR. A header can declare a zero record
    // length and nothing upstream rejects it, so falling back to a hundredth of
    // a byte would leave the guard a hundred times weaker than the flat byte it
    // replaced, on precisely the malformed input it exists for.
    for (const bad of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compressedBytesPerPointFloor(bad)).toBe(UNKNOWN_RECORD_BYTES_PER_POINT);
      expect(compressedBytesPerPointFloor(bad)).toBeGreaterThan(MIN_BYTES_PER_POINT_FLOOR);
    }
  });

  it('is never looser than the flat byte it replaced, for a malformed header', () => {
    // 10^9 points behind a kilobyte, with the record length a malformed file
    // declared as zero.
    const floor = compressedBytesPerPointFloor(0);
    expect(() => validateDeclaredPointCount(1e9, 1024, floor, 'COPC node'))
      .toThrow(LoadError);
    expect(() => validateDeclaredPointCount(1025, 1024, floor, 'COPC node'))
      .toThrow(LoadError);
  });
});

describe('validateDeclaredPointCount with a fractional floor', () => {
  it('accepts a node compressed past the old one-byte floor', () => {
    // 50,000 PDRF 6 points in 40 KB is 0.8 bytes per point, a 37.5x ratio. A
    // node whose points share a classification, an intensity and a
    // near-constant coordinate delta feeds the coder almost no entropy and gets
    // there without being malformed.
    const floor = compressedBytesPerPointFloor(30);
    expect(validateDeclaredPointCount(50_000, 40_000, floor, 'COPC node')).toBe(50_000);
    // The same call at the floor that shipped before.
    expect(() => validateDeclaredPointCount(50_000, 40_000, 1, 'COPC node'))
      .toThrow(LoadError);
  });

  it('refuses a ratio past the ceiling, so the window is bounded not removed', () => {
    // 60x on a thirty-byte record. The change widens the admitted ratio from
    // 30x to 50x; it does not admit anything at all.
    const floor = compressedBytesPerPointFloor(30);
    expect(() => validateDeclaredPointCount(50_000, 25_000, floor, 'COPC node'))
      .toThrow(LoadError);
  });

  it('still refuses a header lying by orders of magnitude', () => {
    const floor = compressedBytesPerPointFloor(30);
    expect(() => validateDeclaredPointCount(1e12, 4096, floor, 'COPC node'))
      .toThrow(/malformed COPC node/);
    expect(() => validateDeclaredPointCount(1e9, 1024, floor, 'LAZ file'))
      .toThrow(LoadError);
  });

  it('holds the bound at the exact boundary the floor sets', () => {
    const floor = compressedBytesPerPointFloor(30); // 0.6 bytes per point
    const bytes = 6_000;
    const most = Math.floor(bytes / floor); // 10,000
    expect(validateDeclaredPointCount(most, bytes, floor, 'LAZ file')).toBe(most);
    expect(() => validateDeclaredPointCount(most + 1, bytes, floor, 'LAZ file'))
      .toThrow(LoadError);
  });

  it('never lets a caller make the bound vacuous', () => {
    // A zero or negative floor would admit any count at all, which is the one
    // thing this guard must not do.
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => validateDeclaredPointCount(1e12, 1024, bad, 'LAZ file'))
        .toThrow(LoadError);
    }
  });

  it('names the floor it applied, so the message is checkable', () => {
    let message = '';
    try {
      validateDeclaredPointCount(1e9, 1024, compressedBytesPerPointFloor(30), 'LAZ file');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/0\.60 byte\(s\) per point/);
    expect(message).toMatch(/malformed LAZ file/);
  });

  it('keeps refusing a count that is not a safe non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => validateDeclaredPointCount(bad, 20_000, 0.6, 'LAZ file'))
        .toThrow(/invalid declared point count/);
    }
  });
});
