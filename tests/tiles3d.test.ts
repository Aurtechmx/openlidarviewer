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

/**
 * Build a PNTS tile whose feature-table binary holds a zeroed float32 POSITION
 * followed by whichever colour and normal arrays were asked for, in that order.
 * Several encodings can be present at once, which is what pins the format's
 * precedence rules; `CONSTANT_RGBA` is written into the feature-table JSON
 * verbatim, because that is where the format keeps it.
 */
function makeAttributePnts(opts: {
  pointsLength?: number;
  rgba?: number[][];
  rgb?: number[][];
  rgb565?: number[];
  constantRgba?: unknown;
  normal?: number[][];
  normalOct16p?: number[][];
}): ArrayBuffer {
  const pointsLength = opts.pointsLength ?? 1;
  const ft: Record<string, unknown> = { POINTS_LENGTH: pointsLength, POSITION: { byteOffset: 0 } };
  let binBytes = pointsLength * 3 * 4;
  const claim = (key: string, bytes: number): number => {
    const at = binBytes;
    ft[key] = { byteOffset: at };
    binBytes += bytes;
    return at;
  };
  const rgbaAt = opts.rgba ? claim('RGBA', pointsLength * 4) : 0;
  const rgbAt = opts.rgb ? claim('RGB', pointsLength * 3) : 0;
  const rgb565At = opts.rgb565 ? claim('RGB565', pointsLength * 2) : 0;
  const normalAt = opts.normal ? claim('NORMAL', pointsLength * 3 * 4) : 0;
  const octAt = opts.normalOct16p ? claim('NORMAL_OCT16P', pointsLength * 2) : 0;
  if (opts.constantRgba !== undefined) ft.CONSTANT_RGBA = opts.constantRgba;

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

  const bin = new Uint8Array(buf, 28 + jsonBytes.length, binBytes);
  const binStart = 28 + jsonBytes.length;
  if (opts.rgba) opts.rgba.forEach((c, i) => bin.set(c, rgbaAt + i * 4));
  if (opts.rgb) opts.rgb.forEach((c, i) => bin.set(c, rgbAt + i * 3));
  if (opts.rgb565) opts.rgb565.forEach((w, i) => view.setUint16(binStart + rgb565At + i * 2, w, true));
  if (opts.normal) {
    let k = 0;
    for (const n of opts.normal) for (const c of n) view.setFloat32(binStart + normalAt + k++ * 4, c, true);
  }
  if (opts.normalOct16p) opts.normalOct16p.forEach((p, i) => bin.set(p, octAt + i * 2));
  return buf;
}

/** Pack a 5/6/5 word the way a writer would, from the raw field values. */
const rgb565Word = (r5: number, g6: number, b5: number) => (r5 << 11) | (g6 << 5) | b5;

