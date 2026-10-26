import { describe, it, expect } from 'vitest';
import { readPackedBits, readPackedBitsBitwise } from '../src/io/e57/compressedVector';

/**
 * E57 integer fields of 32 bits or fewer are read a byte window at a time.
 * Every width 1..32 at every starting bit 0..7 must give the value the
 * bit-by-bit loop gives; `bitLoop` below is that loop as it stood.
 */

function bitLoop(buffer: Uint8Array, byteIndex: number, bitInByte: number, bitWidth: number): number {
  let packed = 0;
  for (let k = 0; k < bitWidth; k++) {
    packed += ((buffer[byteIndex] >> bitInByte) & 1) * 2 ** k;
    bitInByte++;
    if (bitInByte === 8) {
      bitInByte = 0;
      byteIndex++;
    }
  }
  return packed;
}

function randomBytes(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('E57 packed integer read: byte window equals the bit loop', () => {
  it('matches for widths 1..32 at bit offsets 0..7 over random bytes', () => {
    const buffer = randomBytes(4096, 9);
    for (let width = 1; width <= 32; width++) {
      for (let bit = 0; bit < 8; bit++) {
        for (let byte = 0; byte + 5 < buffer.length; byte += 37) {
          const want = bitLoop(buffer, byte, bit, width);
          expect(readPackedBits(buffer, byte, bit, width), `w${width} b${bit} @${byte}`).toBe(want);
        }
      }
    }
  });

  it('matches at the extremes: all-ones, all-zeros and a value ending on the last byte', () => {
    const ones = new Uint8Array(8).fill(0xff);
    const zeros = new Uint8Array(8);
    for (let width = 1; width <= 32; width++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(readPackedBits(ones, 0, bit, width)).toBe(2 ** width - 1);
        expect(readPackedBits(zeros, 0, bit, width)).toBe(0);
        // The last bit read is the last bit of the buffer.
        const len = Math.ceil((bit + width) / 8);
        const tight = randomBytes(len, width * 8 + bit);
        expect(readPackedBits(tight, 0, bit, width)).toBe(bitLoop(tight, 0, bit, width));
      }
    }
  });

  it('keeps the bit loop for widths over 32', () => {
    const buffer = randomBytes(64, 3);
    for (let width = 33; width <= 53; width++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(readPackedBits(buffer, 1, bit, width)).toBe(bitLoop(buffer, 1, bit, width));
        expect(readPackedBitsBitwise(buffer, 1, bit, width)).toBe(bitLoop(buffer, 1, bit, width));
      }
    }
  });

  it('a zero-width field reads 0 without touching the buffer', () => {
    expect(readPackedBits(new Uint8Array(0), 0, 0, 0)).toBe(0);
  });
});
