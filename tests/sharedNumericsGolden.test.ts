/**
 * sharedNumericsGolden.test.ts
 *
 * Golden pins for the numeric helpers that used to be duplicated across the
 * tree (quantiles, byte-size strings). Written BEFORE the consolidation so the
 * snapshot records what every call site produced on main; the consolidation
 * must reproduce it bit for bit.
 *
 * Two layers:
 *   1. Public-API snapshots: each site that exposes its quantile through an
 *      exported function is driven with fixed inputs and its full output is
 *      snapshotted (numbers serialise round-trip exact).
 *   2. Frozen legacy formulas: a verbatim copy of each private implementation
 *      as it stood on main, compared with Object.is against the site's current
 *      public path where one exists (and, after consolidation, against the
 *      named shared variant each site now calls).
 */

import { describe, it, expect } from 'vitest';
import { percentile as lassoPercentile } from '../src/render/measure/lassoVolume';
import { percentileSorted as framePercentileSorted } from '../src/perf/frameTelemetry';
import { aggregate } from '../src/render/streaming/streamingBenchmark';
import { computeScalarRange } from '../src/render/elevationRange';
import { rgbAutoNormalize } from '../src/render/rgbAutoNormalize';
import { compareGrids, type GridSpec } from '../src/validation/gridAgreement';
import { checkpointAccuracy, type Checkpoint } from '../src/validation/checkpointAccuracy';
import { formatMegabytes } from '../src/app/offlineCopy';
import {
  quantile,
  quantileSorted,
  quantileType7InPlace,
  quantileNearestRankSorted,
  floorRankIndex,
} from '../src/terrain/quantile';
import { sampleBudgetRefusal } from '../src/render/streaming/fullCloudGrade';
import { formatTelemetry } from '../src/io/loadTelemetry';
import { oversizeReportResult } from '../src/ui/reportVerifier';
import { assertWorkflowFileSize } from '../src/ui/WorkflowController';

