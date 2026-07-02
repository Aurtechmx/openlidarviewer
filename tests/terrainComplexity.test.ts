/**
 * terrainComplexity.test.ts — analytic truth for the terrain-complexity cores
 * (TPI per Weiss 2001; VRM per Sappington et al. 2007).
 *
 * Every expected value below is HAND-COMPUTED from the definitions on small
 * grids — no golden files, no recorded outputs. The load-bearing assertion is
 * slope-INDEPENDENCE: a constant planar slope has θ > 0 but zero ruggedness
 * (VRM ≈ 0) and zero relative position (TPI ≈ 0 interior); a total-curvature
 * measure would fail it.
 */
import { describe, test, expect } from 'vitest';
import {
  computeTPI,
  TPI_CLASS,
  TPI_FLAT_SLOPE_TAN,
} from '../src/terrain/complexity/terrainPositionIndex';
import { computeVRM } from '../src/terrain/complexity/vectorRuggedness';
import type { TerrainCoverageMeta } from '../src/terrain/TerrainContracts';
import { hornSlope, hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

/** Row-major grid builder: z(row, col). */
function grid(cols: number, rows: number, f: (row: number, col: number) => number): Float32Array {
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = f(r, c);
  return z;
}

const at = (cols: number) => (r: number, c: number) => r * cols + c;

// ── TPI — Weiss (2001) ───────────────────────────────────────────────────────

describe('computeTPI — flat plane', () => {
  const cols = 9;
  const rows = 9;
  const z = grid(cols, rows, () => 5);
  const slope = hornSlope(z, cols, rows, 1);
  const res = computeTPI(z, cols, rows, { radiusCells: 1, slope });

  test('TPI is 0 everywhere (every window mean equals the centre)', () => {
    for (let i = 0; i < cols * rows; i++) expect(res.tpi[i]).toBeCloseTo(0, 9);
    expect(res.mean).toBeCloseTo(0, 9);
    expect(res.stdev).toBeCloseTo(0, 9);
  });

  test('stdev 0 standardises to 0 (not NaN) and classifies flat (θ ≤ 5°)', () => {
    expect(res.classes).not.toBeNull();
    for (let i = 0; i < cols * rows; i++) {
      expect(res.stdTpi[i]).toBe(0);
      expect(res.classes![i]).toBe(TPI_CLASS.flat);
    }
  });

  test('summary carries dispersion, never a bare number', () => {
    expect(res.summary.median).toBeCloseTo(0, 9);
    expect(res.summary.iqr).toBeCloseTo(0, 9);
    expect(res.summary.p75).toBeGreaterThanOrEqual(res.summary.p25);
  });
});

describe('computeTPI — constant planar slope (THE slope-independence case)', () => {
  // z = 0.5·col: θ = atan(0.5) ≈ 26.6° > 5°, yet the terrain has no relative
  // position anywhere — a symmetric window's mean equals the centre exactly.
  const cols = 11;
  const rows = 11;
  const z = grid(cols, rows, (_r, c) => 0.5 * c);
  const slope = hornSlope(z, cols, rows, 1);
  const idx = at(cols);
  const res = computeTPI(z, cols, rows, { radiusCells: 1, slope });

  test('interior TPI ≈ 0 despite θ > 0 (tight tolerance)', () => {
    for (let r = 1; r < rows - 1; r++)
      for (let c = 1; c < cols - 1; c++) expect(Math.abs(res.tpi[idx(r, c)])).toBeLessThan(1e-5);
  });

  test('interior classifies middle slope (|stdTPI| ≤ 0.5 and θ > 5°)', () => {
    expect(slope[idx(5, 5)]).toBeGreaterThan(TPI_FLAT_SLOPE_TAN);
    for (let r = 2; r < rows - 2; r++)
      for (let c = 2; c < cols - 2; c++) expect(res.classes![idx(r, c)]).toBe(TPI_CLASS.middle);
  });

  test('edges shrink the window and NEVER wrap — hand-computed border values', () => {
    // West edge (r interior, c=0), radius-1 circle → E=0.5, N=0, S=0:
    // mean = 1/6, TPI = −1/6. A wrapping window would pull in col 10 (z=5).
    expect(res.tpi[idx(5, 0)]).toBeCloseTo(-1 / 6, 6);
    // East edge mirror: +1/6.
    expect(res.tpi[idx(5, 10)]).toBeCloseTo(1 / 6, 6);
    // Corner (0,0): neighbours E=0.5 and S-row cell 0 → mean 0.25, TPI −0.25.
    expect(res.tpi[idx(0, 0)]).toBeCloseTo(-0.25, 6);
    expect(res.truncatedWindowCount).toBe(4 * (cols - 1)); // the border ring
  });
});

describe('computeTPI — single ridge (9×9, z=10 on row 4, radius 1)', () => {
  const cols = 9;
  const rows = 9;
  const z = grid(cols, rows, (r) => (r === 4 ? 10 : 0));
  const slope = hornSlope(z, cols, rows, 1);
  const idx = at(cols);
  const res = computeTPI(z, cols, rows, { radiusCells: 1, slope });

  // Hand-computed (radius-1 circle = N,S,E,W, centre excluded):
  //   crest interior (4,c): mean(10,10,0,0)=5      → TPI = +5
  //   flank interior (3,c): mean(10,0,0,0)=2.5     → TPI = −2.5
  //   crest edge (4,0):     mean(10,0,0)=10/3      → TPI = +20/3
  //   flank edge (3,0):     mean(0,10,0)=10/3      → TPI = −10/3
  //   everywhere else 0. Sum = 0 → mean TPI = 0.
  //   Σ TPI² = 2·(20/3)² + 7·5² + 4·(10/3)² + 14·2.5² = 1200/9 + 262.5
  //          = 395.8333…, var = /81 = 4.886831…, stdev = 2.2106178…
  const stdev = Math.sqrt((1200 / 9 + 262.5) / 81);

  test('crest TPI is +5 exactly; flank −2.5; grid mean 0; stdev analytic', () => {
    expect(res.tpi[idx(4, 4)]).toBeCloseTo(5, 6);
    expect(res.tpi[idx(3, 4)]).toBeCloseTo(-2.5, 6);
    expect(res.tpi[idx(1, 4)]).toBeCloseTo(0, 6);
    expect(res.mean).toBeCloseTo(0, 6);
    expect(res.stdev).toBeCloseTo(stdev, 6);
  });

  test('crest standardises above +1 SD and classifies ridge', () => {
    expect(res.stdTpi[idx(4, 4)]).toBeCloseTo(5 / stdev, 5); // ≈ 2.262
    expect(res.stdTpi[idx(4, 4)]).toBeGreaterThan(1);
    expect(res.classes![idx(4, 4)]).toBe(TPI_CLASS.ridge);
  });
});

describe('computeTPI — single pit (9×9, z=−10 at centre, radius 1)', () => {
  const cols = 9;
  const rows = 9;
  const z = grid(cols, rows, (r, c) => (r === 4 && c === 4 ? -10 : 0));
  const slope = hornSlope(z, cols, rows, 1);
  const idx = at(cols);
  const res = computeTPI(z, cols, rows, { radiusCells: 1, slope });

  // Hand-computed: pit TPI = −10 (all four neighbours 0); each of its four
  // neighbours TPI = 0 − mean(−10,0,0,0) = +2.5; all else 0. Mean = 0,
  // var = (100 + 4·6.25)/81 = 125/81, stdev = 1.242260…
  const stdev = Math.sqrt(125 / 81);

  test('pit TPI is −10; standardises below −1 SD; classifies valley', () => {
    expect(res.tpi[idx(4, 4)]).toBeCloseTo(-10, 6);
    expect(res.tpi[idx(3, 4)]).toBeCloseTo(2.5, 6);
    expect(res.mean).toBeCloseTo(0, 6);
    expect(res.stdev).toBeCloseTo(stdev, 6);
    expect(res.stdTpi[idx(4, 4)]).toBeLessThan(-1);
    expect(res.classes![idx(4, 4)]).toBe(TPI_CLASS.valley);
  });
});

describe('computeTPI — edges, NoData, and degenerate inputs stay honest', () => {
  test('NaN cells are skipped as centres and as neighbours', () => {
    const cols = 5;
    const rows = 5;
    const z = grid(cols, rows, () => 1);
    z[12] = NaN; // centre cell
    const res = computeTPI(z, cols, rows, { radiusCells: 1 });
    expect(Number.isNaN(res.tpi[12])).toBe(true);
    // Neighbours of the NaN cell still read TPI 0 — the void never enters a mean.
    expect(res.tpi[11]).toBeCloseTo(0, 9);
    expect(res.validCellCount).toBe(24);
    expect(res.truncatedWindowCount).toBeGreaterThan(0);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  test('±Infinity is NoData, same as NaN', () => {
    const z = Float32Array.from([1, 1, 1, 1, Infinity, 1, 1, 1, 1]);
    const res = computeTPI(z, 3, 3, { radiusCells: 1 });
    expect(Number.isNaN(res.tpi[4])).toBe(true);
    expect(res.validCellCount).toBe(8);
    for (let i = 0; i < 9; i++) if (i !== 4) expect(Number.isFinite(res.tpi[i])).toBe(true);
  });

  test('a validity mask (DtmGrid.coverage-style) overrides finite z', () => {
    const z = grid(3, 3, () => 2);
    const valid = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const res = computeTPI(z, 3, 3, { radiusCells: 1, valid });
    expect(Number.isNaN(res.tpi[4])).toBe(true);
    expect(res.validCellCount).toBe(8);
  });

  test('empty and all-NoData grids return NaN summaries and say why', () => {
    const empty = computeTPI(new Float32Array(0), 0, 0, { radiusCells: 1 });
    expect(empty.validCellCount).toBe(0);
    expect(Number.isNaN(empty.mean)).toBe(true);
    expect(Number.isNaN(empty.summary.median)).toBe(true);
    expect(empty.warnings.some((w) => w.includes('empty grid'))).toBe(true);

    const allNaN = computeTPI(grid(3, 3, () => NaN), 3, 3, { radiusCells: 1 });
    expect(allNaN.validCellCount).toBe(0);
    expect(Number.isNaN(allNaN.stdev)).toBe(true);
    expect(allNaN.warnings.some((w) => w.includes('no valid cells'))).toBe(true);
  });

  test('an isolated valid cell (no valid neighbour) gets NaN, not an invented 0', () => {
    const z = grid(3, 3, (r, c) => (r === 1 && c === 1 ? 7 : NaN));
    const res = computeTPI(z, 3, 3, { radiusCells: 1 });
    expect(Number.isNaN(res.tpi[4])).toBe(true);
    expect(res.validCellCount).toBe(0);
  });

  test('invalid radius falls back to 1 with a warning; no slope → no classes', () => {
    const z = grid(3, 3, () => 1);
    const res = computeTPI(z, 3, 3, { radiusCells: 0 });
    expect(res.warnings.some((w) => w.includes('radiusCells invalid'))).toBe(true);
    expect(res.classes).toBeNull();
    expect(res.warnings.some((w) => w.includes('no slope grid'))).toBe(true);
  });
});

// ── VRM — Sappington et al. (2007), doi:10.2193/2005-723 ────────────────────

describe('computeVRM — flat plane', () => {
  const cols = 9;
  const rows = 9;
  const z = grid(cols, rows, () => 5);
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);
  const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });

  test('VRM is exactly 0 everywhere (all normals (0,0,1)), edges included', () => {
    for (let i = 0; i < cols * rows; i++) expect(res.vrm[i]).toBeCloseTo(0, 12);
    expect(res.summary.median).toBeCloseTo(0, 12);
    expect(res.summary.iqr).toBeCloseTo(0, 12);
    expect(res.validCellCount).toBe(cols * rows);
  });
});

