/**
 * tests/terrainDescriptorSyntheticTruth.test.ts
 *
 * SYNTHETIC KNOWN-TRUTH validation for the terrain descriptors:
 *   VRM — computeVRM, src/terrain/complexity/vectorRuggedness.ts
 *   TPI — computeTPI, src/terrain/complexity/terrainPositionIndex.ts
 *
 * Claim under test: VRM-TPI.
 *
 * RELATIONSHIP TO tests/terrainComplexity.test.ts. That file establishes the
 * definitions on small hand-computed grids (flat, planar slope, single ridge,
 * single pit, NoData handling). This file adds CLOSED-FORM ANALYTIC FAMILIES:
 * surfaces whose descriptor value is a formula in the surface parameter and
 * the window size, so a whole family is checked at once rather than one grid
 * per case. The two closed forms it leans on:
 *
 *   TPI on a quadratic surface. For z = a(u² + v²) and any offset set
 *   symmetric under (du,dv) → (−du,−dv), the linear terms cancel and
 *       TPI = −a · mean(du² + dv²)   over the offset set.
 *   The descriptor is therefore a scaled DISCRETE LAPLACIAN, and its value at
 *   a given cell is a pure function of the window's second moment — which is
 *   exactly why it is scale-sensitive, and by how much.
 *
 *   VRM on a two-orientation surface. Give p window cells the unit normal
 *   (sinθ cos α, sinθ sin α, cosθ) and q cells its horizontal mirror
 *   (aspect α + π). Then Σn = ((p−q) sinθ cosα, (p−q) sinθ sinα, (p+q) cosθ),
 *       R = √((p−q)² sin²θ + n² cos²θ),  VRM = 1 − R/n,  n = p + q.
 *   Every VRM number below is that formula with p, q counted by hand for the
 *   named cell, so the assertion is arithmetic the reader can redo.
 *
 * The slope/aspect inputs for the VRM family are BUILT DIRECTLY rather than
 * derived, so the closed form is exact and the test does not depend on the
 * derivative kernel. Two scenes go through `hornSlopeAspect` as a read-only
 * import to confirm the descriptors connect to the shipped pipeline; neither
 * this file nor the claim it supports modifies terrainDerivatives.ts.
 *
 * HONESTY. Synthetic validation is not field validation, and neither
 * descriptor has been compared against a second implementation (GDAL, SAGA,
 * the ArcGIS VRM toolbox). These tests establish that the shipped code
 * computes the definitions it documents, on surfaces where the definitions
 * have closed-form answers. They establish nothing about agreement with any
 * other software, and nothing about real terrain.
 *
 * Pure Node: no DOM, no three.js, no network.
 */

import { describe, test, expect } from 'vitest';
import { computeTPI, TPI_CLASS } from '../src/terrain/complexity/terrainPositionIndex';
import { computeVRM } from '../src/terrain/complexity/vectorRuggedness';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

/** Row-major grid builder: z(row, col). */
function grid(cols: number, rows: number, f: (row: number, col: number) => number): Float32Array {
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = f(r, c);
  return z;
}

const at = (cols: number) => (r: number, c: number) => r * cols + c;

/**
 * VRM closed form for a window holding p normals at aspect α and q at α + π,
 * all at the same slope tangent m. See the header derivation.
 */
function vrmTwoOrientation(p: number, q: number, m: number): number {
  const n = p + q;
  const cosT = 1 / Math.sqrt(1 + m * m);
  const sinT = m * cosT;
  const d = p - q;
  const R = Math.sqrt(d * d * sinT * sinT + n * n * cosT * cosT);
  return 1 - R / n;
}

// ═══ TPI — quadratic surfaces, the discrete-Laplacian closed form ═══════════

