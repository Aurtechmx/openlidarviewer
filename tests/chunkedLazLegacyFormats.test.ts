/**
 * chunkedLazLegacyFormats.test.ts: a chunked LAZ in point formats 0 to 3 (the
 * LAS 1.0 to 1.3 formats most airborne surveys still ship in) decodes chunk by
 * chunk to the values it was written with, so the out-of-core index and the
 * storage sample take it as they take formats 6 to 8.
 *
 * multichunk-pdrf3.laz: 120 000 points written by laspy 2.7.0 with lazrs at
 * point format 3, LAS 1.2, in three 50 000-point chunks. Point i sits at
 * x = 400000 + (i % 1000) * 0.5, y = 5200000 + floor(i / 1000) * 0.5,
 * z = 100 + (i % 17) * 0.25, with intensity (7i) mod 65536, class i % 5 + 1,
 * GPS time 1000 + i / 1000 and RGB (3i, 5i, 11i) mod 65536.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { parseLasHeader } from '../src/io/lasHeader';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { decodeLazChunkLocal } from '../src/io/heavy/decodeLazChunked';
import { decodeContext } from '../src/io/lasDecodeShared';
import { getLazPerf } from '../src/io/lazDecode';
import { buildPreviewSample } from '../src/io/heavy/previewSampler';

const bytes = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('chunked LAZ in point format 3', () => {
  const buffer = bytes('multichunk-pdrf3.laz');
  const header = parseLasHeader(buffer);

  it('decodes every chunk on its own to the written values', async () => {
    expect(header.pointFormat).toBe(3);
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), undefined, header.offsetToPointData);
    expect(table.supported).toBe(true);
    if (!table.supported) return;
    expect(table.chunks.length).toBe(3);
    const origin: [number, number, number] = [400000, 5200000, 0];
    const ctx = decodeContext(header, origin);
    const lazPerf = await getLazPerf();
    let checked = 0;
    for (const c of table.chunks) {
      const raw = decodeLazChunkLocal(lazPerf, {
        chunk: new Uint8Array(buffer, c.byteOffset, c.byteLength).slice(),
        pointCount: c.pointCount, firstPointIndex: c.firstPointIndex,
        pointDataRecordFormat: header.pointFormat, pointRecordLength: header.pointDataRecordLength,
        scale: header.scale, offset: header.offset, ctx,
      });
      for (let k = 0; k < c.pointCount; k++) {
        const i = c.firstPointIndex + k;
        expect(raw.positions[k * 3]! + origin[0]).toBeCloseTo(400000 + (i % 1000) * 0.5, 3);
        expect(raw.positions[k * 3 + 1]! + origin[1]).toBeCloseTo(5200000 + Math.floor(i / 1000) * 0.5, 3);
        expect(raw.positions[k * 3 + 2]! + origin[2]).toBeCloseTo(100 + (i % 17) * 0.25, 3);
        expect(raw.intensity[k]).toBe((i * 7) % 65536);
        expect(raw.classification[k]).toBe((i % 5) + 1);
        expect(raw.gpsTime![k]).toBeCloseTo(1000 + i * 0.001, 6);
        checked++;
      }
    }
    expect(checked).toBe(120_000);
  });

  it('builds a preview sample spread across the chunks', async () => {
    const sample = await buildPreviewSample(new ArrayBufferRangeSource(buffer), { format: 'laz', offsetToPointData: header.offsetToPointData }, { targetPoints: 30_000, strata: 3 });
    expect(sample).not.toBeNull();
    expect(sample!.pointCount).toBe(30_000);
    expect(sample!.schema.hasRgb).toBe(true);
    expect(sample!.schema.hasGps).toBe(true);
    // Every chunk contributes, so the sample reaches the end of the file: the
    // last record comes from the third chunk (y from 5200050 m on).
    const v = new DataView(sample!.records.buffer, sample!.records.byteOffset, sample!.records.byteLength);
    const lastY = v.getFloat32((sample!.pointCount - 1) * sample!.recordBytes + 4, true) + sample!.origin[1];
    expect(lastY).toBeGreaterThanOrEqual(5_200_050);
  });
});
