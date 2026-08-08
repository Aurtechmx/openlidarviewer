/**
 * marshIslandCheckpoints.test.ts — OLV's DTM against INDEPENDENT surveyed
 * ground truth.
 *
 * Dataset: USGS Marsh Island / New Bedford MA UAS survey (Over et al. 2024,
 * DOI 10.5066/P19TLXVG), public domain / CC0. It ships 104 RTK check shots
 * (Emlid RS3) that are independent of the aerial control points, in NAD83(2011)
 * UTM 19N with NAVD88 orthometric heights. The classified point cloud's Z is the
 * SAME reference — NAVD88 orthometric — so OLV's DTM and the checkpoints are
 * compared with no vertical-datum reconciliation.
 *
 * OLV grids the committed class-2 ground with the production rasterizeDtm
 * (point-in-cell mean), and each checkpoint is compared to the DTM cell it falls
 * in. This is absolute accuracy against surveyed truth, not a check against
 * another implementation of the same maths.
 *
 * MATCHING PROTOCOL (fixed before the accuracy was computed):
 *  - sample the DTM at the cell containing the checkpoint's UTM easting/northing,
 *    nearest cell, no interpolation;
 *  - a checkpoint whose cell has no classified ground (no DTM value) is REJECTED,
 *    not counted;
 *  - a residual over 1 m is a gross outlier — a check shot that landed above the
 *    bare-earth surface the DTM represents (marsh structure / vegetation) — and
 *    is reported separately, using a physical 1 m bare-earth threshold, not a
 *    threshold chosen from the results.
 *
 * The asserted bounds come from the accuracy budget (RTK ~2 cm + a UAS
 * bare-earth product's ~10 cm class), not from the measured figures; the
 * measured N / RMSE / MAE / median / bias are logged unchanged.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/terrain-field');
const GROUND = resolve(DIR, 'crops/marsh-island__ground.f32');
const CKPTS = resolve(DIR, 'references/marsh-island__checkpoints.json');
const CELL = 0.5; // m

interface Checkpoints {
  readonly checkpoints: ReadonlyArray<{ id: number; e: number; n: number; z: number }>;
}

function readGround(): TerrainPoint[] {
  const buf = readFileSync(GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 3;
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  return pts;
}

describe('OLV DTM vs 104 independent RTK checkpoints (Marsh Island, NAVD88↔NAVD88)', () => {
  const has = existsSync(GROUND) && existsSync(CKPTS);

  (has ? it : it.skip)('agrees with surveyed ground truth within the product accuracy budget', () => {
    const pts = readGround();
    // Grid the ground over the checkpoint area (relative coords, origin 0,0).
    let maxX = 0, maxY = 0;
    for (const p of pts) { if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const cols = Math.ceil(maxX / CELL) + 1;
    const rows = Math.ceil(maxY / CELL) + 1;
    const grid = { originH1: 0, originH2: 0, cols, rows, cellSizeM: CELL } as const;
    const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid, aggregation: 'mean' }).z;

    const cps = (JSON.parse(readFileSync(CKPTS, 'utf8')) as Checkpoints).checkpoints;
    const residuals: number[] = [];
    let rejected = 0;
    for (const c of cps) {
      const col = Math.floor(c.e / CELL), row = Math.floor(c.n / CELL);
      if (col < 0 || col >= cols || row < 0 || row >= rows) { rejected++; continue; }
      const v = z[row * cols + col];
      if (!Number.isFinite(v)) { rejected++; continue; } // no classified ground → reject
      residuals.push(v - c.z);
    }
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    const n = residuals.length;
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
    const mae = abs.reduce((s, r) => s + r, 0) / n;
    const median = abs[Math.floor(n / 2)];
    const bias = residuals.reduce((s, r) => s + r, 0) / n;
    const maxAbs = abs[n - 1];
    const kept = residuals.filter((r) => Math.abs(r) < 1.0); // bare-earth gross-outlier cut
    const rmseKept = Math.sqrt(kept.reduce((s, r) => s + r * r, 0) / kept.length);
    const gross = n - kept.length;
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Marsh Island OLV DTM vs ${n} RTK checkpoints (rej ${rejected}): rmse=${(rmse * 100).toFixed(2)}cm mae=${(mae * 100).toFixed(2)}cm median=${(median * 100).toFixed(2)}cm bias=${(bias * 100).toFixed(2)}cm max=${(maxAbs * 100).toFixed(1)}cm | excl.>1m (${gross} gross): rmse=${(rmseKept * 100).toFixed(2)}cm`);

    // Coverage: most checkpoints have classified ground beneath them.
    expect(n).toBeGreaterThan(95);
    // Absolute accuracy against surveyed truth, within the RTK + bare-earth
    // product budget (spec-derived, not fitted): the median is decimetre-class
    // and the outlier-free RMSE is inside 15 cm.
    expect(median).toBeLessThan(0.10);
    expect(rmseKept).toBeLessThan(0.15);
    // The gross outliers are few (check shots above bare earth), not the norm.
    expect(gross).toBeLessThan(0.1 * n);
  });
});
