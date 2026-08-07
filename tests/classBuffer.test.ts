/**
 * tests/classBuffer.test.ts
 *
 * Coverage for the pure ArrayLike -> Uint8Array narrowing helper that
 * feeds the class histogram. An existing Uint8Array is returned by
 * identity (no copy); any other source is copied into a fresh byte
 * buffer where each write truncates to the low 8 bits.
 */

import { describe, it, expect } from 'vitest';
import { toClassBuffer } from '../src/render/class/classBuffer';

describe('toClassBuffer', () => {
  it('returns the same Uint8Array by identity (no copy)', () => {
    const src = new Uint8Array([2, 6, 9]);
    const out = toClassBuffer(src);
    expect(out).toBe(src);
  });

  it('empty input yields an empty buffer', () => {
    const out = toClassBuffer([]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toHaveLength(0);
  });

  it('copies a number[] into a fresh Uint8Array with identical values', () => {
    const src = [0, 1, 2, 6, 255];
    const out = toClassBuffer(src);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).not.toBe(src as unknown as Uint8Array);
    expect(Array.from(out)).toEqual([0, 1, 2, 6, 255]);
  });

  it('copies from a non-Uint8Array typed array (Float32Array), truncating to byte', () => {
    // Uint8Array assignment truncates toward zero and wraps mod 256:
    // 2.9 -> 2, 256 -> 0, 257 -> 1.
    const src = new Float32Array([2.9, 256, 257]);
    const out = toClassBuffer(src);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([2, 0, 1]);
  });

  it('values above the byte range wrap mod 256 on write', () => {
    const out = toClassBuffer([256, 300, 511]);
    // 256 -> 0, 300 -> 44, 511 -> 255
    expect(Array.from(out)).toEqual([0, 44, 255]);
  });

  it('preserves ASPRS class codes within the byte range unchanged', () => {
    const out = toClassBuffer([1, 2, 3, 4, 5, 6, 9]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 9]);
  });

  it('accepts a plain ArrayLike (length + indexer) source', () => {
    const src: ArrayLike<number> = { length: 3, 0: 2, 1: 6, 2: 9 };
    const out = toClassBuffer(src);
    expect(Array.from(out)).toEqual([2, 6, 9]);
  });
});
