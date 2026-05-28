import {
  fadeOpacity,
  FADE_MS,
  FADE_START_OPACITY,
} from '../src/render/streaming/StreamingRenderer';

// --- node fade-in math ------------------------------------

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

test('fadeOpacity at half-elapsed follows ease-out cubic, biased toward the end opacity', () => {
  // v0.3.4 — fade uses ease-out cubic (1 - (1 - t)^3). At t = 0.5 the eased
  // value is 1 - 0.125 = 0.875, so the half-elapsed opacity is
  // start + (1 - start) * 0.875 — biased toward the end opacity for a
  // softer "settling" feel.
  const mid = fadeOpacity(FADE_MS / 2, FADE_MS, FADE_START_OPACITY);
  expect(mid).toBeCloseTo(FADE_START_OPACITY + (1 - FADE_START_OPACITY) * 0.875, 6);
  // The eased midpoint is strictly above the linear midpoint — proves the
  // ease-out direction (a regression that switched to ease-in would fail).
  const linearMid = FADE_START_OPACITY + (1 - FADE_START_OPACITY) / 2;
  expect(mid).toBeGreaterThan(linearMid);
});

test('fadeOpacity returns 1.0 immediately when duration is zero — defensive', () => {
  expect(fadeOpacity(0, 0, FADE_START_OPACITY)).toBe(1);
});
