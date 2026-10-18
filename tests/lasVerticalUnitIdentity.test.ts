/**
 * lasVerticalUnitIdentity.test.ts — a LAS conversion keeps the vertical unit
 * the source declared, independently of the horizontal one.
 *
 * Route under test, end to end: source LAS bytes → `parseLasHeader` →
 * `CrsService.resolveForScan` (the `ResolvedCrs` the Export panel hands the
 * converter) → `convertCloud` → re-parse of the written bytes. The written Z
 * values are never scaled by any mode, so the vertical unit the output
 * declares must be the source's: a 10 US-survey-foot rise stays 3.048006 m.
 *
 * A declared vertical unit that cannot be read is written with no vertical
 * claim at all; a vertical CRS code whose unit contradicts the declared unit,
 * or a unit token that contradicts its factor, refuses the conversion.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { CrsService } from '../src/geo/CrsService';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { spatialContextFrom, verticalMetresPerUnit } from '../src/geo/SpatialContext';
import { convertCloud } from '../src/convert/convertCloud';
import { writeLas, type WriteLasOptions } from '../src/convert/writeLas';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import { parseLasHeader } from '../src/io/lasHeader';
import { UNIT_FACTORS } from '../src/units/units';

const US_FT = UNIT_FACTORS.M_PER_US_FT;
const FT = UNIT_FACTORS.M_PER_FT;
const FORMATS = ['las', 'las14'] as const;

function buf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** GeoKeys of the first LASF_Projection 34735 VLR, or an empty map. */
function geoKeys(bytes: Uint8Array): Map<number, number> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = v.getUint16(94, true);
  const nVlr = v.getUint32(100, true);
  let p = headerSize;
  const keys = new Map<number, number>();
  for (let i = 0; i < nVlr; i++) {
    const user = new TextDecoder().decode(bytes.subarray(p + 2, p + 18)).replace(/\0+$/, '');
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    const body = p + 54;
    if (user === 'LASF_Projection' && id === 34735) {
      const n = v.getUint16(body + 6, true);
      for (let k = 0; k < n; k++) {
        const at = body + 8 + k * 8;
        keys.set(v.getUint16(at, true), v.getUint16(at + 6, true));
      }
      return keys;
    }
    p = body + len;
  }
  return keys;
}

/** Overwrite one GeoKey value in place (to build source declarations the writer refuses). */
function setGeoKey(bytes: Uint8Array, key: number, value: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  const v = new DataView(out.buffer);
  let p = v.getUint16(94, true);
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    const body = p + 54;
    if (id === 34735) {
      for (let k = 0; k < v.getUint16(body + 6, true); k++) {
        const at = body + 8 + k * 8;
        if (v.getUint16(at, true) === key) v.setUint16(at + 6, value, true);
      }
    }
    p = body + len;
  }
  return out;
}

/** A four-point source LAS: Z 100 and 110 in whatever unit the opts declare. */
function sourceLas(opts: WriteLasOptions, xy: [number, number] = [500000, 4000000]): Uint8Array {
  const [x0, y0] = xy;
  return writeLas(
    {
      count: 4,
      x: Float64Array.from([x0, x0 + 1, x0, x0 + 1]),
      y: Float64Array.from([y0, y0, y0 + 1, y0 + 1]),
      z: Float64Array.from([100, 100, 110, 110]),
    },
    opts,
  );
}

function cloudFor(crs: CrsInfo | null, name: string, xy: [number, number] = [500000, 4000000]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 10, 1, 1, 10]),
    origin: [xy[0], xy[1], 100],
    sourceFormat: 'las',
    name,
    metadata: { crs: crs ?? undefined },
  } as ConstructorParameters<typeof PointCloud>[0]);
}

function memoryService(): CrsService {
  const store = new Map<string, never>();
  return new CrsService({
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, { ...v, updatedAt: 0 } as never); },
    clear: (k) => { store.delete(k); },
  });
}

/** Load a source the way the app does: parse the bytes, resolve through CrsService. */
function load(bytes: Uint8Array, name: string, xy?: [number, number]): { cloud: PointCloud; resolved: ResolvedCrs; svc: CrsService } {
  const crs = parseLasHeader(buf(bytes)).crs;
  const cloud = cloudFor(crs, name, xy);
  const svc = memoryService();
  const resolved = svc.resolveForScan({ name, detected: crs ?? undefined, source: 'las-vlr' });
  return { cloud, resolved, svc };
}

interface Reread {
  readonly crs: CrsInfo | null;
  readonly keys: Map<number, number>;
  readonly zMin: number;
  readonly zMax: number;
  /** Metres per Z unit as a reader of the output applies it (GeoTIFF convention). */
  readonly zToMetres: number | undefined;
}

