import { edlObscurance, edlShade, edlDefaultEnabled } from '../src/render/edl';

// ────────────────────────────────────────────────────────────────────────────
// edlObscurance — the log2(eye-distance) depth-discontinuity sum
// ────────────────────────────────────────────────────────────────────────────

describe('edlObscurance', () => {
  test('a flat surface (center equals every neighbour) has zero obscurance', () => {
    expect(edlObscurance(10, [10, 10, 10, 10])).toBe(0);
  });

  test('a center behind its neighbours accumulates positive obscurance', () => {
    // Center is farther (20) than neighbours (10) — the receding side of an edge.
    expect(edlObscurance(20, [10, 10, 10, 10])).toBeGreaterThan(0);
  });

  test('a center in front of its neighbours has zero obscurance', () => {
    // Center nearer (10) than neighbours (20): max(0, …) clamps every term.
    expect(edlObscurance(10, [20, 20, 20, 20])).toBe(0);
  });

  test('only neighbours nearer than the center contribute', () => {
    // Two neighbours nearer, two farther — only the nearer two count.
    const mixed = edlObscurance(16, [8, 8, 32, 32]);
    const onlyNear = edlObscurance(16, [8, 8]);
    expect(mixed).toBeCloseTo(onlyNear, 10);
  });

  test('is scale-invariant — doubling every distance leaves obscurance unchanged', () => {
    const base = edlObscurance(20, [10, 12, 15, 40]);
    const scaled = edlObscurance(40, [20, 24, 30, 80]);
    expect(scaled).toBeCloseTo(base, 10);
  });

  test('no neighbours yields zero obscurance', () => {
    expect(edlObscurance(10, [])).toBe(0);
  });

  test('a zero distance is floored rather than producing NaN or Infinity', () => {
    const result = edlObscurance(10, [0, 0]);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// edlShade — obscurance → [0,1] shading factor
// ────────────────────────────────────────────────────────────────────────────

describe('edlShade', () => {
  test('zero obscurance leaves the pixel untouched (factor 1)', () => {
    expect(edlShade(0, 0.5)).toBe(1);
  });

  test('positive obscurance darkens the pixel (factor strictly between 0 and 1)', () => {
    const s = edlShade(2, 0.5);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  test('higher strength darkens more', () => {
    expect(edlShade(2, 1.0)).toBeLessThan(edlShade(2, 0.3));
  });

  test('zero strength leaves any pixel untouched', () => {
    expect(edlShade(5, 0)).toBe(1);
  });

  test('negative strength is clamped to zero (no brightening)', () => {
    expect(edlShade(5, -1)).toBe(1);
  });

  test('the factor never leaves the [0,1] range', () => {
    for (const o of [0, 0.5, 5, 50, 500]) {
      for (const st of [0, 0.5, 1.5, 10]) {
        const s = edlShade(o, st);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// edlDefaultEnabled — the capability gate
// ────────────────────────────────────────────────────────────────────────────

describe('edlDefaultEnabled', () => {
  test('on by default for WebGPU on a non-mobile device', () => {
    expect(edlDefaultEnabled('webgpu', false)).toBe(true);
  });

  test('off by default for WebGPU on a mobile device', () => {
    expect(edlDefaultEnabled('webgpu', true)).toBe(false);
  });

  test('off by default on the WebGL 2 fallback backend', () => {
    expect(edlDefaultEnabled('webgl2', false)).toBe(false);
    expect(edlDefaultEnabled('webgl2', true)).toBe(false);
  });
});
