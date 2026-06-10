import {
  edlObscurance,
  edlShade,
  edlDefaultEnabled,
  eyeDistanceToLogDepth,
  logDepthToEyeDistance,
} from '../src/render/edl';

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

  test('a near-flat surface within the depth bias yields zero obscurance', () => {
    // ±2% depth jitter — the kind a finite-precision depth buffer produces on
    // a flat surface. The noise gate must suppress it so EDL does not shimmer.
    expect(edlObscurance(10, [10.2, 10.2, 9.8, 9.8])).toBe(0);
  });

  test('a sub-bias depth step is ignored, but a larger step still counts', () => {
    // log2(10 / 9.6) ≈ 0.06 — below the 0.1 bias → ignored.
    expect(edlObscurance(10, [9.6])).toBe(0);
    // log2(10 / 7) ≈ 0.51 — well above the bias → a real edge, counted.
    expect(edlObscurance(10, [7])).toBeGreaterThan(0);
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
// logDepthToEyeDistance — inverting the logarithmic depth-buffer encoding
//
// The renderer draws with `logarithmicDepthBuffer: true`, so the EDL pass
// samples Ulrich near-anchored log depth, not standard perspective depth:
//     raw = log2(eyeDist / near') / log2(far / near'),  near' = max(near, 1e-6)
// These tests pin the CPU twin of the GPU inversion node in `Viewer.ts`.
// ────────────────────────────────────────────────────────────────────────────

describe('logDepthToEyeDistance', () => {
  // The Viewer's actual camera planes at construction.
  const NEAR = 0.1;
  const FAR = 5_000_000;

  test('hand-computed point: near=1, far=1024 — eye distance 32 encodes to exactly 0.5', () => {
    // Forward: log2(32 / 1) / log2(1024 / 1) = 5 / 10 = 0.5.
    expect(eyeDistanceToLogDepth(32, 1, 1024)).toBeCloseTo(0.5, 12);
    // Inverse: 1 · 2^(0.5 · log2(1024)) = 2^5 = 32.
    expect(logDepthToEyeDistance(0.5, 1, 1024)).toBeCloseTo(32, 10);
  });

  test('depth 0 decodes to the near plane, depth 1 to the far plane', () => {
    expect(logDepthToEyeDistance(0, NEAR, FAR)).toBeCloseTo(NEAR, 10);
    // Far is huge, so compare with a relative tolerance.
    expect(logDepthToEyeDistance(1, NEAR, FAR) / FAR).toBeCloseTo(1, 10);
  });

  test('the near and far planes encode to depth 0 and 1', () => {
    expect(eyeDistanceToLogDepth(NEAR, NEAR, FAR)).toBeCloseTo(0, 12);
    expect(eyeDistanceToLogDepth(FAR, NEAR, FAR)).toBeCloseTo(1, 12);
  });

  test('round-trips across seven orders of magnitude of eye distance', () => {
    // A 5 m indoor scan and a 50 km survey share one depth buffer — the
    // inversion must be exact everywhere in between, not just at the planes.
    for (const d of [0.1, 0.5, 5, 120, 9_876.5, 1_000_000, 4_999_999]) {
      const raw = eyeDistanceToLogDepth(d, NEAR, FAR);
      expect(raw).toBeGreaterThanOrEqual(0);
      expect(raw).toBeLessThanOrEqual(1);
      // Relative comparison: distances span 0.1 … 5e6.
      expect(logDepthToEyeDistance(raw, NEAR, FAR) / d).toBeCloseTo(1, 8);
    }
  });

  test('is strictly monotonic — a deeper sample decodes to a larger distance', () => {
    let prev = 0;
    for (const raw of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const d = logDepthToEyeDistance(raw, NEAR, FAR);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  test('a degenerate near plane of 0 is clamped (to 1e-6) instead of dividing by zero', () => {
    const raw = eyeDistanceToLogDepth(10, 0, 1000);
    expect(Number.isFinite(raw)).toBe(true);
    expect(logDepthToEyeDistance(raw, 0, 1000) / 10).toBeCloseTo(1, 8);
  });

  test('keeps the 1e-4 distance floor so the downstream log2 stays finite', () => {
    // raw = 0 with a zero near plane decodes to the clamped near of 1e-6,
    // which the MIN_DIST floor lifts to 1e-4 — same semantics as the GPU
    // node's max(…, 1e-4) and edlObscurance's own floor.
    expect(logDepthToEyeDistance(0, 0, 1000)).toBe(1e-4);
    expect(Number.isFinite(Math.log2(logDepthToEyeDistance(0, 0, 1000)))).toBe(true);
  });

  test('mis-decoding log depth with the perspective formula is badly wrong (the fixed bug)', () => {
    // The defect this inversion fixes: a mid-scene point at 707 m
    // (geometric mean of near/far ≈ sqrt(0.1 · 5e6)) log-encodes to ~0.5.
    // The standard perspective inversion near·far/(far − (far−near)·raw)
    // would read that sample as ~0.2 m — off by more than three orders of
    // magnitude, which is why EDL obscurance landed in the wrong space.
    const trueDist = Math.sqrt(NEAR * FAR); // ≈ 707.1
    const raw = eyeDistanceToLogDepth(trueDist, NEAR, FAR);
    const perspectiveMisread = (NEAR * FAR) / (FAR - (FAR - NEAR) * raw);
    expect(logDepthToEyeDistance(raw, NEAR, FAR) / trueDist).toBeCloseTo(1, 8);
    expect(perspectiveMisread).toBeLessThan(trueDist / 1000);
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
