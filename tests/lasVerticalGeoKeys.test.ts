/**
 * lasVerticalGeoKeys.test.ts — the LAS GeoKey VLR names the vertical CRS in
 * the unit of the Z values.
 *
 * PDAL, like GDAL, takes the vertical unit from the VerticalGeoKey (4096) code
 * and ignores VerticalUnitsGeoKey (4099). A LAS with 4096 = 5703 and 4099 =
 * US survey foot therefore read as NAVD88 in metres. The converter now writes
 * the code in the unit of the heights, through the same resolver as the DEM
 * GeoTIFFs. The directory header stays 1,1,0: LAS 1.4 R16 fixes
 * `wMinorRevision = 0; // Always` for this record.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';

const HAS_PDAL = spawnSync('pdal', ['--version'], { stdio: 'ignore' }).status === 0;

/** The GeoKey directory of the first LASF_Projection 34735 VLR: header and keys. */
function geoKeyVlr(bytes: Uint8Array): { header: number[]; keys: Map<number, number> } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = v.getUint16(94, true);
  const nVlr = v.getUint32(100, true);
  let p = headerSize;
  for (let i = 0; i < nVlr; i++) {
    const user = new TextDecoder().decode(bytes.subarray(p + 2, p + 18)).replace(/\0+$/, '');
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    const body = p + 54;
    if (user === 'LASF_Projection' && id === 34735) {
      const header = [0, 1, 2, 3].map((k) => v.getUint16(body + k * 2, true));
      const keys = new Map<number, number>();
      for (let k = 0; k < header[3]; k++) {
        const at = body + 8 + k * 8;
        keys.set(v.getUint16(at, true), v.getUint16(at + 6, true));
      }
      return { header, keys };
    }
    p = body + len;
  }
  throw new Error('no GeoKey VLR');
}

const g = (): GlobalPoints => ({
  count: 3,
  x: Float64Array.from([500000.1, 500001.5, 500002]),
  y: Float64Array.from([4100000, 4100000.25, 4100001]),
  z: Float64Array.from([12.34, 13, 14.5]),
});
const opts = { epsg: 32612, isGeographic: false, linearUnitCode: 9001 } as const;

describe('LAS vertical GeoKeys', () => {
  it('writes NAVD88 in US survey feet as EPSG:6360, header 1,1,0', () => {
    const { header, keys } = geoKeyVlr(writeLas(g(), { ...opts, verticalEpsg: 5703, verticalUnitCode: 9003 }));
    expect(header.slice(0, 3)).toEqual([1, 1, 0]);
    expect(keys.get(4096)).toBe(6360);
    expect(keys.get(4099)).toBe(9003);
  });

  it('writes NAVD88 in international feet as EPSG:8228, in LAS 1.4 too', () => {
    const { keys } = geoKeyVlr(writeLas14(g(), { ...opts, verticalEpsg: 5703, verticalUnitCode: 9002 }));
    expect(keys.get(4096)).toBe(8228);
    expect(keys.get(4099)).toBe(9002);
  });

  it('keeps the unit but no vertical CRS when the code contradicts it', () => {
    const { keys } = geoKeyVlr(writeLas(g(), { ...opts, verticalEpsg: 6360, verticalUnitCode: 9001 }));
    expect(keys.has(4096)).toBe(false);
    expect(keys.get(4099)).toBe(9001);
  });

  it('keeps the unit but no vertical CRS when EPSG has none in that unit', () => {
    const { keys } = geoKeyVlr(writeLas(g(), { ...opts, verticalEpsg: 3855, verticalUnitCode: 9002 }));
    expect(keys.has(4096)).toBe(false);
    expect(keys.get(4099)).toBe(9002);
  });

  it('maps a depth CRS to its unit form rather than dropping it', () => {
    const { keys } = geoKeyVlr(writeLas(g(), { ...opts, verticalEpsg: 6357, verticalUnitCode: 9003 }));
    expect(keys.get(4096)).toBe(6358);
  });
});

describe('PDAL reads the LAS vertical CRS in the unit of the heights', () => {
  let dir = '';
  beforeAll(() => { if (HAS_PDAL) dir = mkdtempSync(join(tmpdir(), 'olv-las-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const read = (name: string, bytes: Uint8Array) => {
    const f = join(dir, `${name}.las`);
    writeFileSync(f, bytes);
    return JSON.parse(execFileSync('pdal', ['info', '--metadata', f], { encoding: 'utf8' })).metadata.srs;
  };

  it.skipIf(!HAS_PDAL)('5703 with US survey feet reads as NAVD88 height (ftUS)', () => {
    const srs = read('usft', writeLas(g(), { ...opts, verticalEpsg: 5703, verticalUnitCode: 9003 }));
    expect(srs.vertical).toContain('VERT_CS["NAVD88 height (ftUS)"');
    expect(srs.vertical).toContain('UNIT["US survey foot"');
  });

  it.skipIf(!HAS_PDAL)('5703 with metres reads as NAVD88 height in metres', () => {
    const srs = read('m', writeLas(g(), { ...opts, verticalEpsg: 5703, verticalUnitCode: 9001 }));
    expect(srs.vertical).toContain('VERT_CS["NAVD88 height"');
    expect(srs.vertical).toContain('UNIT["metre"');
  });
});
