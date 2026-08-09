/**
 * coconinoCheckpoints.test.ts — OLV's DTM against INDEPENDENT surveyed ground
 * truth across a frozen multi-tile Coconino checkpoint universe.
 *
 * Dataset: USGS AZ Coconino B1 2019 (project 19049), public domain (USGS 3DEP /
 * The National Map). The project's aerial-LiDAR NVA/VVA accuracy checkpoints are
 * held separate from the 12 LiDAR Control Points — an independent vertical-
 * accuracy set, not reused for calibration, registration, strip adjustment,
 * classification tuning, or OLV parameter tuning. Checkpoints are reprojected to
 * the tile CRS (NAD83(2011) / Conus Albers). Tile Z and checkpoint Z are both
 * NAVD88 orthometric (Geoid12B), so there is no vertical-datum reconciliation.
 *
 * The checkpoint universe is FROZEN in
 * validation/terrain-field/coconino/input-universe.json: every downloaded tile
 * is hashed, and a checkpoint is IN the universe iff its Albers (E,N) falls
 * inside a downloaded tile's header bounds. Membership is fixed before any
 * residual is computed; no checkpoint is removed for a large error. OLV grids
 * the committed class-2 ground with the production rasterizeDtm at 1.0 m (the
 * USGS 3DEP QL2 bare-earth DEM resolution) and compares each checkpoint to its
 * DTM cell, nearest cell, no interpolation; a checkpoint whose cell carries no
 * classified ground is REJECTED, not counted.
 *
 * Per-checkpoint bounds are the USGS accuracy class for the type (NVA 0.30 m,
 * VVA 0.60 m), spec-derived, not fitted. This is external checkpoint agreement,
 * not an E5 field campaign: the checkpoints are found public data (not surveyed
 * under a protocol frozen before the survey), and N is below the formal count
 * threshold, so per validation/terrain-field/coconino/coconino-validation-summary.json
 * the DTM grade stays E3. The measured metrics are logged unchanged.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const DIR = resolve(__dirname, '../validation/terrain-field');
const GROUND = resolve(DIR, 'crops/coconino__ground.f32');
const MATCHED = resolve(DIR, 'references/coconino__matched.json');
const UNIVERSE = resolve(DIR, 'coconino/input-universe.json');
const CELL = 1.0; // m — USGS 3DEP QL2 bare-earth DEM resolution
const BOUND: Record<string, number> = { NVA: 0.3, VVA: 0.6 };

interface Cp { id: string; type: 'NVA' | 'VVA'; e: number; n: number; z: number }

function readGround(): TerrainPoint[] {
  const buf = readFileSync(GROUND);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const pts: TerrainPoint[] = new Array(f.length / 3);
  for (let i = 0; i < pts.length; i++) pts[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  return pts;
}

describe('OLV DTM vs independent USGS checkpoints (Coconino, NAVD88↔NAVD88)', () => {
  const has = existsSync(GROUND) && existsSync(MATCHED);

  (has ? it : it.skip)('agrees with surveyed ground truth within each checkpoint\'s USGS accuracy class', () => {
    const pts = readGround();
    const cps = (JSON.parse(readFileSync(MATCHED, 'utf8')) as { checkpoints: Cp[] }).checkpoints;

    // No control points may enter the accuracy set: every matched checkpoint is
    // an NVA or VVA accuracy point, never a LiDAR Control Point.
    for (const c of cps) expect(['NVA', 'VVA']).toContain(c.type);

    // The checkpoints span the whole project, so each is gridded in its OWN
    // local frame (a small window around it) rather than one universe-wide grid.
    // The DTM value is the production rasterizeDtm cell that contains the point.
    const HALO = 4; // m — local window; the crop only holds ground within 3 m
    const dtmAt = (c: Cp): number => {
      const oH1 = Math.floor(c.e) - HALO, oH2 = Math.floor(c.n) - HALO;
      const span = 2 * HALO + 1;
      const local: TerrainPoint[] = [];
      for (const p of pts) {
        if (p.x >= oH1 && p.x < oH1 + span && p.y >= oH2 && p.y < oH2 + span) local.push(p);
      }
      if (local.length === 0) return NaN;
      const z = rasterizeDtm(local, new Uint8Array(local.length).fill(1), { grid: { originH1: oH1, originH2: oH2, cols: span, rows: span, cellSizeM: CELL }, aggregation: 'mean' }).z;
      const col = Math.floor((c.e - oH1) / CELL), row = Math.floor((c.n - oH2) / CELL);
      return z[row * span + col];
    };

    const all: number[] = [], nva: number[] = [], vva: number[] = [];
    const failures: string[] = [];
    let rejected = 0;
    for (const c of cps) {
      const v = dtmAt(c);
      if (!Number.isFinite(v)) { rejected++; continue; } // no classified ground → reject
      const resid = v - c.z;
      all.push(resid);
      (c.type === 'NVA' ? nva : vva).push(resid);
      if (Math.abs(resid) > (BOUND[c.type] ?? 0.6)) {
        failures.push(`${c.id} (${c.type}): ${(resid * 100).toFixed(1)}cm > ${BOUND[c.type] * 100}cm`);
      }
    }

    const stat = (r: number[]) => {
      const n = r.length; const abs = r.map(Math.abs).sort((a, b) => a - b);
      const rmse = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / n);
      return { n, rmse_cm: (rmse * 100).toFixed(2), mae_cm: ((abs.reduce((s, x) => s + x, 0) / n) * 100).toFixed(2), bias_cm: ((r.reduce((s, x) => s + x, 0) / n) * 100).toFixed(2), max_cm: (abs[n - 1] * 100).toFixed(2) };
    };
    // eslint-disable-next-line no-console
    console.log(`[terrain-field] Coconino DTM vs ${all.length} USGS checkpoints (rej ${rejected}): overall ${JSON.stringify(stat(all))} | NVA ${nva.length >= 5 ? JSON.stringify(stat(nva)) : 'INSUFFICIENT_N'} | VVA ${vva.length >= 5 ? JSON.stringify(stat(vva)) : 'INSUFFICIENT_N'}`);

    // No checkpoint is silently dropped: candidates == usable + rejected.
    expect(all.length + rejected).toBe(cps.length);
    // A real multi-tile universe, not a single point.
    expect(all.length).toBeGreaterThanOrEqual(10);
    // Every usable checkpoint sits within its own USGS accuracy class.
    expect(failures, `checkpoints outside their USGS class:\n${failures.join('\n')}`).toHaveLength(0);
  });

  const hasUni = existsSync(UNIVERSE) && existsSync(MATCHED);
  (hasUni ? it : it.skip)('the frozen universe and the matched crop agree, and E5 is not falsely claimed', () => {
    const uni = JSON.parse(readFileSync(UNIVERSE, 'utf8'));
    const matched = (JSON.parse(readFileSync(MATCHED, 'utf8')) as { checkpoints: Cp[] }).checkpoints;
    // The crop covers exactly the frozen matched universe — deterministic membership.
    expect(matched.length).toBe(uni.matchedCheckpointCount);
    const uniIds = new Set(uni.matchedCheckpoints.map((c: { id: string }) => c.id));
    for (const c of matched) expect(uniIds.has(c.id)).toBe(true);
    // Evidence cannot be silently promoted: the determination stays E3 / not-E5,
    // with the limiting reasons recorded.
    expect(uni.evidenceDetermination.e5Reached).toBe(false);
    expect(uni.evidenceDetermination.limitingReasons.length).toBeGreaterThan(0);
    expect(uni.evidenceIndependence.usedForParameterTuning).toBe(false);
  });
});
