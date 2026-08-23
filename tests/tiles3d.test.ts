import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { parsePnts } from '../src/io/tiles3d/pnts';

describe('parseTileset', () => {
  const base = {
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      refine: 'ADD',
      geometricError: 50,
      boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
      content: { uri: 'root.pnts' },
      children: [
        { geometricError: 10, boundingVolume: { sphere: [0, 0, 0, 5] }, content: { uri: 'a.pnts' } },
      ],
    },
  };

  it('parses an explicit hierarchy and inherits refine to children', () => {
    const t = parseTileset(JSON.stringify(base));
    expect(t.assetVersion).toBe('1.1');
    expect(t.root.refine).toBe('ADD');
    expect(t.root.contentUri).toBe('root.pnts');
    expect(t.root.children).toHaveLength(1);
    expect(t.root.children[0].refine).toBe('ADD'); // inherited
    expect(t.root.children[0].boundingVolume.sphere).toEqual([0, 0, 0, 5]);
  });

  it('accepts a pre-parsed object and the url content alias', () => {
    const t = parseTileset({ ...base, root: { ...base.root, content: { url: 'root.pnts' } } } as object);
    expect(t.root.contentUri).toBe('root.pnts');
  });

  it('refuses implicit tiling and a missing root refine', () => {
    expect(() => parseTileset({ ...base, root: { ...base.root, implicitTiling: {} } } as object)).toThrow(/implicit/);
    expect(() => parseTileset({ ...base, root: { ...base.root, refine: undefined } } as object)).toThrow(/refine/);
    expect(() => parseTileset({ geometricError: 1, root: base.root } as object)).toThrow(/asset\.version/);
  });
});

/** Build a minimal PNTS tile with float32 POSITION and an RTC_CENTER. */
function makePnts(points: number[][], rtc?: [number, number, number]): ArrayBuffer {
  const ft: Record<string, unknown> = { POINTS_LENGTH: points.length, POSITION: { byteOffset: 0 } };
  if (rtc) ft.RTC_CENTER = rtc;
  let ftJson = JSON.stringify(ft);
  while (ftJson.length % 8 !== 0) ftJson += ' '; // pad to 8-byte boundary
  const ftJsonBytes = new TextEncoder().encode(ftJson);
  const ftBinBytes = points.length * 3 * 4;
  const total = 28 + ftJsonBytes.length + ftBinBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true); // 'pnts'
  view.setUint32(4, 1, true); // version
  view.setUint32(8, total, true); // byteLength
  view.setUint32(12, ftJsonBytes.length, true);
  view.setUint32(16, ftBinBytes, true);
  view.setUint32(20, 0, true); // batch table json
  view.setUint32(24, 0, true); // batch table binary
  new Uint8Array(buf, 28, ftJsonBytes.length).set(ftJsonBytes);
  const binStart = 28 + ftJsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  return buf;
}

/** Build a PNTS whose feature table is exactly `ft` (with an empty FT binary). */
function makeFeatureTablePnts(ft: Record<string, unknown>): ArrayBuffer {
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const total = 28 + jsonBytes.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  return buf;
}