describe('parsePnts colours', () => {
  it('reports no colour when the tile carries none', () => {
    expect(parsePnts(makeAttributePnts({})).colors).toBeNull();
  });

  it('decodes RGBA, keeping the three channels the colour buffer holds', () => {
    const t = parsePnts(
      makeAttributePnts({ pointsLength: 2, rgba: [[10, 20, 30, 255], [200, 100, 50, 0]] }),
    );
    // The alpha byte has no destination in a three-channel buffer, and a zero
    // alpha does not blank the colour it accompanied.
    expect([...(t.colors as Uint8Array)]).toEqual([10, 20, 30, 200, 100, 50]);
  });

  it('decodes RGB', () => {
    const t = parsePnts(makeAttributePnts({ pointsLength: 2, rgb: [[1, 2, 3], [253, 254, 255]] }));
    expect([...(t.colors as Uint8Array)]).toEqual([1, 2, 3, 253, 254, 255]);
  });

  it('decodes CONSTANT_RGBA onto every point', () => {
    const t = parsePnts(makeAttributePnts({ pointsLength: 3, constantRgba: [70, 80, 90, 255] }));
    expect([...(t.colors as Uint8Array)]).toEqual([70, 80, 90, 70, 80, 90, 70, 80, 90]);
  });

  it('leaves PNTS colour at the 8-bit values the tile wrote', () => {
    // PNTS channels are bytes. LAS carries 16-bit RGB and this viewer narrows
    // it on the way in; applying any of that here would divide these values by
    // 257 or shift them to zero.
    const t = parsePnts(makeAttributePnts({ rgb: [[255, 128, 1]] }));
    expect([...(t.colors as Uint8Array)]).toEqual([255, 128, 1]);
  });

  it('expands each RGB565 field across the full 8-bit range', () => {
    const t = parsePnts(
      makeAttributePnts({
        pointsLength: 6,
        rgb565: [
          rgb565Word(31, 63, 31), // white
          rgb565Word(0, 0, 0), //    black
          rgb565Word(31, 0, 0), //   red at full strength
          rgb565Word(0, 63, 0), //   green at full strength
          rgb565Word(0, 0, 31), //   blue at full strength
          rgb565Word(16, 32, 8), //  mid-range, distinct per field width
        ],
      }),
    );
    expect([...(t.colors as Uint8Array)]).toEqual([
      255, 255, 255, // a shift-only expansion would give 248, 252, 248
      0, 0, 0,
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      // round(16*255/31) = 132, round(32*255/63) = 130, round(8*255/31) = 66.
      // Shifting instead would give 128, 128, 64.
      132, 130, 66,
    ]);
  });

  it('reads the RGB565 fields at their own widths and positions', () => {
    // Field values chosen so red, green and blue are all different, and so
    // swapping the green and blue widths changes both of them.
    const t = parsePnts(makeAttributePnts({ rgb565: [rgb565Word(1, 2, 3)] }));
    // round(1*255/31) = 8, round(2*255/63) = 8, round(3*255/31) = 25.
    // Reading green as 5 bits would give 16; blue as 6 bits would give 12.
    expect([...(t.colors as Uint8Array)]).toEqual([8, 8, 25]);
  });

  it('ranks RGBA over RGB over RGB565 over CONSTANT_RGBA', () => {
    // Every encoding present at once, each carrying a colour no other one could
    // produce, so the winner names itself.
    const all = {
      rgba: [[10, 20, 30, 255]],
      rgb: [[40, 50, 60]],
      rgb565: [rgb565Word(31, 0, 0)], // 255, 0, 0
      constantRgba: [70, 80, 90, 255],
    };
    expect([...(parsePnts(makeAttributePnts(all)).colors as Uint8Array)]).toEqual([10, 20, 30]);
    const { rgba: _rgba, ...noRgba } = all;
    expect([...(parsePnts(makeAttributePnts(noRgba)).colors as Uint8Array)]).toEqual([40, 50, 60]);
    const { rgb: _rgb, ...noRgb } = noRgba;
    expect([...(parsePnts(makeAttributePnts(noRgb)).colors as Uint8Array)]).toEqual([255, 0, 0]);
    const { rgb565: _rgb565, ...noRgb565 } = noRgb;
    expect([...(parsePnts(makeAttributePnts(noRgb565)).colors as Uint8Array)]).toEqual([70, 80, 90]);
  });
});

/**
 * The chord between a decoded oct16p normal and the direction it was encoded
 * from, at the widest the encoding allows.
 *
 * Each of the two stored bytes carries one coordinate of the octahedral
 * projection over [-1, 1], so rounding moves it by at most 1/255. Decoding maps
 * (px, py) to (px, py, 1 − |px| − |py|) — or its folded form, which has the same
 * shape — whose derivative in either coordinate has length sqrt(2), so the
 * unnormalised point moves by at most 2·sqrt(2)/255. That point lies on the
 * octahedron |x| + |y| + |z| = 1, whose nearest point to the origin is at
 * 1/sqrt(3), and normalising two vectors of length at least L separates them by
 * at most 2/(2L) times their difference. So the unit vectors differ by at most
 * sqrt(3) · 2·sqrt(2)/255 = 2·sqrt(6)/255, about 0.0192.
 */
const OCT16P_CHORD_BOUND = (2 * Math.sqrt(6)) / 255;

