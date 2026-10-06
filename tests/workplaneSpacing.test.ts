import { describe, it, expect } from 'vitest';
import {
  chooseAutoSpacing,
  fixedSpacing,
  minorStepFor,
  withinHoldBand,
  HOLD_MAX_PX,
  HOLD_MIN_PX,
  TARGET_PX,
} from '../src/render/workplane/workplaneSpacing';

const IS_125 = (v: number): boolean => {
  const e = Math.floor(Math.log10(v));
  const m = Math.round(v / Math.pow(10, e));
  return [1, 2, 5].includes(m) && Math.abs(v - m * Math.pow(10, e)) < 1e-12 * Math.pow(10, e);
};

/** Zoom levels from far out to close in, as CSS px per unit. */
const ZOOMS = Array.from({ length: 400 }, (_, i) => Math.pow(10, -4 + i * 0.02));

describe('automatic spacing: 1-2-5 steps, 50 to 100 px apart', () => {
  it('every fresh choice is a 1-2-5 value whose major lines sit about 45 to 112 px apart', () => {
    for (const ppu of ZOOMS) {
      const s = chooseAutoSpacing(ppu, null)!;
      expect(IS_125(s.major), `major ${s.major}`).toBe(true);
      const px = s.major * ppu;
      expect(px).toBeGreaterThanOrEqual(TARGET_PX / Math.sqrt(2.5) - 1e-9);
      expect(px).toBeLessThanOrEqual(TARGET_PX * Math.sqrt(2.5) + 1e-9);
    }
  });

  it('prints clean values (0.2, not 0.20000000000000001)', () => {
    expect(chooseAutoSpacing(70 / 0.2, null)!.major).toBe(0.2);
    expect(String(chooseAutoSpacing(70 / 0.002, null)!.major)).toBe('0.002');
    expect(chooseAutoSpacing(70 / 5000, null)!.major).toBe(5000);
  });

  it('minor lines subdivide on round values: 1 -> 0.2, 2 -> 0.5, 5 -> 1', () => {
    expect(minorStepFor(1)).toBe(0.2);
    expect(minorStepFor(2)).toBe(0.5);
    expect(minorStepFor(5)).toBe(1);
    expect(minorStepFor(20)).toBe(5);
    expect(minorStepFor(0.05)).toBe(0.01);
  });

  it('refuses a scale it cannot measure rather than guessing', () => {
    expect(chooseAutoSpacing(0, null)).toBeNull();
    expect(chooseAutoSpacing(NaN, 5)).toBeNull();
    expect(chooseAutoSpacing(-1, null)).toBeNull();
  });
});

describe('hysteresis', () => {
  it('the hold band contains the whole selection band, so a fresh choice is always held', () => {
    expect(HOLD_MIN_PX).toBeLessThan(TARGET_PX / Math.sqrt(2.5));
    expect(HOLD_MAX_PX).toBeGreaterThan(TARGET_PX * Math.sqrt(2.5));
    for (const ppu of ZOOMS) {
      const s = chooseAutoSpacing(ppu, null)!;
      expect(withinHoldBand(s.major * ppu)).toBe(true);
      expect(chooseAutoSpacing(ppu, s.major)!.major).toBe(s.major);
    }
  });

  it('keeps the drawn step while it stays inside the band', () => {
    // 5 units at 14 px/unit = 70 px; zooming to 8 or 26 px/unit (40 or 130 px) keeps it.
    expect(chooseAutoSpacing(8, 5)!.major).toBe(5);
    expect(chooseAutoSpacing(26, 5)!.major).toBe(5);
    // Outside the band it moves on.
    expect(chooseAutoSpacing(6, 5)!.major).not.toBe(5);
    expect(chooseAutoSpacing(30, 5)!.major).not.toBe(5);
  });

  it('a jittering zoom at a step boundary does not pop back and forth', () => {
    let major: number | null = null;
    let changes = 0;
    // Oscillate +-8 % around the ppu where a fresh choice flips between 2 and 5.
    const boundary = TARGET_PX / Math.sqrt(2 * 5);
    for (let i = 0; i < 200; i++) {
      const ppu = boundary * (i % 2 === 0 ? 1.08 : 0.92);
      const next: number = chooseAutoSpacing(ppu, major)!.major;
      if (major !== null && next !== major) changes++;
      major = next;
    }
    expect(changes).toBe(0);
  });

  it('a steady zoom changes step once per step, never back', () => {
    let major: number | null = null;
    const seen: number[] = [];
    for (const ppu of ZOOMS) {
      const next: number = chooseAutoSpacing(ppu, major)!.major;
      if (next !== major) seen.push(next);
      major = next;
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
  });
});

describe('fixed spacing', () => {
  it('keeps the typed value and refuses zero, negatives and non-numbers', () => {
    expect(fixedSpacing(3)).toEqual({ major: 3, minor: 0.6 });
    expect(fixedSpacing(10)).toEqual({ major: 10, minor: 2 });
    expect(fixedSpacing(0)).toBeNull();
    expect(fixedSpacing(-2)).toBeNull();
    expect(fixedSpacing(Number.NaN)).toBeNull();
  });
});
