/**
 * The lasso's canonical stockpile record in the scan's own frame:
 *  - the grid integrates in the plane normal to the scan's up axis, so a Y-up
 *    scan gets the same figure and authority as the same scene Z-up;
 *  - the printed base is an elevation (the recentred origin added back), or
 *    is labelled a local height when the scene has no single datum;
 *  - the record's confidence answers to the coverage shares it reports.
 */
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { makeLassoUnprojector } from '../src/render/measure/lassoProjector';
import { volumeFromLassoWithFootprint } from '../src/render/measure/lassoVolume';
import { capConfidenceByCoverage, deriveVolumeRecord } from '../src/render/measure/measureDerivations';
import { lassoStockpileResult, stockpileToastSuffix } from '../src/render/measure/stockpilePresenter';
import { withStockpileGrid } from '../src/render/measure/stockpileResult';
import { CUT_FILL_VOLUME_METHOD, volumeCutFill } from '../src/render/measure/volume';
import { elevationDatumOffset } from '../src/render/measure/geometry';
import type { VolumeRecord } from '../src/render/measure/types';
import type { Vec3 } from '../src/render/navMath';

/** Ground at height 0 over a 10 x 10 plan, plus a 4 x 4 x 2 block: 32 m³ above ground. */
function scene(yUp: boolean): Float32Array {
  const pts: number[] = [];
  for (let a = 0; a <= 10 + 1e-9; a += 0.1) {
    for (let b = 0; b <= 10 + 1e-9; b += 0.1) {
      const h = a > 3 && a < 7 && b > 3 && b < 7 ? 2 : 0;
      if (yUp) pts.push(a, h, b);
      else pts.push(a, b, h);
    }
  }
  return new Float32Array(pts);
}

function lassoRun(yUp: boolean, walkSampled = false) {
  const up: Vec3 = yUp ? [0, 1, 0] : [0, 0, 1];
  const positions = scene(yUp);
  const cam = new PerspectiveCamera(50, 1, 0.1, 1000);
  if (yUp) cam.up.set(0, 0, -1);
  else cam.up.set(0, 1, 0);
  if (yUp) {
    cam.position.set(5, 30, 20);
    cam.lookAt(5, 0, 5);
  } else {
    cam.position.set(5, -20, 30);
    cam.lookAt(5, 5, 0);
  }
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const W = 1000;
  const H = 1000;
  const unproject = makeLassoUnprojector(cam.matrixWorld.elements, cam.projectionMatrixInverse.elements, W, H, up);
  const corners: Vec3[] = yUp
    ? [[-0.5, 0, -0.5], [10.5, 0, -0.5], [10.5, 0, 10.5], [-0.5, 0, 10.5]]
    : [[-0.5, -0.5, 0], [10.5, -0.5, 0], [10.5, 10.5, 0], [-0.5, 10.5, 0]];
  const lasso = corners.map(([x, y, z]) => {
    const p = new Vector3(x, y, z).project(cam);
    return { x: (p.x * 0.5 + 0.5) * W, y: (1 - (p.y * 0.5 + 0.5)) * H };
  });
  const out = volumeFromLassoWithFootprint({
    positions,
    selected: Array.from({ length: positions.length / 3 }, (_, i) => i),
    referencePercentile: 0.05,
    up,
    footprint: (refZ) => {
      const r: Vec3[] = [];
      for (const s of lasso) {
        const w = unproject(s.x, s.y, refZ);
        if (!w) return null;
        r.push(w);
      }
      return r;
    },
  });
  const ps = deriveVolumeRecord(out.result, out.referenceZ, CUT_FILL_VOLUME_METHOD);
  const stock = lassoStockpileResult(ps, {
    polygon: out.polygon3D,
    positions,
    lin: 1,
    options: { densityUnitKnown: true, vert: 1, walkSampled, up },
  }, 1);
  return { out, stock };
}

describe('lasso stockpile record, Z-up vs Y-up (same physical scene)', () => {
  it.each([false, true])('yUp=%s: the canonical grid record is about 32 m³ and carries the grid authority', (yUp) => {
    const { out, stock } = lassoRun(yUp);
    expect(out.footprintBasis).toBe('drawn-lasso');
    expect(stock.record.fill!).toBeGreaterThan(30);
    expect(stock.record.fill!).toBeLessThan(34);
    expect(stock.record.gridAuthority).toBeDefined();
    expect(stock.record.crossCheck).toBeDefined();
    expect(stock.suffix).toContain('area-weighted grid');
  });

  it('Z-up and Y-up give the same authority and the same grid figure', () => {
    const z = lassoRun(false).stock.record;
    const y = lassoRun(true).stock.record;
    expect(y.gridAuthority).toBe(z.gridAuthority);
    expect(y.method).toBe(z.method);
    expect(y.fill!).toBeCloseTo(z.fill!, 1);
  });

  it.each([false, true])('yUp=%s: a sampled walk is labelled PREVIEW', (yUp) => {
    const { stock } = lassoRun(yUp, true);
    expect(stock.record.gridAuthority).toBe('preview');
    expect(stock.headline).toContain('PREVIEW');
  });
});

