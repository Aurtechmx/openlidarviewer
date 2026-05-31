/**
 * tests/colorProvenance.test.ts
 *
 * Coverage for the v0.3.7 colour-provenance formatter:
 *   - round-trip preserves the input byte (display == scanner for every
 *     stored colour)
 *   - linear values for known sRGB inputs match the piecewise EOTF
 *   - hex string is well-formed
 *   - format strings carry every field
 *   - clamps + NaN guards behave
 */

import { describe, it, expect } from 'vitest';
import { colorProvenance, formatColorProvenance } from '../src/render/colorProvenance';

describe('colorProvenance — round trip', () => {
  it('display equals scanner for every stored colour (sRGB → linear → sRGB)', () => {
    // Sample 20 representative bytes across the channel range.
    const samples = [0, 1, 5, 15, 31, 63, 95, 127, 159, 191, 223, 245, 250, 252, 254, 255];
    for (const v of samples) {
      const cp = colorProvenance(v, v, v);
      expect(cp.display[0]).toBe(v);
      expect(cp.display[1]).toBe(v);
      expect(cp.display[2]).toBe(v);
    }
  });

  it('linear values for [128, 128, 128] sit near 0.215 (perceptual mid-grey)', () => {
    // mid-grey sRGB byte 128 → linear ≈ 0.2158.
    const cp = colorProvenance(128, 128, 128);
    for (const v of cp.linear) {
      expect(v).toBeGreaterThan(0.21);
      expect(v).toBeLessThan(0.22);
    }
  });

  it('extreme inputs map to extreme linear values', () => {
    const black = colorProvenance(0, 0, 0);
    expect(black.linear[0]).toBeCloseTo(0, 6);
    expect(black.linear[1]).toBeCloseTo(0, 6);
    expect(black.linear[2]).toBeCloseTo(0, 6);
    const white = colorProvenance(255, 255, 255);
    expect(white.linear[0]).toBeCloseTo(1, 5);
    expect(white.linear[1]).toBeCloseTo(1, 5);
    expect(white.linear[2]).toBeCloseTo(1, 5);
  });
});

describe('colorProvenance — hex string', () => {
  it('formats every byte as two lowercase hex digits', () => {
    const cp = colorProvenance(15, 255, 0);
    expect(cp.hex).toBe('#0fff00');
  });

  it('handles channel 0 and 255 boundaries', () => {
    expect(colorProvenance(0, 0, 0).hex).toBe('#000000');
    expect(colorProvenance(255, 255, 255).hex).toBe('#ffffff');
  });
});

describe('colorProvenance — clamps + NaN guards', () => {
  it('clamps negative channel values to 0', () => {
    const cp = colorProvenance(-50, -10, -1);
    expect(cp.scanner).toEqual([0, 0, 0]);
  });

  it('clamps oversized channels to 255', () => {
    const cp = colorProvenance(300, 1000, 256);
    expect(cp.scanner).toEqual([255, 255, 255]);
  });

  it('NaN channels collapse to 0', () => {
    const cp = colorProvenance(NaN, NaN, NaN);
    expect(cp.scanner).toEqual([0, 0, 0]);
    expect(cp.linear[0]).toBeCloseTo(0, 6);
  });
});

describe('formatColorProvenance — display strings', () => {
  it('every row carries every channel + the hex code', () => {
    const cp = colorProvenance(184, 102, 46);
    const f = formatColorProvenance(cp);
    expect(f.scanner).toMatch(/R\s+184\s+G\s+102\s+B\s+46/);
    expect(f.scanner).toContain('#');
    expect(f.linear).toMatch(/R\s+\d\.\d{3}\s+G\s+\d\.\d{3}\s+B\s+\d\.\d{3}/);
    expect(f.display).toMatch(/R\s+184\s+G\s+102\s+B\s+46/);
  });
});
