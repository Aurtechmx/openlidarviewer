/**
 * A remembered CRS override must not attach to a different STREAMING dataset.
 *
 * The static path was given `datasetIdentity(cloud)` so two same-named files
 * could be told apart before a persisted override was reapplied. The streaming
 * path was not: it called `resolveForScan` with only a name and the detected
 * CRS, so two unrelated COPC/EPT sources sharing a filename — both declaring no
 * CRS, which is the case a user overrides — still collided, and the first one's
 * frame was silently applied to the second.
 *
 * Streaming states the same two facts in its own shape: `sourcePointCount`, and
 * bounds as one flat [minX,minY,minZ,maxX,maxY,maxZ].
 */
import { describe, it, expect } from 'vitest';
import { datasetIdentity, CrsService } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

describe('datasetIdentity reads the streaming shape', () => {
  it('takes the source total and the flat data bounds', () => {
    const id = datasetIdentity({
      sourcePointCount: 42_000_000,
      dataBounds: () => [100, 200, 10, 1100, 1400, 60],
    });
    expect(id?.pointCount).toBe(42_000_000);
    expect(id?.extent).toEqual([1000, 1200, 50]);
  });

  it('falls back to the octree cube when no tight bounds exist', () => {
    const id = datasetIdentity({
      sourcePointCount: 5, localBounds: () => [0, 0, 0, 10, 20, 30],
    });
    expect(id?.extent).toEqual([10, 20, 30]);
  });

  it('prefers the tight data bounds over the cube', () => {
    const id = datasetIdentity({
      sourcePointCount: 5,
      dataBounds: () => [0, 0, 0, 1, 2, 3],
      localBounds: () => [0, 0, 0, 999, 999, 999],
    });
    expect(id?.extent).toEqual([1, 2, 3]);
  });

  it('returns undefined when a stream states neither fact', () => {
    expect(datasetIdentity({ dataBounds: () => null })).toBeUndefined();
  });

  it('survives a throwing bounds accessor', () => {
    const id = datasetIdentity({
      sourcePointCount: 7,
      dataBounds: () => { throw new Error('not ready'); },
    });
    expect(id).toEqual({ pointCount: 7 });
  });

  it('still reads a static cloud exactly as before', () => {
    const id = datasetIdentity({
      sourceDeclaredPointCount: 90_000_000,
      pointCount: 4_000_000,
      bounds: () => ({ min: [0, 0, 0], max: [100, 200, 30] }),
    });
    expect(id).toEqual({ pointCount: 90_000_000, extent: [100, 200, 30] });
  });
});

describe('a remembered override and a different stream of the same name', () => {
  function memoryPort() {
    const map = new Map<string, CrsOverride>();
    return { get: (k: string) => map.get(k), set: (k: string, v: CrsOverride) => { map.set(k, v); }, clear: (k: string) => { map.delete(k); } };
  }
  const stream = (name: string, pts: number, span: number) => ({
    name, detected: undefined, source: 'copc-meta' as const,
    identity: datasetIdentity({ sourcePointCount: pts, dataBounds: () => [0, 0, 0, span, span, span / 10] }),
  });

  it('does NOT apply to an unrelated stream sharing the filename', () => {
    const svc = new CrsService(memoryPort() as never);
    svc.resolveForScan(stream('survey.copc.laz', 1_000_000, 500));
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta' });
    expect(svc.current()?.epsg).toBe(32612);

    const b = svc.resolveForScan(stream('survey.copc.laz', 42_000_000, 12_000));
    expect(b.epsg, "the other stream's frame was applied").not.toBe(32612);
  });

  it('DOES apply when the same stream is reopened', () => {
    const svc = new CrsService(memoryPort() as never);
    svc.resolveForScan(stream('survey.copc.laz', 1_000_000, 500));
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta' });
    expect(svc.resolveForScan(stream('survey.copc.laz', 1_000_000, 500)).epsg).toBe(32612);
  });
});
