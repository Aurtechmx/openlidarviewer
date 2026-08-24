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

describe('the allocation bound the ratio leaves behind', () => {
  /**
   * `MAX_LAZ_COMPRESSION_RATIO` is a judgement, so the property it was chosen
   * for is pinned instead of the number. The guard's job is bounding what a
   * lying header can allocate, and the point of deriving the floor from the
   * record length is that the bound stops varying by point format.
   *
   * Bytes per point are `allocRawPoints`: positions Float32x3, intensity
   * Uint16, classification, return number and return count Uint8, point source
   * id Uint16, plus GPS time Float64 and 16-bit colour where the format carries
   * them.
   */
  const FORMATS: readonly { name: string; recordLength: number; perPoint: number }[] = [
    { name: 'PDRF 0', recordLength: 20, perPoint: 19 },
    { name: 'PDRF 1', recordLength: 28, perPoint: 27 },
    { name: 'PDRF 2', recordLength: 26, perPoint: 25 },
    { name: 'PDRF 3', recordLength: 34, perPoint: 33 },
    { name: 'PDRF 6', recordLength: 30, perPoint: 27 },
    { name: 'PDRF 7', recordLength: 36, perPoint: 33 },
  ];

  /** Output bytes a header can force, as a multiple of the bytes backing it. */
  function allocationMultiple(recordLength: number, perPoint: number): number {
    return perPoint / compressedBytesPerPointFloor(recordLength);
  }

  it('admits the same multiple of the input bytes for every point format', () => {
    // The flat byte gave 19x for PDRF 0 and 33x for PDRF 3, which is the same
    // inconsistency as the compression ratio seen from the allocation side.
    const multiples = FORMATS.map((f) => allocationMultiple(f.recordLength, f.perPoint));
    const spread = Math.max(...multiples) / Math.min(...multiples);
    expect(spread).toBeLessThan(1.15);
  });

  it('stays inside fifty times the bytes that back it', () => {
    for (const f of FORMATS) {
      expect(allocationMultiple(f.recordLength, f.perPoint)).toBeLessThan(50);
    }
  });

  it('is looser than the flat byte it replaced, by under three times', () => {
    // Stated rather than hidden. The guard is a sanity check against a header
    // lying by orders of magnitude, not a memory guarantee, so trading this
    // much of an already 19x to 33x bound to stop refusing legitimate files is
    // the deliberate part of the change.
    for (const f of FORMATS) {
      const before = f.perPoint / 1;
      const after = allocationMultiple(f.recordLength, f.perPoint);
      expect(after).toBeGreaterThan(before);
      expect(after / before).toBeLessThan(3);
    }
  });
});
