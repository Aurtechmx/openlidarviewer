/**
 * lasHeaderBoundsOrigin.test.ts — the local origin of a LAS/LAZ load comes from
 * the points when the header bounds do not enclose them.
 *
 * Every LAS path recentres records about an origin before narrowing them to
 * Float32. That origin is the floored header minimum, which is only right when
 * the header's min/max actually describe the data. A writer that leaves the
 * bounds at zero (or stale) while the records carry UTM coordinates puts the
 * origin at 0, so the Float32 positions hold full UTM values and lose
 * millimetres. These tests pin the origin to the first record in that case,
 * and pin byte-identical behaviour for files whose bounds are honest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLas, loadLazFromFile } from '../src/io/loadLas';
import { toXyz } from '../src/io/exporters';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { openSlicedLasSource } from '../src/io/heavy/slicedLasSource';
import { openSlicedLas } from '../src/io/heavy/slicedLasReader';
import { openChunkedLazSource } from '../src/io/heavy/chunkedLazSource';
import { buildPreviewSample } from '../src/io/heavy/previewSampler';
import { HEADER_BOUNDS_UNTRUSTED_WARNING, lasOriginFor } from '../src/io/lasDataOrigin';
import type { PointCloud } from '../src/model/PointCloud';

const H = 227;
const REC = 20;
const RECORDS: ReadonlyArray<readonly [number, number, number]> = [
  [123456, 876789, 210123],
  [123457, 876790, 210124],
];

/**
 * A LAS 1.2, PDRF 0 file: scale 0.001, offset (500000, 4100000, 0), two records
 * 1 mm apart on every axis. `bounds` selects honest header bounds or bounds
 * left at zero; `stale` writes non-zero bounds that miss the data.
 */
function las(bounds: 'honest' | 'zero' | 'stale'): ArrayBuffer {
  const n = RECORDS.length;
  const buf = new ArrayBuffer(H + n * REC);
  const v = new DataView(buf);
  new Uint8Array(buf).set([0x4c, 0x41, 0x53, 0x46]);
  v.setUint8(24, 1);
  v.setUint8(25, 2);
  v.setUint16(94, H, true);
  v.setUint32(96, H, true);
  v.setUint8(104, 0);
  v.setUint16(105, REC, true);
  v.setUint32(107, n, true);
  for (let a = 0; a < 3; a++) v.setFloat64(131 + a * 8, 0.001, true);
  v.setFloat64(155, 500000, true);
  v.setFloat64(163, 4100000, true);
  v.setFloat64(171, 0, true);
  if (bounds === 'honest') {
    // max x, min x, max y, min y, max z, min z
    v.setFloat64(179, 500123.457, true);
    v.setFloat64(187, 500123.456, true);
    v.setFloat64(195, 4100876.79, true);
    v.setFloat64(203, 4100876.789, true);
    v.setFloat64(211, 210.124, true);
    v.setFloat64(219, 210.123, true);
  } else if (bounds === 'stale') {
    v.setFloat64(179, 1000, true);
    v.setFloat64(187, 900, true);
    v.setFloat64(195, 2000, true);
    v.setFloat64(203, 1900, true);
    v.setFloat64(211, 10, true);
    v.setFloat64(219, 5, true);
  }
  RECORDS.forEach((p, i) => {
    v.setInt32(H + i * REC, p[0], true);
    v.setInt32(H + i * REC + 4, p[1], true);
    v.setInt32(H + i * REC + 8, p[2], true);
  });
  return buf;
}

function lazFixture(): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** The same file with its six header bound fields zeroed. */
function zeroBounds(buffer: ArrayBuffer): ArrayBuffer {
  const out = buffer.slice(0);
  new Uint8Array(out, 179, 48).fill(0);
  return out;
}

function world(cloud: PointCloud, i: number): [number, number, number] {
  return [
    cloud.positions[i * 3] + cloud.origin[0],
    cloud.positions[i * 3 + 1] + cloud.origin[1],
    cloud.positions[i * 3 + 2] + cloud.origin[2],
  ];
}

function warnings(cloud: PointCloud): readonly string[] {
  return cloud.metadata?.loadWarnings ?? [];
}

