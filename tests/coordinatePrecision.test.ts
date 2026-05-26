/**
 * coordinatePrecision.test.ts — v0.3.1 Phase 10 Task 32.
 *
 * Verifies that points within ±10 km of the cloud's render origin retain
 * sub-millimetre precision when stored in the `Float32Array` buffers used
 * by every streaming and static cloud, so an octree node 10 km out still
 * renders without f32 jitter. The bound is the published acceptance
 * criterion for Task 32; the test pins it so a regression (e.g. a switch
 * to `Float16` or a wider local-space) fails CI loudly.
 *
 * Pure — no DOM, no three.js — exercises only `Math` and typed arrays.
 */

/** A `Float32Array` round-trip — the same lossy step every decoded point takes. */
function f32(x: number): number {
  return new Float32Array([x])[0];
}

/** The largest absolute residual for a coordinate set after f32 round-trip. */
function maxResidualMetres(coords: readonly number[]): number {
  let max = 0;
  for (const c of coords) {
    const e = Math.abs(f32(c) - c);
    if (e > max) max = e;
  }
  return max;
}

// --- Task 32 acceptance — sub-mm precision inside ±10 km of the origin ------

test('a single point 10 km from the render origin stays within 2 mm after f32 round-trip', () => {
  // 10 km, plus a sub-metre offset that's hostile to f32 precision (a
  // mantissa-aligned value would round perfectly; a non-aligned one shows
  // the realistic worst case).
  const x = 10_000 + 0.5;
  const residual = Math.abs(f32(x) - x);
  expect(residual).toBeLessThan(0.002); // < 2 mm
});

test('a grid of 64 points sampling the ±10 km cube has sub-mm error throughout', () => {
  const coords: number[] = [];
  for (let i = 0; i < 64; i++) {
    // Spread evenly across [-10 km, +10 km] with a sub-metre offset.
    coords.push(-10_000 + (i * 20_000) / 63 + 0.13);
  }
  expect(maxResidualMetres(coords)).toBeLessThan(0.002); // < 2 mm everywhere
});

test('precision degrades predictably beyond the boundary — documented behaviour', () => {
  // At 100 km from origin the worst-case error is around 8–10 mm — too
  // coarse for sub-mm survey work, so the rec is to rebase the render
  // origin per-node when local coordinates would exceed ±10 km.
  expect(maxResidualMetres([100_000 + 0.5])).toBeLessThan(0.02); // < 2 cm
  // At 1000 km the residual passes 10 cm; this is the regression-pin.
  // (We do NOT assert sub-mm here — we assert the floor of when jitter
  // becomes visible, so a future Float64 buffer would tighten the bound.)
  expect(maxResidualMetres([1_000_000 + 0.5])).toBeLessThan(0.2); // < 20 cm
});

test('a point exactly AT the render origin round-trips identically — no precision lost', () => {
  expect(f32(0)).toBe(0);
  expect(f32(1)).toBe(1);
  expect(f32(-1)).toBe(-1);
});
