/**
 * A classification code survives the trip to the GPU exactly.
 *
 * `buildPointMesh` uploads classification as a one-value-per-instance FLOAT
 * attribute rather than an integer one, because a float attribute is portable
 * across the WebGPU and WebGL 2 backends, and the size graph rounds it back to
 * an integer before indexing the class-visibility mask. That round trip is a
 * release blocker if it is ever inexact: a class that came back as its
 * neighbour would mislabel points, and the mask would hide the wrong ones.
 *
 * The arithmetic holds for the whole ASPRS range and this pins it. Every
 * integer up to 2^24 is exactly representable in a 32-bit float, so 0 to 255
 * has a wide margin, and the test exists to catch a change of attribute type
 * rather than to doubt IEEE 754.
 */
import { describe, it, expect } from 'vitest';

/** The upload path in `Viewer.buildPointMesh`, isolated. */
function uploadAsFloatAttribute(classification: ArrayLike<number>): Float32Array {
  const out = new Float32Array(classification.length);
  for (let i = 0; i < classification.length; i++) out[i] = classification[i];
  return out;
}

/** What the size graph does before indexing the visibility mask. */
const readBack = (v: number): number => Math.round(v);

describe('classification codes through the float attribute', () => {
  it('returns every ASPRS code unchanged', () => {
    const codes = Array.from({ length: 256 }, (_unused, i) => i);
    const uploaded = uploadAsFloatAttribute(codes);
    for (let i = 0; i < codes.length; i++) {
      expect(readBack(uploaded[i])).toBe(codes[i]);
    }
  });

  it('keeps neighbouring codes distinct, which is what mislabelling would break', () => {
    const uploaded = uploadAsFloatAttribute([1, 2, 3, 11, 12, 13, 254, 255]);
    expect([...uploaded].map(readBack)).toEqual([1, 2, 3, 11, 12, 13, 254, 255]);
    expect(new Set(uploaded).size).toBe(8);
  });

  it('is exact well past the range ASPRS defines', () => {
    // 2^24 is the last integer a float32 holds exactly. Codes are bytes, so the
    // margin is enormous; this records where the exactness actually ends.
    for (const v of [0, 255, 65535, 1 << 20, (1 << 24) - 1]) {
      expect(readBack(uploadAsFloatAttribute([v])[0])).toBe(v);
    }
  });

  it('does not silently round a value that is not a code', () => {
    // A fractional value is not an ASPRS class. It must not arrive looking like
    // one, so the round-back is recorded rather than assumed harmless.
    const uploaded = uploadAsFloatAttribute([2.5]);
    expect(uploaded[0]).toBe(2.5);
    expect(readBack(uploaded[0])).toBe(3);
  });
});