describe('computeVRM — constant planar slope (THE slope-independence assertion)', () => {
  // z = x on a 20×20 grid, cell 1 ⇒ interior Horn tangent m = 1 (θ = 45°),
  // downslope aspect = π (west). Identical normals ⇒ VRM must be 0 even
  // though θ > 0 — the property that separates ruggedness from steepness.
  const cols = 20;
  const rows = 20;
  const z = grid(cols, rows, (_r, c) => c);
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);
  const idx = at(cols);
  const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });

  test('the surface really is steep (θ = 45°) and west-facing', () => {
    expect(slope[idx(10, 10)]).toBeCloseTo(1, 12);
    // atan2(−0, −1) is −π: same downslope direction as +π (west). Float32
    // storage bounds the comparison at ~1e-7.
    expect(Math.abs(aspect[idx(10, 10)])).toBeCloseTo(Math.PI, 6);
  });

  test('deep-interior VRM ≈ 0 despite θ > 0 — tight tolerance', () => {
    // Cells ≥ 2 from the border: their 3×3 windows contain only interior
    // Horn cells, whose normals are bit-identical.
    for (let r = 2; r < rows - 2; r++)
      for (let c = 2; c < cols - 2; c++) expect(res.vrm[idx(r, c)]).toBeLessThan(1e-12);
  });

  test('median VRM over the grid is 0 (interior dominates the border ring)', () => {
    expect(res.summary.median).toBeLessThan(1e-12);
  });
});

