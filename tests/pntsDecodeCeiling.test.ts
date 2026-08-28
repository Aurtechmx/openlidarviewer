import { describe, expect, it } from 'vitest';

import {
  MAX_PNTS_DECODED_BYTES,
  MAX_PNTS_DECODED_BYTES_MOBILE,
  MAX_PNTS_TILE_POINTS,
  parsePnts,
  pntsDeviceDecodeLimits,
} from '../src/io/tiles3d/pnts';

/**
 * A PNTS tile declaring more points than the decoder is willing to allocate for.
 *
 * The transport caps a tile body at 128 MiB, which bounds the DOWNLOAD and not the
 * decode. POSITION_QUANTIZED costs six bytes a point on the wire, so that cap admits
 * about 22.4 million points, and each one is expanded into a Float32 position plus the
 * intensity, classification, return and GPS channels the generic chunk contract carries.
 * The scheduler reserves against this ceiling before the fetch rather than the real
 * figure, so this refusal is the last line: it has to happen on POINTS_LENGTH, before the
 * first array is allocated, for a body declaring more than the ceiling allows.
 */
function pntsWithDeclaredPoints(pointsLength: number): ArrayBuffer {
  const featureTable = JSON.stringify({
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: 0 },
  });
  // Pad the JSON to a 4-byte boundary, as the spec requires.
  const padded = featureTable.padEnd(Math.ceil(featureTable.length / 4) * 4, ' ');
  const jsonBytes = new TextEncoder().encode(padded);
  const HEADER = 28;
  // No binary section: the refusal must land before any accessor reads one.
  const buffer = new ArrayBuffer(HEADER + jsonBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x73746e70, true); // "pnts"
  view.setUint32(4, 1, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buffer, HEADER).set(jsonBytes);
  return buffer;
}

/**
 * Count the large (>4096-element) `Float32Array` / `Uint8Array` allocations that
 * `run` triggers. The decoder resolves both constructors through the global at
 * call time, so swapping the bindings here observes any allocation it attempts;
 * a refusal that fires before the allocation seam leaves the count at zero.
 */
function countBigAllocations(run: () => void): number {
  const RealF32 = globalThis.Float32Array;
  const RealU8 = globalThis.Uint8Array;
  let bigAlloc = 0;
  const note = (n: unknown): void => {
    if (typeof n === 'number' && n > 4096) bigAlloc++;
  };
  class F32 extends RealF32 {
    constructor(...args: unknown[]) {
      note(args[0]);
      // @ts-expect-error forward whatever the decoder passed
      super(...args);
    }
  }
  class U8 extends RealU8 {
    constructor(...args: unknown[]) {
      note(args[0]);
      // @ts-expect-error forward whatever the decoder passed
      super(...args);
    }
  }
  (globalThis as { Float32Array: unknown }).Float32Array = F32;
  (globalThis as { Uint8Array: unknown }).Uint8Array = U8;
  try {
    run();
  } finally {
    (globalThis as { Float32Array: unknown }).Float32Array = RealF32;
    (globalThis as { Uint8Array: unknown }).Uint8Array = RealU8;
  }
  return bigAlloc;
}


describe('PNTS decoded-point ceiling', () => {
  it('refuses a tile declaring more points than the ceiling', () => {
    const tile = pntsWithDeclaredPoints(MAX_PNTS_TILE_POINTS + 1);
    expect(() => parsePnts(tile)).toThrow(/POINTS_LENGTH/);
  });

  it('names the ceiling and the declared figure so the refusal is actionable', () => {
    const tile = pntsWithDeclaredPoints(22_369_621);
    expect(() => parsePnts(tile)).toThrow(/22369621/);
    expect(() => parsePnts(tile)).toThrow(new RegExp(String(MAX_PNTS_TILE_POINTS)));
  });

  it('refuses before allocating, so an absurd declaration costs no memory', () => {
    // UINT32_MAX points would be ~100 GiB of channels if it reached the allocator.
    const tile = pntsWithDeclaredPoints(4_294_967_295);
    expect(() => parsePnts(tile)).toThrow(/POINTS_LENGTH/);
  });

  it('lets a caller lower the ceiling for a constrained device', () => {
    const tile = pntsWithDeclaredPoints(1_000);
    expect(() => parsePnts(tile, { maxPoints: 999 })).toThrow(/POINTS_LENGTH/);
  });

  it('accepts a tile at exactly the ceiling rather than off by one', () => {
    // Reaching the position accessor proves the ceiling passed; the truncated
    // buffer then fails on the section bounds, which is a different refusal.
    const tile = pntsWithDeclaredPoints(MAX_PNTS_TILE_POINTS);
    expect(() => parsePnts(tile)).toThrow(/past the feature-table binary section/);
  });
});