function reread(bytes: Uint8Array): Reread {
  const h = parseLasHeader(buf(bytes));
  const ctx = spatialContextFrom(h.crs);
  return {
    crs: h.crs,
    keys: geoKeys(bytes),
    zMin: h.min[2],
    zMax: h.max[2],
    zToMetres: h.crs ? verticalMetresPerUnit(ctx, 'horizontal-when-known') : undefined,
  };
}

function convertOk(cloud: PointCloud, opts: Parameters<typeof convertCloud>[1]): Reread {
  const out = convertCloud(cloud, opts);
  expect(out.report.log.filter((l) => l.level === 'error')).toEqual([]);
  expect(out.report.ok).toBe(true);
  return reread(out.file!.bytes);
}

/** The physical elevation difference the output states for the 10-unit rise. */
/**
 * LAS 1.4 point formats 6-10 need the CRS as WKT, and this build holds no
 * verified WKT for the State Plane foot code used below, so a LAS 1.4 export
 * of it is refused by name (LAS 1.2 records it as GeoKeys).
 */
function expectNoWktRefusal(cloud: PointCloud, opts: Parameters<typeof convertCloud>[1], code: number): void {
  const out = convertCloud(cloud, opts);
  expect(out.file).toBeNull();
  expect(out.report.log.map((l) => l.message).join(' ')).toContain(`no verified WKT definition for EPSG:${code}`);
}

function riseMetres(r: Reread): number {
  expect(r.zToMetres).toBeDefined();
  return (r.zMax - r.zMin) * (r.zToMetres as number);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('ResolvedCrs and SpatialContext carry the vertical unit', () => {
  it('resolveForScan keeps the vertical unit token beside its factor', () => {
    const { resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'r.las');
    expect(resolved.verticalLinearUnit).toBe('us-survey-foot');
    expect(resolved.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
    const ctx = spatialContextFrom(resolved);
    expect(ctx.verticalLinearUnit).toBe('us-survey-foot');
    expect(ctx.linearUnit).toBe('metre');
  });

  it('a horizontal override keeps the detected vertical unit token', () => {
    const { svc } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'o.las');
    const detected = parseLasHeader(buf(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }))).crs!;
    const r = svc.setOverride({ override: { epsg: 32614, kind: 'projected' }, detected, source: 'las-vlr' })!;
    expect(r.epsg).toBe(32614);
    expect(r.verticalLinearUnit).toBe('us-survey-foot');
    expect(r.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
  });

  it('derives the token from a proven factor when only the factor is present, never from the horizontal unit', () => {
    const base: ResolvedCrs = {
      kind: 'projected', name: 'EPSG:32613', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
      source: 'las-vlr', confidence: 'medium', userConfirmed: false,
    };
    expect(spatialContextFrom({ ...base, verticalUnitToMetres: US_FT }).verticalLinearUnit).toBe('us-survey-foot');
    expect(spatialContextFrom({ ...base, verticalUnitToMetres: FT }).verticalLinearUnit).toBe('foot');
    expect(spatialContextFrom({ ...base, verticalUnitToMetres: 0.5 }).verticalLinearUnit).toBe('unknown');
    expect(spatialContextFrom(base).verticalLinearUnit).toBeUndefined();
  });
});

