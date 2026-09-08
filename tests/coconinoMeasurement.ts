/**
 * coconinoMeasurement.ts — the ONE measurement behind every Coconino artifact.
 *
 * Both the accuracy gate (coconinoCheckpoints.test.ts) and the published
 * artifacts (coconinoArtifacts.test.ts) read this module, so a number in a
 * shipped file and the number the gate judges cannot be produced by two
 * different pieces of arithmetic.
 *
 * They were. The universe was rebuilt to 60 matched checkpoints across 57 tiles
 * on 2026-08-14, but coconino-metrics.json, coconino-validation-summary.json and
 * coconino-checkpoint-results.csv were written on 2026-08-09 for a 13-point,
 * 8-tile universe, and the rebuild script carried the old `metrics` block
 * forward untouched (`prev.update(...)`), so input-universe.json listed 60
 * checkpoints beside statistics over 13. Nothing recomputed them because nothing
 * could: the gate printed its metrics to the console and wrote no file.
 *
 * The residuals were never wrong. What was missing was one derivation that every
 * artifact is written from, and a check that fails when they diverge again.
 *
 * The rejection rule is the gate's, unchanged: a checkpoint whose local window
 * holds no classified ground yields no DTM cell and cannot be measured, so it is
 * REJECTED and reported as such. `candidate === usable + rejected` is asserted;
 * no checkpoint is ever removed for a large residual.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const FIELD = resolve(__dirname, '../validation/terrain-field');
export const PATHS = {
  ground: resolve(FIELD, 'crops/coconino__ground.f32'),
  matched: resolve(FIELD, 'references/coconino__matched.json'),
  published: resolve(FIELD, 'references/coconino-b19-2019__checkpoints.json'),
  universe: resolve(FIELD, 'coconino/input-universe.json'),
  metrics: resolve(FIELD, 'coconino/coconino-metrics.json'),
  summary: resolve(FIELD, 'coconino/coconino-validation-summary.json'),
  results: resolve(FIELD, 'coconino/coconino-checkpoint-results.csv'),
  eligibility: resolve(FIELD, 'coconino/coconino-eligibility.json'),
  requiredTiles: resolve(FIELD, 'coconino/required-tiles.json'),
  sums: resolve(FIELD, 'coconino/SHA256SUMS'),
  readme: resolve(FIELD, 'README.md'),
} as const;

/** m — the USGS 3DEP QL2 bare-earth DEM resolution. */
export const CELL_M = 1.0;
/** m — local window half-width; the crop only holds ground within 3 m of a point. */
const HALO_M = 4;

export interface Checkpoint {
  readonly id: string;
  readonly type: 'NVA' | 'VVA';
  readonly e: number;
  readonly n: number;
  readonly z: number;
}

export interface CheckpointResult {
  readonly id: string;
  readonly type: 'NVA' | 'VVA';
  readonly e: number;
  readonly n: number;
  readonly zSurveyed: number;
  /** The DTM cell value, or null when no classified ground fell in the window. */
  readonly zOlv: number | null;
  readonly residualM: number | null;
  readonly state: 'measured' | 'rejected-no-ground';
}

/** The statistics every artifact reports, in centimetres. */
export interface Stats {
  readonly n: number;
  readonly rmse_cm: number;
  readonly mae_cm: number;
  readonly median_cm: number;
  readonly bias_cm: number;
  readonly nmad_cm: number;
  readonly p90_cm: number;
  readonly p95_cm: number;
  readonly max_cm: number;
}