describe('TPI closed form — bowl z = a(u² + v²) reads −a at EVERY interior cell', () => {
  // 13 × 13 grid, origin at the centre cell (6, 6): u = c − 6, v = r − 6.
  // Radius-1 circle = the four rook neighbours, Σ(du² + dv²) = 4, mean = 1,
  //   ⇒ TPI = −a exactly, INDEPENDENT of position — a bowl has the same
  //   relative position everywhere, which is the correct answer for a
  //   constant-curvature surface and a non-obvious one.
  const cols = 13;
  const rows = 13;
  const a = 0.5;
  const idx = at(cols);
  const z = grid(cols, rows, (r, c) => a * ((c - 6) ** 2 + (r - 6) ** 2));
  const res = computeTPI(z, cols, rows, { radiusCells: 1 });

  test('every interior cell is exactly −a = −0.5', () => {
    // z values are multiples of 0.5 up to 36 — binary-exact in Float32 — and
    // TPI is O(1), so 1e-6 is Float32 storage of the OUTPUT only.
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) expect(res.tpi[idx(r, c)]).toBeCloseTo(-a, 6);
    }
  });

  test('a dome (−a) mirrors it exactly: +a everywhere interior', () => {
    const dome = grid(cols, rows, (r, c) => -a * ((c - 6) ** 2 + (r - 6) ** 2));
    const dRes = computeTPI(dome, cols, rows, { radiusCells: 1 });
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) expect(dRes.tpi[idx(r, c)]).toBeCloseTo(a, 6);
    }
  });

  test('the sign convention holds: pit negative, peak positive', () => {
    expect(res.tpi[idx(6, 6)]).toBeLessThan(0); // bowl floor
    const dome = grid(cols, rows, (r, c) => -a * ((c - 6) ** 2 + (r - 6) ** 2));
    expect(computeTPI(dome, cols, rows, { radiusCells: 1 }).tpi[idx(6, 6)]).toBeGreaterThan(0);
  });
});

describe('TPI closed form — SCALE SENSITIVITY is a factor of 7/3 between radius 1 and 2', () => {
  // Registered failure mode: "scale sensitivity". On the same bowl,
  //   radius 1: 4 offsets, Σ(du²+dv²) = 4,  mean 1    ⇒ TPI = −a
  //   radius 2: 12 offsets — 4 at d²=1, 4 at d²=2, 4 at d²=4 —
  //             Σ = 4 + 8 + 16 = 28, mean 7/3         ⇒ TPI = −7a/3
  // The SAME cell on the SAME surface reports −0.5 or −1.1666…, a 2.33×
  // difference, purely from the radius. A VRM/TPI figure without its
  // neighbourhood stated is not a figure.
  const cols = 17;
  const rows = 17;
  const a = 0.5;
  const idx = at(cols);
  const z = grid(cols, rows, (r, c) => a * ((c - 8) ** 2 + (r - 8) ** 2));
  const r1 = computeTPI(z, cols, rows, { radiusCells: 1 });
  const r2 = computeTPI(z, cols, rows, { radiusCells: 2 });

  test('radius 2 interior is exactly −7a/3', () => {
    for (let r = 2; r < rows - 2; r++) {
      for (let c = 2; c < cols - 2; c++) {
        expect(r2.tpi[idx(r, c)]).toBeCloseTo((-7 * a) / 3, 5);
      }
    }
  });

  test('the ratio between the two radii is exactly 7/3 at the same cell', () => {
    // 1e-5 absolute on a ratio of two O(1) Float32 values.
    expect(r2.tpi[idx(8, 8)] / r1.tpi[idx(8, 8)]).toBeCloseTo(7 / 3, 5);
  });

  test('the offset count behind each radius is what the closed form assumed', () => {
    // Cross-check via the support bookkeeping rather than by re-deriving the
    // window: a radius-2 interior cell has a FULL window, so the border ring
    // that is truncated must be two cells deep (17² − 13² = 120 cells).
    expect(r2.truncatedWindowCount).toBe(cols * rows - (cols - 4) * (rows - 4));
    expect(r1.truncatedWindowCount).toBe(cols * rows - (cols - 2) * (rows - 2));
  });
});

