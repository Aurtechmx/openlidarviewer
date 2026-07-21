/**
 * convertCloud.test.ts — EPSG resolver, reprojection, and the orchestrator.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { epsgToProj4, isGeographicEpsg, epsgLabel } from '../src/convert/epsg';
import { reprojectGlobal } from '../src/convert/reproject';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { convertCloud } from '../src/convert/convertCloud';
import type { CrsInfo } from '../src/io/crs';

function utmCloud(crs?: CrsInfo | null): PointCloud {
  // A few points near UTM 11N easting 500000 / northing 4000000.
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin: [500000, 4000000, 100],
    sourceFormat: 'las',
    name: 'survey.las',
    metadata: crs !== undefined ? { crs } : undefined,
  });
}

describe('epsgToProj4 / isGeographicEpsg / epsgLabel', () => {
  it('derives WGS84 UTM north and south zones', () => {
    expect(epsgToProj4(32611)).toContain('+proj=utm +zone=11');
    expect(epsgToProj4(32611)).not.toContain('+south');
    expect(epsgToProj4(32733)).toContain('+south');
    expect(epsgToProj4(32733)).toContain('+zone=33');
  });
  it('knows common geographic codes and rejects unknowns', () => {
    expect(epsgToProj4(4326)).toContain('+proj=longlat');
    expect(isGeographicEpsg(4326)).toBe(true);
    expect(isGeographicEpsg(32611)).toBe(false);
    expect(epsgToProj4(999999)).toBeNull();
    expect(epsgLabel(32611)).toMatch(/UTM zone 11N/);
  });

  it('resolves the widened CRS families (NAD/ETRS/GDA UTM + national grids)', () => {
    expect(epsgToProj4(26917)).toMatch(/\+proj=utm \+zone=17 .*NAD83/); // NAD83 / UTM 17N
    expect(epsgToProj4(25831)).toMatch(/\+proj=utm \+zone=31/); // ETRS89 / UTM 31N
    expect(epsgToProj4(28355)).toMatch(/\+proj=utm \+zone=55 \+south/); // GDA94 / MGA 55
    expect(epsgToProj4(7855)).toMatch(/\+proj=utm \+zone=55 \+south/); // GDA2020 / MGA 55
    expect(epsgToProj4(27700)).toContain('+proj=tmerc'); // British National Grid
    expect(epsgToProj4(2154)).toContain('+proj=lcc'); // Lambert-93
    expect(epsgToProj4(2193)).toContain('+proj=tmerc'); // NZTM
    expect(epsgToProj4(5070)).toContain('+proj=aea'); // CONUS Albers
    expect(epsgToProj4(3035)).toContain('+proj=laea'); // ETRS89-LAEA
    expect(isGeographicEpsg(7844)).toBe(true); // GDA2020 geographic
    expect(isGeographicEpsg(3035)).toBe(false); // projected
    expect(epsgLabel(27700)).toMatch(/British National Grid/);
  });
});

describe('reprojectGlobal', () => {
  it('transforms UTM 11N to WGS84 lon/lat in the expected ballpark', () => {
    const g = cloudToGlobal(utmCloud(null));
    const r = reprojectGlobal(g, 32611, 4326);
    expect(r.transformed).toBe(true);
    // Zone 11 central meridian is -117°, northing 4,000,000 ≈ 36°N.
    expect(r.points.x[0]).toBeGreaterThan(-118);
    expect(r.points.x[0]).toBeLessThan(-116);
    expect(r.points.y[0]).toBeGreaterThan(35);
    expect(r.points.y[0]).toBeLessThan(37);
    // Z is passed through untouched.
    expect(r.points.z[0]).toBeCloseTo(100, 6);
  });
  it('no-ops when source and target match, or when a code is unresolved', () => {
    const g = cloudToGlobal(utmCloud(null));
    expect(reprojectGlobal(g, 32611, 32611).transformed).toBe(false);
    expect(reprojectGlobal(g, 999999, 4326).transformed).toBe(false);
  });

  it('transforms a British National Grid point to WGS84 and back (invertible)', () => {
    const g = { count: 1, x: Float64Array.from([530000]), y: Float64Array.from([180000]), z: Float64Array.from([50]) };
    const geo = reprojectGlobal(g, 27700, 4326);
    expect(geo.transformed).toBe(true);
    // Central-London-ish: lon ≈ -0.1°, lat ≈ 51.5°.
    expect(geo.points.x[0]).toBeGreaterThan(-1);
    expect(geo.points.x[0]).toBeLessThan(1);
    expect(geo.points.y[0]).toBeGreaterThan(50);
    expect(geo.points.y[0]).toBeLessThan(53);
    const back = reprojectGlobal(geo.points, 4326, 27700);
    expect(back.points.x[0]).toBeCloseTo(530000, 1);
    expect(back.points.y[0]).toBeCloseTo(180000, 1);
  });
});

describe('convertCloud', () => {
  it('keeps CRS and writes LAS', () => {
    const { file, report } = convertCloud(utmCloud({ source: 'wkt', name: 'UTM 11N', epsg: 32611, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }), { format: 'las' });
    expect(report.ok).toBe(true);
    expect(report.pointCount).toBe(3);
    expect(file?.filename).toBe('survey.las');
    expect(String.fromCharCode(file!.bytes[0], file!.bytes[1], file!.bytes[2], file!.bytes[3])).toBe('LASF');
    expect(report.crsNote).toMatch(/kept/i);
  });

  it('assign mode tags a new EPSG and warns when it overrides a known CRS', () => {
    const { report } = convertCloud(
      utmCloud({ source: 'wkt', name: 'UTM 11N', epsg: 32611, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
      { format: 'las', crsMode: 'assign', targetEpsg: 32612 },
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).toMatch(/assigned/i);
    expect(report.log.some((l) => l.level === 'warn')).toBe(true);
  });

  it('reproject mode transforms when the source CRS is known', () => {
    const { file, report } = convertCloud(
      utmCloud({ source: 'wkt', name: 'UTM 11N', epsg: 32611, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false }),
      { format: 'xyz', crsMode: 'reproject', targetEpsg: 4326 },
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).toMatch(/reprojected/i);
    const firstLine = new TextDecoder().decode(file!.bytes).split('\n')[0];
    const lon = parseFloat(firstLine.split(' ')[0]);
    expect(lon).toBeGreaterThan(-118);
    expect(lon).toBeLessThan(-116);
  });

  it('reproject fails clearly when the source CRS is unknown', () => {
    const { file, report } = convertCloud(utmCloud(null), { format: 'las', crsMode: 'reproject', targetEpsg: 4326 });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.log.some((l) => /source CRS/i.test(l.message))).toBe(true);
  });

  it('reports LAZ as unavailable rather than producing a bad file', () => {
    const { file, report } = convertCloud(utmCloud(null), { format: 'laz' });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.log[0].message).toMatch(/not available/i);
  });
});

describe('convertCloud — omitClassification guard', () => {
  /** Read the per-point classification bytes back out of a written LAS file. */
  function classFromLas(bytes: Uint8Array): number[] {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pdrf = dv.getUint8(104);
    const recLen = dv.getUint16(105, true);
    const dataOffset = dv.getUint32(96, true);
    // PDRF 6+ (LAS 1.4) zeroes the legacy count and uses the extended uint64 at
    // offset 247; the legacy formats use the uint32 at 107.
    const count = pdrf >= 6 ? Number(dv.getBigUint64(247, true)) : dv.getUint32(107, true);
    const classOff = pdrf >= 6 ? 16 : 15;
    const mask = pdrf >= 6 ? 0xff : 0x1f;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(dv.getUint8(dataOffset + i * recLen + classOff) & mask);
    }
    return out;
  }

  function classifiedCloud(): PointCloud {
    return new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
      origin: [500000, 4000000, 100],
      sourceFormat: 'las',
      name: 'survey.las',
      classification: Uint8Array.from([2, 5, 6]),
    });
  }

  it('writes the real classes when the guard is off (default)', () => {
    const { file } = convertCloud(classifiedCloud(), { format: 'las14' });
    expect(classFromLas(file!.bytes)).toEqual([2, 5, 6]);
  });

  it('writes class 0 for every point when omitClassification is set', () => {
    const { file, report } = convertCloud(classifiedCloud(), { format: 'las14', omitClassification: true });
    expect(classFromLas(file!.bytes)).toEqual([0, 0, 0]);
    expect(report.log.some((l) => /omitted/i.test(l.message))).toBe(true);
  });
});

