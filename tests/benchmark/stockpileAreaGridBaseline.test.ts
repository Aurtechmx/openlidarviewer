/**
 * stockpileAreaGridBaseline.test.ts: the area-weighted grid estimator against
 * the point-sample estimator on one pile, across the point counts a lasso
 * selection reaches. Gated on `STOCKPILE_BENCH=1`; every run is printed,
 * nothing asserted on time. The pile is a cone over a flat apron so both
 * estimators have an analytic volume to be read against. Points are uniform
 * over the apron. The presenter path is timed too, since that is what the
 * toast pays.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { stockpileAreaGrid } from '../../src/render/measure/stockpileAreaGrid';
import { stockpileVolume } from '../../src/render/measure/stockpileVolume';
import { presentStockpileAreaGrid } from '../../src/render/measure/stockpilePresenter';
import type { Vec3 } from '../../src/render/navMath';

const ENABLED = process.env.STOCKPILE_BENCH === '1';
const SIZES = (process.env.STOCKPILE_BENCH_SIZES ?? '100000,500000,2000000')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0);

/** A cone of radius R and height H on a 2R + 20 square apron at z = 0. */
function pile(n: number, R = 40, H = 12): { positions: Float32Array; polygon: Vec3[]; volume: number } {
  let s = 20260915;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  const side = 2 * R + 20;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = rnd() * side - side / 2;
    const y = rnd() * side - side / 2;
    const r = Math.hypot(x, y);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = r < R ? H * (1 - r / R) : 0;
  }
  const h = side / 2;
  return { positions, polygon: [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]], volume: (Math.PI * R * R * H) / 3 };
}

describe.skipIf(!ENABLED)('stockpile estimator cost', () => {
  it('times both estimators on a cone across the lasso ladder', () => {
    for (const n of SIZES) {
      const { positions, polygon, volume } = pile(n);
      const points = [];
      for (let i = 0; i < positions.length; i += 3) points.push({ x: positions[i], y: positions[i + 1], z: positions[i + 2] });
      const poly2 = polygon.map((p) => ({ x: p[0], y: p[1] }));
      const t: Record<string, number[]> = { grid: [], point: [], presenter: [] };
      let gridV = 0, pointV = 0, presV = 0, cell = 0;
      for (let r = 0; r < 3; r++) {
        let t0 = performance.now();
        const g = stockpileAreaGrid({ points, polygon: poly2, base: { kind: 'constant', zM: 0 } });
        t.grid.push(performance.now() - t0); gridV = g.fillM3; cell = g.cellSizeM;
        t0 = performance.now();
        const p = stockpileVolume({ polygon, positions, base: { mode: 'explicit', z: 0 } });
        t.point.push(performance.now() - t0); pointV = p.volume;
        t0 = performance.now();
        const v = presentStockpileAreaGrid(polygon, positions, { z: 0, uncertainty: 0 }, { sourceComplete: true, sampled: false });
        t.presenter.push(performance.now() - t0); presV = v.volumeM3;
      }
      expect(presV).toBeCloseTo(gridV, 6);
      const best = (xs: number[]) => Math.min(...xs).toFixed(0);
      // eslint-disable-next-line no-console
      console.log(
        `  ${n} pts: grid best ${best(t.grid)} ms (cell ${cell.toFixed(2)} m, ${gridV.toFixed(1)} m³, ${((gridV / volume - 1) * 100).toFixed(2)}% vs analytic)` +
          `  point-sample best ${best(t.point)} ms (${pointV.toFixed(1)} m³, ${((pointV / volume - 1) * 100).toFixed(2)}%)` +
          `  presenter path best ${best(t.presenter)} ms  runs grid[${t.grid.map((x) => x.toFixed(0)).join(',')}] point[${t.point.map((x) => x.toFixed(0)).join(',')}]`,
      );
    }
  }, 600_000);
});
