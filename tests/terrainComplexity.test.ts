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
import { hornSlope } from '../src/terrain/ground/terrainDerivatives';

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
