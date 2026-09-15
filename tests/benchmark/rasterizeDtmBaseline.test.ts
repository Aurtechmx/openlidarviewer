/**
 * rasterizeDtmBaseline.test.ts: per-cell aggregation cost of the DTM raster.
 *
 * Times `rasterizeDtm` for each aggregation over a synthetic ground return
 * set at a fixed grid, best of three, so the list-needing modes (median,
 * percentile, robust) can be compared with the O(1)-state modes and with
 * themselves across a change to their storage. Gated on
 * `RASTERIZE_BENCH=1`; every run is printed, nothing is asserted on time.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { rasterizeDtm, type DtmAggregation } from '../../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../../src/terrain/TerrainContracts';

const ENABLED = process.env.RASTERIZE_BENCH === '1';
const POINTS = Number(process.env.RASTERIZE_BENCH_POINTS ?? 2_000_000);
const RUNS = 3;

function cloud(n: number): TerrainPoint[] {
  let s = 20260915;
  const rnd = (): number => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const pts: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = rnd() * 1000;
    const y = rnd() * 1000;
    pts[i] = { x, y, z: 100 + 10 * Math.sin(x / 90) * Math.cos(y / 70) + rnd() * 0.5 };
  }
  return pts;
}

// Skipped by design outside a benchmark run: it needs an explicit opt-in.
describe.skipIf(!ENABLED)('rasterizeDtm aggregation cost', () => {
  it(
    'times every aggregation on one return set',
    () => {
      const pts = cloud(POINTS);
      const mask = new Uint8Array(POINTS).fill(1);
      const grid = { originH1: 0, originH2: 0, cols: 1000, rows: 1000, cellSizeM: 1 };
      // eslint-disable-next-line no-console
      console.log(`\nrasterizeDtm: ${POINTS / 1e6}M returns over ${grid.cols}x${grid.rows}, best of ${RUNS}`);
      for (const aggregation of ['mean', 'min', 'median', 'percentile', 'robust'] as DtmAggregation[]) {
        const times: number[] = [];
        let filled = 0;
        for (let r = 0; r < RUNS; r++) {
          const t0 = performance.now();
          const out = rasterizeDtm(pts, mask, { grid, aggregation, percentile: 0.25 });
          times.push(performance.now() - t0);
          filled = out.filledCellCount;
        }
        expect(filled).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
          `  ${aggregation.padEnd(10)} best ${Math.min(...times).toFixed(0).padStart(6)} ms   runs [${times.map((t) => t.toFixed(0)).join(', ')}]   filled ${filled}`,
        );
      }
    },
    600_000,
  );
});
