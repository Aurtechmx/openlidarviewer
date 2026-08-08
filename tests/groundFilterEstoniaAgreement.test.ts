/**
 * groundFilterEstoniaAgreement.test.ts — OLV's ground filter vs PDAL SMRF on
 * REAL low-relief terrain.
 *
 * The synthetic ground-filter study (tests/groundFilterPdalAgreement.test.ts) is
 * `partial`: OLV's SMRF-core and PDAL's full `filters.smrf` agree on every return
 * on the PLANAR synthetic scenes, but fall to 0.61–0.77 on the rolling and ridge
 * scenes. The divergence is mechanistic — OLV implements a SUBSET of the SMRF
 * stages (Pingel et al. 2013), and the omitted stages change the result only
 * where local relief grows the morphological window; on low-relief ground the
 * subset and the full pipeline coincide.
 *
 * This leg confirms that on REAL low-relief terrain. The fixture is a 150 × 150 m
 * crop of the Estonian Land Board 2020 national LiDAR (tile 568539, Zenodo DOI
 * 10.5281/zenodo.19232743, CC BY 4.0): flat boreal ground (~1.6 m of bare-earth
 * relief) under tall forest canopy, so the filter has real work to do — 40 % of
 * the 95,005 returns are ground, 60 % above-ground. PDAL `filters.smrf` was run
 * with the same parameters OLV is given (cell 1 m, window 16, slope 0.15,
 * threshold 0.5, scalar 0), its per-return Classification frozen in
 * `pdal/pc-16-estonia-boreal__smrf.csv`.
 *
 * The gate — label agreement ≥ 0.99 over ≥ 50,000 returns — is the one already
 * registered for GROUND-FILTER (src/validation/crossCheck.ts, and the synthetic
 * study's metrics), so this runs a NEW dataset against a FROZEN tolerance. This
 * is cross-implementation agreement on low-relief terrain, not accuracy against
 * ground truth and not a claim about steep or complex terrain, where the two
 * filters demonstrably diverge.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/cross-implementation/pdal-pipeline');
const FIX = resolve(DIR, 'fixtures/pc-16-estonia-boreal.csv');
const REF = resolve(DIR, 'pdal/pc-16-estonia-boreal__smrf.csv');
const EPS = 1e-3; // row-alignment tolerance in metres

describe('OLV ground filter vs PDAL SMRF on real low-relief terrain (Estonia)', () => {
  const has = existsSync(FIX) && existsSync(REF);

  (has ? it : it.skip)('agrees on ≥ 0.99 of returns over a balanced real crop', () => {
    const fx = readFileSync(FIX, 'utf8').trim().split('\n').slice(1);
    const rf = readFileSync(REF, 'utf8').trim().split('\n').slice(1);
    expect(rf.length).toBe(fx.length);

    const pts: TerrainPoint[] = new Array(fx.length);
    const pdal = new Uint8Array(fx.length);
    let ground = 0;
    for (let i = 0; i < fx.length; i++) {
      const [x, y, z] = fx[i].split(',').map(Number);
      pts[i] = { x, y, z };
      const rc = rf[i].replace(/"/g, '').split(',').map(Number);
      // Row alignment: the reference must describe the same return, in order.
      if (Math.abs(rc[0] - x) > EPS || Math.abs(rc[1] - y) > EPS) {
        throw new Error(`row ${i} misaligned: fixture (${x},${y}) vs reference (${rc[0]},${rc[1]})`);
      }
      pdal[i] = rc[3] === 2 ? 1 : 0;
      if (pdal[i]) ground++;
    }

    const olv = classifyGroundSmrf(pts, {
      cellSizeM: 1, maxWindowCells: 16, slope: 0.15, elevationThresholdM: 0.5, scalingFactorM: 0, verticalAxis: 'z',
    }).isGround;

    let same = 0;
    for (let i = 0; i < pts.length; i++) if (olv[i] === pdal[i]) same++;
    const agree = same / pts.length;
    // eslint-disable-next-line no-console
    console.log(`[cross-impl] Estonia GROUND-FILTER OLV vs PDAL SMRF: n=${pts.length} ground=${(100 * ground / pts.length).toFixed(1)}% agree=${agree.toFixed(5)} (bar 0.99)`);

    // Balanced split: this is real discrimination, not an all-ground regime.
    expect(ground / pts.length).toBeGreaterThan(0.2);
    expect(ground / pts.length).toBeLessThan(0.8);
    // ≥ 50,000 returns and ≥ 0.99 agreement — the registered GROUND-FILTER gate.
    expect(pts.length).toBeGreaterThan(50_000);
    expect(agree).toBeGreaterThanOrEqual(0.99);
  });
});
