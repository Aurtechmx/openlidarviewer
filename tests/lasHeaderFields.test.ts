/**
 * The EPT tile decoder reads the LAS header's layout without its CRS.
 *
 * `buildContext` parsed every tile's full header, CRS included, and used only
 * the point layout (format, record length, count, scale, offset). The CRS
 * parse reads the EPSG tables, so the decode worker carried them for a value
 * it threw away. `parseLasHeaderFields` returns every header field with
 * `crs: null`; `parseLasHeader` is that plus the CRS, unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import * as crsModule from '../src/io/crs';
import { parseLasHeader, parseLasHeaderFields } from '../src/io/lasHeader';
import { buildContext } from '../src/io/ept/eptLaszipDecode';
import { writeLas14 } from '../src/convert/writeLas';

vi.mock('../src/io/crs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/io/crs')>();
  return { ...orig, parseCrsFromVlrs: vi.fn(orig.parseCrsFromVlrs) };
});

const UTM = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';

function lasWithWkt(): ArrayBuffer {
  const bytes = writeLas14({ count: 2, x: Float64Array.of(500000, 500010), y: Float64Array.of(4000000, 4000010), z: Float64Array.of(1, 2) }, { wkt: UTM });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('the header without its CRS', () => {
  it('has every other field of the full header, in the same order, and crs null', () => {
    const buf = lasWithWkt();
    const full = parseLasHeader(buf);
    const fields = parseLasHeaderFields(buf);
    expect(full.crs?.epsg).toBe(32612);
    expect(fields.crs).toBeNull();
    expect(Object.keys(fields)).toEqual(Object.keys(full));
    expect({ ...fields, crs: full.crs }).toEqual(full);
  });

  it('the EPT tile decoder does not parse the CRS', () => {
    const spy = vi.mocked(crsModule.parseCrsFromVlrs);
    const buf = lasWithWkt();
    spy.mockClear();
    const ctx = buildContext(buf);
    expect(ctx.pointCount).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    parseLasHeader(buf);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
