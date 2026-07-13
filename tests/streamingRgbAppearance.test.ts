/**
 * streamingRgbAppearance.test.ts
 *
 * Pin the contract: `streamingNodeColors` in RGB mode applies the
 * `rgbAppearance` bundle (including temperature + tint) before
 * returning the byte buffer. A regression here is what makes the
 * Advanced > White-balance sliders feel like no-ops on streaming
 * clouds.
 */

import { describe, it, expect } from 'vitest';
import { streamingNodeColors } from '../src/render/streaming/streamingColors';
import { IDENTITY_RGB_APPEARANCE } from '../src/render/rgbAppearance';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

function makeDecoded(rgb: number[]): DecodedChunk {
  const n = rgb.length / 3;
  return {
    pointCount: n,
    positions: new Float32Array(n * 3),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    rgb: new Uint8Array(rgb),
    returnNumber: new Uint8Array(n),
    numberOfReturns: new Uint8Array(n),
    sourceId: new Uint16Array(n),
  } as unknown as DecodedChunk;
}

const RANGES = {
  minZ: 0,
  maxZ: 1,
  minIntensity: 0,
  maxIntensity: 1,
  minGpsTime: 0,
  maxGpsTime: 1,
  minReturnNumber: 0,
  maxReturnNumber: 1,
} as const;

describe('streamingNodeColors — RGB appearance pass-through', () => {
  it('returns raw RGB bytes when no appearance is passed', () => {
    const decoded = makeDecoded([128, 128, 128]);
    const out = streamingNodeColors('rgb', decoded, RANGES);
    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
  });

  it('returns identity-equivalent bytes when given the identity bundle', () => {
    const decoded = makeDecoded([128, 128, 128]);
    const out = streamingNodeColors('rgb', decoded, RANGES, IDENTITY_RGB_APPEARANCE);
    // Round-trip via /255 *255 may drift by 1 LSB due to sRGB float math.
    expect(Math.abs(out[0] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(out[1] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(out[2] - 128)).toBeLessThanOrEqual(2);
  });

  it('warm temperature shifts red up and blue down (full slider)', () => {
    // Neutral grey input — easy to read the channel shift.
    const decoded = makeDecoded([128, 128, 128]);
    const out = streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      temperature: 1, // full warm
    });
    // tempGainR = 1.25, tempGainB = 0.75 → red ≈ 160, blue ≈ 96.
    expect(out[0]).toBeGreaterThan(128);
    expect(out[2]).toBeLessThan(128);
    // Green stays at unit gain on the temperature axis.
    expect(Math.abs(out[1] - 128)).toBeLessThanOrEqual(2);
  });

  it('cool temperature shifts blue up and red down', () => {
    const decoded = makeDecoded([128, 128, 128]);
    const out = streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      temperature: -1, // full cool
    });
    expect(out[0]).toBeLessThan(128);
    expect(out[2]).toBeGreaterThan(128);
  });

  it('magenta tint lifts red + blue, dips green', () => {
    const decoded = makeDecoded([128, 128, 128]);
    const out = streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      tint: 1, // full magenta
    });
    // tintGainR = 1.15, tintGainG = 0.85, tintGainB = 1.15
    expect(out[0]).toBeGreaterThan(128);
    expect(out[1]).toBeLessThan(128);
    expect(out[2]).toBeGreaterThan(128);
  });

  it('any non-zero WB slider causes output to diverge from input', () => {
    const decoded = makeDecoded([128, 128, 128]);
    // The returned Uint8Array is a view into a shared scratch buffer
    // (see streamingNodeColors JSDoc). Copy each result before the
    // next call so the comparison reads the right snapshot.
    const snap = (arr: Uint8Array) => new Uint8Array(arr);

    const neutral = snap(streamingNodeColors('rgb', decoded, RANGES, IDENTITY_RGB_APPEARANCE));
    const warm = snap(streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      temperature: 0.3,
    }));
    expect(warm[0]).not.toBe(neutral[0]);
    expect(warm[2]).not.toBe(neutral[2]);

    const cool = snap(streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      temperature: -0.3,
    }));
    expect(cool[0]).not.toBe(neutral[0]);
    expect(cool[2]).not.toBe(neutral[2]);

    const tint = snap(streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      tint: 0.3,
    }));
    expect(tint[1]).not.toBe(neutral[1]);
  });

  it('preserves transparency-friendly clamp at the extremes', () => {
    const decoded = makeDecoded([255, 255, 255]);
    const out = streamingNodeColors('rgb', decoded, RANGES, {
      ...IDENTITY_RGB_APPEARANCE,
      exposure: 4, // huge over-exposure
    });
    // All channels clamp at 255 — no wrap-around.
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(255);
    expect(out[2]).toBe(255);
  });

  it('returns reusable buffer subarray of correct length', () => {
    const decoded = makeDecoded([10, 20, 30, 40, 50, 60]);
    const out = streamingNodeColors('rgb', decoded, RANGES, IDENTITY_RGB_APPEARANCE);
    expect(out.length).toBe(6);
  });
});
