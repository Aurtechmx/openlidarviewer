import { describe, expect, it } from 'vitest';
import { MAX_FEEL_DT_SEC, perFrameToDt } from '../src/render/orbitFeel';

/** Fraction still remaining after `seconds` of frames at `hz`. */
function remainingAfter(k: number, hz: number, seconds: number): number {
  let rest = 1;
  for (let i = 0; i < Math.round(hz * seconds); i++) rest *= 1 - perFrameToDt(k, 1 / hz);
  return rest;
}

describe('perFrameToDt', () => {
  it('returns the tuned factor at 60 Hz', () => {
    for (const k of [0.05, 0.07, 0.12, 0.18]) expect(perFrameToDt(k, 1 / 60)).toBeCloseTo(k, 12);
  });

  it('covers the same fraction per wall time at 30, 60 and 120 Hz', () => {
    for (const k of [0.05, 0.07, 0.12, 0.18]) {
      const covered60 = 1 - remainingAfter(k, 60, 0.5);
      for (const hz of [30, 120]) {
        const covered = 1 - remainingAfter(k, hz, 0.5);
        expect(Math.abs(covered - covered60) / covered60).toBeLessThan(0.01);
      }
    }
  });

  it('clamps the step so a stall does not jump the camera', () => {
    expect(perFrameToDt(0.12, 5)).toBeCloseTo(perFrameToDt(0.12, MAX_FEEL_DT_SEC), 12);
    expect(perFrameToDt(0.12, 5)).toBeLessThan(1);
    expect(perFrameToDt(0.12, -1)).toBe(0);
    expect(perFrameToDt(0.12, Number.NaN)).toBe(0);
  });
});