/** Euclidean distance between two 3-vectors. */
const chord = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('parsePnts normals', () => {
  it('reports no normals when the tile carries none', () => {
    expect(parsePnts(makeAttributePnts({})).normals).toBeNull();
  });

  it('decodes float32 NORMAL as the tile wrote it', () => {
    const t = parsePnts(makeAttributePnts({ pointsLength: 2, normal: [[0, 0, 1], [0.5, -0.5, 0.25]] }));
    expect([...(t.normals as Float32Array)]).toEqual([0, 0, 1, 0.5, -0.5, 0.25]);
  });

  it('decodes the oct16p corners and the body diagonal exactly', () => {
    // (255, 255) folds to px = py = 1, z = −1, so the folded point is (0, 0, −1)
    // and needs no rounding at all. (170, 170) gives px = py = 1/3 and z = 1/3,
    // which normalises to the body diagonal.
    const t = parsePnts(makeAttributePnts({ pointsLength: 2, normalOct16p: [[255, 255], [170, 170]] }));
    const n = [...(t.normals as Float32Array)];
    expect(chord(n.slice(0, 3), [0, 0, -1])).toBeLessThan(1e-6);
    const third = 1 / Math.sqrt(3);
    expect(chord(n.slice(3, 6), [third, third, third])).toBeLessThan(1e-6);
  });

  it('round-trips the axis and oblique directions inside the encoding bound', () => {
    // Codes are the octahedral projection of each direction rounded to a byte:
    // ((p * 0.5 + 0.5) * 255), with the lower hemisphere folded outwards first.
    const cases: ReadonlyArray<{ code: [number, number]; direction: [number, number, number] }> = [
      { code: [255, 128], direction: [1, 0, 0] },
      { code: [0, 128], direction: [-1, 0, 0] },
      { code: [128, 255], direction: [0, 1, 0] },
      { code: [128, 0], direction: [0, -1, 0] },
      { code: [128, 128], direction: [0, 0, 1] },
      { code: [255, 255], direction: [0, 0, -1] },
      { code: [170, 170], direction: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] },
      { code: [219, 44], direction: [0.6, -0.48, -0.64] },
    ];
    const t = parsePnts(
      makeAttributePnts({ pointsLength: cases.length, normalOct16p: cases.map((c) => [...c.code]) }),
    );
    const normals = t.normals as Float32Array;
    cases.forEach((c, i) => {
      const decoded = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
      // A direction, so unit length whatever the two bytes happened to name.
      expect(Math.hypot(decoded[0], decoded[1], decoded[2])).toBeCloseTo(1, 6);
      expect(chord(decoded, c.direction)).toBeLessThan(OCT16P_CHORD_BOUND);
    });
  });

  it('prefers NORMAL when a tile carries both encodings', () => {
    // The oct16p pair would decode to the body diagonal, which shares no
    // component with the float32 array.
    const t = parsePnts(
      makeAttributePnts({ normal: [[0, 0, 1]], normalOct16p: [[170, 170]] }),
    );
    expect([...(t.normals as Float32Array)]).toEqual([0, 0, 1]);
  });
});

/** Bytes per id for each BATCH_ID component width the format allows. */
const BATCH_ID_WIDTHS: Record<string, number> = {
  UNSIGNED_BYTE: 1,
  UNSIGNED_SHORT: 2,
  UNSIGNED_INT: 4,
};

/**
 * Build a PNTS tile carrying a zeroed float32 POSITION, a BATCH_ID array, and a
 * batch table. `componentType` is written into the accessor only when given, so
 * omitting it is the case that pins the format's default width; `writeWidth`
 * separates the width the bytes were written at from the width the accessor
 * names, which is what a stride mistake looks like from outside.
 */
function makeBatchPnts(
  opts: {
    pointsLength?: number;
    batchIds?: number[];
    componentType?: string;
    writeWidth?: number;
    batchLength?: number;
    batchTable?: Record<string, unknown>;
    batchTableBinary?: number[];
  } = {},
): ArrayBuffer {
  const ids = opts.batchIds;
  const pointsLength = opts.pointsLength ?? ids?.length ?? 1;
  const width = opts.writeWidth ?? BATCH_ID_WIDTHS[opts.componentType ?? 'UNSIGNED_SHORT'];
  const ft: Record<string, unknown> = { POINTS_LENGTH: pointsLength, POSITION: { byteOffset: 0 } };
  const idsAt = pointsLength * 3 * 4;
  let binBytes = idsAt;
  if (ids) {
    const accessor: Record<string, unknown> = { byteOffset: idsAt };
    if (opts.componentType !== undefined) accessor.componentType = opts.componentType;
    ft.BATCH_ID = accessor;
    ft.BATCH_LENGTH = opts.batchLength ?? Math.max(...ids) + 1;
    binBytes += pointsLength * width;
  } else if (opts.batchLength !== undefined) {
    ft.BATCH_LENGTH = opts.batchLength;
  }

  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);

  let btJsonBytes = new Uint8Array(0);
  if (opts.batchTable) {
    let btJson = JSON.stringify(opts.batchTable);
    while (btJson.length % 8 !== 0) btJson += ' ';
    btJsonBytes = new TextEncoder().encode(btJson);
  }
  const btBin = new Uint8Array(opts.batchTableBinary ?? []);

  const total = 28 + jsonBytes.length + binBytes + btJsonBytes.length + btBin.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, 0x73746e70, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, btJsonBytes.length, true);
  view.setUint32(24, btBin.length, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  if (ids) {
    ids.forEach((id, i) => {
      const at = binStart + idsAt + i * width;
      if (width === 1) view.setUint8(at, id);
      else if (width === 2) view.setUint16(at, id, true);
      else view.setUint32(at, id, true);
    });
  }
  new Uint8Array(buf, binStart + binBytes, btJsonBytes.length).set(btJsonBytes);
  new Uint8Array(buf, binStart + binBytes + btJsonBytes.length, btBin.length).set(btBin);
  return buf;
}

