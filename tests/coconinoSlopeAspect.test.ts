/**
 * coconinoSlopeAspect.test.ts — OLV slope/aspect on REAL STEEP terrain, against
 * two independent references.
 *
 * The existing slope/aspect cross-checks run on a synthetic analytic DEM and on
 * the flat White Sands dune field. This leg adds the case they miss: a 150 x 150 m
 * crop of the USGS AZ Coconino B1 2019 airborne LiDAR (project 19049, public
 * domain 3DEP), 40 m of relief over the window, real slopes to ~45 degrees in
 * conifer forest. The DTM is the scipy point-in-cell mean of the class-2 ground
 * (references/coconino-slope__bincell-dtm.asc).
 *
 * Two comparisons on the same committed DTM:
 *  1. OLV `hornSlopeAspect` vs an INDEPENDENT NumPy Horn implementation at 735
 *     frozen interior cells (references/coconino-slope__slope-aspect-spotcheck.json).
 *     Same convention, separate codebase — proves the implementation on steep
 *     real ground to floating-point tolerance.
 *  2. OLV slope (converted to degrees) vs **gdaldem 3.13.1** `slope -alg Horn`
 *     (references/coconino-slope__gdaldem-slope.asc), interior cells, within the
 *     registered E4 slope tolerance of 0.5 degrees. A DIFFERENT tool on real
 *     steep terrain — this broadens the slope cross-implementation evidence from
 *     the analytic surface to national-survey terrain; it does not, on its own,
 *     promote the claim beyond E4 (still cross-implementation, not surveyed
 *     truth).
 *
 * Skips when a reference is absent (GDAL is not a CI dependency); the references
 * are committed, so it runs in CI without GDAL present.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

const DIR = resolve(__dirname, '../validation/terrain-field/references');
const DTM = resolve(DIR, 'coconino-slope__bincell-dtm.asc');
const SPOT = resolve(DIR, 'coconino-slope__slope-aspect-spotcheck.json');
const GDAL_SLOPE = resolve(DIR, 'coconino-slope__gdaldem-slope.asc');

const MIN_SLOPE_DEG = 2; // near-flat cells excluded (unstable direction; GDAL flags flats)

/** Read an ESRI ASCII grid, returning values SOUTH-UP (row 0 = south) to match OLV. */
function readAsc(path: string): { cols: number; rows: number; cell: number; nodata: number; z: Float64Array } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const h: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    h[m[1].toLowerCase()] = Number(m[2]);
  }
  const cols = h.ncols, rows = h.nrows, cell = h.cellsize, nodata = h.nodata_value ?? -9999;
  const nums = lines.slice(i).join(' ').trim().split(/\s+/).filter(Boolean).map(Number);
  const north = new Float64Array(nums); // row 0 = north as written
  const z = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[(rows - 1 - r) * cols + c] = north[r * cols + c];
  return { cols, rows, cell, nodata, z };
}

describe('OLV slope/aspect on real steep terrain (Coconino forest)', () => {
  const hasSpot = existsSync(DTM) && existsSync(SPOT);

  (hasSpot ? it : it.skip)('matches an independent NumPy Horn reference at 735 frozen cells', () => {
    const { cols, rows, cell, z } = readAsc(DTM);
    const zf = Float32Array.from(z, (v) => (v <= -9998 ? NaN : v));
    const ref = JSON.parse(readFileSync(SPOT, 'utf8')) as {
      grid: { cols: number; rows: number; cellSizeM: number };
      tolerance: { slopeAbs: number; aspectRad: number };
      cells: Array<{ index: number; slope: number; aspect: number }>;
    };
    expect(cols).toBe(ref.grid.cols);
    expect(rows).toBe(ref.grid.rows);
    const der = hornSlopeAspect(zf, cols, rows, cell);
    const circ = (a: number, b: number) => { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
    let maxSlope = 0, maxAspect = 0;
    for (const c of ref.cells) {
      maxSlope = Math.max(maxSlope, Math.abs(der.slope[c.index] - c.slope));
      maxAspect = Math.max(maxAspect, circ(der.aspect[c.index], c.aspect));
    }
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Coconino slope/aspect vs NumPy Horn (${ref.cells.length} cells): maxSlopeAbs=${maxSlope.toExponential(2)} maxAspectRad=${maxAspect.toExponential(2)}`);
    expect(ref.cells.length).toBeGreaterThan(500);
    expect(maxSlope).toBeLessThan(ref.tolerance.slopeAbs);
    expect(maxAspect).toBeLessThan(ref.tolerance.aspectRad);
  });

  const hasGdal = existsSync(DTM) && existsSync(GDAL_SLOPE);

  (hasGdal ? it : it.skip)('agrees with gdaldem 3.13.1 slope within 0.5 degrees on real steep terrain', () => {
    const { cols, rows, cell, z } = readAsc(DTM);
    const zf = Float32Array.from(z, (v) => (v <= -9998 ? NaN : v));
    const der = hornSlopeAspect(zf, cols, rows, cell);
    const g = readAsc(GDAL_SLOPE); // degrees, south-up
    expect(g.cols).toBe(cols);
    let max = 0, sum = 0, n = 0;
    for (let idx = 0; idx < cols * rows; idx++) {
      const gv = g.z[idx];
      if (!Number.isFinite(gv) || gv <= -9998 || gv < MIN_SLOPE_DEG) continue;
      const olvDeg = Math.atan(der.slope[idx]) * 180 / Math.PI; // m/m → degrees
      if (!Number.isFinite(olvDeg)) continue;
      const d = Math.abs(olvDeg - gv);
      max = Math.max(max, d); sum += d; n++;
    }
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Coconino slope vs gdaldem 3.13.1 (${n} interior cells, slopes to ~45deg): max=${max.toFixed(4)}deg mean=${(sum / n).toFixed(4)}deg`);
    expect(n).toBeGreaterThan(5000);
    expect(max).toBeLessThan(0.5); // registered E4 slope tolerance
  });
});