/** A feature table declaring positions, colour, normals and batch ids: the
 * heaviest channel set this decoder allocates, 31 decoded bytes a point. No
 * binary section, so any refusal that lands here landed before an accessor was
 * read or an array was allocated. */
function pntsAllChannels(pointsLength: number): ArrayBuffer {
  const ft = JSON.stringify({
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: 0 },
    RGBA: { byteOffset: 0 },
    NORMAL: { byteOffset: 0 },
    BATCH_ID: { byteOffset: 0 },
  });
  const padded = ft.padEnd(Math.ceil(ft.length / 4) * 4, ' ');
  const jsonBytes = new TextEncoder().encode(padded);
  const buffer = new ArrayBuffer(28 + jsonBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buffer, 28).set(jsonBytes);
  return buffer;
}

describe('PNTS decoded-byte ceiling', () => {
  it('exposes a decoded-byte budget below the point ceiling at full width', () => {
    // The point ceiling alone cannot bind on decoded size: at 31 bytes a point
    // an 8,000,000-point tile is ~248 MB, so the byte budget has to sit below
    // that or it never refuses a legal-count tile the device cannot hold.
    expect(MAX_PNTS_DECODED_BYTES).toBeLessThan(MAX_PNTS_TILE_POINTS * 31);
  });

  it('refuses a channel-heavy tile over the byte budget yet under the point ceiling', () => {
    // 7,000,000 points is under the 8,000,000 point ceiling, but at 31 decoded
    // bytes a point it is ~217 MB, past the budget. The scheduler admitted it on
    // a typical estimate; this is where a genuinely huge node is stopped.
    const tile = pntsAllChannels(7_000_000);
    expect(7_000_000).toBeLessThan(MAX_PNTS_TILE_POINTS);
    expect(7_000_000 * 31).toBeGreaterThan(MAX_PNTS_DECODED_BYTES);
    expect(() => parsePnts(tile)).toThrow(/decoded byte/i);
  });

  it('refuses before allocating: the big typed arrays are never constructed', () => {
    const tile = pntsAllChannels(7_000_000);
    const bigAlloc = countBigAllocations(() => {
      expect(() => parsePnts(tile)).toThrow(/decoded byte/i);
    });
    expect(bigAlloc).toBe(0);
  });

  it('lets a caller lower the byte budget for a constrained device', () => {
    // A tile well under the default budget is refused once the caller tightens
    // it, the same lever `maxPoints` gives for the count ceiling.
    const tile = pntsAllChannels(1_000);
    expect(() => parsePnts(tile, { maxDecodedBytes: 1_000 })).toThrow(/decoded byte/i);
  });
});