export interface CoconinoMetrics {
  readonly overall: Stats;
  readonly NVA: Stats;
  readonly VVA: Stats;
  /** In the frozen universe: inside a downloaded tile's header bounds. */
  readonly candidate: number;
  /** Measured: the checkpoint's DTM cell carried classified ground. */
  readonly usable: number;
  /** No classified ground in the cell. Never a rejection for a large error. */
  readonly rejected: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Linear-interpolated percentile of |residual|.
 *
 * This is the function the VVA gate judges against, so the reported p95 is the
 * one the release tested. The 2026-08-09 files used a nearest-rank percentile
 * instead, which is why their p95 and max read as the same number; two
 * definitions of "p95" for one dataset is the drift this module removes.
 */
export function percentileAbs(sortedAbs: readonly number[], q: number): number {
  if (sortedAbs.length === 0) return Number.NaN;
  const idx = q * (sortedAbs.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sortedAbs[lo] + (sortedAbs[hi] - sortedAbs[lo]) * (idx - lo);
}

/** Median of an already-sorted array; the mean of the two middles when even. */
function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export const rmseOf = (residualsM: readonly number[]): number =>
  Math.sqrt(residualsM.reduce((s, x) => s + x * x, 0) / residualsM.length);

/** Statistics over signed residuals in metres, reported in centimetres. */
export function statsOf(residualsM: readonly number[]): Stats {
  const n = residualsM.length;
  const abs = residualsM.map(Math.abs).sort((a, b) => a - b);
  const med = medianOf([...residualsM].sort((a, b) => a - b));
  // NMAD = 1.4826 x median absolute deviation about the median: the robust
  // spread USGS/ASPRS reporting carries beside RMSE for non-Gaussian tails.
  const madSorted = residualsM.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  return {
    n,
    rmse_cm: round2(rmseOf(residualsM) * 100),
    mae_cm: round2((abs.reduce((s, x) => s + x, 0) / n) * 100),
    median_cm: round2(medianOf(abs) * 100),
    bias_cm: round2((residualsM.reduce((s, x) => s + x, 0) / n) * 100),
    nmad_cm: round2(1.4826 * medianOf(madSorted) * 100),
    p90_cm: round2(percentileAbs(abs, 0.9) * 100),
    p95_cm: round2(percentileAbs(abs, 0.95) * 100),
    max_cm: round2(abs[n - 1] * 100),
  };
}

/** The committed class-2 ground crop, as production terrain points. */
export function readGround(): TerrainPoint[] {
  const buf = readFileSync(PATHS.ground);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const pts: TerrainPoint[] = new Array(f.length / 3);
  for (let i = 0; i < pts.length; i++) pts[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  return pts;
}

/** The frozen matched universe. */
export function readMatched(): Checkpoint[] {
  return (JSON.parse(readFileSync(PATHS.matched, 'utf8')) as { checkpoints: Checkpoint[] }).checkpoints;
}

/**
 * Measure every matched checkpoint against the production DTM.
 *
 * Each checkpoint is gridded in its OWN local window rather than one
 * project-wide grid: the universe spans ~50x110 km and the committed crop holds
 * only the ground around each checkpoint. The DTM value is the production
 * rasterizeDtm cell containing the point: nearest cell, no interpolation.
 */
export function measureCheckpoints(
  points: readonly TerrainPoint[],
  checkpoints: readonly Checkpoint[],
): CheckpointResult[] {
  return checkpoints.map((c) => {
    const rejected = {
      id: c.id, type: c.type, e: c.e, n: c.n, zSurveyed: c.z,
      zOlv: null, residualM: null, state: 'rejected-no-ground',
    } as const;
    const oH1 = Math.floor(c.e) - HALO_M, oH2 = Math.floor(c.n) - HALO_M;
    const span = 2 * HALO_M + 1;
    const local: TerrainPoint[] = [];
    for (const p of points) {
      if (p.x >= oH1 && p.x < oH1 + span && p.y >= oH2 && p.y < oH2 + span) local.push(p);
    }
    if (local.length === 0) return rejected;
    const { z } = rasterizeDtm(local, new Uint8Array(local.length).fill(1), {
      grid: { originH1: oH1, originH2: oH2, cols: span, rows: span, cellSizeM: CELL_M },
      aggregation: 'mean',
    });
    const col = Math.floor((c.e - oH1) / CELL_M), row = Math.floor((c.n - oH2) / CELL_M);
    const v = z[row * span + col];
    if (!Number.isFinite(v)) return rejected;
    return { id: c.id, type: c.type, e: c.e, n: c.n, zSurveyed: c.z, zOlv: v, residualM: v - c.z, state: 'measured' };
  });
}

/** Signed residuals in metres for the measured checkpoints of one stratum. */
export const residualsOf = (
  results: readonly CheckpointResult[],
  type?: 'NVA' | 'VVA',
): number[] =>
  results
    .filter((r) => r.state === 'measured' && (type ? r.type === type : true))
    .map((r) => r.residualM as number);

/** The funnel and the statistics, from the measured results. */
export function metricsOf(results: readonly CheckpointResult[]): CoconinoMetrics {
  const usable = results.filter((r) => r.state === 'measured').length;
  return {
    overall: statsOf(residualsOf(results)),
    NVA: statsOf(residualsOf(results, 'NVA')),
    VVA: statsOf(residualsOf(results, 'VVA')),
    candidate: results.length,
    usable,
    rejected: results.length - usable,
  };
}

/** Everything an artifact needs, from the committed inputs alone. */
export function computeCoconino(): { results: CheckpointResult[]; metrics: CoconinoMetrics } {
  const results = measureCheckpoints(readGround(), readMatched());
  return { results, metrics: metricsOf(results) };
}