describe('TPI closed form — EDGE EFFECTS flip the sign on a bowl', () => {
  // Registered failure mode: "edge effects" / register scope: "Cells near the
  // grid edge" is unsupported. This scene quantifies why.
  //
  // Bowl z = a(u² + v²) on 13 × 13, u = c − 6, v = r − 6, radius 1.
  //   interior      : TPI = −a                       = −0.5
  //   west edge c=0 : surviving neighbours (u+1,v), (u,v±1)
  //                   ⇒ TPI = −a(2u + 3)/3, u = −6   = +3a = +1.5
  //   east edge c=12: mirror, TPI = a(2u − 3)/3, u=6  = +3a = +1.5
  //   corner (0,0)  : neighbours (u+1,v), (u,v+1)
  //                   ⇒ TPI = −a(u + v + 1), u=v=−6   = +5.5
  // The border ring reports the OPPOSITE SIGN to the interior of the same
  // bowl, at 3× to 11× the magnitude. Edge TPI is not comparable to interior
  // TPI — it answers a different question against a one-sided neighbourhood.
  const cols = 13;
  const rows = 13;
  const a = 0.5;
  const idx = at(cols);
  const z = grid(cols, rows, (r, c) => a * ((c - 6) ** 2 + (r - 6) ** 2));
  const res = computeTPI(z, cols, rows, { radiusCells: 1 });

  test('west and east edge cells both read +3a, against an interior −a', () => {
    expect(res.tpi[idx(6, 0)]).toBeCloseTo(3 * a, 5);
    expect(res.tpi[idx(6, cols - 1)]).toBeCloseTo(3 * a, 5);
    expect(res.tpi[idx(6, 6)]).toBeCloseTo(-a, 6);
  });

  test('north and south edges mirror it (the window shrinks, never wraps)', () => {
    expect(res.tpi[idx(0, 6)]).toBeCloseTo(3 * a, 5);
    expect(res.tpi[idx(rows - 1, 6)]).toBeCloseTo(3 * a, 5);
  });

  test('corners read −a(u+v+1) = +5.5 — eleven times the interior magnitude', () => {
    expect(res.tpi[idx(0, 0)]).toBeCloseTo(5.5, 5);
    expect(res.tpi[idx(0, cols - 1)]).toBeCloseTo(5.5, 5);
    expect(res.tpi[idx(rows - 1, 0)]).toBeCloseTo(5.5, 5);
    expect(res.tpi[idx(rows - 1, cols - 1)]).toBeCloseTo(5.5, 5);
  });

  test('the artefact is DISCLOSED — truncation is counted and warned about', () => {
    // The behaviour above is not silently wrong: every affected cell is
    // counted, meanWindowSupport drops below 1, and a warning names it. That
    // is the difference between a documented limit and a defect.
    expect(res.truncatedWindowCount).toBe(cols * rows - (cols - 2) * (rows - 2));
    expect(res.meanWindowSupport).toBeLessThan(1);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  test('the border artefact leaks into the CLASSES: a bowl rim classifies ridge', () => {
    // stdTPI standardises over all valid cells, edge cells included, so the
    // border's +5.5 sits far above +1 SD and Weiss-classifies as ridge on a
    // surface that is a bowl everywhere. Classification inherits the edge
    // caveat; it is not a separate, safer product.
    const slope = new Float32Array(cols * rows); // 0 ⇒ flat/middle split is moot
    const withClasses = computeTPI(z, cols, rows, { radiusCells: 1, slope });
    expect(withClasses.stdTpi[idx(0, 0)]).toBeGreaterThan(1);
    expect(withClasses.classes![idx(0, 0)]).toBe(TPI_CLASS.ridge);
  });
});

describe('TPI blind spot — a saddle reads 0 at every scale', () => {
  // z = a(u² − v²): a genuine saddle, strongly curved in both directions.
  // The Laplacian is zero, so TPI = −a·mean(du² − dv²) = 0 for ANY offset set
  // symmetric in du/dv. TPI ≈ 0 therefore does NOT mean "flat" — it means
  // "at the neighbourhood mean", which a saddle is. Recorded here so the
  // approved claim ("relative-position index") is not read as a flatness test.
  const cols = 17;
  const rows = 17;
  const a = 0.25;
  const idx = at(cols);
  const z = grid(cols, rows, (r, c) => a * ((c - 8) ** 2 - (r - 8) ** 2));
  const r1 = computeTPI(z, cols, rows, { radiusCells: 1 });
  const r2 = computeTPI(z, cols, rows, { radiusCells: 2 });

  test('interior TPI is 0 at radius 1 and radius 2 alike', () => {
    for (let r = 2; r < rows - 2; r++) {
      for (let c = 2; c < cols - 2; c++) {
        // 1e-4 absolute: the cancellation is exact in exact arithmetic, but
        // the z field reaches ±16 and TPI is a difference of Float32 sums.
        expect(Math.abs(r1.tpi[idx(r, c)])).toBeLessThan(1e-4);
        expect(Math.abs(r2.tpi[idx(r, c)])).toBeLessThan(1e-4);
      }
    }
  });

  test('VRM on the SAME saddle is non-zero — the descriptors are complementary', () => {
    // The normals genuinely decohere across a saddle, so the ruggedness
    // measure sees what the position index cannot. Asserted as a direction,
    // not a magnitude: the magnitude depends on the derivative kernel.
    const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);
    const vrm = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });
    expect(vrm.vrm[idx(8, 8)]).toBeGreaterThan(1e-4);
    expect(vrm.summary.median).toBeGreaterThan(0);
  });
});

