import { adaptivePointSize, maxPointSize } from '../src/render/pointStyle';

// ────────────────────────────────────────────────────────────────────────────
// adaptivePointSize — distance-aware point sizing with min/max clamps
// ────────────────────────────────────────────────────────────────────────────

describe('adaptivePointSize', () => {
  // base 4 px, reference distance 100, clamps [1, 12].
  const base = 4;
  const ref = 100;
  const min = 1;
  const max = 12;

  test('a point at the reference distance renders at the base size', () => {
    expect(adaptivePointSize(base, ref, ref, min, max)).toBeCloseTo(base, 10);
  });

  test('a nearer point renders larger', () => {
    expect(adaptivePointSize(base, ref / 2, ref, min, max)).toBeGreaterThan(base);
  });

  test('a farther point renders smaller', () => {
    expect(adaptivePointSize(base, ref * 2, ref, min, max)).toBeLessThan(base);
  });

  test('a very far point is clamped to the minimum, never vanishing', () => {
    expect(adaptivePointSize(base, ref * 100_000, ref, min, max)).toBe(min);
  });

  test('a very near point is clamped to the maximum, never bloating', () => {
    expect(adaptivePointSize(base, ref / 100_000, ref, min, max)).toBe(max);
  });

  test('size is monotonic — a nearer point is never smaller than a farther one', () => {
    let prev = 0;
    for (const dist of [ref * 4, ref * 2, ref, ref / 2, ref / 4]) {
      const size = adaptivePointSize(base, dist, ref, min, max);
      expect(size).toBeGreaterThanOrEqual(prev);
      prev = size;
    }
  });

  test('a degenerate (zero or negative) eye distance falls back to the max size', () => {
    expect(adaptivePointSize(base, 0, ref, min, max)).toBe(max);
    expect(adaptivePointSize(base, -5, ref, min, max)).toBe(max);
  });

  test('a degenerate reference distance falls back to the max size', () => {
    expect(adaptivePointSize(base, ref, 0, min, max)).toBe(max);
  });

  test('the result always stays within the clamp range', () => {
    for (const dist of [0.001, 1, 50, 100, 1000, 1e6]) {
      const size = adaptivePointSize(base, dist, ref, min, max);
      expect(size).toBeGreaterThanOrEqual(min);
      expect(size).toBeLessThanOrEqual(max);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// maxPointSize
// ────────────────────────────────────────────────────────────────────────────

describe('maxPointSize', () => {
  test('scales the base size by the factor', () => {
    expect(maxPointSize(4, 3)).toBe(12);
  });

  test('never returns less than the base size, even for a factor below 1', () => {
    expect(maxPointSize(4, 0.5)).toBe(4);
  });
});
