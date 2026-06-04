/**
 * convertRoundTrip.test.ts — proof the converter actually converts.
 *
 * Writes each format, then reads it back with the project's OWN loaders and
 * checks coordinates and attributes survive. If a third-party tool can read a
 * LAS file, so can our reader — so a clean round-trip here is strong evidence
 * the output is genuinely valid, not just structurally plausible.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { writeLas } from '../src/convert/writeLas';
import { writeXyz } from '../src/convert/writeAscii';
import { reprojectGlobal } from '../src/convert/reproject';
import { convertCloud } from '../src/convert/convertCloud';
import { writeAsc } from '../src/convert/writeAscii';
import { decodeFull } from '../src/convert/decodeFull';
import { loadLas } from '../src/io/loadLas';
import { loadXyz } from '../src/io/loadXyz';

// A small survey-scale cloud with every attribute populated.
function sampleCloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([
      0.123, 0.0, 12.34,
      10.5, 20.25, 13.0,
      30.0, 40.0, 14.5,
    ]),
    origin: [500000, 4100000, 0],
    colors: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
    intensity: Uint16Array.from([100, 200, 300]),
    classification: Uint8Array.from([2, 2, 6]),
    sourceFormat: 'las',
    name: 'rt.las',
  });
}

const globalOf = (c: PointCloud, i: number): [number, number, number] => [
  c.positions[i * 3] + c.origin[0],
  c.positions[i * 3 + 1] + c.origin[1],
  c.positions[i * 3 + 2] + c.origin[2],
];

describe('LAS round-trip (write → read back with loadLas)', () => {
  it('recovers coordinates and attributes within the storage scale', async () => {
    const src = sampleCloud();
    const g = cloudToGlobal(src);
    const bytes = writeLas(g, { epsg: 32611 });

    const out = await loadLas(bytes.buffer as ArrayBuffer, 'las', 'rt.las');
    expect(out.pointCount).toBe(3);

    for (let i = 0; i < 3; i++) {
      const a = globalOf(src, i);
      const b = globalOf(out, i);
      expect(b[0]).toBeCloseTo(a[0], 2); // ≤ 1 cm
      expect(b[1]).toBeCloseTo(a[1], 2);
      expect(b[2]).toBeCloseTo(a[2], 2);
    }
    // Intensity survives exactly.
    expect(Array.from(out.intensity ?? [])).toEqual([100, 200, 300]);
    // Classification survives exactly.
    expect(Array.from(out.classification ?? [])).toEqual([2, 2, 6]);

    // Colour now round-trips through loadLas (the reader decodes LAS RGB):
    // 16-bit channels narrow back to the original 8-bit values.
    const c = out.colors;
    expect(c).toBeDefined();
    expect(Array.from(c!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    // And the file is point format 2 (carries RGB) at the byte level.
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(104)).toBe(2);
  });
});

describe('XYZ round-trip (write → read back with loadXyz)', () => {
  it('recovers coordinates (and colour) from the text output', async () => {
    const src = sampleCloud();
    const g = cloudToGlobal(src);
    const text = writeXyz(g, 3);
    const bytes = new TextEncoder().encode(text);

    const out = await loadXyz(bytes.buffer as ArrayBuffer, 'rt.xyz');
    expect(out.pointCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      const a = globalOf(src, i);
      const b = globalOf(out, i);
      expect(b[0]).toBeCloseTo(a[0], 2);
      expect(b[1]).toBeCloseTo(a[1], 2);
      expect(b[2]).toBeCloseTo(a[2], 2);
    }
  });
});

describe('ASC input/output works through the real decode path', () => {
  it('writeAsc → decodeFull (sniffs .asc → xyz loader) recovers coordinates', async () => {
    const src = sampleCloud();
    const g = cloudToGlobal(src);
    const text = writeAsc(g, { precision: 3, epsg: 32611 });
    const bytes = new TextEncoder().encode(text);

    // decodeFull sniffs the filename: `.asc` must route to the ASCII loader,
    // skip the "# crs / # columns" header, and read x y z.
    const out = await decodeFull(bytes.buffer as ArrayBuffer, 'cloud.asc');
    expect(out.pointCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      const a = globalOf(src, i);
      const b = globalOf(out, i);
      expect(b[0]).toBeCloseTo(a[0], 2);
      expect(b[1]).toBeCloseTo(a[1], 2);
      expect(b[2]).toBeCloseTo(a[2], 2);
    }
  });

  it('a .txt ASCII point list also decodes', async () => {
    const bytes = new TextEncoder().encode('500000.5 4100000.25 10.0\n500001.5 4100001.5 11.0\n');
    const out = await decodeFull(bytes.buffer as ArrayBuffer, 'points.txt');
    expect(out.pointCount).toBe(2);
  });
});

describe('reprojection is invertible (UTM → WGS84 → UTM)', () => {
  it('returns to the original coordinates within a millimetre', () => {
    const g = cloudToGlobal(sampleCloud());
    const toGeo = reprojectGlobal(g, 32611, 4326);
    expect(toGeo.transformed).toBe(true);
    const back = reprojectGlobal(toGeo.points, 4326, 32611);
    expect(back.transformed).toBe(true);
    for (let i = 0; i < g.count; i++) {
      expect(back.points.x[i]).toBeCloseTo(g.x[i], 3); // ≤ 1 mm
      expect(back.points.y[i]).toBeCloseTo(g.y[i], 3);
    }
  });
});

describe('end-to-end convertCloud → LAS reads back correctly', () => {
  it('a LAS produced by the full orchestrator is valid and complete', async () => {
    const src = sampleCloud();
    const { file, report } = convertCloud(src, { format: 'las', crsMode: 'keep' });
    expect(report.ok).toBe(true);
    const out = await loadLas(file!.bytes.buffer as ArrayBuffer, 'las', file!.filename);
    expect(out.pointCount).toBe(3);
    expect(globalOf(out, 2)[0]).toBeCloseTo(globalOf(src, 2)[0], 2);
  });
});