describe('convertCloud — mesh up-axis is DETECTED, then normalised', () => {
  const N = 40;
  /** A height field authored in the given frame — enough surface to detect. */
  function field(up: 'y' | 'z'): PointCloud {
    const pts: number[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        // A clear hill: wide footprint, modest height — unambiguously a
        // surface, so up-axis detection has something to decide with.
        const e = 5 * Math.exp(-(((i - 20) ** 2 + (j - 20) ** 2) / 180));
        if (up === 'y') pts.push(i * 2, e, j * 2);
        else pts.push(i * 2, j * 2, e);
      }
    }
    return new PointCloud({
      positions: Float32Array.from(pts),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'field.ply',
    });
  }
  it('rotates a DETECTED Y-up mesh so elevation lands in the Z column', () => {
    // First authored point is (0, e, 0): east 0, elevation e (Y), north 0 (−Z)
    // — the XYZ line must read 0, 0, e, not the raw storage order.
    const out = convertCloud(field('y'), { format: 'xyz' });
    const e = 0;
    const second = '';
    expect(out.report.log.some((l) => /y-up/i.test(l.message))).toBe(true);
    // Decisive coordinate check: authored point (3, sin(1)cos(0), 0) is line 3*N.
    // Authored point at grid (3, 0): (6, e30, 0) → east 6, north 0, up e30.
    const line = new TextDecoder().decode(out.file!.bytes).trim().split('\n')[3 * N];
    const elev = 5 * Math.exp(-((3 - 20) ** 2 + (0 - 20) ** 2) / 180);
    expect(line).toBe(`6.000 0.000 ${elev.toFixed(3)}`);
    void e; void second;
  });

  it('leaves a Z-up-AUTHORED ply untouched — the format table alone was wrong', () => {
    // CloudCompare/PDAL-style tools write Z-up PLYs; hard-classifying the
    // format as Y-up rotated real terrain into vertical walls in the terrain
    // gather, caught by e2e. The converter uses the same detection.
    const out = convertCloud(field('z'), { format: 'xyz' });
    const line = new TextDecoder().decode(out.file!.bytes).trim().split('\n')[3 * N];
    const elev = 5 * Math.exp(-((3 - 20) ** 2 + (0 - 20) ** 2) / 180);
    expect(line).toBe(`6.000 0.000 ${elev.toFixed(3)}`);
    expect(out.report.log.some((l) => /y-up/i.test(l.message))).toBe(false);
  });

  it('never second-guesses a survey format', () => {
    const out = convertCloud(
      new PointCloud({
        positions: Float32Array.from([3, 5, 7]),
        origin: [0, 0, 0],
        sourceFormat: 'las',
        name: 's.las',
      }),
      { format: 'xyz' },
    );
    expect(new TextDecoder().decode(out.file!.bytes).trim()).toBe('3.000 5.000 7.000');
  });
});