describe('LAS conversion keeps the declared vertical unit (load → resolve → convert → re-parse)', () => {
  for (const format of FORMATS) {
    describe(format, () => {
      it('metre XY + NAVD88 US-survey-foot Z: Keep writes 6360 / ftUS and Z unchanged', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'mixed.las');
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.zMin).toBe(100);
        expect(r.zMax).toBe(110);
        expect(r.crs?.verticalEpsg).toBe(6360);
        expect(r.crs?.verticalLinearUnit).toBe('us-survey-foot');
        expect(r.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
        expect(r.keys.get(4096)).toBe(6360);
        expect(r.keys.get(4099)).toBe(9003);
        expect(r.crs?.linearUnit).toBe('metre');
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('metre XY + international-foot Z: Keep writes the foot unit', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9002 }), 'ft.las');
        expect(resolved.verticalUnitToMetres).toBe(FT);
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.crs?.verticalUnitToMetres).toBe(FT);
        expect(r.keys.get(4099)).toBe(9002);
        expect(r.keys.get(4096)).toBe(8228);
        expect(riseMetres(r)).toBeCloseTo(3.048, 9);
      });

      it('metre XY + foot Z declared by unit alone (no vertical CRS): Keep writes the unit alone', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalUnitCode: 9003 }), 'unit-only.las');
        expect(resolved.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
        if (format === 'las14') {
          // A WKT cannot state a height unit without a vertical CRS, and a WKT
          // reader would take these heights in metres, so LAS 1.4 refuses.
          const out = convertCloud(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
          expect(out.file).toBeNull();
          expect(out.report.log.map((l) => l.message).join(' ')).toContain('declared in US survey feet with no vertical datum');
          return;
        }
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.keys.get(4096)).toBeUndefined();
        expect(r.keys.get(4099)).toBe(9003);
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('foot XY + metre Z: Keep writes foot horizontal and metre vertical', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 2225, linearUnitCode: 9003, verticalEpsg: 5703, verticalUnitCode: 9001 }, [6000000, 2000000]), 'ftxy.las', [6000000, 2000000]);
        if (format === 'las14') return expectNoWktRefusal(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved }, 2225);
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.crs?.linearUnit).toBe('us-survey-foot');
        expect(r.crs?.verticalEpsg).toBe(5703);
        expect(r.crs?.verticalUnitToMetres).toBe(1);
        expect(riseMetres(r)).toBeCloseTo(10, 9);
      });

      it('matching units (metre XY + NAVD88 metre Z): Keep writes 5703 / metre', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9001 }), 'm.las');
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.keys.get(4096)).toBe(5703);
        expect(r.keys.get(4099)).toBe(9001);
        expect(riseMetres(r)).toBeCloseTo(10, 9);
      });

      it('absent vertical unit: Keep adds no vertical claim and the reader interprets Z as before', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 2225, linearUnitCode: 9003 }, [6000000, 2000000]), 'novert.las', [6000000, 2000000]);
        expect(resolved.verticalUnitToMetres).toBeUndefined();
        if (format === 'las14') return expectNoWktRefusal(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved }, 2225);
        const r = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(r.keys.has(4099)).toBe(false);
        expect(r.keys.has(4096)).toBe(false);
        expect(r.crs?.verticalUnitToMetres).toBeUndefined();
        // Same reading as the source: the horizontal unit, by the GeoTIFF convention.
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('Assign keeps the source vertical CRS and unit', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'assign.las');
        const r = convertOk(cloud, { format, crsMode: 'assign', targetEpsg: 32614, resolvedSourceCrs: resolved });
        expect(r.crs?.epsg).toBe(32614);
        expect(r.crs?.verticalEpsg).toBe(6360);
        expect(r.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
        expect(r.zMin).toBe(100);
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('horizontal Reproject keeps the source vertical CRS and unit on unchanged Z', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'rep.las');
        const r = convertOk(cloud, { format, crsMode: 'reproject', targetEpsg: 32614, resolvedSourceCrs: resolved });
        expect(r.crs?.epsg).toBe(32614);
        expect(r.crs?.verticalEpsg).toBe(6360);
        expect(r.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
        expect(r.zMin).toBe(100);
        expect(r.zMax).toBe(110);
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('Reproject of foot XY with no declared vertical unit keeps Z in the source foot', () => {
        const { cloud, resolved } = load(sourceLas({ epsg: 2225, linearUnitCode: 9003 }, [6000000, 2000000]), 'ftrep.las', [6000000, 2000000]);
        // The reproject is skipped (no definition for 2225), so the file stays in 2225.
        if (format === 'las14') return expectNoWktRefusal(cloud, { format, crsMode: 'reproject', targetEpsg: 4326, resolvedSourceCrs: resolved }, 2225);
        const r = convertOk(cloud, { format, crsMode: 'reproject', targetEpsg: 4326, resolvedSourceCrs: resolved });
        expect(r.zMin).toBe(100);
        expect(r.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
        expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
      });

      it('conflicting declarations (6360 is ftUS, the unit says metre) refuse with a clear message', () => {
        // The writer never emits this pair, so the source's 4096 is patched to it.
        const src = setGeoKey(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9001 }), 4096, 6360);
        expect(geoKeys(src).get(4096)).toBe(6360);
        expect(geoKeys(src).get(4099)).toBe(9001);
        const { cloud, resolved } = load(src, 'conflict.las');
        const out = convertCloud(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(out.report.ok).toBe(false);
        expect(out.file).toBeNull();
        expect(out.report.log.map((l) => l.message).join(' ')).toMatch(/vertical.*EPSG:6360.*US survey f.*metre|vertical.*conflict/i);
      });

      it('a unit token that contradicts its factor refuses', () => {
        const resolved: ResolvedCrs = {
          kind: 'projected', name: 'EPSG:32613', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
          source: 'las-vlr', confidence: 'medium', userConfirmed: false,
          verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalLinearUnit: 'foot', verticalUnitToMetres: 1,
        };
        const out = convertCloud(cloudFor(null, 'tok.las'), { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(out.report.ok).toBe(false);
        expect(out.report.log.map((l) => l.message).join(' ')).toMatch(/vertical unit/i);
      });

      // Writing no vertical claim would let a reader take the heights in the
      // horizontal unit (metres here), so an unreadable unit refuses the write.
      it('an unreadable vertical unit refuses the write and says why', () => {
        const resolved: ResolvedCrs = {
          kind: 'projected', name: 'EPSG:32613', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
          source: 'las-vlr', confidence: 'medium', userConfirmed: false,
          verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalLinearUnit: 'unknown', verticalUnitToMetres: Number.NaN,
        };
        const out = convertCloud(cloudFor(null, 'unk.las'), { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(out.report.ok).toBe(false);
        expect(out.file).toBeNull();
        expect(out.report.log.some((l) => l.level === 'error' && /vertical unit not readable/i.test(l.message))).toBe(true);
      });

      it('a saved unreadable vertical unit (token only, factor dropped) refuses the write too', () => {
        const resolved: ResolvedCrs = {
          kind: 'projected', name: 'EPSG:32613', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
          source: 'las-vlr', confidence: 'medium', userConfirmed: false, verticalLinearUnit: 'unknown',
        };
        const out = convertCloud(cloudFor(null, 'unk.las'), { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(out.report.ok).toBe(false);
        expect(out.file).toBeNull();
      });

      // A yard is a valid length, but no LAS vertical unit code names it; no
      // named unit may stand in for 0.9144 m.
      it('a valid vertical unit LAS cannot name (yard) refuses the write with the factor', () => {
        const resolved: ResolvedCrs = {
          kind: 'projected', name: 'EPSG:32613', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
          source: 'las-vlr', confidence: 'medium', userConfirmed: false,
          verticalLinearUnit: 'unknown', verticalUnitToMetres: 0.9144,
        };
        const out = convertCloud(cloudFor(null, 'yard.las'), { format, crsMode: 'keep', resolvedSourceCrs: resolved });
        expect(out.report.ok).toBe(false);
        expect(out.file).toBeNull();
        expect(out.report.log.some((l) => l.level === 'error' && /0\.9144 m/.test(l.message) && /cannot state/.test(l.message))).toBe(true);
      });
    });
  }

  it('the audit case: Keep from the resolved CRS matches Keep from the declared CRS', () => {
    for (const format of FORMATS) {
      const { cloud, resolved } = load(sourceLas({ epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 }), 'mixed-units.las');
      const viaResolved = convertOk(cloud, { format, crsMode: 'keep', resolvedSourceCrs: resolved });
      const viaDeclared = convertOk(cloud, { format, crsMode: 'keep' });
      expect(viaResolved.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
      expect(viaResolved.crs?.verticalEpsg).toBe(viaDeclared.crs?.verticalEpsg);
      expect(viaResolved.keys.get(4099)).toBe(viaDeclared.keys.get(4099));
    }
  });
});

describe('LAS 1.4 with a compound WKT', () => {
  const compound = (vertName: string, unit: string, factor: number, code: number): string =>
    'COMPD_CS["WGS 84 / UTM zone 13N + ' + vertName + '",'
    + 'PROJCS["WGS 84 / UTM zone 13N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],'
    + 'PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",-105],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],'
    + 'UNIT["metre",1],AUTHORITY["EPSG","32613"]],'
    + `VERT_CS["${vertName}",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["${unit}",${factor}],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","${code}"]]]`;

  it('Keep preserves the compound vertical (ftUS) through WKT and GeoKeys', () => {
    const info = crsFromWkt(compound('NAVD88 height (ftUS)', 'US survey foot', US_FT, 6360));
    expect(info.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
    const svc = memoryService();
    const resolved = svc.resolveForScan({ name: 'c.las', detected: info, source: 'las-vlr' });
    const r = convertOk(cloudFor(info, 'c.las'), { format: 'las14', crsMode: 'keep', resolvedSourceCrs: resolved });
    expect(r.crs?.verticalEpsg).toBe(6360);
    expect(r.crs?.verticalUnitToMetres).toBeCloseTo(US_FT, 12);
    expect(riseMetres(r)).toBeCloseTo(3.048006, 6);
  });

  it('refuses when the compound WKT names another vertical unit than the resolved one', () => {
    const resolved: ResolvedCrs = {
      kind: 'projected', name: 'x', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
      source: 'las-vlr', confidence: 'high', userConfirmed: false,
      wkt: compound('NAVD88 height', 'metre', 1, 5703),
      verticalEpsg: 6360, verticalDatum: 'NAVD88 height (ftUS)', verticalLinearUnit: 'us-survey-foot', verticalUnitToMetres: US_FT,
    };
    const out = convertCloud(cloudFor(null, 'cw.las'), { format: 'las14', crsMode: 'keep', resolvedSourceCrs: resolved });
    expect(out.report.ok).toBe(false);
    expect(out.file).toBeNull();
    expect(out.report.log.map((l) => l.message).join(' ')).toMatch(/vertical/i);
  });
});
