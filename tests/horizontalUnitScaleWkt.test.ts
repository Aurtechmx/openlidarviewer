/**
 * horizontalUnitScaleWkt.test.ts — a projected CRS's declared unit factor is
 * the unit, and a name never overrides it.
 *
 * UNIT["centimetre",0.01] is 0.01 m per unit. It used to match the metre name
 * and carry the token 'metre' beside the 0.01 factor, so a label read metres
 * and the LAS writer stamped ProjLinearUnits = metre on centimetre coordinates.
 * The token is metre, foot or US survey foot only when the factor is that unit
 * (within 1e-9 m); any other valid factor keeps its value with the token
 * 'unknown' and `linearUnitByFactor`, which every unit gate reads as known, so
 * figures convert by the factor. A serializer that cannot state such a unit
 * refuses with the reason.
 */

import { describe, it, expect } from 'vitest';
import { crsFromWkt, linearUnitLabel, type CrsInfo } from '../src/io/crs';
import { isLinearUnitKnown, resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { CrsService } from '../src/geo/CrsService';
import { frameScalars, measureUnitFrameOf } from '../src/app/measurementExportFrame';
import { measurementsToCsv } from '../src/export/measurementExport';
import { convertCloud } from '../src/convert/convertCloud';
import { parseLasHeader } from '../src/io/lasHeader';
import { spacingRowFor } from '../src/ui/StreamingPanel';
import { PointCloud } from '../src/model/PointCloud';
import type { Measurement } from '../src/render/measure/types';

const GEOGCS = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const wkt1 = (unit: string): string =>
  `PROJCS["Local grid",${GEOGCS},PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",-105],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],${unit},AXIS["Easting",EAST],AXIS["Northing",NORTH]]`;
const wkt2 = (unit: string): string =>
  'PROJCRS["Local grid",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],' +
  'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["TM",METHOD["Transverse Mercator"]],CS[Cartesian,2],' +
  `AXIS["(E)",east,ORDER[1],${unit}],AXIS["(N)",north,ORDER[2],${unit}]]`;

const BY_FACTOR: ReadonlyArray<readonly [string, number]> = [
  ['centimetre', 0.01],
  ['millimetre', 0.001],
  ['kilometre', 1000],
  ['yard', 0.9144],
];

describe('a projected CRS in a valid non-named unit converts by its factor', () => {
  for (const [shape, build] of [['WKT1', (n: string, f: number) => wkt1(`UNIT["${n}",${f}]`)], ['WKT2', (n: string, f: number) => wkt2(`LENGTHUNIT["${n}",${f}]`)]] as const) {
    it.each(BY_FACTOR)(`${shape}: %s keeps %s m per unit`, (name, factor) => {
      const crs = crsFromWkt(build(name, factor));
      expect(crs.isGeographic).toBe(false);
      expect(crs.linearUnit).toBe('unknown');
      expect(crs.linearUnitToMetres).toBe(factor);
      expect(crs.linearUnitByFactor).toBe(true);
      expect(crs.linearUnitNote).toMatch(new RegExp(`"${name}" is ${factor} m per unit`));
      expect(isLinearUnitKnown(crs)).toBe(true);
      expect(linearUnitLabel(crs.linearUnit, crs)).toBe(`units of ${factor} m`);
      const ctx = spatialContextFrom(crs);
      expect(ctx.linearUnitKnown).toBe(true);
      expect(ctx.linearUnitToMetres).toBe(factor);
      expect(frameScalars(ctx).unitsVerified).toBe(true);
      expect(measureUnitFrameOf(ctx).crsKnown).toBe(true);
    });
  }

  it.each([['metre', 1, 'metre'], ['foot', 0.3048, 'foot'], ['US survey foot', 0.304800609601219, 'us-survey-foot']] as const)(
    'a named unit (%s) keeps its token and exact factor',
    (name, factor, token) => {
      for (const crs of [crsFromWkt(wkt1(`UNIT["${name}",${factor}]`)), crsFromWkt(wkt2(`LENGTHUNIT["${name}",${factor}]`))]) {
        expect(crs.linearUnit).toBe(token);
        expect(crs.linearUnitByFactor).toBeUndefined();
        expect(crs.linearUnitNote).toBeUndefined();
        expect(crs.linearUnitToMetres).toBeCloseTo(factor, 9);
      }
    },
  );

  it('a familiar name with a conflicting factor: the factor decides and the conflict is noted', () => {
    const asFoot = crsFromWkt(wkt1('UNIT["metre",0.3048]'));
    expect(asFoot.linearUnit).toBe('foot');
    expect(asFoot.linearUnitToMetres).toBe(0.3048);
    expect(asFoot.linearUnitNote).toMatch(/"metre" disagrees with its factor \(0\.3048 m per unit\); the factor is used/);
    const half = crsFromWkt(wkt2('LENGTHUNIT["foot",0.5]'));
    expect(half.linearUnit).toBe('unknown');
    expect(half.linearUnitToMetres).toBe(0.5);
    expect(half.linearUnitByFactor).toBe(true);
    expect(half.linearUnitNote).toMatch(/"foot" disagrees/);
  });

  it('an unusable factor is still unknown, not known by factor', () => {
    for (const unit of ['UNIT["metre",0]', 'UNIT["metre",-1]', 'UNIT["metre",1e999]']) {
      const crs = crsFromWkt(wkt1(unit));
      expect(crs.linearUnit).toBe('unknown');
      expect(crs.linearUnitByFactor).toBeUndefined();
      expect(isLinearUnitKnown(crs)).toBe(false);
    }
    // The inert placeholder of an unknown unit never reads as known.
    expect(isLinearUnitKnown({ linearUnit: 'unknown', linearUnitToMetres: 1 })).toBe(false);
  });
});

describe('the by-factor unit survives resolution, overrides and a saved session', () => {
  const cm = { ...crsFromWkt(wkt1('UNIT["centimetre",0.01]')), epsg: 32613 } as CrsInfo;

  it('a saved session keeps it', () => {
    const reloaded = parseResolvedCrs(JSON.parse(JSON.stringify(resolvedFromCrsInfo(cm, 'las-vlr'))))!;
    expect(reloaded.linearUnitByFactor).toBe(true);
    expect(spatialContextFrom(reloaded).linearUnitKnown).toBe(true);
    expect(spatialContextFrom(reloaded).linearUnitToMetres).toBe(0.01);
  });

  it('an override that confirms the detected code keeps it; one to another code takes that code\'s unit', () => {
    const identity = { pointCount: 1000, extent: [10, 10, 1] as [number, number, number], min: [100, 200, 0] as [number, number, number] };
    const svc = (epsg: number) => {
      const s = new CrsService({ get: () => ({ epsg, kind: 'projected', updatedAt: 1, detectedEpsg: 32613, detectedEpsgObserved: true, identity, identityVersion: 2 }), set: () => undefined, clear: () => undefined });
      s.resolveForScan({ name: 'cm.las', detected: cm, source: 'las-vlr', identity });
      return s;
    };
    const same = svc(32613);
    expect(same.current()?.source).toBe('user-override');
    expect(same.context().linearUnitToMetres).toBe(0.01);
    expect(same.context().linearUnitKnown).toBe(true);
    const other = svc(32612);
    expect(other.context().linearUnit).toBe('metre');
    expect(other.current()?.linearUnitByFactor).toBeUndefined();
  });
});

describe('figures and serializers', () => {
  const cm = crsFromWkt(wkt1('UNIT["centimetre",0.01]'));

  it('a 100-unit distance on a centimetre grid exports as 1 m', () => {
    const s = frameScalars(spatialContextFrom(cm));
    const m: Measurement = { id: 'd', name: 'd', kind: 'distance', points: [[0, 0, 0], [60, 80, 0]] };
    const csv = measurementsToCsv([m], { toOutput: (p) => p, up: [0, 0, 1], unitToMetres: s.unitToMetres, verticalUnitToMetres: s.verticalUnitToMetres, unitsVerified: s.unitsVerified });
    const [header, row] = csv.split('\n');
    expect(header).toContain('length_m');
    expect(row!.split(',')[header!.split(',').indexOf('length_m')]).toBe('1');
  });

  it('streamed spacing on a centimetre grid converts by the factor', () => {
    expect(spacingRowFor('copc', 250, cm).value).toBe('2.50 m');
  });

  const cloud = (crs: CrsInfo): PointCloud => new PointCloud({
    positions: Float32Array.from([0, 0, 0, 100, 0, 0, 0, 100, 10]), origin: [50000000, 400000000, 100], sourceFormat: 'las', name: 'cm.las', metadata: { crs },
  } as ConstructorParameters<typeof PointCloud>[0]);

  it('LAS 1.2 refuses a unit its GeoKeys cannot state', () => {
    const out = convertCloud(cloud(cm), { format: 'las', crsMode: 'keep' });
    expect(out.report.ok).toBe(false);
    expect(out.file).toBeNull();
    expect(out.report.log.some((l) => l.level === 'error' && /Horizontal unit not representable/.test(l.message) && /0\.01 m/.test(l.message))).toBe(true);
  });

  it('LAS 1.4 keeps the source WKT verbatim, and a reader gets the factor back', () => {
    const out = convertCloud(cloud(cm), { format: 'las14', crsMode: 'keep' });
    expect(out.report.log.filter((l) => l.level === 'error')).toEqual([]);
    const h = parseLasHeader(out.file!.bytes.buffer.slice(out.file!.bytes.byteOffset, out.file!.bytes.byteOffset + out.file!.bytes.byteLength) as ArrayBuffer);
    expect(h.crs?.linearUnitToMetres).toBe(0.01);
    expect(h.crs?.linearUnitByFactor).toBe(true);
    expect(h.crs?.wkt).toContain('UNIT["centimetre",0.01]');
  });
});