describe('computeVRM — alternating rough surface (triangle wave, period 4)', () => {
  // z(col) = [0, 1, 0, −1][col mod 4], every row identical, cell 1.
  // Interior Horn: dzdx cycles (1, 0, −1, 0), dzdy = 0 ⇒ face tangent m = 1
  // (θ = 45°, cosθ = √2/2), aspect alternates west/east; ridge/valley lines flat.
  // Hand-computed window resultants (3×3, all rows identical):
  //   centre on a ridge/valley line (m = 0), window m = (±1, 0, ∓1):
  //     Σ per row = (0, 0, 1 + 2cosθ) ⇒ VRM_a = 1 − (1+2cosθ)/3
  //               = (2/3)(1 − √2/2) = 0.19526215…
  //   centre on a face (m = ±1), window m = (0, ±1, 0):
  //     |Σ| per row = √(sin²θ + (2+cosθ)²) = √(5 + 4cosθ)
  //     ⇒ VRM_b = 1 − √(5 + 2√2)/3 = 0.06735647…
  const cols = 16;
  const rows = 9;
  const wave = [0, 1, 0, -1];
  const z = grid(cols, rows, (_r, c) => wave[c % 4]);
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);
  const idx = at(cols);
  const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });

  const cosT = Math.SQRT1_2;
  const vrmA = (2 / 3) * (1 - cosT);
  const vrmB = 1 - Math.sqrt(5 + 4 * cosT) / 3;

  test('per-cell VRM matches the analytic window resultants', () => {
    for (let c = 2; c <= cols - 3; c++) {
      const expected = c % 2 === 1 ? vrmA : vrmB; // odd cols are ridge/valley lines
      expect(res.vrm[idx(4, c)]).toBeCloseTo(expected, 6);
    }
  });

  test('rough VRM is clearly above the constant-slope case and inside [0, 1]', () => {
    expect(res.summary.median).toBeGreaterThan(0.05); // slope case: 0
    for (let i = 0; i < cols * rows; i++) {
      if (!Number.isFinite(res.vrm[i])) continue;
      expect(res.vrm[i]).toBeGreaterThanOrEqual(0);
      expect(res.vrm[i]).toBeLessThanOrEqual(1);
    }
    expect(res.summary.iqr).toBeGreaterThanOrEqual(0);
  });
});

