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

  it('refuses a bad magic and quantised positions', () => {
    const bad = new ArrayBuffer(28);
    new DataView(bad).setUint32(0, 0x12345678, true);
    expect(() => parsePnts(bad)).toThrow(/magic/);

    expect(() => parsePnts(makeFeatureTablePnts({ POINTS_LENGTH: 1, POSITION_QUANTIZED: { byteOffset: 0 } }))).toThrow(/QUANTIZED/);
  });
});
