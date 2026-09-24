/**
 * Scan angle, user data, scanner channel, scan direction and edge-of-flight-line
 * survive a write → decode round trip through both LAS writers.
 */
import { describe, it, expect } from 'vitest';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { loadLas } from '../src/io/loadLas';

function base(over: Partial<GlobalPoints> = {}): GlobalPoints {
  return {
    count: 4,
    x: Float64Array.from([500000, 500001, 500002, 500003]),
    y: Float64Array.from([4100000, 4100001, 4100002, 4100003]),
    z: Float64Array.from([10, 11, 12, 13]),
    ...over,
  };
}

const read = (las: Uint8Array, name: string) =>
  loadLas(las.buffer as ArrayBuffer, 'las', name, 1, undefined, true);

describe('LAS acquisition fields round trip', () => {
  it('extended format (6): all five fields come back exactly', async () => {
    // Raw int16 values chosen so the decoded float32 degrees are what we write.
    const raws = [-15000, -1, 0, 30000];
    const g0 = base({
      scanAngle: Float32Array.from(raws.map((r) => r * 0.006)),
      userData: Uint8Array.from([0, 1, 127, 255]),
      scannerChannel: Uint8Array.from([0, 1, 2, 3]),
      scanDirection: Uint8Array.from([1, 0, 1, 0]),
      edgeOfFlightLine: Uint8Array.from([0, 1, 1, 0]),
      classificationFlags: Uint8Array.from([0xf, 0, 0x5, 0x8]),
    });
    const a = await read(writeLas14(g0), 'a.las');
    expect(Array.from(a.userData!)).toEqual([0, 1, 127, 255]);
    expect(Array.from(a.scannerChannel!)).toEqual([0, 1, 2, 3]);
    expect(Array.from(a.scanDirection!)).toEqual([1, 0, 1, 0]);
    expect(Array.from(a.edgeOfFlightLine!)).toEqual([0, 1, 1, 0]);
    expect(Array.from(a.classificationFlags!)).toEqual([0xf, 0, 0x5, 0x8]);
    expect(Array.from(a.scanAngle!)).toEqual(Array.from(g0.scanAngle!));
    // decode → write → decode is byte-stable on the fields.
    const b = await read(
      writeLas14(base({
        scanAngle: a.scanAngle, userData: a.userData, scannerChannel: a.scannerChannel,
        scanDirection: a.scanDirection, edgeOfFlightLine: a.edgeOfFlightLine,
      })),
      'b.las',
    );
    expect(Array.from(b.scanAngle!)).toEqual(Array.from(a.scanAngle!));
  });

  it('legacy format (0): whole-degree rank, clamped, plus direction/edge bits and user data', async () => {
    const g = base({
      scanAngle: Float32Array.from([-12.4, 45.6, -120, 90]),
      userData: Uint8Array.from([9, 0, 200, 255]),
      scanDirection: Uint8Array.from([0, 1, 1, 0]),
      edgeOfFlightLine: Uint8Array.from([1, 0, 1, 0]),
      returnNumber: Uint8Array.from([1, 2, 3, 7]),
      returnCount: Uint8Array.from([1, 3, 3, 7]),
    });
    const out = await read(writeLas(g), 'l.las');
    expect(Array.from(out.scanAngle!)).toEqual([-12, 46, -90, 90]);
    expect(Array.from(out.userData!)).toEqual([9, 0, 200, 255]);
    expect(Array.from(out.scanDirection!)).toEqual([0, 1, 1, 0]);
    expect(Array.from(out.edgeOfFlightLine!)).toEqual([1, 0, 1, 0]);
    // The direction/edge bits share the return byte without disturbing it.
    expect(Array.from(out.returnNumber!)).toEqual([1, 2, 3, 7]);
    expect(Array.from(out.returnCount!)).toEqual([1, 3, 3, 7]);
  });

  it('absent fields still write 0 in both layouts', async () => {
    for (const las of [writeLas(base()), writeLas14(base())]) {
      const out = await read(las, 'z.las');
      expect(Array.from(out.scanAngle!)).toEqual([0, 0, 0, 0]);
      expect(Array.from(out.userData!)).toEqual([0, 0, 0, 0]);
      expect(Array.from(out.scanDirection!)).toEqual([0, 0, 0, 0]);
      expect(Array.from(out.edgeOfFlightLine!)).toEqual([0, 0, 0, 0]);
      if (out.scannerChannel) expect(Array.from(out.scannerChannel)).toEqual([0, 0, 0, 0]);
    }
  });
});