/** Deterministic LCG so the battery is identical on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sample(seed: number, n: number, ties = false): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(ties ? Math.round(r() * 5) : (r() - 0.3) * 137.25);
  return out;
}

const SIZES = [1, 2, 3, 4, 5, 7, 10, 19, 20, 21, 100, 257];
const PS = [0, 0.01, 0.05, 0.1, 0.25, 0.333, 0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 1];

describe('golden: exported quantile paths', () => {
  it('lassoVolume.percentile', () => {
    const rows: number[] = [];
    for (const n of SIZES) {
      const v = sample(n, n);
      for (const p of [...PS, -0.5, 1.5]) rows.push(lassoPercentile(v, p));
    }
    rows.push(lassoPercentile([], 0.5), lassoPercentile([NaN, 3, Infinity, 1], 0.5));
    expect(rows).toMatchSnapshot();
  });

  it('frameTelemetry.percentileSorted', () => {
    const rows: number[] = [];
    for (const n of SIZES) {
      const v = sample(n + 1, n).sort((a, b) => a - b);
      for (const p of [0, 1, 5, 25, 50, 90, 95, 99, 100]) rows.push(framePercentileSorted(v, n, p));
      rows.push(framePercentileSorted(v, Math.max(0, n - 1), 95));
    }
    rows.push(framePercentileSorted([], 0, 50));
    expect(rows).toMatchSnapshot();
  });

  it('streamingBenchmark.aggregate', () => {
    expect(SIZES.map((n) => aggregate(sample(n + 2, n))).concat(aggregate([]))).toMatchSnapshot();
  });

  it('elevationRange.computeScalarRange', () => {
    const out = [];
    for (const n of SIZES) {
      const v = Float32Array.from(sample(n + 3, n));
      out.push(computeScalarRange(v));
      out.push(computeScalarRange(v, { lowerPercentile: 2, upperPercentile: 98 }));
    }
    expect(out).toMatchSnapshot();
  });

  it('rgbAutoNormalize', () => {
    const out = [];
    for (const [seed, scale] of [[1, 255], [2, 90], [3, 40], [4, 255]] as const) {
      const r = rng(seed);
      const c = new Uint8Array(3 * 997);
      for (let i = 0; i < c.length; i++) c[i] = Math.floor(r() * scale) + (seed === 4 ? 0 : 0);
      out.push(rgbAutoNormalize({ colorsU8: c }));
    }
    expect(out).toMatchSnapshot();
  });

  it('gridAgreement.compareGrids (nearest-rank median / NMAD / p95)', () => {
    const out = [];
    for (const [w, h] of [[2, 2], [5, 4], [9, 7]] as const) {
      const spec: GridSpec = { originX: 0, originY: 0, cellSize: 1, width: w, height: h };
      const a = sample(w * 10 + h, w * h);
      const b = sample(w * 20 + h, w * h);
      out.push(compareGrids({ spec, values: a, nodata: null }, { spec, values: b, nodata: null }, { tolerance: 0.5 }));
    }
    expect(out).toMatchSnapshot();
  });

  it('checkpointAccuracy (nearest-rank)', () => {
    const out = [];
    for (const n of [5, 12, 31]) {
      const res = sample(n * 7, n);
      const cps: Checkpoint[] = res.map((r, i) => ({
        id: `c${i}`,
        reference: 100,
        measured: 100 + r / 100,
        usage: 'independent',
      }));
      out.push(checkpointAccuracy(cps, { minSample: 5 }));
    }
    expect(out).toMatchSnapshot();
  });
});

// ── Frozen legacy formulas, verbatim from main before consolidation. ────────
export const legacy = {
  /** checkpointAccuracy / gridAgreement / spatialBootstrap (identical text). */
  nearestRank(sorted: readonly number[], p: number): number {
    const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[Math.min(idx, sorted.length - 1)];
  },
  /** stockpileVolume.percentileSorted */
  stockpile(sorted: Float64Array, p: number): number {
    const n = sorted.length;
    if (n === 0) return Number.NaN;
    if (n === 1) return sorted[0];
    const idx = Math.max(0, Math.min(1, p)) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
  },
  /** profileSampler.percentileSorted (p in 0..100) */
  profile(sorted: Float64Array, count: number, p: number): number {
    if (count === 1) return sorted[0];
    const frac = Math.max(0, Math.min(100, p)) / 100;
    const rank = frac * (count - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    const w = rank - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
  },
  /** lassoOcclusion.quantileInPlace */
  occlusion(values: Float64Array, p: number): number {
    const n = values.length;
    if (n === 0) return 0;
    values.sort();
    const idx = Math.max(0, Math.min(1, p)) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return values[lo];
    return values[lo] * (hi - idx) + values[hi] * (idx - lo);
  },
  /** rgbAutoNormalize.percentile */
  rgb(sorted: Float32Array, p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
    return sorted[i];
  },
  /** elevationRange index pick */
  elevationIdx(used: number, pct: number): number {
    return Math.max(0, Math.min(used - 1, Math.floor((pct / 100) * used)));
  },
  /** streamingBenchmark.percentile */
  benchmark(sortedAscending: readonly number[], q: number): number {
    const n = sortedAscending.length;
    if (n === 0) return 0;
    if (n === 1) return sortedAscending[0];
    const clamped = Math.min(1, Math.max(0, q));
    const idx = clamped * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedAscending[lo];
    const frac = idx - lo;
    return sortedAscending[lo] * (1 - frac) + sortedAscending[hi] * frac;
  },
};

describe('golden: frozen legacy formulas agree with the exported paths on main', () => {
  it('frameTelemetry.percentileSorted is nearest-rank on p/100', () => {
    for (const n of SIZES) {
      const v = sample(n + 1, n).sort((a, b) => a - b);
      for (let p = 0; p <= 100; p += 0.5) {
        expect(Object.is(framePercentileSorted(v, n, p), legacy.nearestRank(v, p / 100))).toBe(true);
      }
    }
  });
});

