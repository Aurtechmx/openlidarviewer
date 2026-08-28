/**
 * pntsDecode.test.ts — decoding a point tile into a streaming chunk.
 *
 * Two things are easy to get wrong and expensive to notice later. The order in
 * which RTC_CENTER, the tile transform and the render origin are applied, which
 * silently misplaces a tile rather than failing. And the attributes a point tile
 * does not carry, which must not be offered as if they were measured.
 */

import { describe, it, expect } from 'vitest';
import {
  PntsChunkDecoder,
  isPntsMetadata,
  PNTS_COLOR_MODES,
  type PntsDecodeMetadata,
} from '../src/io/tiles3d/pntsDecode';
import { pntsDeviceDecodeLimits } from '../src/io/tiles3d/pnts';

const PNTS_MAGIC = 0x73746e70;

/** A minimal valid `.pnts` body, optionally with RTC_CENTER and RGB. */
function makePnts(
  points: readonly (readonly [number, number, number])[],
  rtc?: readonly [number, number, number],
  rgb?: readonly (readonly [number, number, number])[],
): ArrayBuffer {
  const posBytes = points.length * 3 * 4;
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (rtc) ft.RTC_CENTER = rtc;
  if (rgb) ft.RGB = { byteOffset: posBytes };
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = posBytes + (rgb ? points.length * 3 : 0);
  const total = 28 + jsonBytes.length + binBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  if (rgb) {
    const bytes = new Uint8Array(buf, binStart + posBytes, points.length * 3);
    let j = 0;
    for (const c of rgb) for (const v of c) bytes[j++] = v;
  }
  return buf;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const meta = (over: Partial<PntsDecodeMetadata> = {}): PntsDecodeMetadata => ({
  format: 'pnts',
  tileTransform: IDENTITY,
  renderOrigin: [0, 0, 0],
  ...over,
});

const decoder = new PntsChunkDecoder();

describe('placement', () => {
  it('adds RTC_CENTER before the tile transform, not after', async () => {
    // Translate by (100, 0, 0). A point at local (1,0,0) with RTC (10,0,0)
    // belongs at 111. Applying the transform first would give 101 + 10 = 111
    // too, so use a SCALING transform, where the order is visible.
    const scaleBy2 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const out = await decoder.decode(
      makePnts([[1, 0, 0]], [10, 0, 0]),
      meta({ tileTransform: scaleBy2 }),
    );
    // (1 + 10) * 2 = 22. Transform-then-RTC would give 1*2 + 10 = 12.
    expect(out.positions[0]).toBeCloseTo(22, 6);
  });

  it('subtracts the render origin last', async () => {
    const out = await decoder.decode(
      makePnts([[5, 6, 7]]),
      meta({ renderOrigin: [5, 6, 7] }),
    );
    expect([...out.positions.slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it('places a point through a translating transform', async () => {
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1];
    const out = await decoder.decode(makePnts([[1, 2, 3]]), meta({ tileTransform: translate }));
    expect([...out.positions.slice(0, 3)]).toEqual([101, 202, 303]);
  });
});

describe('transient memory', () => {
  it('allocates no second XYZ array — positions are transformed in place', async () => {
    // parsePnts already owns a fresh Float32Array of the tile's positions.
    // Transforming into a second array of the same size doubled the transient
    // XYZ footprint of every tile decode. A positions-only tile of N points must
    // see exactly ONE Float32Array of length 3N allocated across the whole
    // decode (the parser's), not two.
    const points = [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ] as const;
    const wanted = points.length * 3;
    const RealFloat32Array = Float32Array;
    let ofWantedLength = 0;
    const Spy = new Proxy(RealFloat32Array, {
      construct(target, args: [number]) {
        if (args[0] === wanted) ofWantedLength += 1;
        return Reflect.construct(target, args) as Float32Array;
      },
    });
    (globalThis as unknown as { Float32Array: typeof Float32Array }).Float32Array =
      Spy as unknown as typeof Float32Array;
    try {
      await new PntsChunkDecoder().decode(makePnts(points), meta());
    } finally {
      (globalThis as unknown as { Float32Array: typeof Float32Array }).Float32Array =
        RealFloat32Array;
    }
    expect(
      ofWantedLength,
      'the decoder allocated a second positions array instead of reusing the parsed one',
    ).toBe(1);
  });
});

describe('attributes the format does not carry', () => {
  it('never offers intensity or classification as a colour mode', () => {
    expect(
      PNTS_COLOR_MODES,
      'a point tile carries neither, so nothing may offer to paint a scan by them',
    ).not.toContain('intensity');
    expect(PNTS_COLOR_MODES).not.toContain('classification');
  });

  it('allocates no array for a channel the format does not carry', async () => {
    const out = await decoder.decode(makePnts([[0, 0, 0], [1, 1, 1]]), meta());
    expect(out.pointCount).toBe(2);
    // Absent, not zero-filled. A zero classification means "never classified"
    // and a zero intensity is not a measured zero, so the chunk must be able to
    // say the channel is missing rather than hand a reader 2 fake readings.
    expect(out.intensity, 'a point tile carries no intensity').toBeUndefined();
    expect(out.classification, 'a point tile carries no classification').toBeUndefined();
    expect(out.returnNumber, 'a point tile carries no return number').toBeUndefined();
    expect(out.returnCount, 'a point tile carries no return count').toBeUndefined();
    expect(out.gpsTime, 'a point tile carries no GPS time').toBeUndefined();
  });

  it('carries RGB through when the tile has it, and omits it when it does not', async () => {
    // A decoder instance serves ONE tileset layer and holds that layer's colour
    // meaning across the tiles it decodes (see tilesetMixedColour.test.ts), so
    // each of these two tilesets gets its own.
    const withRgb = await new PntsChunkDecoder().decode(
      makePnts([[0, 0, 0]], undefined, [[10, 20, 30]]),
      meta(),
    );
    expect([...(withRgb.rgb ?? [])]).toEqual([10, 20, 30]);
    const without = await new PntsChunkDecoder().decode(makePnts([[0, 0, 0]]), meta());
    expect(without.rgb).toBeUndefined();
  });
});

/**
 * A `.pnts` header declaring `pointsLength` points with position, colour, normal
 * and batch-id channels, and NO binary section. The decoded-byte ceiling is
 * checked before any accessor reads the (absent) binary, so a refusal that lands
 * here landed before the first big array was allocated.
 */
function makeDeclaredAllChannels(pointsLength: number): ArrayBuffer {
  const ft = JSON.stringify({
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: 0 },
    RGBA: { byteOffset: 0 },
    NORMAL: { byteOffset: 0 },
    BATCH_ID: { byteOffset: 0 },
  });
  let json = ft;
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const total = 28 + jsonBytes.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  return buf;
}

describe('device-aware decode limits', () => {
  // 5,000,000 points at 31 decoded bytes each is ~147.8 MiB: above the 96 MiB
  // mobile ceiling and below the 192 MiB desktop ceiling.
  const MID_POINTS = 5_000_000;

  it('refuses the mid-size tile when constructed with the mobile ceiling', async () => {
    const mobile = new PntsChunkDecoder({ decodeLimits: pntsDeviceDecodeLimits(true) });
    await expect(
      mobile.decode(makeDeclaredAllChannels(MID_POINTS), meta()),
    ).rejects.toThrow(/decoded byte/i);
  });

  it('admits it past the byte ceiling on desktop — a later section refusal, not a byte one', async () => {
    const desktop = new PntsChunkDecoder({ decodeLimits: pntsDeviceDecodeLimits(false) });
    await expect(
      desktop.decode(makeDeclaredAllChannels(MID_POINTS), meta()),
    ).rejects.toThrow(/section/i);
  });

  it('the old device-independent decoder (no limits) did not refuse it on decoded bytes', async () => {
    // Red-green anchor: this is the pre-fix construction. It reaches the section
    // refusal, never the decoded-byte one — the gap the mobile ceiling closes.
    await expect(
      new PntsChunkDecoder().decode(makeDeclaredAllChannels(MID_POINTS), meta()),
    ).rejects.toThrow(/section/i);
  });
});

describe('metadata routing', () => {
  it('recognises its own metadata and not LAS metadata', () => {
    expect(isPntsMetadata(meta())).toBe(true);
    expect(isPntsMetadata({ pointDataRecordFormat: 6, pointRecordLength: 30 })).toBe(false);
    expect(isPntsMetadata(null)).toBe(false);
  });

  it('refuses a body routed to it with metadata for another format', async () => {
    await expect(
      decoder.decode(makePnts([[0, 0, 0]]), { pointDataRecordFormat: 6 }),
    ).rejects.toThrow(/another format/);
  });
});
