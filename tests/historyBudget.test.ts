import { describe, it, expect } from 'vitest';
import {
  CONSERVATIVE_LAYOUT,
  FLOAT_LAYOUT,
  bytesPerPixel,
  historyBytes,
  historyFits,
  HISTORY_BYTES_CEILING,
} from '../src/render/continuity/historyBudget';

const MB = 1024 * 1024;

describe('history budget', () => {
  it('costs nine bytes a pixel conservatively and twenty-four at full float', () => {
    expect(bytesPerPixel(CONSERVATIVE_LAYOUT)).toBe(9);
    expect(bytesPerPixel(FLOAT_LAYOUT)).toBe(24);
  });

  // Reaching for a 32-bit float everywhere is the easy path and the reason a
  // history turns into hundreds of megabytes.
  it('costs under a third of the float layout', () => {
    const w = 3840;
    const h = 2160;
    expect(historyBytes(w, h) / historyBytes(w, h, FLOAT_LAYOUT)).toBeCloseTo(9 / 24, 12);
  });

  it.each([
    ['1080p', 1920, 1080, 17.8],
    ['1440p', 2560, 1440, 31.6],
    ['4K', 3840, 2160, 71.2],
  ])('sizes %s at about %s MB', (_label, w, h, expected) => {
    expect(historyBytes(w, h) / MB).toBeCloseTo(expected as number, 1);
  });

  // The figure that matters is device pixels, so a ratio of two is already in
  // the numbers. Quoting a CSS size would understate the allocation fourfold.
  it('counts device pixels, so a doubled ratio costs four times as much', () => {
    expect(historyBytes(2560 * 2, 1440 * 2)).toBe(historyBytes(2560, 1440) * 4);
  });

  // A high-DPI tablet allocates more than a 4K monitor, which is the case most
  // easily missed when a budget is reasoned about in panel names.
  it('makes a high-DPI tablet cost more than a 4K panel', () => {
    const tablet = historyBytes(2388 * 2, 1668 * 2);
    const uhd = historyBytes(3840, 2160);
    expect(tablet).toBeGreaterThan(uhd);
  });

  it('declines a history it cannot fit rather than allocating it', () => {
    expect(historyFits(1920, 1080)).toBe(true);
    expect(historyFits(3840, 2160)).toBe(true);
    // 4K at a ratio of two passes the ceiling even at nine bytes a pixel.
    expect(historyBytes(3840 * 2, 2160 * 2)).toBeGreaterThan(HISTORY_BYTES_CEILING);
    expect(historyFits(3840 * 2, 2160 * 2)).toBe(false);
  });

  it('would decline far sooner at full float', () => {
    expect(historyFits(2560 * 2, 1440 * 2, CONSERVATIVE_LAYOUT)).toBe(true);
    expect(historyFits(2560 * 2, 1440 * 2, FLOAT_LAYOUT)).toBe(false);
  });

  it('costs nothing for a degenerate size', () => {
    for (const [w, h] of [[0, 1080], [-5, 100], [Number.NaN, 100], [Infinity, 100]]) {
      expect(historyBytes(w, h)).toBe(0);
    }
  });
});
