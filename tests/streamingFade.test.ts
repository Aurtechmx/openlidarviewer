import {
  fadeOpacity,
  FADE_MS,
  FADE_START_OPACITY,
} from '../src/render/streaming/StreamingRenderer';

// --- Phase 7 Task 25 — node fade-in math ------------------------------------

test('fadeOpacity returns the start opacity at elapsed=0', () => {
  expect(fadeOpacity(0, FADE_MS, FADE_START_OPACITY)).toBeCloseTo(FADE_START_OPACITY, 6);
});

test('fadeOpacity hits exactly 1.0 at elapsed=duration', () => {
  expect(fadeOpacity(FADE_MS, FADE_MS, FADE_START_OPACITY)).toBeCloseTo(1, 6);
});

test('fadeOpacity is monotonic — opacity rises with every step', () => {
  const a = fadeOpacity(20, FADE_MS, FADE_START_OPACITY);
  const b = fadeOpacity(60, FADE_MS, FADE_START_OPACITY);
  const c = fadeOpacity(100, FADE_MS, FADE_START_OPACITY);
  expect(a).toBeLessThan(b);
  expect(b).toBeLessThan(c);
});

test('fadeOpacity clamps past the duration to 1.0 — no overshoot', () => {
  expect(fadeOpacity(FADE_MS + 1, FADE_MS, FADE_START_OPACITY)).toBe(1);
  expect(fadeOpacity(10_000, FADE_MS, FADE_START_OPACITY)).toBe(1);
});

test('fadeOpacity clamps negative elapsed to the start opacity — no undershoot', () => {
  expect(fadeOpacity(-50, FADE_MS, FADE_START_OPACITY)).toBe(FADE_START_OPACITY);
});

test('fadeOpacity is the linear midpoint at half-elapsed', () => {
  const mid = fadeOpacity(FADE_MS / 2, FADE_MS, FADE_START_OPACITY);
  expect(mid).toBeCloseTo(FADE_START_OPACITY + (1 - FADE_START_OPACITY) / 2, 6);
});

test('fadeOpacity returns 1.0 immediately when duration is zero — defensive', () => {
  expect(fadeOpacity(0, 0, FADE_START_OPACITY)).toBe(1);
});
