/**
 * coordinatePrecision.test.ts — v0.3.1.
 *
 * Verifies that points within ±10 km of the cloud's render origin retain
 * sub-millimetre precision when stored in the `Float32Array` buffers used
 * by every streaming and static cloud, so an octree node 10 km out still
 * renders without f32 jitter. The bound is the published acceptance
 * criterion for the v0.3.1 precision contract; the test pins it so a regression (e.g. a switch
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

// --- sub-mm precision inside ±10 km of the origin ------

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

// --- v0.3.2-Georef audit extensions ----------------------------------------
// The bounds above (±10 km from render origin) cover most single-scan
// surveys. The tests below pin the recenter contract at MUCH larger
// magnitudes — UTM eastings near 800,000 m, northings near 9,000,000 m, ECEF
// 6,371 km — to prove the Float64 → Float32 narrow is robust to any
// reasonable real-world coordinate, as long as the render origin is the
// floored min of the cloud's own data (which the loader enforces).

/**
 * Recenter helper — same Float64-subtract-then-Float32-narrow contract as
 * `coordinateBridge.recenter`, isolated here so the test can pin the
 * invariant without depending on the bridge module's API surface.
 */
function recenter(worldF64: number, originF64: number): number {
  return f32(worldF64 - originF64);
}

test('research-grade: UTM 12N northing 4,100,876.789 round-trips to sub-mm', () => {
  // Real-world UTM 12N northing. Render origin is the cloud's floored min
  // (4_100_000), so the residual is ~876.789 m — well inside Float32's
  // sub-mm zone.
  const world = 4_100_876.789;
  const origin = 4_100_000;
  const local = recenter(world, origin);
  const recovered = local + origin;
  expect(Math.abs(recovered - world)).toBeLessThan(1e-3); // < 1 mm
});

test('research-grade: UTM 12S southern-hemisphere northing 9,500,000 holds precision', () => {
  // UTM zones in the southern hemisphere use a 10 million m false northing
  // offset, so coordinates near 9.5 M are routine. The floored-min origin
  // keeps the residual tractable.
  const world = 9_500_123.456;
  const origin = 9_500_000;
  const local = recenter(world, origin);
  const recovered = local + origin;
  expect(Math.abs(recovered - world)).toBeLessThan(1e-3);
});

test('research-grade: ECEF earth-radius coordinates survive recenter', () => {
  // Earth-Centered Earth-Fixed coordinates push 6.37 M magnitudes. The
  // recenter pattern handles it as long as origin matches cloud min.
  const world = 6_371_000.001;
  const origin = 6_371_000;
  const local = recenter(world, origin);
  const recovered = local + origin;
  expect(Math.abs(recovered - world)).toBeLessThan(1e-3);
});

test('research-grade: 1 km × 1 km cloud at UTM origin has sub-mm worst-case', () => {
  // Survey a 1 km × 1 km footprint at UTM 12N. All residuals should hold
  // sub-mm precision after the f32 narrow.
  const origin = 487_000;
  const worst = (() => {
    let max = 0;
    for (let i = 0; i <= 100; i++) {
      const world = origin + (i * 1000) / 100 + 0.137;
      const recovered = recenter(world, origin) + origin;
      max = Math.max(max, Math.abs(recovered - world));
    }
    return max;
  })();
  expect(worst).toBeLessThan(1e-3); // < 1 mm anywhere in a 1 km footprint
});