describe('LAS origin when the header bounds do not enclose the data', () => {
  it('keeps millimetre detail when the header bounds are zero', async () => {
    const cloud = await loadLas(las('zero'), 'las');
    expect(cloud.origin).toEqual([500123, 4100876, 210]);
    const a = world(cloud, 0);
    const b = world(cloud, 1);
    for (let k = 0; k < 3; k++) {
      expect(b[k] - a[k]).toBeCloseTo(0.001, 6);
    }
    expect(a[0]).toBeCloseTo(500123.456, 6);
    expect(a[1]).toBeCloseTo(4100876.789, 6);
    expect(a[2]).toBeCloseTo(210.123, 6);
    expect(warnings(cloud)).toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
    // The export carries the two distinct points, not one collapsed value.
    const lines = toXyz(cloud).trim().split('\n').filter((l) => /^-?\d/.test(l));
    expect(new Set(lines).size).toBe(2);
  });

  it('takes the origin from the points when non-zero bounds miss the data', async () => {
    const cloud = await loadLas(las('stale'), 'las');
    expect(cloud.origin).toEqual([500123, 4100876, 210]);
    expect(warnings(cloud)).toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
  });

  it('leaves a file with honest bounds exactly as before', async () => {
    const cloud = await loadLas(las('honest'), 'las');
    expect(cloud.origin).toEqual([500123, 4100876, 210]);
    expect(warnings(cloud)).not.toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
    expect(cloud.metadata?.loadWarnings).toBeUndefined();
  });

  it('decides the origin from the header and record 0 in one rule', () => {
    const header = {
      min: [0, 0, 0] as [number, number, number],
      max: [0, 0, 0] as [number, number, number],
      scale: [0.01, 0.01, 0.01] as [number, number, number],
    };
    expect(lasOriginFor(header, [500000.5, 4100000.25, 12.7])).toEqual({
      origin: [500000, 4100000, 12],
      boundsTrusted: false,
      warning: HEADER_BOUNDS_UNTRUSTED_WARNING,
    });
    // Data that really sits at zero with zero bounds is enclosed.
    expect(lasOriginFor(header, [0, 0, 0])).toEqual({ origin: [0, 0, 0], boundsTrusted: true });
    // Within one scale step of the bounds is enclosed.
    const near = { ...header, min: [10, 10, 10] as [number, number, number], max: [20, 20, 20] as [number, number, number] };
    expect(lasOriginFor(near, [20.005, 9.995, 15]).boundsTrusted).toBe(true);
    expect(lasOriginFor(near, [20.02, 15, 15]).boundsTrusted).toBe(false);
    // No record to look at: the header origin, as before.
    expect(lasOriginFor(near, null)).toEqual({ origin: [10, 10, 10], boundsTrusted: true });
  });
});

describe('LAZ origin when the header bounds do not enclose the data', () => {
  it('loadLas recovers the same world coordinates as the intact file', async () => {
    const intact = await loadLas(lazFixture(), 'laz');
    const zeroed = await loadLas(zeroBounds(lazFixture()), 'laz');
    expect(warnings(intact)).not.toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
    expect(warnings(zeroed)).toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
    expect(zeroed.origin).not.toEqual([0, 0, 0]);
    expect(zeroed.pointCount).toBe(intact.pointCount);
    let worst = 0;
    for (let i = 0; i < intact.pointCount; i += 997) {
      const a = world(intact, i);
      const b = world(zeroed, i);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
    }
    expect(worst).toBeLessThan(0.001);
  });

  it('loadLazFromFile takes the origin from the points too', async () => {
    const file = new File([zeroBounds(lazFixture())], 'zeroed.laz');
    const cloud = await loadLazFromFile(file, 'zeroed.laz');
    const reference = await loadLas(zeroBounds(lazFixture()), 'laz');
    expect(cloud.origin).toEqual(reference.origin);
    expect(warnings(cloud)).toContain(HEADER_BOUNDS_UNTRUSTED_WARNING);
  });
});

describe('heavy paths use the same origin rule', () => {
  it('sliced LAS source and reader take the origin from the points and drop the header box', async () => {
    const opened = await openSlicedLas(new ArrayBufferRangeSource(las('zero')));
    expect(opened.origin).toEqual([500123, 4100876, 210]);
    const src = await openSlicedLasSource(new ArrayBufferRangeSource(las('stale')));
    expect(src.origin).toEqual([500123, 4100876, 210]);
    expect(src.source.header).toBeUndefined();
  });

  it('sliced LAS source with honest bounds is unchanged', async () => {
    const src = await openSlicedLasSource(new ArrayBufferRangeSource(las('honest')));
    expect(src.origin).toEqual([500123, 4100876, 210]);
    expect(src.source.header).toBeDefined();
  });

  it('chunked LAZ source takes the origin from the points', async () => {
    const intact = await openChunkedLazSource(new ArrayBufferRangeSource(lazFixture()));
    const zeroed = await openChunkedLazSource(new ArrayBufferRangeSource(zeroBounds(lazFixture())));
    const reference = await loadLas(zeroBounds(lazFixture()), 'laz');
    expect(zeroed.origin).not.toEqual([0, 0, 0]);
    expect(zeroed.origin).toEqual(reference.origin);
    expect(zeroed.source.header).toBeUndefined();
    expect(intact.origin).toEqual([499999, 4099999, 191]);
    expect(intact.source.header).toBeDefined();
  });

  it('LAZ preview sample takes the origin from the points', async () => {
    const reference = await loadLas(zeroBounds(lazFixture()), 'laz');
    const sample = await buildPreviewSample(new ArrayBufferRangeSource(zeroBounds(lazFixture())), {
      format: 'laz',
      offsetToPointData: 475,
    });
    expect(sample).not.toBeNull();
    expect(sample!.origin).not.toEqual([0, 0, 0]);
    expect(sample!.origin).toEqual(reference.origin);
    // The frame is measured from the sample, not the bogus header box.
    expect(sample!.localMax[0] - sample!.localMin[0]).toBeGreaterThan(100);
    expect(sample!.localMax[1] - sample!.localMin[1]).toBeGreaterThan(100);
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(sample!.localMin[a])).toBeLessThan(5000);
      expect(Math.abs(sample!.localMax[a])).toBeLessThan(5000);
    }
  });
});
