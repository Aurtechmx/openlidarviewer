/**
 * vrmCrossCheck.test.ts — VRM against an independent implementation.
 *
 * Three-way, like the slope cross-check. VRM (Sappington et al. 2007, the 3x3
 * mean-resultant of unit surface normals) is compared against SAGA 7.8.2's Vector
 * Ruggedness Measure AND against the closed-form VRM of the fixture surface.
 *
 * The fixture is a smooth TILTED quadratic z = a·x + c·(x²+y²). The tilt keeps the
 * slope non-zero everywhere, so there is no aspect singularity, and the gentle
 * curvature is well resolved, so Horn's normal (OLV) and SAGA's estimator both
 * converge to the analytic normal. The comparison is over the interior with a
 * two-cell border removed: Horn's slope halves on the outer ring (edge clamp), and
 * the 3x3 VRM window carries that one ring inward, so the affected zone is two
 * cells deep — excluded exactly as the slope cross-check excludes its border.
 *
 * The closed-form leg recomputes the true Sappington VRM from the analytic
 * gradient, independently of OLV, so a wrong reference tool surfaces there.
 *
 * Skips rather than fails when the reference is absent (SAGA is not a project
 * dependency); the slot stays pending until the file lands.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { computeVRM } from '../src/terrain/complexity/vectorRuggedness';
import { crossCheck, REFERENCE_SLOTS } from '../src/validation/crossCheck';
import { N, CELL, VRM_A, VRM_C } from '../scripts/descriptor-fixture-params.mjs';

const DIR = resolve(__dirname, '../validation/cross-implementation/descriptor');
const DEM = resolve(DIR, 'vrm-tilted.asc');
const REF = resolve(DIR, 'vrm-tilted__vrm.asc');
const BORDER = 2;

const coord = (i: number) => (i - N / 2 + 0.5) * CELL;

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

/** True Sappington VRM at each cell: 3x3 mean-resultant of analytic unit normals. */
function analyticVrm(): Float64Array {
  const nx = new Float64Array(N * N);
  const ny = new Float64Array(N * N);
  const nz = new Float64Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const fx = VRM_A + 2 * VRM_C * coord(c);
      const fy = 2 * VRM_C * coord(r);
      const den = Math.sqrt(fx * fx + fy * fy + 1);
      const i = r * N + c;
      nx[i] = -fx / den;
      ny[i] = -fy / den;
      nz[i] = 1 / den;
    }
  }
  const out = new Float64Array(N * N).fill(Number.NaN);
  for (let r = 1; r < N - 1; r++) {
    for (let c = 1; c < N - 1; c++) {
      let sx = 0, sy = 0, sz = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const j = (r + dr) * N + (c + dc);
        sx += nx[j]; sy += ny[j]; sz += nz[j];
      }
      out[r * N + c] = 1 - Math.sqrt(sx * sx + sy * sy + sz * sz) / 9;
    }
  }
  return out;
}

function olvVrm(dem: { cols: number; rows: number; v: Float32Array }): Float32Array {
  const { slope, aspect } = hornSlopeAspect(dem.v, dem.cols, dem.rows, CELL, CELL);
  return computeVRM(slope, aspect, dem.cols, dem.rows, { windowCells: 3 }).vrm;
}

/** Interior cells with a `BORDER`-cell margin removed. */
function interior(g: ArrayLike<number>, cols: number, rows: number): number[] {
  const out: number[] = [];
  for (let r = BORDER; r < rows - BORDER; r++) for (let c = BORDER; c < cols - BORDER; c++) out.push(g[r * cols + c] as number);
  return out;
}

const SLOT = REFERENCE_SLOTS.find((s) => s.claimId === 'VRM')!;

describe('VRM cross-implementation', () => {
  it('has a declared SAGA slot with a pre-registered tolerance', () => {
    expect(SLOT.referenceTool).toBe('SAGA');
    expect(SLOT.toleranceAbs).toBe(1e-4);
  });

  it('our VRM matches the closed-form Sappington VRM on the fixture surface', () => {
    const dem = readAsc(DEM);
    expect(dem.cols).toBe(N);
    const ours = interior(olvVrm(dem), dem.cols, dem.rows);
    const truth = interior(analyticVrm(), N, N);
    const report = crossCheck(ours, truth, { toleranceAbs: SLOT.toleranceAbs, minCells: 1000 });
    expect(report.verdict, report.summary).toBe('agree');
  });

  const withReference = existsSync(REF) ? it : it.skip;

  withReference('agrees with SAGA, and SAGA agrees with the closed form', () => {
    const dem = readAsc(DEM);
    const ref = readAsc(REF);
    expect(ref.cols, 'reference grid width differs from the DEM').toBe(dem.cols);
    expect(ref.rows).toBe(dem.rows);
    const ours = interior(olvVrm(dem), dem.cols, dem.rows);
    const saga = interior(ref.v, ref.cols, ref.rows);
    const truth = interior(analyticVrm(), N, N);
    const opts = { toleranceAbs: SLOT.toleranceAbs, nodata: ref.nodata, minCells: 1000 };
    const refVsTruth = crossCheck(saga, truth, opts);
    expect(refVsTruth.verdict, `SAGA vs closed form: ${refVsTruth.summary}`).toBe('agree');
    const oursVsRef = crossCheck(ours, saga, opts);
    expect(oursVsRef.verdict, `ours vs SAGA: ${oursVsRef.summary}`).toBe('agree');
    console.log(`VRM  ours vs SAGA: ${oursVsRef.summary}`);
  });

  it('keeps the slot pending until a reference is actually supplied', () => {
    expect(SLOT.status).toBe(existsSync(REF) ? 'supplied' : 'pending');
  });
});