describe('golden: byte-size strings', () => {
  it('offlineCopy.formatMegabytes', () => {
    expect([0, 1, 999, 49_999, 50_000, 1_000_000, 12_345_678, 7.25e9].map(formatMegabytes)).toMatchSnapshot();
  });
  it('fullCloudGrade.sampleBudgetRefusal note', () => {
    expect([2e7, 9e7, 3e8].map((p) => sampleBudgetRefusal({ sampledPoints: p }))).toMatchSnapshot();
  });
  it('loadTelemetry.formatTelemetry byte rows', () => {
    const out = [0, 1, 999, 1000, 54_321, 999_999, 1_000_000, 12_345_678, 7.25e9].map((b) =>
      formatTelemetry({ requestedBytes: b, uniqueBytesRead: b / 3, compressedBytesRead: b * 2 } as never),
    );
    expect(out).toMatchSnapshot();
  });
  it('oversize report / workflow messages', () => {
    const sizes = [32 * 1024 * 1024 + 1, 40.5 * 1024 * 1024, 33.5 * 1024 * 1024, 1e9];
    const wf = sizes.map((b) => {
      try { assertWorkflowFileSize(b); return 'ok'; } catch (e) { return (e as Error).message; }
    });
    expect({ report: sizes.map((b) => oversizeReportResult(b)?.reason), wf }).toMatchSnapshot();
  });
});

describe('consolidation: each site now calls a named variant identical to its legacy formula', () => {
  const same = (a: number, b: number): boolean => Object.is(a, b);
  const PX = [...PS, -0.25, 1.25, 0.049999, 0.500001];

  it('nearest-rank (checkpointAccuracy, gridAgreement, spatialBootstrap, frameTelemetry)', () => {
    for (const n of SIZES) {
      const v = sample(n + 11, n, n % 2 === 0).sort((a, b) => a - b);
      for (const p of PX) expect(same(quantileNearestRankSorted(v, p), legacy.nearestRank(v, p))).toBe(true);
    }
  });

  it('type-7 sorted (stockpileVolume, profileSampler, streamingBenchmark)', () => {
    for (const n of SIZES) {
      const v = Float64Array.from(sample(n + 12, n, n % 3 === 0)).sort();
      for (const p of PX) {
        expect(same(quantileSorted(v, p), legacy.stockpile(v, p))).toBe(true);
        expect(same(quantileSorted(v, p), legacy.benchmark(Array.from(v), p))).toBe(true);
      }
      for (let pp = -10; pp <= 110; pp += 0.5) {
        expect(same(quantileSorted(v, pp / 100), legacy.profile(v, v.length, pp))).toBe(true);
      }
    }
  });

  it('type-7 in place (lassoOcclusion)', () => {
    for (const n of SIZES) {
      for (const p of PX) {
        const a = Float64Array.from(sample(n + 13, n));
        const b = Float64Array.from(a);
        expect(same(quantileType7InPlace(a, p), legacy.occlusion(b, p))).toBe(true);
      }
    }
  });

  it('type-7 filtered (lassoVolume.percentile) is the shared quantile', () => {
    for (const n of SIZES) {
      const v = sample(n + 14, n);
      v.push(NaN, Infinity);
      for (const p of PX) expect(same(lassoPercentile(v, p), quantile(v, p))).toBe(true);
    }
  });

  it('floor-rank index (rgbAutoNormalize, elevationRange)', () => {
    for (const n of SIZES) {
      const v = Float32Array.from(sample(n + 15, n)).sort();
      for (const p of PX) {
        expect(same(v[floorRankIndex(n, p)], legacy.rgb(v, p))).toBe(true);
      }
      for (let pct = 0; pct <= 100; pct += 0.5) {
        expect(floorRankIndex(n, pct / 100)).toBe(legacy.elevationIdx(n, pct));
      }
    }
  });
});