describe('parsePnts', () => {
  it('decodes header, POINTS_LENGTH, RTC_CENTER, and float32 positions', () => {
    const buf = makePnts([[1, 2, 3], [4, 5, 6]], [1000, 2000, 3000]);
    const t = parsePnts(buf);
    expect(t.version).toBe(1);
    expect(t.pointsLength).toBe(2);
    expect(t.rtcCenter).toEqual([1000, 2000, 3000]);
    expect([...t.positions]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a bad magic', () => {
    const bad = new ArrayBuffer(28);
    new DataView(bad).setUint32(0, 0x12345678, true);
    expect(() => parsePnts(bad)).toThrow(/magic/);
  });

  it('refuses a feature table with no position array at all', () => {
    expect(() => parsePnts(makeFeatureTablePnts({ POINTS_LENGTH: 1 }))).toThrow(
      /neither POSITION nor POSITION_QUANTIZED/,
    );
  });
});

/**
 * Build a PNTS whose feature-table binary holds the arrays given, in order:
 * float32 POSITION first, then uint16 POSITION_QUANTIZED. Both may be present,
 * which is the case that pins the format's precedence rule.
 */
function makePositionPnts(opts: {
  position?: number[][];
  quantized?: number[][];
  volumeOffset?: number[];
  volumeScale?: number[];
}): ArrayBuffer {
  const pointsLength = (opts.position ?? opts.quantized ?? []).length;
  const ft: Record<string, unknown> = { POINTS_LENGTH: pointsLength };
  let binBytes = 0;
  let positionAt = 0;
  let quantizedAt = 0;
  if (opts.position) {
    positionAt = binBytes;
    ft.POSITION = { byteOffset: positionAt };
    binBytes += pointsLength * 3 * 4;
  }
  if (opts.quantized) {
    quantizedAt = binBytes;
    ft.POSITION_QUANTIZED = { byteOffset: quantizedAt };
    binBytes += pointsLength * 3 * 2;
  }
  if (opts.volumeOffset) ft.QUANTIZED_VOLUME_OFFSET = opts.volumeOffset;
  if (opts.volumeScale) ft.QUANTIZED_VOLUME_SCALE = opts.volumeScale;
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const total = 28 + jsonBytes.length + binBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  if (opts.position) {
    let k = 0;
    for (const p of opts.position) for (const c of p) view.setFloat32(binStart + positionAt + k++ * 4, c, true);
  }
  if (opts.quantized) {
    let k = 0;
    for (const p of opts.quantized) for (const c of p) view.setUint16(binStart + quantizedAt + k++ * 2, c, true);
  }
  return buf;
}

describe('parsePnts quantised positions', () => {
  it('dequantises against the volume with 65535 as full scale', () => {
    // Scale equal to full scale makes the expected value the code itself, so a
    // divisor of 65536 shows up as 32767.5 and 65534 instead of 32768 and 65535.
    const t = parsePnts(
      makePositionPnts({
        quantized: [
          [0, 32768, 65535],
          [65535, 0, 1],
        ],
        volumeOffset: [0, 0, 0],
        volumeScale: [65535, 65535, 65535],
      }),
    );
    expect(t.pointsLength).toBe(2);
    expect([...t.positions]).toEqual([0, 32768, 65535, 65535, 0, 1]);
  });

  it('applies a per-axis scale and offset', () => {
    const t = parsePnts(
      makePositionPnts({
        quantized: [[0, 65535, 32768]],
        volumeOffset: [10, 20, 30],
        volumeScale: [65535, 131070, 65535],
      }),
    );
    // 0/full + 10; 65535 * 2 full-scale steps + 20; half of full scale + 30.
    expect([...t.positions]).toEqual([10, 131090, 32798]);
  });

  it('keeps the scaled code in Float64 until the volume offset is added', () => {
    // A 1 km volume sitting 1000 km from the origin. Each code below is a value
    // whose float32-rounded intermediate lands on the other side of a float32
    // step once the offset is added, so narrowing before the addition rounds
    // twice and moves the point.
    const t = parsePnts(
      makePositionPnts({
        quantized: [[49909, 54947, 63016]],
        volumeOffset: [1_000_000, 1_000_000, 1_000_000],
        volumeScale: [100, 100, 100],
      }),
    );
    expect([...t.positions]).toEqual([1000076.1875, 1000083.8125, 1000096.1875]);
    // What the same tile would decode to if the intermediate were narrowed:
    expect([...t.positions]).not.toEqual([1000076.125, 1000083.875, 1000096.125]);
  });

  it('prefers POSITION when a tile carries both encodings', () => {
    // The quantised array would place this point at 1001, 1001, 1001.
    const t = parsePnts(
      makePositionPnts({
        position: [[1, 2, 3]],
        quantized: [[65535, 65535, 65535]],
        volumeOffset: [1000, 1000, 1000],
        volumeScale: [1, 1, 1],
      }),
    );
    expect([...t.positions]).toEqual([1, 2, 3]);
  });

  it('refuses a quantised array with no volume to interpret it', () => {
    const noVolume = makePositionPnts({ quantized: [[1, 2, 3]] });
    expect(() => parsePnts(noVolume)).toThrow(/POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET/);
    const noScale = makePositionPnts({ quantized: [[1, 2, 3]], volumeOffset: [0, 0, 0] });
    expect(() => parsePnts(noScale)).toThrow(/POSITION_QUANTIZED requires QUANTIZED_VOLUME_SCALE/);
    const noOffset = makePositionPnts({ quantized: [[1, 2, 3]], volumeScale: [1, 1, 1] });
    expect(() => parsePnts(noOffset)).toThrow(/POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET/);
  });
});
