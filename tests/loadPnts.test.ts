/**
 * Opening a single 3D Tiles PNTS tile.
 *
 * The fixtures are generated rather than committed: a minimal PNTS is a
 * 28-byte header, a feature-table JSON section and a feature-table binary
 * section, which a few lines of DataView writes produce exactly and a binary
 * blob in the tree would only obscure.
 *
 * Coordinates are asserted, never counts alone. `PointCloud` holds recentred
 * float32 positions plus the origin they were recentred about, so every
 * assertion below adds the origin back and compares the real coordinate — the
 * only form in which a dropped `RTC_CENTER` is visible at all.
 */
import { describe, it, expect } from 'vitest';
import { loadPnts } from '../src/io/loadPnts';
import { sniffFormat } from '../src/io/sniffFormat';
import { loaderFor } from '../src/io/loaderRegistry';
import type { PointCloud } from '../src/model/PointCloud';

const PNTS_MAGIC = 0x73746e70; // 'pnts', little-endian

/** Build a PNTS tile with float32 POSITION, an optional RTC_CENTER and RGB. */
function makePnts(
  points: readonly (readonly number[])[],
  opts: { rtc?: readonly [number, number, number]; rgb?: readonly (readonly number[])[] } = {},
): ArrayBuffer {
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (opts.rtc) ft.RTC_CENTER = opts.rtc;
  const positionBytes = points.length * 3 * 4;
  if (opts.rgb) ft.RGB = { byteOffset: positionBytes };

  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' '; // sections are 8-byte aligned
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = positionBytes + (opts.rgb ? points.length * 3 : 0);
  const total = 28 + jsonBytes.length + binBytes;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true); // version
  view.setUint32(8, total, true); // byteLength
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true); // batch-table JSON
  view.setUint32(24, 0, true); // batch-table binary
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);

  const binStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  if (opts.rgb) {
    const rgb = new Uint8Array(buf, binStart + positionBytes, points.length * 3);
    let j = 0;
    for (const c of opts.rgb) for (const channel of c) rgb[j++] = channel;
  }
  return buf;
}

/** The real (un-recentred) coordinate of point `i`, as the cloud holds it. */
function pointAt(cloud: PointCloud, i: number): [number, number, number] {
  return [
    cloud.positions[i * 3] + cloud.origin[0],
    cloud.positions[i * 3 + 1] + cloud.origin[1],
    cloud.positions[i * 3 + 2] + cloud.origin[2],
  ];
}

describe('loadPnts', () => {
  it('opens a tile to its declared points at their own coordinates', async () => {
    const cloud = await loadPnts(
      makePnts([
        [1, 2, 3],
        [4, 5, 6],
        [-7, 8, -9],
      ]),
      'tile.pnts',
    );
    expect(cloud.pointCount).toBe(3);
    expect(cloud.sourceFormat).toBe('pnts');
    expect(cloud.name).toBe('tile.pnts');
    expect(pointAt(cloud, 0)).toEqual([1, 2, 3]);
    expect(pointAt(cloud, 1)).toEqual([4, 5, 6]);
    expect(pointAt(cloud, 2)).toEqual([-7, 8, -9]);
  });

  it('adds RTC_CENTER back to every position', async () => {
    // A centre far from the origin and different on each axis: a dropped
    // centre, a centre added to one axis only, and a transposed centre all
    // land somewhere these assertions can see.
    const rtc: [number, number, number] = [4194304, -1048576, 2097152];
    const cloud = await loadPnts(
      makePnts(
        [
          [1, 2, 3],
          [10, 20, 30],
        ],
        { rtc },
      ),
    );
    expect(pointAt(cloud, 0)).toEqual([rtc[0] + 1, rtc[1] + 2, rtc[2] + 3]);
    expect(pointAt(cloud, 1)).toEqual([rtc[0] + 10, rtc[1] + 20, rtc[2] + 30]);
    // The centre is applied in float64 before recentring, so it survives at
    // full precision rather than being quantised onto the float32 grid a
    // coordinate of this magnitude sits on (a step of 0.5 m at 4.2e6).
    const shifted = await loadPnts(makePnts([[0.25, 0.25, 0.25]], { rtc }));
    expect(pointAt(shifted, 0)).toEqual([rtc[0] + 0.25, rtc[1] + 0.25, rtc[2] + 0.25]);
  });

  it('carries the tile’s RGB through, filtered with the positions', async () => {
    const cloud = await loadPnts(
      makePnts(
        [
          [0, 0, 0],
          [1, 1, 1],
        ],
        {
          rgb: [
            [10, 20, 30],
            [200, 210, 220],
          ],
        },
      ),
    );
    expect([...(cloud.colors ?? [])]).toEqual([10, 20, 30, 200, 210, 220]);
  });

  it('drops a non-finite position through the shared sanitation', async () => {
    const cloud = await loadPnts(
      makePnts(
        [
          [1, 2, 3],
          [Number.NaN, 0, 0],
          [4, 5, 6],
        ],
        { rgb: [[1, 1, 1], [2, 2, 2], [3, 3, 3]] },
      ),
    );
    expect(cloud.pointCount).toBe(2);
    expect(pointAt(cloud, 0)).toEqual([1, 2, 3]);
    expect(pointAt(cloud, 1)).toEqual([4, 5, 6]);
    // The colours are filtered by the same index set, so the surviving points
    // keep their own colours rather than the dropped point's.
    expect([...(cloud.colors ?? [])]).toEqual([1, 1, 1, 3, 3, 3]);
    expect(cloud.metadata?.loadWarnings?.join(' ')).toMatch(/1/);
  });

  it('refuses a file that only borrows the .pnts name', async () => {
    const impostor = new TextEncoder().encode('This is not a tile, it is a note.').buffer;
    await expect(loadPnts(impostor, 'notes.pnts')).rejects.toThrow(/magic/);
  });

  it('refuses a truncated tile rather than reading past its sections', async () => {
    const whole = makePnts([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const truncated = whole.slice(0, whole.byteLength - 8);
    await expect(loadPnts(truncated)).rejects.toThrow(/byteLength exceeds the buffer/);
    // A header alone is short of the 28 bytes the format requires.
    await expect(loadPnts(whole.slice(0, 12))).rejects.toThrow(/shorter than the 28-byte header/);
  });
});

describe('pnts detection and registry wiring', () => {
  it('sniffs a tile by its magic bytes whatever it is named', () => {
    const buf = makePnts([[1, 2, 3]]);
    expect(sniffFormat(buf, 'tile.pnts')).toBe('pnts');
    expect(sniffFormat(buf, 'tile.bin')).toBe('pnts');
    expect(sniffFormat(buf, 'no-extension-at-all')).toBe('pnts');
  });

  it('routes the pnts format to the pnts loader', async () => {
    const cloud = await loaderFor('pnts')(makePnts([[1, 2, 3]], { rtc: [100, 200, 300] }), 'a.pnts');
    expect(cloud.sourceFormat).toBe('pnts');
    expect(pointAt(cloud, 0)).toEqual([101, 202, 303]);
  });
});
