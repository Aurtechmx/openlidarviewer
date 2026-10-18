/**
 * lasWktPdalIntegration.test.ts — independent readers agree with the LAS 1.4
 * CRS records and the WKT this build constructs.
 *
 * Two optional checks, each run only when its tool is on PATH and reported as
 * skipped (by name) otherwise:
 *   - PDAL (`pdal info --metadata`) reads every exported LAS 1.4 file with no
 *     "Global encoding WKT flag not set" warning and a non-empty SRS whose
 *     EPSG is the one exported.
 *   - PDAL reads the vertical CRS and its unit from the WKT, and a PDAL
 *     reprojection to NAVD88 metres scales foot heights accordingly.
 *   - PROJ (`projinfo -o WKT1_GDAL`) produces, byte for byte, every WKT the
 *     table can construct: each stored code, each UTM-family zone, and the
 *     compound of a horizontal code with each stored vertical code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertCloud } from '../src/convert/convertCloud';
import { writeLas } from '../src/convert/writeLas';
import { CrsService } from '../src/geo/CrsService';
import { parseLasHeader } from '../src/io/lasHeader';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';
import { compoundWkt, wktForEpsg } from '../src/io/epsgWkt';
import { STATIC_WKT, UTM_FAMILIES, VERT_CS_WKT } from '../src/io/epsgWktTable';

function onPath(tool: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
}
const HAS_PDAL = onPath('pdal');
const HAS_PROJINFO = onPath('projinfo');

function cloud(crs: CrsInfo, rgb: boolean, origin: [number, number, number]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 5, 2]),
    origin,
    sourceFormat: 'las',
    name: 'geokeys.las',
    ...(rgb ? { colors: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]) } : {}),
    metadata: { crs },
  });
}

const geotiff = (epsg: number, name: string, extra: Partial<CrsInfo> = {}): CrsInfo => ({
  source: 'geotiff', name, epsg, isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1, ...extra,
});

interface Case { readonly label: string; readonly crs: CrsInfo; readonly origin: [number, number, number]; readonly epsg: number; readonly vertical?: number }

const BIG_WKT = wktForEpsg(32633)!.replace('"WGS 84 / UTM zone 33N"', `"WGS 84 / UTM zone 33N ${'x'.repeat(70000)}"`);

const CASES: readonly Case[] = [
  { label: 'EPSG:26912 from GeoKeys', crs: geotiff(26912, 'NAD83 / UTM zone 12N'), origin: [500000, 4000000, 100], epsg: 26912 },
  { label: 'EPSG:32633 from GeoKeys', crs: geotiff(32633, 'WGS 84 / UTM zone 33N'), origin: [400000, 5600000, 100], epsg: 32633 },
  { label: 'EPSG:2154 from GeoKeys', crs: geotiff(2154, 'RGF93 v1 / Lambert-93'), origin: [650000, 6860000, 100], epsg: 2154 },
  {
    label: 'EPSG:26912 + NAVD88 (ftUS) from GeoKeys',
    crs: geotiff(26912, 'NAD83 / UTM zone 12N', { verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalLinearUnit: 'us-survey-foot', verticalUnitToMetres: 1200 / 3937 }),
    origin: [500000, 4000000, 100],
    epsg: 26912,
    vertical: 6360,
  },
  {
    label: 'EPSG:32633 with an oversized source WKT (EVLR)',
    crs: { ...geotiff(32633, 'WGS 84 / UTM zone 33N'), source: 'wkt', wkt: BIG_WKT },
    origin: [400000, 5600000, 100],
    epsg: 32633,
  },
];

describe.skipIf(!HAS_PDAL)('PDAL reads the exported LAS 1.4 CRS (requires pdal on PATH)', () => {
  let dir = '';
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'olv-las14-wkt-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  for (const rgb of [false, true]) {
    for (const c of CASES) {
      it(`PDRF ${rgb ? 7 : 6}: ${c.label}`, () => {
        const { file, report } = convertCloud(cloud(c.crs, rgb, c.origin), { format: 'las14', crsMode: 'keep' });
        expect(report.ok).toBe(true);
        const path = join(dir, `${c.epsg}-${rgb ? 7 : 6}-${c.vertical ?? 0}-${c.crs.wkt ? 'w' : 'k'}.las`);
        writeFileSync(path, file!.bytes);
        const run = spawnSync('pdal', ['info', path, '--metadata'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        expect(run.status).toBe(0);
        expect(`${run.stderr}${run.stdout}`).not.toMatch(/WKT flag not set/i);
        const meta = JSON.parse(run.stdout).metadata;
        expect(meta.dataformat_id).toBe(rgb ? 7 : 6);
        expect(meta.global_encoding & 0x10).toBe(0x10);
        const srs = meta.srs;
        expect(srs.wkt.length).toBeGreaterThan(0);
        expect(srs.horizontal).toContain(`AUTHORITY["EPSG","${c.epsg}"]`);
        const horizontalJson = srs.json.type === 'CompoundCRS' ? srs.json.components[0] : srs.json;
        expect(horizontalJson.id).toEqual({ authority: 'EPSG', code: c.epsg });
        if (c.vertical != null) {
          expect(srs.vertical).toContain(`AUTHORITY["EPSG","${c.vertical}"]`);
          expect(srs.json.components[1].id).toEqual({ authority: 'EPSG', code: c.vertical });
        }
      });
    }
  }
});

describe.skipIf(!HAS_PROJINFO)('constructed WKT equals PROJ output (requires projinfo on PATH)', () => {
  const projinfo = (id: string): string =>
    execFileSync('projinfo', [id, '-o', 'WKT1_GDAL', '--single-line', '-q'], { encoding: 'utf8' }).trim();

  it('every stored code', () => {
    for (const code of Object.keys(STATIC_WKT).map(Number)) expect(wktForEpsg(code), `EPSG:${code}`).toBe(projinfo(`EPSG:${code}`));
  });

  it('every UTM-family zone', () => {
    for (const f of UTM_FAMILIES) {
      for (let code = f.first; code <= f.last; code++) expect(wktForEpsg(code), `EPSG:${code}`).toBe(projinfo(`EPSG:${code}`));
    }
  });

  it('the compound of 26912 with each stored vertical CRS', () => {
    for (const v of Object.keys(VERT_CS_WKT).map(Number)) {
      expect(compoundWkt(wktForEpsg(26912)!, v), `EPSG:26912+${v}`).toBe(projinfo(`EPSG:26912+${v}`));
    }
  }, 60_000);
});

/**
 * Heights as PDAL reads them: the vertical CRS must come from the WKT, since
 * PDAL ignores the GeoKeys once bit 4 is set. Source: a GeoKey-only LAS with
 * EPSG:32613 metre XY and NAVD88 heights of 100 and 110 in each unit.
 */
