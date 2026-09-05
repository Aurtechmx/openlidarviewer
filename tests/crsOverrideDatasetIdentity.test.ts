/**
 * A remembered CRS override must not attach to a different dataset.
 *
 * Overrides are keyed by filename alone (`keyForDataset`), and the record's only
 * identifying field was the EPSG the file declared when the choice was made.
 * That field is absent precisely when it matters: a scan with no CRS is the kind
 * a user overrides. So a persisted `points.laz -> EPSG:32612` matched the next
 * unrelated `points.laz` that also declared nothing, and every downstream
 * product — measurements, DTM, contours, GeoJSON, KML, reports — inherited a
 * frame belonging to a different survey. The coordinates stay internally
 * consistent, which is what makes it dangerous: nothing looks wrong.
 *
 * The store is localStorage-backed, so the two files need not be open together,
 * or even in the same session.
 */
import { describe, it, expect } from 'vitest';
import { CrsService, datasetIdentity, sameDataset } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

/** An in-memory stand-in for the persistent store. */
function memoryPort() {
  const map = new Map<string, CrsOverride>();
  return {
    get: (k: string) => map.get(k),
    set: (k: string, v: CrsOverride) => { map.set(k, v); },
    clear: (k: string) => { map.delete(k); },
    map,
  };
}

/** A scan: a name, no declared CRS, and its own size and shape. */
const scan = (name: string, pointCount: number, span: number) => ({
  name,
  detected: undefined,
  source: 'las-vlr' as const,
  identity: {
    pointCount,
    extent: [span, span, span / 10] as [number, number, number],
  },
});

describe('a remembered override and a different dataset of the same name', () => {
  it('does NOT apply to a different scan that shares the filename', () => {
    const port = memoryPort();
    const svc = new CrsService(port as never);

    // Scan A: no CRS, user assigns UTM 12N. The choice is remembered.
    svc.resolveForScan(scan('scan.laz', 1_000_000, 500));
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    expect(svc.current()?.epsg).toBe(32612);

    // Scan B: an unrelated survey that happens to be called scan.laz, also
    // declaring no CRS. Different size, different extent.
    const b = svc.resolveForScan(scan('scan.laz', 42_000_000, 12_000));
    expect(b.epsg, 'the other dataset\'s frame was applied').not.toBe(32612);
  });

  it('DOES still apply when the same scan is reopened', () => {
    const port = memoryPort();
    const svc = new CrsService(port as never);
    svc.resolveForScan(scan('scan.laz', 1_000_000, 500));
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });

    // Same file, same facts — the user's choice must survive.
    const again = svc.resolveForScan(scan('scan.laz', 1_000_000, 500));
    expect(again.epsg).toBe(32612);
  });

  it('tolerates the small drift a re-decode can produce', () => {
    const port = memoryPort();
    const svc = new CrsService(port as never);
    svc.resolveForScan(scan('scan.laz', 1_000_000, 500));
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    // 0.2% fewer points, 0.5% smaller extent — the same survey.
    const again = svc.resolveForScan(scan('scan.laz', 998_000, 502.5));
    expect(again.epsg).toBe(32612);
  });
});

describe('sameDataset says "cannot tell" rather than "different"', () => {
  it('accepts when either side recorded no identity', () => {
    expect(sameDataset(undefined, { pointCount: 10 })).toBe(true);
    expect(sameDataset({ pointCount: 10 }, undefined)).toBe(true);
    // A legacy entry keeps working rather than silently dropping the choice.
  });

  it('accepts when the two sides have no overlapping facts', () => {
    expect(sameDataset({ pointCount: 10 }, { extent: [1, 1, 1] })).toBe(true);
  });

  it('rejects on a positive disagreement in either fact', () => {
    expect(sameDataset({ pointCount: 1_000_000 }, { pointCount: 42_000_000 })).toBe(false);
    expect(sameDataset({ extent: [500, 500, 50] }, { extent: [12000, 12000, 1200] })).toBe(false);
  });

  it('is not fooled by a zero or non-finite span', () => {
    expect(sameDataset({ extent: [0, 0, 0] }, { extent: [500, 500, 50] })).toBe(true);
    expect(sameDataset({ pointCount: Number.NaN }, { pointCount: 5 })).toBe(true);
  });
});

describe('datasetIdentity', () => {
  it('prefers the SOURCE total over the resident one, so a strided load still matches', () => {
    const id = datasetIdentity({
      sourceDeclaredPointCount: 90_000_000,
      declaredPointCount: 90_000_000,
      pointCount: 4_000_000,
      bounds: () => ({ min: [0, 0, 0], max: [100, 200, 30] }),
    });
    expect(id?.pointCount).toBe(90_000_000);
    expect(id?.extent).toEqual([100, 200, 30]);
  });

  it('returns undefined when nothing identifying is available', () => {
    expect(datasetIdentity({})).toBeUndefined();
    expect(datasetIdentity(null)).toBeUndefined();
  });

  it('survives a throwing bounds()', () => {
    const id = datasetIdentity({
      pointCount: 5,
      bounds: () => { throw new Error('not ready'); },
    });
    expect(id).toEqual({ pointCount: 5 });
  });
});