describe('device-aware PNTS decode ceiling', () => {
  // 5,000,000 points at 31 decoded bytes each is ~147.8 MiB: above the 96 MiB
  // mobile ceiling, below the 192 MiB desktop ceiling, and under the 8,000,000
  // point count ceiling. So it is a single legal tile that mobile must refuse on
  // its decoded size and desktop must admit — the exact case the scheduler's
  // ASSUMED_TILE_POINTS estimate cannot catch before the body is fetched.
  const MID_POINTS = 5_000_000;

  it('sizes the mobile ceiling below desktop and derives a matching point cap', () => {
    const mobile = pntsDeviceDecodeLimits(true);
    const desktop = pntsDeviceDecodeLimits(false);
    expect(mobile.maxDecodedBytes).toBe(MAX_PNTS_DECODED_BYTES_MOBILE);
    expect(desktop.maxDecodedBytes).toBe(MAX_PNTS_DECODED_BYTES);
    expect(mobile.maxDecodedBytes).toBeLessThan(desktop.maxDecodedBytes);
    // The point cap is derived from the byte ceiling and clamped to the desktop
    // count ceiling, so it never exceeds it.
    expect(mobile.maxPoints).toBeLessThanOrEqual(MAX_PNTS_TILE_POINTS);
    expect(desktop.maxPoints).toBeLessThanOrEqual(MAX_PNTS_TILE_POINTS);
  });

  it('confirms the mid-size tile straddles the two ceilings', () => {
    expect(MID_POINTS * 31).toBeGreaterThan(MAX_PNTS_DECODED_BYTES_MOBILE);
    expect(MID_POINTS * 31).toBeLessThan(MAX_PNTS_DECODED_BYTES);
    expect(MID_POINTS).toBeLessThan(MAX_PNTS_TILE_POINTS);
  });

  it('refuses the tile on the mobile ceiling before the big allocation', () => {
    const tile = pntsAllChannels(MID_POINTS);
    const bigAlloc = countBigAllocations(() => {
      expect(() => parsePnts(tile, pntsDeviceDecodeLimits(true))).toThrow(
        /decoded byte/i,
      );
    });
    // The allocation seam is never reached: mobile refuses on the true size.
    expect(bigAlloc).toBe(0);
  });

  it('admits the same tile on desktop — the refusal is device-specific', () => {
    // Desktop limits do NOT throw on the decoded-byte ceiling. The tile has no
    // binary section, so it reaches the position accessor and then fails on the
    // section bounds, which is a DIFFERENT refusal — proof the byte ceiling
    // passed.
    const tile = pntsAllChannels(MID_POINTS);
    expect(() => parsePnts(tile, pntsDeviceDecodeLimits(false))).not.toThrow(
      /decoded byte/i,
    );
    expect(() => parsePnts(tile, pntsDeviceDecodeLimits(false))).toThrow(
      /section/i,
    );
  });

  it('the mobile refusal did not hold under the old device-independent default', () => {
    // Red-green anchor: the pre-fix decoder called parsePnts with no limits, so
    // this tile sailed through the 192 MiB default. Reproduce that here and show
    // it does NOT refuse on decoded bytes — which is exactly the gap the mobile
    // ceiling closes.
    const tile = pntsAllChannels(MID_POINTS);
    expect(() => parsePnts(tile)).not.toThrow(/decoded byte/i);
  });
});

describe('CONSTANT_RGBA amplification', () => {
  /**
   * CONSTANT_RGBA lives in the feature-table JSON, not the binary, so unlike
   * RGBA, RGB and RGB565 it has no backing bytes for `arrayStart` to bound it
   * against. Colours are resolved before the positions branch, so a tile of a
   * few hundred bytes reached `new Uint8Array(pointsLength * 3)` before any
   * accessor was range-checked. At a uint32 POINTS_LENGTH that is a 12.9 GB
   * allocation from a file that fits in a packet.
   */
  it('refuses a tiny tile that declares a huge constant-coloured cloud', () => {
    const ft = JSON.stringify({
      POINTS_LENGTH: 4_294_967_295,
      CONSTANT_RGBA: [255, 0, 0, 255],
      POSITION: { byteOffset: 0 },
    });
    const padded = ft.padEnd(Math.ceil(ft.length / 4) * 4, ' ');
    const jsonBytes = new TextEncoder().encode(padded);
    const buffer = new ArrayBuffer(28 + jsonBytes.length);
    const view = new DataView(buffer);
    view.setUint32(0, 0x73746e70, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, buffer.byteLength, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, 0, true);
    new Uint8Array(buffer, 28).set(jsonBytes);

    expect(buffer.byteLength).toBeLessThan(300);
    expect(() => parsePnts(buffer)).toThrow(/exceeds the 8000000 point ceiling/);
  });
});
