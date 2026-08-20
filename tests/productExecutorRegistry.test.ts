import { describe, it, expect } from 'vitest';
import { ProcessService } from '../src/process/ProcessService';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';
import { ProductExecutorRegistry } from '../src/process/ProductExecutorRegistry';
import { computeTerrainCore, type TerrainCore } from '../src/terrain/contour/analyseContours';

function crs(o: Partial<CrsInfo> = {}): CrsInfo {
  return { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, ...o } as CrsInfo;
}
const readyFacts: ScanFacts = {
  kind: 'static', coverage: 'full', crs: crs(), pointCount: 1_000_000,
  hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
  classification: 'full', groundClassified: true, hasBuildingClass: false, medianSpacing: 0.2,
};
const blockedFacts: ScanFacts = { ...readyFacts, pointCount: 0 };

/** A small ground grid the DTM core can rasterise. */
function gridPoints(): Float32Array {
  const n = 12, out = new Float32Array(n * n * 3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[k++] = i;
      out[k++] = j;
      out[k++] = 100 + 0.1 * i;
    }
  }
  return out;
}

interface DtmCtx {
  points: Float32Array;
}

describe('ProductExecutorRegistry', () => {
  it('runs the real DTM core through the gate when the product is ready', async () => {
    let calls = 0;
    const registry = new ProductExecutorRegistry<DtmCtx>().register<TerrainCore>('dtm', (ctx) => {
      calls++;
      return computeTerrainCore(ctx.points, { cellSizeM: 1, crs: 'EPSG:32610' });
    });
    const svc = ProcessService.fromFacts([readyFacts]);
    expect(svc.readiness('dtm')).toBe('ready');

    const res = await registry.run<TerrainCore>(svc, 'dtm', { points: gridPoints() });
    expect(res.ran).toBe(true);
    if (res.ran) expect(res.value.dtm.cols).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  it('refuses a blocked product without invoking the executor', async () => {
    let calls = 0;
    const registry = new ProductExecutorRegistry<DtmCtx>().register<TerrainCore>('dtm', (ctx) => {
      calls++;
      return computeTerrainCore(ctx.points, { cellSizeM: 1, crs: 'EPSG:32610' });
    });
    const svc = ProcessService.fromFacts([blockedFacts]);
    expect(svc.readiness('dtm')).toBe('blocked');

    const res = await registry.run<TerrainCore>(svc, 'dtm', { points: gridPoints() });
    expect(res.ran).toBe(false);
    if (!res.ran) expect(res.reasonCode).toBe('NO_POINTS');
    expect(calls).toBe(0);
  });

  it('fails closed for an unregistered product', async () => {
    const registry = new ProductExecutorRegistry<DtmCtx>();
    const svc = ProcessService.fromFacts([readyFacts]);
    const res = await registry.run(svc, 'dsm', { points: gridPoints() });
    expect(res.ran).toBe(false);
    if (!res.ran) expect(res.reasonCode).toBe('EXECUTOR_UNREGISTERED');
  });
});
