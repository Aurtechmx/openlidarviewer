/**
 * reprojectHonesty.test.ts — datum-shift honesty for the converter.
 *
 * Two defect classes from the v0.4.3 audit / v0.4.5 workplan:
 *
 *   1. "Reprojected ✓" on transforms whose datum leg is missing/degenerate:
 *      GDA94→GDA2020 resolves to an IDENTITY shift (true difference ≈ 1.8 m),
 *      and NAD27 has no NADCON grids in proj4js — both used to log a clean
 *      success. They must now carry an explicit caveat/warning, and the
 *      report's CRS status must say "approximate".
 *
 *   2. The metre GeoKey (9001) was stamped whenever the MODE was 'reproject',
 *      even when the transform was SKIPPED (unresolvable CRS) and the file
 *      stayed in its source (possibly foot) CRS — convertCloud.ts:139-141.
 *      A skipped reproject must keep the source linear unit.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { datumShiftCaveat, epsgDatumFamily } from '../src/convert/epsg';
import { reprojectGlobal } from '../src/convert/reproject';
import { convertCloud } from '../src/convert/convertCloud';
import type { CrsInfo } from '../src/io/crs';

function cloudWith(crs: CrsInfo | null, origin: [number, number, number]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin,
    sourceFormat: 'las',
    name: 'survey.las',
    metadata: crs !== undefined ? { crs } : undefined,
  });
}

/** Parse the GeoKeyDirectory of a LAS 1.2 file into keyId → value. */
function geoKeysOf(las: Uint8Array): Map<number, number> {
  const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
  const keys = new Map<number, number>();
  if (view.getUint32(100, true) === 0) return keys; // no VLR
  const payload = 227 + 54; // header + VLR header
  const numKeys = view.getUint16(payload + 6, true);
  for (let k = 0; k < numKeys; k++) {
    const eo = payload + 8 + k * 8;
    keys.set(view.getUint16(eo, true), view.getUint16(eo + 6, true));
  }
  return keys;
}

describe('epsgDatumFamily / datumShiftCaveat', () => {
  it('classifies the registry codes into datum families', () => {
    expect(epsgDatumFamily(32611)).toBe('WGS84');
    expect(epsgDatumFamily(26915)).toBe('NAD83');
    expect(epsgDatumFamily(26715)).toBe('NAD27');
    expect(epsgDatumFamily(4267)).toBe('NAD27');
    expect(epsgDatumFamily(28355)).toBe('GDA94');
    expect(epsgDatumFamily(7855)).toBe('GDA2020');
    expect(epsgDatumFamily(25831)).toBe('ETRS89');
    expect(epsgDatumFamily(999999)).toBeNull();
  });

  it('caveats GDA94↔GDA2020 (identity shift vs the real ~1.8 m difference)', () => {
    expect(datumShiftCaveat(28355, 7855)).toMatch(/GDA94/);
    expect(datumShiftCaveat(7844, 4283)).toMatch(/1\.8 m/);
  });

  it('caveats every cross-datum NAD27 leg (no grids bundled)', () => {
    expect(datumShiftCaveat(26715, 26915)).toMatch(/NAD27/i); // NAD27→NAD83 UTM 15
    expect(datumShiftCaveat(4326, 4267)).toMatch(/grids/i); // WGS84→NAD27 geographic
  });

  it('stays quiet within one datum and on conventionally-coincident pairs', () => {
    expect(datumShiftCaveat(26715, 4267)).toBeNull(); // NAD27 UTM → NAD27 geographic
    expect(datumShiftCaveat(32611, 4326)).toBeNull(); // WGS84 → WGS84
    expect(datumShiftCaveat(25831, 4326)).toBeNull(); // ETRS89 → WGS84 (sub-metre)
    expect(datumShiftCaveat(999999, 4326)).toBeNull(); // unknown → no claim
  });
});