// ═══ VRM — the two-orientation closed form ══════════════════════════════════

/** Build constant-slope, two-aspect grids directly (see the header). */
function twoAspect(
  cols: number,
  rows: number,
  m: number,
  alpha: number,
  isFlipped: (row: number, col: number) => boolean,
): { slope: Float32Array; aspect: Float32Array } {
  const slope = new Float32Array(cols * rows).fill(m);
  const aspect = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      aspect[r * cols + c] = isFlipped(r, c) ? alpha + Math.PI : alpha;
    }
  }
  return { slope, aspect };
}

describe('VRM closed form — a uniform plane is 0 at ANY slope, including vertical-ish', () => {
  // Slope-independence is the defining property (register: "Ruggedness ...
  // indices"), and the existing suite proves it at m = 1 via Horn. Here it is
  // asserted as a FAMILY: p = n, q = 0 ⇒ R = n ⇒ VRM = 0 for every m.
  const cols = 9;
  const rows = 9;

  test.each([0, 0.1, 1, 5, 100, 1e6])('m = %p ⇒ VRM 0 everywhere, edges included', (m) => {
    const { slope, aspect } = twoAspect(cols, rows, m, 1.234, () => false);
    const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });
    // Identical unit vectors sum without cancellation, so this is exact up to
    // the accumulation of n identical Float64 terms — 1e-9 is generous.
    for (let i = 0; i < cols * rows; i++) expect(res.vrm[i]).toBeCloseTo(0, 9);
    expect(res.summary.median).toBeCloseTo(0, 9);
  });
});

describe('VRM closed form — checkerboard of opposed aspects, exact per window size', () => {
  // Aspect alternates α / α+π on a checkerboard at constant m = 1 (θ = 45°).
  //   window 3 interior: p = 5, q = 4 ⇒ VRM = 1 − √41/9      = 0.2885417…
  //   window 5 interior: p = 13, q = 12 ⇒ VRM = 1 − √313/25  = 0.2923271…
  // Both are the closed form with p, q counted by parity on the window.
  const cols = 15;
  const rows = 15;
  const m = 1;
  const idx = at(cols);
  const { slope, aspect } = twoAspect(cols, rows, m, 0.7, (r, c) => (r + c) % 2 === 1);
  const w3 = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });
  const w5 = computeVRM(slope, aspect, cols, rows, { windowCells: 5 });

  test('window 3 interior equals 1 − √41/9 at every interior cell', () => {
    const expected = vrmTwoOrientation(5, 4, m);
    expect(expected).toBeCloseTo(1 - Math.sqrt(41) / 9, 12); // the helper IS the formula
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        // Float32 output storage of an O(0.1) value ⇒ 1e-6 absolute.
        expect(w3.vrm[idx(r, c)]).toBeCloseTo(expected, 6);
      }
    }
  });

  test('window 5 interior equals 1 − √313/25 — a different number on the same surface', () => {
    const expected = vrmTwoOrientation(13, 12, m);
    expect(expected).toBeCloseTo(1 - Math.sqrt(313) / 25, 12);
    for (let r = 2; r < rows - 2; r++) {
      for (let c = 2; c < cols - 2; c++) expect(w5.vrm[idx(r, c)]).toBeCloseTo(expected, 6);
    }
    expect(expected).not.toBeCloseTo(vrmTwoOrientation(5, 4, m), 3);
  });
});

