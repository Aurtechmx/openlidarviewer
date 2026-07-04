import { describe, it, expect } from 'vitest';
import { buildResidentSnapshot } from '../src/render/streaming/residentSnapshot';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

/** A minimal decoded chunk of `n` points, values seeded from `base`. */
function chunk(n: number, base: number, opts: { rgb?: boolean; psid?: boolean } = {}): DecodedChunk {
  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const gpsTime = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = base + i;
    positions[i * 3 + 1] = base + i + 0.5;
    positions[i * 3 + 2] = base + i + 0.25;
    intensity[i] = base + i;
    classification[i] = (base + i) % 32;
    returnNumber[i] = 1;
    returnCount[i] = 1;
    gpsTime[i] = base + i;
  }
  const c: DecodedChunk = { pointCount: n, positions, intensity, classification, returnNumber, returnCount, gpsTime };
  if (opts.rgb) {
    c.rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) c.rgb[i] = (base + i) % 256;
  }
  if (opts.psid) {
    c.pointSourceId = new Uint16Array(n);
    for (let i = 0; i < n; i++) c.pointSourceId[i] = base + i;
  }
  return c;
}

const OPTS = { origin: [100, 200, 300] as [number, number, number], name: 'scan.copc', sourceFormat: 'laz' as const };

describe('buildResidentSnapshot', () => {
  it('returns null when there are no resident points', () => {
    expect(buildResidentSnapshot([], OPTS)).toBeNull();
    expect(buildResidentSnapshot([chunk(0, 0)], OPTS)).toBeNull();
  });

  it('concatenates multiple chunks in order with a correct total', () => {
    const cloud = buildResidentSnapshot([chunk(2, 0), chunk(3, 10)], OPTS)!;
    expect(cloud).not.toBeNull();
    expect(cloud.pointCount).toBe(5);
    // second chunk's first point (base 10) must follow the first chunk's 2 points
    expect(cloud.positions[2 * 3]).toBe(10);
    expect(cloud.intensity?.[2]).toBe(10);
    expect(cloud.classification?.[4]).toBe((10 + 2) % 32);
  });

  it('carries the origin through so world = local + origin', () => {
    const cloud = buildResidentSnapshot([chunk(1, 7)], OPTS)!;
    expect(cloud.origin).toEqual([100, 200, 300]);
    // local position was base+0 on x; world adds origin.x
    expect(cloud.positions[0] + cloud.origin[0]).toBe(7 + 100);
  });

  it('emits RGB / point-source id only when every chunk carries them', () => {
    const allRgb = buildResidentSnapshot([chunk(2, 0, { rgb: true }), chunk(2, 5, { rgb: true })], OPTS)!;
    expect(allRgb.colors).toBeInstanceOf(Uint8Array);
    expect(allRgb.colors?.length).toBe(4 * 3);

    const mixed = buildResidentSnapshot([chunk(2, 0, { rgb: true }), chunk(2, 5)], OPTS)!;
    expect(mixed.colors).toBeUndefined();

    const allPsid = buildResidentSnapshot([chunk(2, 0, { psid: true }), chunk(2, 5, { psid: true })], OPTS)!;
    expect(allPsid.pointSourceId).toBeInstanceOf(Uint16Array);
    const mixedPsid = buildResidentSnapshot([chunk(2, 0, { psid: true }), chunk(2, 5)], OPTS)!;
    expect(mixedPsid.pointSourceId).toBeUndefined();
  });

  it('stamps the declared count to equal the decoded count (not a lossy read)', () => {
    const cloud = buildResidentSnapshot([chunk(4, 0)], OPTS)!;
    expect(cloud.declaredPointCount).toBe(4);
    expect(cloud.decodedPointCount).toBe(4);
  });
});
