/**
 * gifEncoder.test.ts — the GIF89a writer, checked by decoding what it wrote.
 *
 * The decoder (tests/helpers/gifDecoder.ts) is written from the format
 * description, so a round trip pins the header, the global colour table, the
 * looping and comment extensions, per-frame delays and rectangles, and the LZW
 * stream: variable code size, dictionary resets at 4096 codes, the 2-bit
 * minimum code size and a one-pixel image.
 */
import { describe, expect, it } from 'vitest';
import { GifWriter, lzwEncode, minCodeSizeFor } from '../src/export/gifEncoder';
import { decodeGif, lzwDecode } from './helpers/gifDecoder';
import { seededRandom } from '../src/ui/fieldSimulation/flowParticles';

const rgb = (...cs: number[][]) => Uint8Array.from(cs.flat());

describe('GIF89a writer', () => {
  it('round-trips frames, delays, rectangles, palette, loop and comment', () => {
    const palette = rgb([0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 128, 255]);
    const w = new GifWriter(7, 5, palette, { comment: 'flow length <= 12 m' });
    const full = Uint8Array.from({ length: 35 }, (_, i) => i % 4);
    w.addFrame({ indices: full, width: 7, height: 5, delayCs: 8 });
    w.addFrame({ indices: Uint8Array.from([2, 2, 3, 3, 1, 0]), width: 3, height: 2, left: 2, top: 1, delayCs: 12 });
    w.addFrame({ indices: Uint8Array.from([1]), width: 1, height: 1, left: 6, top: 4, delayCs: 300 });
    const bytes = w.finish();
    const g = decodeGif(bytes);
    expect(g.version).toBe('GIF89a');
    expect([g.width, g.height]).toEqual([7, 5]);
    expect(Array.from(g.palette)).toEqual(Array.from(palette));
    expect(g.loop).toBe(0);
    expect(g.comments).toEqual(['flow length <= 12 m']);
    expect(g.frames.map((f) => f.delayCs)).toEqual([8, 12, 300]);
    expect(g.frames.map((f) => [f.left, f.top, f.width, f.height])).toEqual([[0, 0, 7, 5], [2, 1, 3, 2], [6, 4, 1, 1]]);
    expect(g.frames.every((f) => f.disposal === 1)).toBe(true);
    expect(Array.from(g.frames[0]!.indices)).toEqual(Array.from(full));
    // The composited third screen: the full frame, the patch, then the corner pixel.
    const s = g.screens[2]!;
    expect(Array.from(s.subarray(7 + 2, 7 + 5))).toEqual([2, 2, 3]);
    expect(Array.from(s.subarray(14 + 2, 14 + 5))).toEqual([3, 1, 0]);
    expect(s[34]).toBe(1);
    expect(s[0]).toBe(0);
    // Header bytes as written: global table flag, 8-bit resolution, 4 entries.
    expect(bytes[10]).toBe(0x80 | 0x70 | 1);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it('round-trips a 256-colour noisy image through dictionary resets', () => {
    const rand = seededRandom(7);
    const palette = new Uint8Array(256 * 3).map((_, i) => (i * 37) & 0xff);
    const n = 300 * 200;
    const noise = Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
    const w = new GifWriter(300, 200, palette);
    w.addFrame({ indices: noise, width: 300, height: 200, delayCs: 5 });
    const g = decodeGif(w.finish());
    expect(g.palette.length).toBe(768);
    expect(Array.from(g.frames[0]!.indices)).toEqual(Array.from(noise));
  });

  it('round-trips long runs, which grow codes to 12 bits', () => {
    const palette = new Uint8Array(16 * 3);
    const n = 400 * 300;
    const runs = Uint8Array.from({ length: n }, (_, i) => Math.floor(i / 977) % 16);
    const w = new GifWriter(400, 300, palette);
    w.addFrame({ indices: runs, width: 400, height: 300, delayCs: 5 });
    expect(Array.from(decodeGif(w.finish()).frames[0]!.indices)).toEqual(Array.from(runs));
  });

  it('uses the 2-bit floor for a 2-colour table, and handles one pixel', () => {
    expect(minCodeSizeFor(2)).toBe(2);
    expect(minCodeSizeFor(4)).toBe(2);
    expect(minCodeSizeFor(5)).toBe(3);
    expect(minCodeSizeFor(256)).toBe(8);
    const w = new GifWriter(1, 1, rgb([0, 0, 0], [255, 255, 255]));
    w.addFrame({ indices: Uint8Array.from([1]), width: 1, height: 1, delayCs: 1 });
    const g = decodeGif(w.finish());
    expect(Array.from(g.frames[0]!.indices)).toEqual([1]);
    for (const data of [[0, 1, 1, 0, 1, 1, 1, 0], [1], [0, 0, 0, 0]]) {
      const idx = Uint8Array.from(data);
      expect(Array.from(lzwDecode(lzwEncode(idx, 2), 2, idx.length))).toEqual(data);
    }
  });

  it('refuses a frame that does not fit, a wrong index count, or an oversize palette', () => {
    const w = new GifWriter(4, 4, rgb([0, 0, 0], [1, 1, 1]));
    expect(() => w.addFrame({ indices: new Uint8Array(4), width: 2, height: 2, left: 3, delayCs: 1 })).toThrow(/does not fit/);
    expect(() => w.addFrame({ indices: new Uint8Array(3), width: 2, height: 2, delayCs: 1 })).toThrow(/indices/);
    expect(() => new GifWriter(4, 4, new Uint8Array(257 * 3))).toThrow(/palette/);
    expect(() => new GifWriter(0, 4, new Uint8Array(6))).toThrow(/size/);
  });

  it('folds a comment to ASCII', () => {
    const w = new GifWriter(1, 1, rgb([0, 0, 0], [9, 9, 9]), { comment: 'area 80,687 m² · C 0.2' });
    w.addFrame({ indices: new Uint8Array(1), width: 1, height: 1, delayCs: 1 });
    expect(decodeGif(w.finish()).comments[0]).toBe('area 80,687 m2 - C 0.2');
  });
});