describe('computeVRM — edges, NoData, and degenerate inputs stay honest', () => {
  test('non-finite slope/aspect cells are NaN centres and skipped window members', () => {
    const cols = 5;
    const rows = 5;
    const z = grid(cols, rows, () => 2);
    const { slope, aspect } = hornSlopeAspect(z, cols, rows, 1);
    slope[12] = NaN;
    const res = computeVRM(slope, aspect, cols, rows, { windowCells: 3 });
    expect(Number.isNaN(res.vrm[12])).toBe(true);
    expect(res.vrm[11]).toBeCloseTo(0, 12); // void never enters a resultant
    expect(res.validCellCount).toBe(24);
    expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  test('a validity mask (DtmGrid.coverage-style) overrides finite inputs', () => {
    const slope = new Float32Array(9);
    const aspect = new Float32Array(9);
    const valid = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const res = computeVRM(slope, aspect, 3, 3, { windowCells: 3, valid });
    expect(Number.isNaN(res.vrm[4])).toBe(true);
    expect(res.validCellCount).toBe(8);
  });

  test('empty and all-invalid grids return NaN summaries and say why', () => {
    const empty = computeVRM(new Float32Array(0), new Float32Array(0), 0, 0, { windowCells: 3 });
    expect(empty.validCellCount).toBe(0);
    expect(Number.isNaN(empty.summary.median)).toBe(true);
    expect(empty.warnings.some((w) => w.includes('empty grid'))).toBe(true);

    const allBad = computeVRM(
      Float32Array.from([NaN, Infinity, NaN, 0.5]),
      Float32Array.from([0, 0, NaN, 0]),
      2,
      2,
      { windowCells: 3 },
    );
    expect(allBad.validCellCount).toBe(1); // only index 3 is fully finite
    const res = computeVRM(Float32Array.from([NaN]), Float32Array.from([NaN]), 1, 1, {
      windowCells: 3,
    });
    expect(res.validCellCount).toBe(0);
    expect(res.warnings.some((w) => w.includes('no valid cells'))).toBe(true);
  });

  test('invalid windowCells (even / zero / NaN) falls back to 3 with a warning', () => {
    const slope = new Float32Array(9);
    const aspect = new Float32Array(9);
    for (const bad of [0, 2, NaN, 2.5]) {
      const res = computeVRM(slope, aspect, 3, 3, { windowCells: bad });
      expect(res.warnings.some((w) => w.includes('windowCells invalid'))).toBe(true);
      expect(res.vrm[4]).toBeCloseTo(0, 12);
    }
  });

  test('windowCells 1 is a single-normal window: VRM 0 by definition', () => {
    const z = grid(4, 4, (r, c) => Math.sin(r) * Math.cos(c));
    const { slope, aspect } = hornSlopeAspect(z, 4, 4, 1);
    const res = computeVRM(slope, aspect, 4, 4, { windowCells: 1 });
    for (let i = 0; i < 16; i++) expect(res.vrm[i]).toBeCloseTo(0, 12);
  });
});

// ── Honesty envelope (TerrainContracts.TerrainCoverageMeta fields) ──────────

describe('honesty envelope — confidence derived from data support, never asserted', () => {
  test('TPI result carries the TerrainCoverageMeta fields with derived confidence', () => {
    // 9×9 full grid, radius 1 (4-neighbour circle): window support is
    // 4/4 for the 49 interior cells, 3/4 for 28 edge cells, 2/4 for 4
    // corners → mean = (49 + 21 + 2)/81 = 72/81; validFraction = 1
    // → confidence = round(100·72/81) = 89.
    const z = grid(9, 9, () => 5);
    const res: TerrainCoverageMeta = computeTPI(z, 9, 9, { radiusCells: 1 });
    expect(res.coverage).toBe('full');
    expect(res.sourcePointCount).toBe(0); // no points claimed without meta
    expect(res.analyzedPointCount).toBe(0);
    expect(res.confidence).toBe(89);
    expect(Array.isArray(res.warnings) || res.warnings.length >= 0).toBe(true);
  });

  test('VRM result: hand-computed window support on a full 9×9, window 3', () => {
    // 3×3 window (incl. centre): 9/9 interior (49), 6/9 edges (28), 4/9
    // corners (4) → mean = (49 + 18.666… + 1.777…)/81 = 69.444…/81
    // → confidence = round(100·0.857338…) = 86.
    const z = grid(9, 9, () => 5);
    const { slope, aspect } = hornSlopeAspect(z, 9, 9, 1);
    const res: TerrainCoverageMeta = computeVRM(slope, aspect, 9, 9, { windowCells: 3 });
    expect(res.confidence).toBe(86);
    expect(res.coverage).toBe('full');
  });

  test('voids reduce confidence and add an ordered void warning', () => {
    const z = grid(6, 6, (r) => (r < 3 ? 1 : NaN)); // half the grid is void
    const full = computeTPI(grid(6, 6, () => 1), 6, 6, { radiusCells: 1 });
    const holed = computeTPI(z, 6, 6, { radiusCells: 1 });
    expect(holed.confidence).toBeLessThan(full.confidence);
    expect(holed.confidence).toBeGreaterThan(0); // still derived, not zeroed
    expect(holed.warnings.some((w) => w.includes('voids'))).toBe(true);
    // Envelope warnings follow core warnings (truncation precedes voids).
    const truncIdx = holed.warnings.findIndex((w) => w.includes('truncated'));
    const voidIdx = holed.warnings.findIndex((w) => w.includes('voids'));
    expect(truncIdx).toBeGreaterThanOrEqual(0);
    expect(voidIdx).toBeGreaterThan(truncIdx);
  });

  test('no valid cells → confidence 0 (no floor, no invented number)', () => {
    const res = computeTPI(grid(3, 3, () => NaN), 3, 3, { radiusCells: 1 });
    expect(res.confidence).toBe(0);
    const vres = computeVRM(new Float32Array(0), new Float32Array(0), 0, 0, { windowCells: 3 });
    expect(vres.confidence).toBe(0);
  });

  test('meta passthrough: coverage mode + point counts echo the source product', () => {
    const z = grid(5, 5, () => 2);
    const { slope, aspect } = hornSlopeAspect(z, 5, 5, 1);
    const res = computeVRM(slope, aspect, 5, 5, {
      windowCells: 3,
      meta: { coverage: 'resident-only', sourcePointCount: 12345, analyzedPointCount: 6789 },
    });
    expect(res.coverage).toBe('resident-only');
    expect(res.sourcePointCount).toBe(12345);
    expect(res.analyzedPointCount).toBe(6789);
    expect(res.warnings.some((w) => w.includes('resident-only'))).toBe(true);

    const sampled = computeTPI(z, 5, 5, { radiusCells: 1, meta: { coverage: 'sampled' } });
    expect(sampled.coverage).toBe('sampled');
    expect(sampled.warnings.some((w) => w.includes('sampled'))).toBe(true);
  });

  test('metrics always ship with dispersion (median + IQR), never bare', () => {
    const z = grid(9, 9, (r, c) => Math.sin(r * 0.7) + Math.cos(c * 0.9));
    const { slope, aspect } = hornSlopeAspect(z, 9, 9, 1);
    const t = computeTPI(z, 9, 9, { radiusCells: 1, slope });
    const v = computeVRM(slope, aspect, 9, 9, { windowCells: 3 });
    for (const s of [t.summary, v.summary]) {
      expect(Number.isFinite(s.median)).toBe(true);
      expect(Number.isFinite(s.iqr)).toBe(true);
      expect(s.iqr).toBeGreaterThanOrEqual(0);
      expect(s.p25).toBeLessThanOrEqual(s.p75);
    }
  });
});
