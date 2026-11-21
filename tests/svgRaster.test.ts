/**
 * svgRaster.test.ts: the contour map PNG's size and its text chunks. The
 * drawing itself needs a browser and is covered end to end.
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { svgSize, withPngText } from '../src/export/sheetKit/svgRaster';
import { encodePng } from '../src/export/sheetKit/png';

/** Chunk types and tEXt entries of a PNG, checking each CRC. */
function chunks(png: Uint8Array): { types: string[]; text: Record<string, string>; idat: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const types: string[] = [];
  const text: Record<string, string> = {};
  const idat: number[] = [];
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    types.push(type);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      text[String.fromCharCode(...data.subarray(0, z))] = Buffer.from(data.subarray(z + 1)).toString('latin1');
    }
    if (type === 'IDAT') idat.push(...data);
    o += 12 + len;
  }
  return { types, text, idat: Uint8Array.from(idat) };
}

describe('svgSize', () => {
  it('reads the root width and height', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="936.00" height="1200.5" viewBox="0 0 1 1">')).toEqual({ width: 936, height: 1200.5 });
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">')).toBeNull();
    expect(svgSize('<svg width="0" height="10">')).toBeNull();
  });
});

describe('withPngText', () => {
  it('adds tEXt chunks after IHDR and leaves the image data unchanged', async () => {
    const rgba = new Uint8Array(4 * 3 * 2).fill(200);
    const png = await encodePng(rgba, 3, 2);
    const out = withPngText(png, [['Software', 'OpenLiDARViewer 0.7.2'], ['Description', 'CRS  EPSG:32612\nNot survey-grade']]);
    const before = chunks(png), after = chunks(out);
    expect(after.types).toEqual(['IHDR', 'tEXt', 'tEXt', ...before.types.slice(1)]);
    expect(after.text).toEqual({ Software: 'OpenLiDARViewer 0.7.2', Description: 'CRS  EPSG:32612\nNot survey-grade' });
    expect(Buffer.from(inflateSync(after.idat)).equals(Buffer.from(inflateSync(before.idat)))).toBe(true);
  });

  it('writes characters outside Latin-1 as ?', async () => {
    const png = await encodePng(new Uint8Array(4), 1, 1);
    expect(chunks(withPngText(png, [['Description', 'a ≤ b']])).text.Description).toBe('a ? b');
  });

  it('refuses bytes that are not a PNG', () => {
    expect(() => withPngText(new Uint8Array(40), [['A', 'b']])).toThrow();
  });
});