describe('VRM closed form — SCALE SENSITIVITY: the same cell reads 0 or 0.175', () => {
  // Registered failure mode: "scale sensitivity". A half-plane of opposed
  // aspects: columns < 8 at α, columns ≥ 8 at α + π, constant m = 1.
  //   cell (7, 6), window 3: covers columns 5–7, all at α ⇒ p = 9, q = 0
  //                          ⇒ VRM = 0 — the cell looks perfectly smooth.
  //   cell (7, 6), window 5: covers columns 4–8; column 8 is flipped
  //                          ⇒ p = 20, q = 5 ⇒ VRM = 1 − √425/25 = 0.1753…
  // Identical terrain, identical cell, two answers three decades apart. The
  // register's "Neighbourhood radii other than the documented one" exclusion
  // is doing real work.
  const cols = 17;
  const rows = 17;
  const m = 1;
  const idx = at(cols);
  const { slope, aspect } = twoAspect(cols, rows, m, 0.3, (_r, c) => c >= 8);
  const w3 = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });
  const w5 = computeVRM(slope, aspect, cols, rows, { windowCells: 5 });

  test('two columns from the discontinuity: window 3 sees nothing', () => {
    expect(w3.vrm[idx(8, 6)]).toBeCloseTo(0, 9);
  });

  test('the same cell under window 5 reads 1 − √425/25 = 0.17538…', () => {
    const expected = vrmTwoOrientation(20, 5, m);
    expect(expected).toBeCloseTo(1 - Math.sqrt(425) / 25, 12);
    expect(w5.vrm[idx(8, 6)]).toBeCloseTo(expected, 6);
  });

  test('on the discontinuity itself both windows fire, with different values', () => {
    // cell (8, 8), window 3: columns 7,8,9 ⇒ p = 3 (col 7), q = 6 ⇒ 1 − √45/9
    // cell (8, 8), window 5: columns 6–10 ⇒ p = 10, q = 15       ⇒ 1 − √325/25
    expect(w3.vrm[idx(8, 8)]).toBeCloseTo(vrmTwoOrientation(3, 6, m), 6);
    expect(w5.vrm[idx(8, 8)]).toBeCloseTo(vrmTwoOrientation(10, 15, m), 6);
    expect(w3.vrm[idx(8, 8)]).not.toBeCloseTo(w5.vrm[idx(8, 8)], 3);
  });
});

describe('VRM closed form — the [0,1] range is reached as slope steepens', () => {
  // Balanced opposition (p = q) collapses the horizontal sum, leaving
  // R = n cosθ ⇒ VRM = 1 − cosθ = 1 − 1/√(1+m²). So VRM → 1 requires a
  // vertical face, and the practical ceiling on real terrain is far below 1:
  // a 45° face in perfect opposition reads only 0.293.
  test.each([
    [1, 1 - Math.SQRT1_2],
    [3, 1 - 1 / Math.sqrt(10)],
    [1000, 1 - 1 / Math.sqrt(1000001)],
  ])('m = %p ⇒ balanced-window VRM = 1 − cosθ = %p', (m, expected) => {
    // A 2 × 2 corner window on a column-alternating pattern is exactly
    // balanced (p = q = 2).
    const { slope, aspect } = twoAspect(4, 4, m, 0.0, (_r, c) => c % 2 === 1);
    const res = computeVRM(slope, aspect, 4, 4, { windowCells: 3 });
    expect(res.vrm[0]).toBeCloseTo(expected, 6);
    expect(res.vrm[0]).toBeGreaterThanOrEqual(0);
    expect(res.vrm[0]).toBeLessThanOrEqual(1);
  });
});

describe('VRM — EDGE EFFECTS: the truncated corner window changes the answer', () => {
  // Registered failure mode: "edge effects". On the checkerboard at m = 1:
  //   interior (window 3, p=5 q=4): 1 − √41/9   = 0.288542
  //   corner   (window 2×2, p=q=2): 1 − cosθ    = 0.292893
  // The corner is not merely "less supported" — it is a DIFFERENT ESTIMATOR
  // (4 normals, balanced) whose value happens to sit near the interior one on
  // this surface and need not on another.
  const cols = 15;
  const rows = 15;
  const m = 1;
  const idx = at(cols);
  const { slope, aspect } = twoAspect(cols, rows, m, 0.7, (r, c) => (r + c) % 2 === 1);
  const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });

  test('the corner equals the balanced 2×2 closed form, not the interior value', () => {
    expect(res.vrm[idx(0, 0)]).toBeCloseTo(vrmTwoOrientation(2, 2, m), 6);
    expect(res.vrm[idx(0, 0)]).not.toBeCloseTo(vrmTwoOrientation(5, 4, m), 4);
  });

  test('a border (non-corner) cell equals the 2×3 = 6-cell closed form', () => {
    // Top edge, column 5: window rows 0–1, cols 4–6 ⇒ 6 cells, parity split
    // 3 / 3 ⇒ balanced again.
    expect(res.vrm[idx(0, 5)]).toBeCloseTo(vrmTwoOrientation(3, 3, m), 6);
  });

  test('every truncated window is counted and warned about', () => {
    expect(res.truncatedWindowCount).toBe(cols * rows - (cols - 2) * (rows - 2));
    expect(res.meanWindowSupport).toBeLessThan(1);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });
});