describe('lasso toast base height', () => {
  // World: ground at z = 1000 over 10 x 10, a 4 x 4 x 2 block on it, held in
  // render space recentred on an integer origin, as a loader does.
  const origin: Vec3 = [500_000, 4_000_000, 1001];
  const pts: number[] = [];
  for (let x = 0; x <= 10 + 1e-9; x += 0.1) {
    for (let y = 0; y <= 10 + 1e-9; y += 0.1) {
      const zWorld = x > 3 && x < 7 && y > 3 && y < 7 ? 1002 : 1000;
      pts.push(500_000 + x - origin[0], 4_000_000 + y - origin[1], zWorld - origin[2]);
    }
  }
  const positions = new Float32Array(pts);
  const polygon: Vec3[] = ([[-0.5, -0.5, -1], [10.5, -0.5, -1], [10.5, 10.5, -1], [-0.5, 10.5, -1]] as Vec3[])
    .map(([x, y, z]) => [500_000 + x - origin[0], 4_000_000 + y - origin[1], z] as Vec3);
  const baseOf = (suffix: string): { value: number; local: boolean } => {
    const m = /base (-?[0-9.]+) m( local height)? \(lowest ground/.exec(suffix);
    expect(m, suffix).not.toBeNull();
    return { value: Number(m![1]), local: m![2] !== undefined };
  };

  it('with the scene datum, the base reads as the ground elevation', () => {
    const datum = elevationDatumOffset(origin, [0, 0, 1]);
    const suffix = stockpileToastSuffix(polygon, positions, 1, { densityUnitKnown: true, vert: 1, elevationDatum: datum });
    const base = baseOf(suffix);
    expect(base.local).toBe(false);
    expect(base.value).toBeCloseTo(1000, 1);
  });

  it('with no single datum, the base is labelled a local height', () => {
    const suffix = stockpileToastSuffix(polygon, positions, 1, { densityUnitKnown: true, vert: 1, elevationDatum: null });
    const base = baseOf(suffix);
    expect(base.local).toBe(true);
    expect(base.value).toBeCloseTo(-1, 1);
  });

  it('the vertical factor scales the elevation, datum included', () => {
    const ft = 0.3048;
    const datum = elevationDatumOffset(origin, [0, 0, 1]);
    const suffix = stockpileToastSuffix(polygon, positions, ft, { densityUnitKnown: true, vert: ft, elevationDatum: datum });
    expect(baseOf(suffix).value).toBeCloseTo(1000 * ft, 1);
  });
});

describe('lasso record confidence vs its own observed share', () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }

  it('a record whose coverage is below 80 % is not high', () => {
    const r = lcg(7);
    const pts: number[] = [];
    // 1200 points inside a 10 x 10 footprint, only on x in [0, 8.5].
    for (let i = 0; i < 1200; i++) pts.push(r() * 8.5, r() * 10, 1 + 0.01 * r());
    // 3600 selected points outside the footprint (an oblique lasso).
    for (let i = 0; i < 3600; i++) pts.push(20 + r() * 20, r() * 10, 3);
    const positions = new Float32Array(pts);
    const polygon: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
    const ps = deriveVolumeRecord(volumeCutFill({ polygon, referenceZ: 0, positions }), 0, CUT_FILL_VOLUME_METHOD);
    const rec = lassoStockpileResult(ps, { polygon, positions, lin: 1, options: {} }, 1).record;
    const observed = Math.min(rec.coverageFraction ?? 1, 1 - (rec.excludedFraction ?? 0));
    expect(observed).toBeLessThan(0.8);
    expect(rec.confidence).not.toBe('high');
  });

  const base: VolumeRecord = {
    fill: 10, cut: 0, net: 10, referenceZ: 0, footprintArea: 100, pointsInPolygon: 5000, densityNative: 50,
    confidence: 'high', method: CUT_FILL_VOLUME_METHOD, coverageFraction: 1,
  };
  const grid = (supportFraction: number, excludedFraction = 0) => ({
    method: 'olv.volume.stockpile-area-grid@4', authority: 'measured' as const, reason: '',
    fillNative: 9, cutNative: 0, netNative: 9, supportFraction, interpolatedFraction: 0, excludedFraction,
  });

  it.each([
    [0.95, 0, 'high'],
    [0.719, 0, 'medium'],
    [0.49, 0, 'low'],
    [0.95, 0.3, 'medium'],
    [0.95, 0.6, 'low'],
  ] as const)('grid support %s, excluded %s caps a high record at %s', (support, excluded, expected) => {
    expect(withStockpileGrid(base, grid(support, excluded)).confidence).toBe(expected);
  });

  it('the cap only ever lowers the tier', () => {
    expect(capConfidenceByCoverage('low', { coverageFraction: 1 })).toBe('low');
    expect(capConfidenceByCoverage('medium', { coverageFraction: 0.7 })).toBe('medium');
    expect(capConfidenceByCoverage('high', {})).toBe('high');
  });
});
