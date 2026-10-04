/**
 * Clipping removes points; it must not change the attributes of the points it
 * keeps. A kept point is written to LAS 1.4 and read back with the project's
 * own decoder, so every byte of its record is checked against the source.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { clipCloud } from '../src/render/clip/clipCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';

function richCloud(): PointCloud {
  return new PointCloud({
    // Points 0 and 2 sit inside the box, point 1 outside it.
    positions: Float32Array.from([0, 0, 0, 50, 50, 50, 1, 1, 1]),
    colors: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]),
    intensity: Uint16Array.from([1000, 2000, 3000]),
    classification: Uint8Array.from([2, 5, 6]),
    classificationFlags: Uint8Array.from([0x1, 0x0, 0x4]),
    returnNumber: Uint8Array.from([1, 2, 3]),
    returnCount: Uint8Array.from([3, 3, 4]),
    scanAngle: Float32Array.from([12.0, -6.0, -18.0]),
    userData: Uint8Array.from([7, 8, 9]),
    scannerChannel: Uint8Array.from([2, 1, 3]),
    scanDirection: Uint8Array.from([1, 0, 1]),
    edgeOfFlightLine: Uint8Array.from([1, 0, 1]),
    pointSourceId: Uint16Array.from([11, 12, 13]),
    gpsTime: Float64Array.from([100.5, 200.5, 300.5]),
    origin: [500000, 4100000, 10],
    sourceFormat: 'las',
    name: 'rich.las',
  });
}

describe('clipCloud keeps every per-point attribute of the points it keeps', () => {
  it('filters the acquisition channels in lockstep with the positions', () => {
    const c = clipCloud(richCloud(), { box: { min: [-1, -1, -1], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true });
    expect(c.pointCount).toBe(2);
    expect(Array.from(c.scanAngle ?? [])).toEqual([12, -18]);
    expect(Array.from(c.userData ?? [])).toEqual([7, 9]);
    expect(Array.from(c.scannerChannel ?? [])).toEqual([2, 3]);
    expect(Array.from(c.scanDirection ?? [])).toEqual([1, 1]);
    expect(Array.from(c.edgeOfFlightLine ?? [])).toEqual([1, 1]);
  });

  it('a clipped LAS 1.4 export reads back with the source values', async () => {
    const c = clipCloud(richCloud(), { box: { min: [-1, -1, -1], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true });
    const { file } = convertCloud(c, { format: 'las14' });
    const bytes = file!.bytes;
    const out = await loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las', 'clip14.las', 1, undefined, true);
    expect(out.pointCount).toBe(2);
    expect(Array.from(out.scanAngle ?? [])).toEqual([12, -18]);
    expect(Array.from(out.userData ?? [])).toEqual([7, 9]);
    expect(Array.from(out.scannerChannel ?? [])).toEqual([2, 3]);
    expect(Array.from(out.scanDirection ?? [])).toEqual([1, 1]);
    expect(Array.from(out.edgeOfFlightLine ?? [])).toEqual([1, 1]);
    expect(Array.from(out.intensity ?? [])).toEqual([1000, 3000]);
    expect(Array.from(out.classification ?? [])).toEqual([2, 6]);
    expect(Array.from(out.classificationFlags ?? [])).toEqual([0x1, 0x4]);
    expect(Array.from(out.returnNumber ?? [])).toEqual([1, 3]);
    expect(Array.from(out.returnCount ?? [])).toEqual([3, 4]);
    expect(Array.from(out.pointSourceId ?? [])).toEqual([11, 13]);
    expect(Array.from(out.gpsTime ?? [])).toEqual([100.5, 300.5]);
    expect(Array.from(out.colors ?? [])).toEqual([10, 20, 30, 70, 80, 90]);
  });
});
