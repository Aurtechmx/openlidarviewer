/**
 * tpiCrossCheck.test.ts — TPI against an independent implementation.
 *
 * Three-way, like the slope cross-check. TPI (centre minus the mean of the eight
 * Moore neighbours) is compared against gdaldem 3.13.1 TPI AND against the
 * closed-form TPI of the fixture surface, so a reference run with the wrong tool
 * surfaces against the closed form rather than being averaged into a plausible
 * agreement.
 *
 * The fixture is a LOW-AMPLITUDE quadratic z = c·(x²+y²), re-centred so |z| stays
 * small. TPI is translation-invariant in elevation, but gdaldem accumulates the
 * neighbourhood mean in float32, whose spacing scales with |z|; keeping |z| small
 * keeps that float32 error far below the tolerance, so the comparison measures the
 * arithmetic and not the reference's storage precision. The closed-form interior
 * TPI is exactly −c·mean(Δx²+Δy²) = −1.5·c, constant across the interior.
 *
 * `computeTPI`'s neighbourhood is the discrete circle of radius √2 cells, which is
 * the eight-cell Moore window gdaldem averages over; radius 1 would be the four
 * axial neighbours and a different index. The one-cell border is excluded because
 * the documented gdaldem command omits -compute_edges.
 *
 * Skips rather than fails when the reference is absent (gdaldem is not a project
 * dependency); the slot stays pending until the file lands.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeTPI } from '../src/terrain/complexity/terrainPositionIndex';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import { N, TPI_C } from '../scripts/descriptor-fixture-params.mjs';

const DIR = resolve(__dirname, '../validation/cross-implementation/descriptor');
const DEM = resolve(DIR, 'tpi-quadratic.asc');
const REF = resolve(DIR, 'tpi-quadratic__tpi.asc');
const MOORE_RADIUS = Math.SQRT2;

/** Closed-form interior TPI for z = c·(x²+y²): −c·mean(Δx²+Δy²) over the 8 Moore neighbours. */
const CLOSED_TPI = (() => {
  const offs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const meanD2 = offs.reduce((a, [dr, dc]) => a + dr * dr + dc * dc, 0) / offs.length;
  return -TPI_C * meanD2;
})();

function readAsc(path: string): { cols: number; rows: number; nodata: number; v: Float32Array } {
  const t = readFileSync(path, 'utf8').split('\n');
  const h: Record<string, number> = {};
  let i = 0;
  for (; i < t.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(t[i]);
    if (!m) break;
    h[m[1].toLowerCase()] = Number(m[2]);
  }
  const nums = t.slice(i).join(' ').trim().split(/\s+/).filter(Boolean).map(Number);
  if (nums.length !== h.ncols * h.nrows) throw new Error(`${path}: ${nums.length} values, expected ${h.ncols * h.nrows}`);
  return { cols: h.ncols, rows: h.nrows, nodata: h.nodata_value ?? -9999, v: Float32Array.from(nums) };
}

/** Interior cells (drop the one-cell border) as a flat list. */
function interior(g: ArrayLike<number>, cols: number, rows: number): number[] {
  const out: number[] = [];
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) out.push(g[r * cols + c] as number);
  return out;
}

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'TPI')!;

describe('TPI cross-implementation', () => {
  it('has a declared GDAL slot with a pre-registered tolerance', () => {
    expect(SLOT.referenceTool).toBe('GDAL');
    expect(SLOT.toleranceAbs).toBe(1e-5);
  });

  it('our TPI matches the closed form on the fixture surface', () => {
    const dem = readAsc(DEM);
    expect(dem.cols).toBe(N);
    const { tpi } = computeTPI(dem.v, dem.cols, dem.rows, { radiusCells: MOORE_RADIUS });
    const ours = interior(tpi, dem.cols, dem.rows);
    const truth = ours.map(() => CLOSED_TPI);
    const report = crossCheck(ours, truth, { toleranceAbs: SLOT.toleranceAbs, minCells: 1000 });
    expect(report.verdict, report.summary).toBe('agree');
  });

  const withReference = existsSync(REF) ? it : it.skip;

  withReference('agrees with gdaldem, and gdaldem agrees with the closed form', () => {
    const dem = readAsc(DEM);
    const ref = readAsc(REF);
    expect(ref.cols, 'reference grid width differs from the DEM').toBe(dem.cols);
    expect(ref.rows).toBe(dem.rows);
    const { tpi } = computeTPI(dem.v, dem.cols, dem.rows, { radiusCells: MOORE_RADIUS });
    const ours = interior(tpi, dem.cols, dem.rows);
    const gdal = interior(ref.v, ref.cols, ref.rows);
    const truth = ours.map(() => CLOSED_TPI);
    const opts = { toleranceAbs: SLOT.toleranceAbs, nodata: ref.nodata, minCells: 1000 };
    const refVsTruth = crossCheck(gdal, truth, opts);
    expect(refVsTruth.verdict, `gdaldem vs closed form: ${refVsTruth.summary}`).toBe('agree');
    const oursVsRef = crossCheck(ours, gdal, opts);
    expect(oursVsRef.verdict, `ours vs gdaldem: ${oursVsRef.summary}`).toBe('agree');
    console.log(`TPI  ours vs gdaldem: ${oursVsRef.summary}`);
  });

  it('keeps the slot pending until a reference is actually supplied', () => {
    expect(SLOT.status).toBe(existsSync(REF) ? 'supplied' : 'pending');
  });
});
