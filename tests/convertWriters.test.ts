/**
 * convertWriters.test.ts — LAS / XYZ / ASC writers + global-coordinate lift.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { cloudToGlobal, globalBounds, type GlobalPoints } from '../src/convert/globalPoints';
import { writeLas, pickPointFormat } from '../src/convert/writeLas';
import { writeXyz, writeAsc } from '../src/convert/writeAscii';

function sampleGlobal(over: Partial<GlobalPoints> = {}): GlobalPoints {
  return {
    count: 3,
    x: Float64Array.from([500000.123, 500001.5, 500002.0]),
    y: Float64Array.from([4100000.0, 4100000.25, 4100001.0]),
    z: Float64Array.from([12.34, 13.0, 14.5]),
    ...over,
  };
}

describe('cloudToGlobal + globalBounds', () => {
  it('lifts local positions by the integer origin into global space', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([1, 2, 3, 4, 5, 6]),
      origin: [500000, 4100000, 10],
      sourceFormat: 'las',
      name: 't.las',
    });
    const g = cloudToGlobal(cloud);
    expect(g.count).toBe(2);
    expect(g.x[0]).toBeCloseTo(500001, 6);
    expect(g.y[1]).toBeCloseTo(4100005, 6);
    expect(g.z[1]).toBeCloseTo(16, 6);
    const b = globalBounds(g);
    expect(b.min).toEqual([500001, 4100002, 13]);
    expect(b.max).toEqual([500004, 4100005, 16]);
  });
});

describe('writeLas', () => {
  it('picks the smallest point format for the attributes present', () => {
    expect(pickPointFormat(sampleGlobal())).toBe(0);
    expect(pickPointFormat(sampleGlobal({ colors: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) }))).toBe(2);
    expect(pickPointFormat(sampleGlobal({ gpsTime: Float64Array.from([1, 2, 3]) }))).toBe(1);
    expect(
      pickPointFormat(
        sampleGlobal({ colors: new Uint8Array(9), gpsTime: Float64Array.from([1, 2, 3]) }),
      ),
    ).toBe(3);
  });

  it('writes a valid LAS 1.2 header and round-trips coordinates within the scale', () => {
    const g = sampleGlobal({
      colors: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
      intensity: Uint16Array.from([10, 20, 30]),
      classification: Uint8Array.from([2, 2, 6]),
    });
    const las = writeLas(g, { epsg: 32611, isGeographic: false });
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);

    // Signature + version.
    expect(String.fromCharCode(las[0], las[1], las[2], las[3])).toBe('LASF');
    expect(view.getUint8(24)).toBe(1);
    expect(view.getUint8(25)).toBe(2);

    // Format 2 (colour, no GPS), 26-byte records, 3 points, 1 VLR.
    expect(view.getUint8(104)).toBe(2);
    expect(view.getUint16(105, true)).toBe(26);
    expect(view.getUint32(107, true)).toBe(3);
    expect(view.getUint32(100, true)).toBe(1);

    const scaleX = view.getFloat64(131, true);
    const offX = view.getFloat64(155, true);
    const pdo = view.getUint32(96, true);

    // First point: reconstruct global X and compare within one scale step.
    const ix = view.getInt32(pdo, true);
    const reconX = offX + ix * scaleX;
    expect(reconX).toBeCloseTo(500000.123, 2);

    // Intensity + classification survive.
    expect(view.getUint16(pdo + 12, true)).toBe(10);
    expect(view.getUint8(pdo + 15) & 0x1f).toBe(2);

    // RGB scaled 8→16 bit (255 → 65535) at the format-2 colour offset.
    expect(view.getUint16(pdo + 20, true)).toBe(255 * 257);

    // CRS VLR records the EPSG (3072 ProjectedCSTypeGeoKey → 32611).
    const geoKeyData = HEADER_AND_VLR_EPSG(view);
    expect(geoKeyData).toBe(32611);
  });

  it('marks a geographic CRS with the geographic model type + finer scale', () => {
    const g = sampleGlobal();
    const las = writeLas(g, { epsg: 4326, isGeographic: true });
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    expect(view.getFloat64(131, true)).toBeCloseTo(1e-7, 12); // geographic X scale
  });

  it('omits the CRS VLR for an EPSG too large to fit a uint16 GeoKey', () => {
    const las = writeLas(sampleGlobal(), { epsg: 102100 }); // ESRI code > 65535
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    expect(view.getUint32(100, true)).toBe(0); // no VLR rather than a corrupt tag
  });

  it('tallies returns > 5 into the TOP legacy slot, matching the record clamp', () => {
    // returnNumber [1, 6, 9]: the record writer clamps high returns rather
    // than wrapping them, so the legacy 5-slot histogram must put 6 and 9 in
    // slot 5 — the old code dropped both into slot 1 (a first-return claim
    // the records contradict). Hand-computed: [1, 0, 0, 0, 2].
    const g = sampleGlobal({ returnNumber: Uint8Array.from([1, 6, 9]) });
    const las = writeLas(g);
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    const byReturn = [0, 1, 2, 3, 4].map((r) => view.getUint32(111 + r * 4, true));
    expect(byReturn).toEqual([1, 0, 0, 0, 2]);
    // A missing / zero return still clamps LOW to slot 1.
    const g0 = sampleGlobal({ returnNumber: Uint8Array.from([0, 2, 5]) });
    const las0 = writeLas(g0);
    const v0 = new DataView(las0.buffer, las0.byteOffset, las0.byteLength);
    expect([0, 1, 2, 3, 4].map((r) => v0.getUint32(111 + r * 4, true))).toEqual([1, 1, 0, 0, 1]);
  });

  it('writes header min/max from the QUANTISED values the records reconstruct', () => {
    // x = [0.0004, 1.0006] at mm scale, offset floor(min)=0: the records hold
    // round(0.0004/0.001)=0 and round(1.0006/0.001)=1001, which reconstruct to
    // 0 and 1001×0.001. The header bounds must be exactly those reconstructed
    // values — the raw doubles (0.0004 / 1.0006) describe coordinates the
    // file does not contain (strict validators flag points outside bounds).
    const g = sampleGlobal({
      x: Float64Array.from([0.0004, 1.0006, 0.5]),
      y: Float64Array.from([0, 0, 0]),
      z: Float64Array.from([0, 0, 0]),
    });
    const las = writeLas(g);
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    const maxX = view.getFloat64(179, true);
    const minX = view.getFloat64(187, true);
    expect(minX).toBe(0); // round(0.0004 / 0.001) = 0 → 0
    expect(maxX).toBe(1001 * 0.001); // bit-identical to the reconstruction
    // And the record agrees with the header exactly.
    const pdo = view.getUint32(96, true);
    const scaleX = view.getFloat64(131, true);
    const offX = view.getFloat64(155, true);
    const recon = offX + view.getInt32(pdo + 20, true) * scaleX; // 2nd point (fmt 0)
    expect(recon).toBe(maxX);
  });

  it('widens the scale so a huge extent never overflows int32', () => {
    // 6 000 km extent at 1 mm would need ~6e9 counts — past int32. The writer
    // must widen the scale and still reconstruct coordinates faithfully.
    const g = sampleGlobal({
      x: Float64Array.from([0, 6_000_000, 3_000_000]),
      y: Float64Array.from([0, 0, 0]),
      z: Float64Array.from([0, 0, 0]),
    });
    const las = writeLas(g);
    const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
    const scaleX = view.getFloat64(131, true);
    const offX = view.getFloat64(155, true);
    const pdo = view.getUint32(96, true);
    expect(scaleX).toBeGreaterThan(0.001); // widened
    const ix = view.getInt32(pdo + 26, true); // 2nd point (record 1), 26-byte fmt0? no color → 20
    // record length is 20 (fmt 0); 2nd point starts at pdo + 20.
    const ix2 = view.getInt32(pdo + 20, true);
    expect(Math.abs(ix2)).toBeLessThanOrEqual(2_147_483_647);
    expect(offX + ix2 * scaleX).toBeCloseTo(6_000_000, 0);
    void ix;
  });
});

// Pull the EPSG out of the GeoKeyDirectory VLR (last key's value offset).
function HEADER_AND_VLR_EPSG(view: DataView): number {
  const headerSize = 227;
  const geoKeyStart = headerSize + 54; // after VLR header
  // header (4 u16) + key1024 (4 u16) + key (4 u16); EPSG is the 12th u16.
  return view.getUint16(geoKeyStart + 22, true);
}

describe('writeXyz / writeAsc', () => {
  it('writes XYZ with x y z and optional r g b', () => {
    const noColor = writeXyz(sampleGlobal());
    expect(noColor.trim().split('\n')).toHaveLength(3);
    expect(noColor.split('\n')[0]).toBe('500000.123 4100000.000 12.340');

    const withColor = writeXyz(sampleGlobal({ colors: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) }));
    expect(withColor.split('\n')[0]).toBe('500000.123 4100000.000 12.340 1 2 3');
  });

  it('writes ASC with a CRS header comment and optional intensity column', () => {
    const asc = writeAsc(sampleGlobal({ intensity: Uint16Array.from([10, 20, 30]) }), { epsg: 32611 });
    const lines = asc.split('\n');
    expect(lines[0]).toMatch(/OpenLiDARViewer ASC/);
    expect(asc).toMatch(/# crs: EPSG:32611/);
    expect(asc).toMatch(/# columns: x y z intensity/);
    // first data line has 4 columns
    const firstData = lines.find((l) => !l.startsWith('#'))!;
    expect(firstData.split(' ')).toHaveLength(4);
  });

  it('honours the precision option', () => {
    const xyz = writeXyz(sampleGlobal(), 1);
    expect(xyz.split('\n')[0]).toBe('500000.1 4100000.0 12.3');
  });
});