describe('reprojectGlobal datum caveat', () => {
  it('flags the GDA94→GDA2020 identity transform while still "succeeding"', () => {
    const g = {
      count: 1,
      x: Float64Array.from([500000]),
      y: Float64Array.from([6000000]),
      z: Float64Array.from([10]),
    };
    const r = reprojectGlobal(g, 28355, 7855); // GDA94 MGA55 → GDA2020 MGA55
    expect(r.transformed).toBe(true);
    expect(r.datumCaveat).toMatch(/GDA94/);
    // The "transform" is the identity our defs imply — that is exactly why
    // the caveat exists (the true shift is ≈ 1.8 m, not 0).
    expect(r.points.x[0]).toBeCloseTo(500000, 3);
    expect(r.points.y[0]).toBeCloseTo(6000000, 3);
  });

  it('keeps datumCaveat null on clean transforms and on failures', () => {
    const g = {
      count: 1,
      x: Float64Array.from([500000]),
      y: Float64Array.from([4000000]),
      z: Float64Array.from([0]),
    };
    expect(reprojectGlobal(g, 32611, 4326).datumCaveat).toBeNull(); // same datum
    expect(reprojectGlobal(g, 999999, 4326).datumCaveat).toBeNull(); // unresolved
    expect(reprojectGlobal(g, 32611, 32611).datumCaveat).toBeNull(); // no-op
  });
});

describe('convertCloud reproject honesty', () => {
  it('downgrades a degenerate-datum reproject to a warning + APPROXIMATE status', () => {
    const { report } = convertCloud(
      cloudWith(
        { source: 'wkt', name: 'GDA94 / MGA 55', epsg: 28355, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false },
        [500000, 6000000, 100],
      ),
      { format: 'las', crsMode: 'reproject', targetEpsg: 7855 },
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).toMatch(/APPROXIMATE/);
    const warn = report.log.find((l) => l.level === 'warn');
    expect(warn?.message).toMatch(/GDA94/);
    // Never the clean "reprojected ✓" info line alone.
    expect(report.log.some((l) => l.level === 'info' && /^reprojected/i.test(l.message))).toBe(false);
  });

  it('a clean same-datum reproject still reports plain success (no caveat noise)', () => {
    const { report } = convertCloud(
      cloudWith(
        { source: 'wkt', name: 'UTM 11N', epsg: 32611, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false },
        [500000, 4000000, 100],
      ),
      { format: 'xyz', crsMode: 'reproject', targetEpsg: 4326 },
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).toBe('reprojected EPSG:32611 → EPSG:4326');
    expect(report.log.some((l) => l.level === 'warn')).toBe(false);
  });

  it('a SKIPPED reproject keeps the source linear-unit GeoKey (not metre 9001)', () => {
    // EPSG:2225 (NAD83 / California zone 1, US survey feet) is NOT in the
    // built-in registry, so the reproject is skipped and the file stays in
    // its source CRS. The unit GeoKey must therefore say 9003 (US survey
    // foot) — the pre-v0.4.5 code stamped 9001 (metre) off the MODE alone.
    const { file, report } = convertCloud(
      cloudWith(
        { source: 'wkt', name: 'NAD83 / California zone 1 (ftUS)', epsg: 2225, linearUnit: 'us-survey-foot', linearUnitToMetres: 0.30480060960121924, isGeographic: false },
        [6500000, 2200000, 100],
      ),
      { format: 'las', crsMode: 'reproject', targetEpsg: 4326 },
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).toMatch(/reproject skipped/i);
    expect(report.log.some((l) => l.level === 'warn')).toBe(true);
    const keys = geoKeysOf(file!.bytes);
    expect(keys.get(3072)).toBe(2225); // still the SOURCE CRS
    expect(keys.get(3076)).toBe(9003); // …and the SOURCE unit, not 9001
  });

  it('an APPLIED reproject to a metric CRS stamps metre (9001) as before', () => {
    const { file, report } = convertCloud(
      cloudWith(
        { source: 'wkt', name: 'NAD83 / UTM 15N', epsg: 26915, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false },
        [500000, 4000000, 100],
      ),
      { format: 'las', crsMode: 'reproject', targetEpsg: 32615 },
    );
    expect(report.ok).toBe(true);
    const keys = geoKeysOf(file!.bytes);
    expect(keys.get(3072)).toBe(32615);
    expect(keys.get(3076)).toBe(9001);
  });
});