describe.skipIf(!HAS_PDAL)('PDAL reads the vertical CRS of a LAS 1.4 export (requires pdal on PATH)', () => {
  let dir = '';
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'olv-las14-vert-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const points = { count: 2, x: Float64Array.of(500000, 500010), y: Float64Array.of(4000000, 4000020), z: Float64Array.of(100, 110) };

  function exportLas14(unitCode: number, opts: { crsMode: 'keep' | 'assign' | 'reproject'; targetEpsg?: number }): string {
    const src = writeLas(points, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: unitCode });
    const detected = parseLasHeader(src.slice().buffer as ArrayBuffer).crs!;
    const resolved = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} })
      .resolveForScan({ name: 'mixed.las', detected, source: 'las-vlr' })!;
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 10]), origin: [500000, 4000000, 100], sourceFormat: 'las', name: 'mixed.las', metadata: { crs: detected },
    });
    const { file, report } = convertCloud(cloud, { format: 'las14', resolvedSourceCrs: resolved, ...opts });
    expect(report.ok).toBe(true);
    const path = join(dir, `v-${unitCode}-${opts.crsMode}-${opts.targetEpsg ?? 0}.las`);
    writeFileSync(path, file!.bytes);
    return path;
  }

  function pdalSrs(path: string) {
    const run = spawnSync('pdal', ['info', path, '--metadata'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(`${run.stderr}`).not.toMatch(/WKT flag not set/i);
    return JSON.parse(run.stdout).metadata.srs;
  }

  /** Heights after PDAL reprojects to EPSG:<horizontal>+5703 (NAVD88 height, metres). */
  function heightsInMetres(path: string, horizontal: number): number[] {
    const csv = `${path}.csv`;
    execFileSync('pdal', ['translate', path, csv, 'reprojection', `--filters.reprojection.out_srs=EPSG:${horizontal}+5703`,
      '--writers.text.order=X,Y,Z', '--writers.text.keep_unspecified=false', '--writers.text.precision=9']);
    return readFileSync(csv, 'utf8').trim().split('\n').slice(1).map((l) => Number(l.split(',')[2]));
  }

  it.each([
    ['metres', 9001, 5703, 1],
    ['international feet', 9002, 8228, 0.3048],
    ['US survey feet', 9003, 6360, 1200 / 3937],
  ] as const)('NAVD88 in %s: compound CRS, and a reprojection to metres scales the heights', (_l, unitCode, code, factor) => {
    const path = exportLas14(unitCode, { crsMode: 'keep' });
    const srs = pdalSrs(path);
    expect(srs.json.type).toBe('CompoundCRS');
    expect(srs.json.components[0].id).toEqual({ authority: 'EPSG', code: 32613 });
    const vertical = srs.json.components.find((c: { type: string }) => c.type === 'VerticalCRS');
    expect(vertical.id).toEqual({ authority: 'EPSG', code });
    const unit = vertical.coordinate_system.axis[0].unit;
    expect(unit === 'metre' ? 1 : unit.conversion_factor).toBeCloseTo(factor, 12);
    const z = heightsInMetres(path, 32613);
    expect(z[0]).toBeCloseTo(100 * factor, 6);
    expect(z[1] - z[0]).toBeCloseTo(10 * factor, 6);
  });

  it('the 32613+6360 case: the 10 ftUS rise reads 3.048006096 m after reprojection to 32613+5703', () => {
    const z = heightsInMetres(exportLas14(9003, { crsMode: 'keep' }), 32613);
    expect(z[1] - z[0]).toBeCloseTo(3.048006096, 8);
  });

  it.each(['assign', 'reproject'] as const)('%s to EPSG:32614 keeps NAVD88 (ftUS) in the WKT', (crsMode) => {
    const path = exportLas14(9003, { crsMode, targetEpsg: 32614 });
    const srs = pdalSrs(path);
    expect(srs.json.type).toBe('CompoundCRS');
    expect(srs.json.components[0].id).toEqual({ authority: 'EPSG', code: 32614 });
    expect(srs.json.components[1].id).toEqual({ authority: 'EPSG', code: 6360 });
    const z = heightsInMetres(path, 32614);
    expect(z[1] - z[0]).toBeCloseTo(3.048006096, 8);
  });
});