describe('parsePnts batch ids', () => {
  it('reports no ids and no batch table when the tile carries neither', () => {
    const t = parsePnts(makeAttributePnts({}));
    expect(t.batchIds).toBeNull();
    expect(t.batchTable).toBeNull();
  });

  it('reads a componentType-less BATCH_ID at the default UNSIGNED_SHORT width', () => {
    // Written as little-endian uint16, so the bytes are 02 01 04 03. Read a byte
    // at a time the same array gives 2 and 1, which are ids the tile never wrote
    // and which are still inside BATCH_LENGTH, so nothing else would notice.
    const t = parsePnts(makeBatchPnts({ batchIds: [0x0102, 0x0304], batchLength: 1000 }));
    expect([...(t.batchIds as Uint32Array)]).toEqual([258, 772]);
  });

  it('reads each of the three legal component widths', () => {
    const byWidth = (componentType: string, batchIds: number[], batchLength: number) => [
      ...(parsePnts(makeBatchPnts({ componentType, batchIds, batchLength })).batchIds as Uint32Array),
    ];
    expect(byWidth('UNSIGNED_BYTE', [0, 7, 255], 256)).toEqual([0, 7, 255]);
    expect(byWidth('UNSIGNED_SHORT', [0, 258, 65535], 65536)).toEqual([0, 258, 65535]);
    // Above the uint16 ceiling, so a short read of this array cannot produce it.
    expect(byWidth('UNSIGNED_INT', [0, 70000, 4294967294], 4294967295)).toEqual([
      0, 70000, 4294967294,
    ]);
  });

  it('accepts an id one below BATCH_LENGTH', () => {
    // The bound is exclusive, so the refusal of an id equal to BATCH_LENGTH is
    // about that value and not about large ids generally.
    const t = parsePnts(makeBatchPnts({ batchIds: [3, 0], batchLength: 4 }));
    expect([...(t.batchIds as Uint32Array)]).toEqual([3, 0]);
  });

  it('gives one id per point, whatever the batch count is', () => {
    const t = parsePnts(makeBatchPnts({ batchIds: [1, 1, 1, 1, 1], batchLength: 2 }));
    expect(t.pointsLength).toBe(5);
    expect(t.batchIds).toHaveLength(5);
    expect(t.positions).toHaveLength(15);
  });

  it('carries the batch table JSON and binary through unchanged', () => {
    const t = parsePnts(
      makeBatchPnts({
        batchIds: [0, 1],
        batchLength: 2,
        batchTable: { name: ['a', 'b'], height: { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' } },
        batchTableBinary: [1, 2, 3, 4, 5, 6, 7, 8],
      }),
    );
    expect(t.batchTable?.json).toEqual({
      name: ['a', 'b'],
      height: { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' },
    });
    expect([...(t.batchTable?.binary as Uint8Array)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('copies the batch-table binary instead of viewing the tile buffer', () => {
    // A view would keep the whole tile alive for as long as a caller held the
    // properties, and would change under a caller that reused the buffer.
    const t = parsePnts(
      makeBatchPnts({ batchIds: [0], batchLength: 1, batchTable: { n: [1] }, batchTableBinary: [9, 9] }),
    );
    const binary = t.batchTable?.binary as Uint8Array;
    expect(binary.buffer.byteLength).toBe(binary.length);
  });

  it('keeps a batch table that has no BATCH_ID pointing into it', () => {
    // Per-point batch-table properties are legal without ids; discarding the
    // table here would drop them.
    const t = parsePnts(makeBatchPnts({ batchTable: { intensity: [1, 2] } }));
    expect(t.batchIds).toBeNull();
    expect(t.batchTable?.json).toEqual({ intensity: [1, 2] });
  });

  it('carries no LAS-style channel the format never supplied', () => {
    // Intensity, classification and return number have no PNTS semantic. A
    // decoder that invented them would report the same constant for every point
    // of every tile, and a caller would have no way to tell it from data.
    const t = parsePnts(
      makeBatchPnts({ batchIds: [0], batchLength: 1, batchTable: { classification: [2] } }),
    );
    expect(Object.keys(t).sort()).toEqual([
      'batchIds',
      'batchTable',
      'colors',
      'normals',
      'pointsLength',
      'positions',
      'rtcCenter',
      'version',
    ]);
    // The batch table names one, and it stays inside the batch table.
    expect(t.batchTable?.json.classification).toEqual([2]);
  });
});

describe('parsePnts batch-metadata gating and section caps', () => {
  it('reads BATCH_ID and the batch table by default', () => {
    const t = parsePnts(
      makeBatchPnts({ batchIds: [0, 1, 2], batchTable: { name: ['a', 'b', 'c'] } }),
    );
    expect([...(t.batchIds as Uint32Array)]).toEqual([0, 1, 2]);
    expect(t.batchTable?.json.name).toEqual(['a', 'b', 'c']);
  });

  it('materialises neither BATCH_ID nor the batch table when metadata is disabled', () => {
    const body = makeBatchPnts({ batchIds: [0, 1, 2], batchTable: { name: ['a', 'b', 'c'] } });
    const RealUint32Array = Uint32Array;
    let u32OfPointCount = 0;
    const Spy = new Proxy(RealUint32Array, {
      construct(target, args: [number]) {
        if (args[0] === 3) u32OfPointCount += 1;
        return Reflect.construct(target, args) as Uint32Array;
      },
    });
    (globalThis as unknown as { Uint32Array: typeof Uint32Array }).Uint32Array =
      Spy as unknown as typeof Uint32Array;
    let t: ReturnType<typeof parsePnts>;
    try {
      t = parsePnts(body, { keepBatchMetadata: false });
    } finally {
      (globalThis as unknown as { Uint32Array: typeof Uint32Array }).Uint32Array = RealUint32Array;
    }
    expect(t.batchIds, 'BATCH_ID must not be materialised when metadata is disabled').toBeNull();
    expect(t.batchTable, 'the batch table must not be kept when metadata is disabled').toBeNull();
    expect(u32OfPointCount, 'no per-point BATCH_ID array was allocated').toBe(0);
  });

  it('refuses an oversized batch-table JSON before it is parsed', () => {
    const body = makeBatchPnts({
      batchIds: [0],
      batchTable: { note: 'x'.repeat(64) },
    });
    const RealParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = ((...args: Parameters<typeof RealParse>) => {
      parseCalls += 1;
      return RealParse(...args);
    }) as typeof JSON.parse;
    try {
      expect(() => parsePnts(body, { maxBatchTableJsonBytes: 8 })).toThrow(
        /batch-table JSON is \d+ bytes, past the 8 byte ceiling/,
      );
    } finally {
      JSON.parse = RealParse;
    }
    // The feature table is parsed (1); the batch table is refused on size before
    // its own JSON.parse, so the count stays at one.
    expect(parseCalls, 'the batch-table JSON was parsed despite exceeding the cap').toBe(1);
  });

  it('refuses an oversized feature-table JSON before it is parsed', () => {
    const body = makeBatchPnts({ batchIds: [0] });
    expect(() => parsePnts(body, { maxFeatureTableJsonBytes: 4 })).toThrow(
      /feature-table JSON is \d+ bytes, past the 4 byte ceiling/,
    );
  });

  it('refuses an oversized batch-table binary before it is copied', () => {
    const body = makeBatchPnts({
      batchIds: [0],
      batchTable: { name: ['a'] },
      batchTableBinary: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(() => parsePnts(body, { maxBatchTableBinaryBytes: 4 })).toThrow(
      /batch-table binary is 8 bytes, past the 4 byte ceiling/,
    );
  });
});
