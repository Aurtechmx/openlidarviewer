/**
 * demPackagePlacement.test.ts — the DEM package tags its rasters with a CRS
 * only when it has placed them. With no world origin (open layers whose
 * origins disagree) the rasters sit at project-frame offsets, so the package
 * writes no .prj and no GeoKeys, and the README says the frame is local.
 */
import { describe, expect, it } from 'vitest';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { demResultFor, DEM_PKG_OPTS } from './helpers/demPackageFixture';
import { extractEntry } from './helpers/zipReader';

const grid = () => ({
  cols: 2, rows: 2, cellSizeM: 1, originH1: 10, originH2: 20,
  z: new Float32Array([1, 2, 3, 4]), coverage: new Uint8Array([2, 2, 2, 2]),
  confidence: new Float32Array(4).fill(90), counts: new Uint32Array(4).fill(1),
  interpDistanceCells: new Float32Array(4), meanConfidence: 90,
});

function geoKey(bytes: Uint8Array, want: number): number | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, true) !== 34735) continue;
    const count = dv.getUint32(p + 4, true);
    const off = dv.getUint32(p + 8, true);
    for (let k = 4; k + 4 <= count; k += 4) {
      if (dv.getUint16(off + k * 2, true) === want) return dv.getUint16(off + (k + 3) * 2, true);
    }
  }
  return null;
}

const text = (zip: Uint8Array, name: string) => new TextDecoder().decode(extractEntry(zip, name)!);
const WKT = 'PROJCS["NAD83 / UTM zone 10N"]';

describe('DEM package placement', () => {
  it('placed: .prj, EPSG and vertical GeoKeys, and a georeferenced README', () => {
    const zip = buildDemPackage(demResultFor(grid()), { ...DEM_PKG_OPTS, basename: 'site', wkt: WKT });
    expect(text(zip, 'site.prj')).toBe(WKT);
    expect(geoKey(extractEntry(zip, 'site-dtm.tif')!, 3072)).toBe(32610);
    expect(geoKey(extractEntry(zip, 'site-dtm.tif')!, 4096)).toBe(5703);
    expect(text(zip, 'site-README.txt')).not.toContain('not georeferenced');
  });

  it('unplaced: no .prj, an untagged GeoTIFF, and a README that says the frame is local', () => {
    const zip = buildDemPackage(demResultFor(grid()), { basename: 'site', wkt: WKT, generationDateIso: DEM_PKG_OPTS.generationDateIso });
    expect(extractEntry(zip, 'site.prj')).toBeNull();
    const tif = extractEntry(zip, 'site-dtm.tif')!;
    expect(geoKey(tif, 3072)).toBeNull();
    expect(geoKey(tif, 4096)).toBeNull();
    const readme = text(zip, 'site-README.txt');
    expect(readme).toContain('local frame, not georeferenced; elevations recentred');
    expect(readme).not.toContain('site.prj');
  });
});
