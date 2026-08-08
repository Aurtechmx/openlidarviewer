/**
 * terrainBoundaryReal.test.ts — quick-win 1. The analytic boundary study
 * (terrainBoundary.test.ts) run on a REAL committed DTM.
 *
 * full real terrain → deterministic interior crop → recompute slope/aspect →
 * compare crop cells against the corresponding full-surface cells, grouped by
 * distance from the artificial boundary (0 / 1 / 2 / 3+ cells).
 *
 * The invariant is the same as the analytic case and validates the production
 * Horn kernel's real-world edge behaviour without changing it: a cell at least
 * one in from the crop edge keeps its full neighbourhood and must match the
 * full-surface truth; only the edge ring (distance 0) carries the clamp error.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { circularAspectError } from '../src/validation/terrainMetrics';
import { readWhiteSandsGround, WS_GRID, hasWhiteSands } from './support/terrainField';

const M = 20; // interior crop margin (cells)

describe('Horn slope/aspect boundary behaviour on real White Sands terrain', () => {
  (hasWhiteSands() ? it : it.skip)('interior matches the full surface; only the edge ring carries the clamp error', () => {
    const pts = readWhiteSandsGround();
    const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: WS_GRID, aggregation: 'mean' });
    const dtm = buildDtmGrid(raster); // filled, complete grid
    const C = WS_GRID.cols, R = WS_GRID.rows;
    const truth = hornSlopeAspect(dtm.z, C, R, WS_GRID.cellSizeM);

    const CC = C - 2 * M, RR = R - 2 * M;
    const cropZ = new Float32Array(CC * RR);
    for (let r = 0; r < RR; r++) for (let c = 0; c < CC; c++) cropZ[r * CC + c] = dtm.z[(r + M) * C + (c + M)];
    const cropped = hornSlopeAspect(cropZ, CC, RR, WS_GRID.cellSizeM);

    // Bucket error by distance from the crop boundary.
    const buckets = new Map<number, { slope: number; aspect: number; n: number }>();
    for (let r = 0; r < RR; r++) {
      for (let c = 0; c < CC; c++) {
        const dist = Math.min(r, c, RR - 1 - r, CC - 1 - c);
        const key = dist >= 3 ? 3 : dist;
        const ci = r * CC + c, ti = (r + M) * C + (c + M);
        const sErr = Math.abs(cropped.slope[ci] - truth.slope[ti]);
        const aErr = circularAspectError(cropped.aspect[ci], truth.aspect[ti]);
        const b = buckets.get(key) ?? { slope: 0, aspect: 0, n: 0 };
        b.slope = Math.max(b.slope, sErr); b.aspect = Math.max(b.aspect, aErr); b.n++;
        buckets.set(key, b);
      }
    }
    const report = [0, 1, 2, 3].map((k) => {
      const b = buckets.get(k)!;
      return `${k === 3 ? '3+' : k}:maxSlope=${b.slope.toExponential(2)},maxAspect=${b.aspect.toFixed(2)},n=${b.n}`;
    });
    // eslint-disable-next-line no-console
    console.log('[terrain-boundary-real]', report.join('  '));

    const edge = buckets.get(0)!;
    const interior = [1, 2, 3].map((k) => buckets.get(k)!);
    // Interior: full real neighbourhood → matches the full-surface truth exactly.
    for (const b of interior) {
      expect(b.slope).toBeLessThan(1e-6);
      expect(b.aspect).toBeLessThan(1e-3);
    }
    // Edge ring carries a strictly larger slope error than the interior.
    expect(edge.slope).toBeGreaterThan(interior[0].slope);
    // Aspect stays a bounded circular separation, never a wraparound blow-up.
    expect(edge.aspect).toBeLessThanOrEqual(180);
  });
});