describe('VRM — sparse coverage manufactures a FALSE ZERO', () => {
  // Registered failure mode: "edge effects" in its NoData form. A cell whose
  // window has been emptied by the validity mask down to itself has n = 1,
  // R = 1, VRM = 0 — indistinguishable in the raster from genuinely smooth
  // terrain, on a surface that is maximally rugged. The module's own header
  // calls this out; this test pins it as observable behaviour, and pins the
  // disclosure channels that let a caller catch it.
  const cols = 5;
  const rows = 5;
  const m = 1;
  const idx = at(cols);
  const { slope, aspect } = twoAspect(cols, rows, m, 0.4, (r, c) => (r + c) % 2 === 1);
  const valid = new Uint8Array(cols * rows); // all masked out…
  valid[idx(2, 2)] = 1; // …except one isolated cell
  const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3, valid });

  test('the isolated cell reports VRM 0 — a smooth reading on rugged ground', () => {
    expect(res.vrm[idx(2, 2)]).toBeCloseTo(0, 12);
    expect(res.validCellCount).toBe(1);
  });

  test('the false zero is detectable only through the support fields', () => {
    // meanWindowSupport = 1/9: the single honest signal that this 0 rests on
    // one normal rather than nine. A consumer that reads only `vrm` cannot
    // tell. Any export of VRM must carry these fields with it.
    expect(res.meanWindowSupport).toBeCloseTo(1 / 9, 9);
    expect(res.truncatedWindowCount).toBe(1);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  test('a partial hole degrades support proportionally rather than refusing', () => {
    // Half the grid masked: the descriptor still computes everywhere it can,
    // and support falls between the isolated case and 1.
    const half = new Uint8Array(cols * rows).fill(1);
    for (let r = 0; r < rows; r++) for (let c = 0; c < 2; c++) half[idx(r, c)] = 0;
    const partial = computeVRM(slope, aspect, cols, rows, { windowCells: 3, valid: half });
    expect(partial.validCellCount).toBe(rows * (cols - 2));
    expect(partial.meanWindowSupport).toBeGreaterThan(1 / 9);
    expect(partial.meanWindowSupport).toBeLessThan(1);
  });
});

describe('VRM/TPI — the closed forms survive the shipped derivative pipeline', () => {
  // The scenes above feed slope/aspect directly so the closed form is exact.
  // This one goes through `hornSlopeAspect` (read-only import) on a surface
  // whose Horn derivatives are themselves exact, to confirm the descriptors
  // sit correctly on the shipped pipeline rather than only on synthetic input.
  //
  // z = x on a 20 × 20 grid, cell 1: Horn returns tangent 1 everywhere in the
  // interior with a single downslope aspect ⇒ the uniform-plane family above
  // ⇒ VRM 0, and the bowl-family TPI argument gives 0 for a LINEAR surface
  // (mean(du) = 0), independent of radius.
  const cols = 20;
  const rows = 20;
  const idx = at(cols);
  const z = grid(cols, rows, (_r, c) => c);
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);

  test('planar surface: VRM 0 in the deep interior at both window sizes', () => {
    for (const w of [3, 5]) {
      const res = computeVRM(slope, aspect, cols, rows, { windowCells: w });
      const margin = (w - 1) / 2 + 1;
      for (let r = margin; r < rows - margin; r++) {
        for (let c = margin; c < cols - margin; c++) {
          expect(res.vrm[idx(r, c)]).toBeLessThan(1e-9);
        }
      }
    }
  });

  test('planar surface: TPI 0 in the deep interior at both radii', () => {
    for (const radius of [1, 2]) {
      const res = computeTPI(z, cols, rows, { radiusCells: radius });
      for (let r = radius; r < rows - radius; r++) {
        for (let c = radius; c < cols - radius; c++) {
          expect(Math.abs(res.tpi[idx(r, c)])).toBeLessThan(1e-4);
        }
      }
    }
  });
});
