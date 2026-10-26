/**
 * tests/storageHistoryReport.test.ts
 *
 * The shell side of the storage-grid test: which clouds it refuses before reading a point,
 * what it hands the worker, and the running-then-settled outcome with its per-cloud cache.
 * Node has no Worker, so the client runs the test on the main thread here.
 */
import { describe, expect, it } from 'vitest';
import { storageHistoryFor, storageHistoryRefusal, storageHistoryRequest } from '../src/app/storageHistoryReport';
import { runAnalysisModules } from '../src/app/analysisModuleRegistry';
import { MAX_RECOVERED_POINTS, MIN_POINTS } from '../src/science/storageHistory';
import { PointCloud } from '../src/model/PointCloud';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';

const METRE: CrsInfo = { source: 'epsg', epsg: 32610, name: 'EPSG:32610', isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1 };
const GEOGRAPHIC: CrsInfo = { source: 'epsg', epsg: 4326, name: 'EPSG:4326', isGeographic: true, linearUnit: 'unknown', linearUnitToMetres: 1 };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A millimetre LAS cloud of `n` points over 60 m whose coordinates were rounded to 0.01 m first. */
function lasCloud(n: number, opts: { quantised?: boolean; crs?: CrsInfo; format?: 'las' | 'laz' | 'ply'; step?: number | null } = {}): PointCloud {
  const r = rng(21);
  const offset: [number, number, number] = [500_000, 4_200_000, 100];
  const positions = new Float32Array(3 * n);
  const s1 = opts.step === undefined ? 0.01 : opts.step;
  for (let i = 0; i < n; i++) {
    let x = r() * 60, y = r() * 60;
    if (s1 !== null) { x = s1 * Math.round(x / s1); y = s1 * Math.round(y / s1); }
    positions[3 * i] = (offset[0] + 0.001 * Math.round(x / 0.001)) - offset[0];
    positions[3 * i + 1] = (offset[1] + 0.001 * Math.round(y / 0.001)) - offset[1];
    positions[3 * i + 2] = 0.001 * Math.round(r() * 5000);
  }
  return new PointCloud({
    positions,
    origin: offset,
    sourceFormat: opts.format ?? 'las',
    name: 'storage-fixture',
    metadata: {
      ...(opts.crs ? { crs: opts.crs } : {}),
      ...(opts.quantised === false ? {} : { sourceQuantisation: { scale: [0.001, 0.001, 0.001], offset } }),
    },
  });
}

describe('storageHistoryRefusal', () => {
  it('refuses other formats, loads that dropped the header grid, geographic frames and small clouds', () => {
    expect(storageHistoryRefusal(lasCloud(10, { format: 'ply' }), undefined)).toBe('not a LAS or LAZ file');
    expect(storageHistoryRefusal(lasCloud(10, { quantised: false }), undefined)).toBe('stored integers not kept by this load');
    expect(storageHistoryRefusal(lasCloud(10, { crs: GEOGRAPHIC }), spatialContextFrom(GEOGRAPHIC))).toBe('geographic coordinates');
    expect(storageHistoryRefusal(lasCloud(MIN_POINTS - 1), undefined)).toBe('too few points');
    expect(storageHistoryRefusal(lasCloud(MIN_POINTS, { format: 'laz' }), spatialContextFrom(METRE))).toBeNull();
  });
});

describe('storageHistoryRequest', () => {
  it('copies X and Y only, with the header grid and the frame unit', () => {
    const c = lasCloud(5);
    const req = storageHistoryRequest(c, spatialContextFrom(METRE));
    expect(req.xy).toHaveLength(10);
    expect(req.xy[2]).toBe(c.positions[3]);
    expect(req.xy[3]).toBe(c.positions[4]);
    expect(req.scale).toEqual([0.001, 0.001]);
    expect(req.offset).toEqual([500_000, 4_200_000]);
    expect(req.sourceOrigin).toEqual([500_000, 4_200_000]);
    expect(req.unitToMetres).toBe(1);
    expect(storageHistoryRequest(c, undefined).unitToMetres).toBeNull();
  });
  it('strides a cloud above the recovery cap', () => {
    const n = MAX_RECOVERED_POINTS + 1;
    const positions = new Float32Array(3 * n);
    const c = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'big', metadata: { sourceQuantisation: { scale: [0.001, 0.001, 0.001], offset: [0, 0, 0] } } });
    expect(storageHistoryRequest(c, undefined).xy).toHaveLength(2 * Math.ceil(n / 2));
  });
});

describe('storageHistoryFor', { timeout: 120_000 }, () => {
  it('reads running, settles once through the listener, then serves the cached outcome', async () => {
    const c = lasCloud(30_000, { crs: METRE });
    const ctx = spatialContextFrom(METRE);
    const settled: unknown[] = [];
    const first = storageHistoryFor(c, ctx, (o) => settled.push(o));
    expect(first).toEqual({ kind: 'running' });
    const again = storageHistoryFor(c, ctx, (o) => settled.push(o));
    expect(again).toEqual({ kind: 'running' });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toHaveLength(2);
    expect(settled[0]).toEqual(settled[1]);
    const outcome = storageHistoryFor(c, ctx);
    expect(outcome.kind).toBe('supported');
    if (outcome.kind === 'supported') {
      expect(outcome.unit).toBe('m');
      expect(outcome.step).toBe(0.01);
      expect(outcome.rotationDeg).toBe(0);
    }
  });
  it('answers a refused cloud at once without a listener call', () => {
    const calls: unknown[] = [];
    expect(storageHistoryFor(lasCloud(50), undefined, (o) => calls.push(o))).toEqual({ kind: 'not-tested', reason: 'too few points' });
    expect(calls).toHaveLength(0);
  });
});

describe('runAnalysisModules', { timeout: 120_000 }, () => {
  it('returns rows with the row running, then hands the rebuilt rows to onUpdate', async () => {
    const c = lasCloud(30_000, { crs: METRE, step: null });
    const updates: string[] = [];
    const rows = await runAnalysisModules(c, { spatialContext: spatialContextFrom(METRE) }, undefined, undefined, (r) => {
      updates.push(r.find((x) => x.label === 'Storage history')?.value ?? '');
    });
    expect(rows.find((r) => r.label === 'Storage history')?.value).toBe('test running');
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toEqual(['none detected']);
    const next = await runAnalysisModules(c, { spatialContext: spatialContextFrom(METRE) });
    expect(next.find((r) => r.label === 'Storage history')?.value).toBe('none detected');
  });
});
