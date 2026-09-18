/**
 * lasClassificationFlags.test.ts — the legacy classification byte carries
 * three flags above the class code, and reading the class by masking with
 * 0x1f erases all three. These tests pin the split and its inverse.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeLegacyClassificationByte,
  encodeLegacyClassificationByte,
  NO_FLAGS,
} from '../src/lasSemantics';

describe('splitting the legacy classification byte', () => {
  it('reads a plain class with no flags', () => {
    const { code, flags } = decodeLegacyClassificationByte(2);
    expect(code).toBe(2);
    expect(flags.synthetic).toBe(false);
    expect(flags.keyPoint).toBe(false);
    expect(flags.withheld).toBe(false);
  });

  it.each([
    ['synthetic', 0x20],
    ['keyPoint', 0x40],
    ['withheld', 0x80],
  ] as const)('reads the %s flag without disturbing the class', (flag, bit) => {
    const { code, flags } = decodeLegacyClassificationByte(2 | bit);
    expect(code).toBe(2);
    expect(flags[flag]).toBe(true);
  });

  it('reads all three flags at once', () => {
    const { code, flags } = decodeLegacyClassificationByte(6 | 0x20 | 0x40 | 0x80);
    expect(code).toBe(6);
    expect(flags.synthetic).toBe(true);
    expect(flags.keyPoint).toBe(true);
    expect(flags.withheld).toBe(true);
  });

  it('reports no overlap flag, because the legacy byte has no such bit', () => {
    // Table 8 defines bits 5, 6 and 7 only. Legacy files carry overlap as
    // class 12; isOverlapPoint() answers that question per format.
    expect(decodeLegacyClassificationByte(12).flags.overlap).toBe(false);
    expect(decodeLegacyClassificationByte(2).flags.overlap).toBe(false);
  });
});

describe('rebuilding the byte', () => {
  it('round-trips every class and flag combination', () => {
    for (let code = 0; code <= 31; code++) {
      for (const synthetic of [false, true]) {
        for (const keyPoint of [false, true]) {
          for (const withheld of [false, true]) {
            const byte = encodeLegacyClassificationByte(code, { synthetic, keyPoint, withheld });
            const back = decodeLegacyClassificationByte(byte);
            expect(back.code).toBe(code);
            expect(back.flags.synthetic).toBe(synthetic);
            expect(back.flags.keyPoint).toBe(keyPoint);
            expect(back.flags.withheld).toBe(withheld);
          }
        }
      }
    }
  });

  it('writes a bare class when no flags are given', () => {
    expect(encodeLegacyClassificationByte(2)).toBe(2);
    expect(encodeLegacyClassificationByte(2, NO_FLAGS)).toBe(2);
  });
});

describe('what masking with 0x1f costs', () => {
  it('erases every flag, which is why the writer must not do it', () => {
    const byte = encodeLegacyClassificationByte(2, {
      synthetic: true,
      keyPoint: true,
      withheld: true,
    });
    const masked = byte & 0x1f;
    expect(decodeLegacyClassificationByte(byte).flags.withheld).toBe(true);
    expect(decodeLegacyClassificationByte(masked).flags.withheld).toBe(false);
    expect(decodeLegacyClassificationByte(masked).flags.synthetic).toBe(false);
    expect(decodeLegacyClassificationByte(masked).flags.keyPoint).toBe(false);
  });
});
