/**
 * tests/rgbAutoNormalize.test.ts
 *
 * Coverage for the v0.3.7 RGB auto-normalize histogram analyser:
 *   - empty cloud returns null
 *   - a healthy histogram returns the identity bundle
 *   - underexposed clouds get an exposure lift
 *   - overexposed clouds get an exposure cut
 *   - low-contrast clouds get a contrast bump
 *   - washed-out clouds get a saturation bump
 */

import { describe, it, expect } from 'vitest';
import { rgbAutoNormalize } from '../src/render/rgbAutoNormalize';

function uniformCloud(value: number, count = 5_000): Uint8Array {
  const out = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = value;
    out[i * 3 + 1] = value;
    out[i * 3 + 2] = value;
  }
  return out;
}

function spreadCloud(
  channels: ReadonlyArray<readonly [number, number, number]>,
): Uint8Array {
  const out = new Uint8Array(channels.length * 3);
  for (let i = 0; i < channels.length; i++) {
    out[i * 3] = channels[i][0];
    out[i * 3 + 1] = channels[i][1];
    out[i * 3 + 2] = channels[i][2];
  }
  return out;
}

describe('rgbAutoNormalize', () => {
  it('returns null on an empty cloud', () => {
    expect(rgbAutoNormalize({ colorsU8: new Uint8Array(0) })).toBeNull();
  });

  it('flags a healthy colourful cloud as healthy and recommends identity', () => {
    // Realistic histogram: luminance spans 0.1..0.9, RGB has chroma
    // variance (so the cloud isn't grey). This is what a well-exposed
    // RGB scan looks like — auto-normalize should leave it alone.
    const triples: Array<[number, number, number]> = [];
    for (let v = 26; v <= 230; v += 4) {
      triples.push([v, Math.max(0, v - 30), Math.min(255, v + 20)]);
    }
    const colorsU8 = spreadCloud(triples);
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(s!.stats.scanClass).toBe('healthy');
    expect(s!.settings.exposure).toBe(1);
    expect(s!.settings.contrast).toBe(1);
    expect(s!.settings.gamma).toBe(1);
  });

  it('flags an underexposed scan and lifts exposure', () => {
    // Every point dark — p95 stays low.
    const colorsU8 = uniformCloud(64); // sRGB byte 64 → linear 0.05
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(s!.stats.scanClass).toBe('underexposed');
    expect(s!.settings.exposure).toBeGreaterThan(1);
  });

  it('flags an overexposed scan and cuts exposure', () => {
    // Every point bright — p5 stays high.
    const colorsU8 = uniformCloud(220);
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(s!.stats.scanClass).toBe('overexposed');
    expect(s!.settings.exposure).toBeLessThan(1);
  });

  it('flags a low-contrast scan and bumps contrast', () => {
    // Tight midtones — p5 ≈ p95.
    const triples: Array<[number, number, number]> = [];
    for (let v = 110; v <= 145; v += 2) triples.push([v, v, v]);
    const colorsU8 = spreadCloud(triples);
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(s!.stats.scanClass).toBe('low-contrast');
    expect(s!.settings.contrast).toBeGreaterThan(1);
  });

  it('flags a washed-out chroma cloud and bumps saturation', () => {
    // Spread luminance but keep RGB channels nearly equal.
    const triples: Array<[number, number, number]> = [];
    for (let v = 20; v <= 220; v += 2) triples.push([v, v + 1, v - 1]);
    const colorsU8 = spreadCloud(triples);
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(['washed-out', 'healthy']).toContain(s!.stats.scanClass);
    if (s!.stats.scanClass === 'washed-out') {
      expect(s!.settings.saturation).toBeGreaterThan(1);
    }
  });

  it('every suggestion carries a reason string and finite stats', () => {
    const colorsU8 = uniformCloud(80);
    const s = rgbAutoNormalize({ colorsU8 });
    expect(s).not.toBeNull();
    expect(s!.stats.reason.length).toBeGreaterThan(0);
    expect(Number.isFinite(s!.stats.p5)).toBe(true);
    expect(Number.isFinite(s!.stats.p50)).toBe(true);
    expect(Number.isFinite(s!.stats.p95)).toBe(true);
    expect(Number.isFinite(s!.stats.chromaStdDev)).toBe(true);
    expect(s!.stats.sampleCount).toBeGreaterThan(0);
  });
});
