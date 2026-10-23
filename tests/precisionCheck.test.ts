/**
 * precisionCheck.test.ts: the Performance panel's precision check and its
 * certificate.
 *
 * The check states the per-draw bound for the active loaded scan at the
 * current view against the chosen limit, in one sentence. The certificate
 * records the same result with the data, frame, draw and limit it covers, and
 * a digest of that scope: the same scope always gives the same digest, and a
 * different limit or view gives a different one.
 */
import { describe, it, expect } from 'vitest';
import { PRECISION_TOLERANCES, precisionCertificate, readPrecision, type PrecisionDeps } from '../src/app/precisionCheck';
import { PointCloud } from '../src/model/PointCloud';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';

const ORIGIN: [number, number, number] = [500_000, 4_500_000, 200];
const METRE_CRS: CrsInfo = { source: 'wkt', epsg: 32633, name: 'WGS 84 / UTM zone 33N', isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1 };

function farCloud(n = 4000): Float32Array {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const local = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    local[3 * i] = rnd() * 1000 + 0.123;
    local[3 * i + 1] = rnd() * 1000 + 0.456;
    local[3 * i + 2] = rnd() * 80 + 0.789;
  }
  return local;
}

/** A column-major view that only translates: the camera a few hundred metres off the tile. */
function translatedView(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]);
}

function deps(over: Partial<PrecisionDeps> = {}, view = translatedView(500, 500, 800)): PrecisionDeps {
  const cloud = new PointCloud({ positions: farCloud(), origin: ORIGIN, sourceFormat: 'las', name: 'tile.las', metadata: { crs: METRE_CRS } });
  const viewer = {
    activeBackend: () => 'webgpu' as const,
    cloudModelView64: (id: string) => (id === 'cloud_0' ? view : null),
    getCloud: (id: string) => (id === 'cloud_0' ? cloud : undefined),
  };
  return {
    viewer: () => viewer,
    activeId: () => 'cloud_0',
    activeCloud: () => cloud,
    context: () => spatialContextFrom(METRE_CRS),
    ...over,
  };
}

describe('the precision check', () => {
  it('offers 1 mm, 1 cm and 10 cm', () => {
    expect(PRECISION_TOLERANCES.map((t) => t.label)).toEqual(['1 mm', '1 cm', '10 cm']);
  });

  it('certifies a loaded scan within 1 mm at this view, and says so in one sentence', () => {
    const r = readPrecision(deps(), 0.001);
    expect(r.state).toBe('PASS');
    expect(r.line).toMatch(/^Positions within .* mm at this view, inside the 1 mm limit\.$/);
    expect(r.diagnostic?.boundMetres).toBeLessThan(0.001);
  });

  it('says a limit tighter than the bound is not certified', () => {
    const r = readPrecision(deps(), 1e-7);
    expect(r.state).toBe('NOT_CERTIFIED');
    expect(r.line).toMatch(/not certified for the/);
  });

  it('asks for a scan when none is open, and declines a streamed one', () => {
    expect(readPrecision(deps({ activeCloud: () => null }), 0.001)).toMatchObject({ state: 'NO_SCAN', line: 'Open a scan to check its precision.' });
    expect(readPrecision(deps({ activeId: () => 'stream' }), 0.001).line).toMatch(/streamed scan is not checked/);
  });
});

describe('the precision certificate', () => {
  it('records the result and the scope it covers', () => {
    const json = precisionCertificate(deps(), 0.001, new Date('2026-10-23T00:00:00Z'));
    expect(json).not.toBeNull();
    const c = JSON.parse(json!);
    expect(c.kind).toBe('olv.draw-precision-certificate');
    expect(c.method).toBe('olv.render.draw-precision-bound@1');
    expect(c.result.boundState).toBe('PASS_BOUND');
    expect(c.requirement.toleranceMetres).toBe(0.001);
    expect(c.draw.contract).toBe('rn');
    expect(c.draw.backend).toBe('webgpu');
    expect(c.draw.modelView64).toHaveLength(16);
    expect(c.frame.crs).toBe(32633);
    expect(c.frame.origin).toEqual(ORIGIN);
    expect(c.dataset.name).toBe('tile.las');
    expect(c.covers).toMatch(/not survey accuracy/);
    expect(c.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same digest for the same scope and a new one when the limit or the view changes', () => {
    const digest = (d: PrecisionDeps, tau: number, at: string): string => JSON.parse(precisionCertificate(d, tau, new Date(at))!).scopeDigest;
    const a = digest(deps(), 0.001, '2026-10-23T00:00:00Z');
    expect(digest(deps(), 0.001, '2026-10-24T00:00:00Z')).toBe(a);
    expect(digest(deps(), 0.01, '2026-10-23T00:00:00Z')).not.toBe(a);
    expect(digest(deps({}, translatedView(400, 500, 800)), 0.001, '2026-10-23T00:00:00Z')).not.toBe(a);
  });

  it('has nothing to certify without a loaded scan', () => {
    expect(precisionCertificate(deps({ activeCloud: () => null }), 0.001)).toBeNull();
  });
});
