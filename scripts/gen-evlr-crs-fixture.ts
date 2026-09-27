/**
 * gen-evlr-crs-fixture.ts: regenerates `tests/fixtures/evlr-crs-utm15.las` and
 * `tests/fixtures/evlr-crs-utm15.laz`.
 *
 * LAS 1.4 lets a writer store the coordinate system in an extended VLR after
 * the point data instead of a VLR before it, and many current deliveries do.
 * These fixtures carry their CRS ONLY that way: point format 6, no VLR CRS, one
 * LASF_Projection/2112 EVLR holding a compound WKT (NAD83(2011) / UTM zone 15N
 * + NAVD88 height, metres), global-encoding bit 4 set. The points are a small
 * synthetic grid written by the app's own LAS 1.4 writer.
 *
 * The LAZ variant is compressed by PDAL (`pdal` on PATH, checked with 2.10.2)
 * from a CRS-free copy, then given the same EVLR after the compressed data. The
 * creation day/year PDAL stamps are pinned so a rerun is byte-identical.
 *
 * Run: npx tsx scripts/gen-evlr-crs-fixture.ts
 */
(globalThis as Record<string, unknown>).__BUILD_IDENTITY__ = {
  version: 'fixture-gen', commit: '0000000', dirty: false,
};

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { writeLas14 } = await import('../src/convert/writeLas');

export const EVLR_FIXTURE_WKT =
  'COMPD_CS["NAD83(2011) / UTM zone 15N + NAVD88 height - Geoid18 (m)",PROJCS["NAD83(2011) / UTM zone 15N",GEOGCS["NAD83(2011)",DATUM["NAD83 (National Spatial Reference System 2011)",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","1116"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","6318"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-93],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["meter",1,AUTHORITY["EPSG","9001"]],AXIS["X",EAST],AXIS["Y",NORTH],AUTHORITY["EPSG","6344"]],VERT_CS["NAVD88 height - Geoid18 (m)",VERT_DATUM["North American Vertical Datum 1988",2005,AUTHORITY["EPSG","5103"]],UNIT["meter",1,AUTHORITY["EPSG","9001"]],AXIS["Up",UP],AUTHORITY["EPSG","5703"]]]';

const N = 20;
const count = N * N;
const x = new Float64Array(count);
const y = new Float64Array(count);
const z = new Float64Array(count);
const classification = new Uint8Array(count).fill(2);
let k = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    x[k] = 260000 + i * 2;
    y[k] = 3290000 + j * 2;
    z[k] = 10 + Math.sin(i / 3) * Math.cos(j / 4);
    k++;
  }
}

/** Append one LASF_Projection/2112 EVLR and point the 1.4 header at it. */
function withWktEvlr(file: Uint8Array): Uint8Array {
  const payload = new Uint8Array(EVLR_FIXTURE_WKT.length + 1);
  for (let i = 0; i < EVLR_FIXTURE_WKT.length; i++) payload[i] = EVLR_FIXTURE_WKT.charCodeAt(i);
  const out = new Uint8Array(file.length + 60 + payload.length);
  out.set(file, 0);
  const view = new DataView(out.buffer);
  const at = file.length;
  const userId = 'LASF_Projection';
  for (let i = 0; i < userId.length; i++) out[at + 2 + i] = userId.charCodeAt(i);
  view.setUint16(at + 18, 2112, true);
  view.setBigUint64(at + 20, BigInt(payload.length), true);
  out.set(payload, at + 60);
  view.setUint16(6, view.getUint16(6, true) | 0x10, true); // WKT bit
  view.setBigUint64(235, BigInt(at), true); // start of first EVLR
  view.setUint32(243, 1, true); // EVLR count
  return out;
}

const las = writeLas14({ count, x, y, z, classification });
writeFileSync('tests/fixtures/evlr-crs-utm15.las', withWktEvlr(las));

const dir = mkdtempSync(join(tmpdir(), 'evlr-fixture-'));
try {
  const src = join(dir, 'plain.las');
  const laz = join(dir, 'plain.laz');
  writeFileSync(src, las);
  execFileSync('pdal', [
    'translate', src, laz,
    '--writers.las.compression=true',
    '--writers.las.minor_version=4',
    '--writers.las.dataformat_id=6',
    '--writers.las.creation_doy=1',
    '--writers.las.creation_year=2024',
  ], { stdio: 'inherit' });
  writeFileSync('tests/fixtures/evlr-crs-utm15.laz', withWktEvlr(new Uint8Array(readFileSync(laz))));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('wrote tests/fixtures/evlr-crs-utm15.las and .laz');
