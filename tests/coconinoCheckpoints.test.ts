/**
 * coconinoCheckpoints.test.ts — OLV's DTM against INDEPENDENT surveyed ground
 * truth in steep, forested terrain.
 *
 * Dataset: USGS AZ Coconino B1 2019 (project 19049), public domain (USGS 3DEP /
 * The National Map). The project's aerial-LiDAR accuracy checkpoints (NVA +
 * VVA, Tables 8/9 of the project report) are held separate from the 12 LiDAR
 * Control Points, so they are an independent set used solely for vertical
 * accuracy — not reused for calibration. Checkpoints are reprojected to the tile
 * CRS (NAD83(2011) / Conus Albers). The tile's Z and the checkpoint Z are BOTH
 * NAVD88 orthometric (Geoid12B), so OLV's DTM and the checkpoints are compared
 * with no vertical-datum reconciliation.
 *
 * This complements the Marsh Island leg (flat coastal marsh) with the hard case
 * Marsh Island does not cover: a VVA checkpoint is surveyed in VEGETATED ground,
 * so this measures bare-earth extraction under canopy. A single forested tile
 * yields N=1 (TR03); the fixture and this test grow with N as more project tiles
 * are added — no code change.
 *
 * The crop + matched reference are produced by
 * scripts/terrain-field/generate-coconino-reference.py from the downloaded
 * tile(s); until they exist this test skips (it never fabricates truth).
 *
 * MATCHING PROTOCOL (fixed before any accuracy was computed):
 *  - OLV grids the committed class-2 ground with the production rasterizeDtm
 *    (point-in-cell mean) at 1.0 m — the USGS 3DEP QL2 bare-earth DEM resolution;
 *  - each checkpoint is compared to the DTM cell it falls in, nearest cell, no
 *    interpolation;
 *  - a checkpoint whose cell carries no classified ground is REJECTED, not
 *    counted;
 *  - the per-checkpoint bound is the USGS accuracy class for its type, not a
 *    figure fitted to the result: NVA (non-vegetated) 0.30 m, VVA (vegetated)
 *    0.60 m. The measured residuals / RMSE are logged unchanged.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/terrain-field');
const GROUND = resolve(DIR, 'crops/coconino__ground.f32');
const MATCHED = resolve(DIR, 'references/coconino__matched.json');
const CELL = 1.0; // m — USGS 3DEP QL2 bare-earth DEM resolution

// USGS accuracy classes (spec-derived, not fitted): a per-checkpoint bare-earth
// residual bound by checkpoint type.
const BOUND: Record<string, number> = { NVA: 0.3, VVA: 0.6 };

interface Matched {
  readonly checkpoints: ReadonlyArray<{ id: string; type: 'NVA' | 'VVA'; e: number; n: number; z: number }>;
}

function readGround(): TerrainPoint[] {
  const buf = readFileSync(GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  return pts;
}

describe('OLV DTM vs independent USGS checkpoints (Coconino forest, NAVD88↔NAVD88)', () => {
  const has = existsSync(GROUND) && existsSync(MATCHED);

  (has ? it : it.skip)('agrees with surveyed ground truth within each checkpoint\'s USGS accuracy class', () => {
    const pts = readGround();
    let maxX = 0, maxY = 0;
    for (const p of pts) { if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const cols = Math.ceil(maxX / CELL) + 1;
    const rows = Math.ceil(maxY / CELL) + 1;
    const grid = { originH1: 0, originH2: 0, cols, rows, cellSizeM: CELL } as const;
    const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid, aggregation: 'mean' }).z;

    const cps = (JSON.parse(readFileSync(MATCHED, 'utf8')) as Matched).checkpoints;
    const residuals: number[] = [];
    let rejected = 0;
    const failures: string[] = [];
    for (const c of cps) {
      const col = Math.floor(c.e / CELL), row = Math.floor(c.n / CELL);
      if (col < 0 || col >= cols || row < 0 || row >= rows) { rejected++; continue; }
      const v = z[row * cols + col];
      if (!Number.isFinite(v)) { rejected++; continue; } // no classified ground → reject
      const resid = v - c.z;
      residuals.push(resid);
      if (Math.abs(resid) > (BOUND[c.type] ?? 0.6)) {
        failures.push(`${c.id} (${c.type}): ${(resid * 100).toFixed(1)}cm > ${(BOUND[c.type] * 100)}cm`);
      }
    }

    const n = residuals.length;
    expect(n, 'at least one checkpoint had classified ground beneath it').toBeGreaterThan(0);
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
    const mae = abs.reduce((s, r) => s + r, 0) / n;
    const median = abs[Math.floor(n / 2)];
    const bias = residuals.reduce((s, r) => s + r, 0) / n;
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Coconino OLV DTM vs ${n} USGS checkpoints (rej ${rejected}): rmse=${(rmse * 100).toFixed(2)}cm mae=${(mae * 100).toFixed(2)}cm median=${(median * 100).toFixed(2)}cm bias=${(bias * 100).toFixed(2)}cm`);

    // Every matched checkpoint sits within its own USGS accuracy class.
    expect(failures, `checkpoints outside their USGS class:\n${failures.join('\n')}`).toHaveLength(0);
    // Once the sample is large enough to be a distribution, the aggregate RMSE
    // stays inside the coarser (vegetated) class.
    if (n >= 10) expect(rmse).toBeLessThan(0.6);
  });
});
