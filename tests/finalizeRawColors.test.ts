/**
 * finalizeRawColors.test.ts
 *
 * Pins the per-file RGB bit-depth decision shared by the plain LAS and LAZ
 * decoders. The regression this guards: a file that stores 8-bit colour in the
 * low byte of the 16-bit RGB field (values 0–255) used to be narrowed with an
 * unconditional `>> 8`, mapping every channel to 0 — a solid-black cloud. The
 * fix scans the file's max channel value once and copies verbatim when it is
 * already 8-bit, only shifting genuine full-range 16-bit data.
 */

import { describe, it, expect } from 'vitest';
import { allocRawPoints, finalizeRawColors, type RawPoints } from '../src/io/lasDecodeShared';

function withColors16(values: number[]): RawPoints {
  const count = values.length / 3;
  const raw = allocRawPoints(count, false, true);
  raw.colors16!.set(values);
  return raw;
}

describe('finalizeRawColors — per-file bit-depth narrowing', () => {
  it('copies an 8-bit-in-low-byte file verbatim (no blackout)', () => {
    const raw = withColors16([200, 100, 50, 255, 0, 128]);
    finalizeRawColors(raw);
    expect(Array.from(raw.colors!)).toEqual([200, 100, 50, 255, 0, 128]);
    expect(raw.colors16).toBeNull(); // staging buffer released
  });

  it('high-bytes a genuine full-range 16-bit file', () => {
    // 65535 → 255, 32768 → 128, 256 → 1 (the ×257 / high-byte convention).
    const raw = withColors16([65535, 32768, 256, 514, 257, 0]);
    finalizeRawColors(raw);
    expect(Array.from(raw.colors!)).toEqual([255, 128, 1, 2, 1, 0]);
  });

  it('treats an all-zero colour buffer as 8-bit (stays black, not crash)', () => {
    const raw = withColors16([0, 0, 0, 0, 0, 0]);
    finalizeRawColors(raw);
    expect(Array.from(raw.colors!)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('no-ops a colourless file', () => {
    const raw = allocRawPoints(4, false, false);
    finalizeRawColors(raw);
    expect(raw.colors).toBeNull();
  });
});
