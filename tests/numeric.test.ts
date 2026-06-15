import { clamp, clamp01 } from '../src/numeric';

describe('clamp', () => {
  test('passes a value already inside the range unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test('clamps below the minimum and above the maximum', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  test('returns the bounds at the edges', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  test('matches the Math.max(min, Math.min(max, x)) idiom when min > max', () => {
    expect(clamp(5, 10, 0)).toBe(Math.max(10, Math.min(0, 5)));
  });

  test('propagates NaN', () => {
    expect(Number.isNaN(clamp(Number.NaN, 0, 10))).toBe(true);
  });
});

describe('clamp01', () => {
  test('constrains to the unit range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });
});
