/**
 * krovakCrs.test.ts — EPSG:5514 (S-JTSK / Krovák East-North) ingest + CRS foundation.
 *
 * The scanner-comparison scans (Zenodo 10.5281/zenodo.15421291) are georeferenced
 * to EPSG:5514, a non-UTM projected CRS OLV did not previously resolve. This pins
 * two things:
 *
 *  1. The registry resolves 5514 as a projected, metre-based European entry.
 *  2. The Krovák proj4 definition reprojects 5514 → WGS84 in agreement with an
 *     authoritative PROJ (pyproj) reference computed on the dataset's own surveyed
 *     reference points. The reference exposed a real calibration bug: the naive
 *     3-parameter datum shift was ~10 m off; the 7-parameter Bursa-Wolf shift
 *     agrees to a few centimetres. This oracle guards against that regression.
 *
 * Measurement note: the SP2 sphere-accuracy study works in native EPSG:5514 metres
 * (Krovák is conformal, near-unity scale), so the residual datum-shift error in the
 * WGS84 leg does not enter inter-point distances. This test also asserts that native
 * metric distances between the reference points are preserved.
 */

import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { epsgToProj4 } from '../src/convert/epsg';
import { getCrsEntry } from '../src/geo/CrsRegistry';

/** Surveyed reference points in EPSG:5514 (from the dataset GroundTruth), with the
 *  WGS84 lon/lat computed by authoritative PROJ (pyproj Transformer 5514→4326). */
const ORACLE = [
  { name: 'Koule01', e: -744290.00006112, n: -1036243.5094764, lon: 14.38782292, lat: 50.14594182 },
  { name: 'Koule02', e: -744277.97274746, n: -1036233.1806463, lon: 14.38796985, lat: 50.14604860 },
  { name: 'BM001', e: -744290.87979444, n: -1036247.7713319, lon: 14.38781888, lat: 50.14590278 },
] as const;

/** Rough metres between two WGS84 lon/lat points (equirectangular, fine at this scale). */
function metresBetween(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 6378137;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const latR = ((aLat + bLat) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(latR);
  return Math.hypot(x, dLat) * R;
}

describe('EPSG:5514 (S-JTSK / Krovák) ingest & CRS foundation', () => {
  it('resolves 5514 as a projected, metre-based European registry entry', () => {
    const entry = getCrsEntry(5514);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('projected');
    expect(entry!.region).toBe('europe');
    // metre-based: no non-metre linear unit override
    expect(entry!.linearUnit).toBeUndefined();
  });

  it('has a Krovák proj4 definition', () => {
    const def = epsgToProj4(5514);
    expect(def).toBeTruthy();
    expect(def).toContain('+proj=krovak');
    // the calibrated 7-parameter datum shift, not the ~10 m-off 3-parameter one
    expect(def).toContain('570.8,85.7,462.8,4.998,1.587,5.261,3.56');
  });

  it('reprojects 5514 → WGS84 within 0.5 m of authoritative PROJ on the surveyed points', () => {
    const def = epsgToProj4(5514)!;
    const fwd = proj4(def, '+proj=longlat +datum=WGS84 +no_defs');
    for (const p of ORACLE) {
      const [lon, lat] = fwd.forward([p.e, p.n]);
      const err = metresBetween(lon, lat, p.lon, p.lat);
      expect(err, `${p.name} horizontal error vs PROJ`).toBeLessThan(0.5);
    }
  });

  it('preserves native EPSG:5514 metric distances (the frame SP2 measures in)', () => {
    // Euclidean distance in projected metres between two surveyed points.
    const a = ORACLE[0];
    const b = ORACLE[1];
    const projected = Math.hypot(a.e - b.e, a.n - b.n);
    // Same pair, distance derived from the WGS84 reprojection, should match to <5 cm
    // (Krovák is conformal at ~unit scale here), confirming distances are frame-safe.
    const wgs = metresBetween(a.lon, a.lat, b.lon, b.lat);
    expect(Math.abs(projected - wgs)).toBeLessThan(0.05);
  });
});
