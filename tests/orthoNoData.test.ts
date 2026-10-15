/**
 * The georeferenced ortho PNG marks no-data pixels transparent. The frame is
 * captured on a black and on a white clear; `composeNoDataAlpha` derives a
 * binary alpha from the pair, and `presentedBlobAtSize` runs the two captures
 * and restores the scene background.
 */

import { describe, it, expect } from 'vitest';
import {
  composeNoDataAlpha,
  NODATA_COVERAGE_THRESHOLD,
} from '../src/render/export/orthoNoData';
import { presentedBlobAtSize } from '../src/render/snapshot';

/** One RGBA pixel per entry. */
const raster = (px: ReadonlyArray<readonly [number, number, number]>): Uint8ClampedArray =>
  new Uint8ClampedArray(px.flatMap(([r, g, b]) => [r, g, b, 255]));

describe('composeNoDataAlpha', () => {
  it('makes a fully covered pixel opaque with its exact colour', () => {
    const dark = raster([[12, 200, 77]]);
    const light = raster([[12, 200, 77]]);
    const out = new Uint8ClampedArray(4);
    expect(composeNoDataAlpha(dark, light, out)).toBe(1);
    expect([...out]).toEqual([12, 200, 77, 255]);
  });

  it('makes an empty pixel transparent black', () => {
    const out = new Uint8ClampedArray(4);
    expect(composeNoDataAlpha(raster([[0, 0, 0]]), raster([[255, 255, 255]]), out)).toBe(0);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('keeps a black point opaque (colour-independent coverage)', () => {
    const out = new Uint8ClampedArray(4);
    composeNoDataAlpha(raster([[0, 0, 0]]), raster([[0, 0, 0]]), out);
    expect([...out]).toEqual([0, 0, 0, 255]);
  });

  it('binarises an antialiased edge: no alpha strictly between 0 and 255', () => {
    // A white point at coverage c over black shows c*255, over white 255.
    const pixels: Array<[number, number, number]>[] = [[], []];
    for (let c = 0; c <= 100; c++) {
      const v = Math.round((c / 100) * 255);
      pixels[0]!.push([v, v, v]);
      pixels[1]!.push([255, 255, 255]);
    }
    const dark = raster(pixels[0]!);
    const out = new Uint8ClampedArray(dark.length);
    composeNoDataAlpha(dark, raster(pixels[1]!), out);
    for (let c = 0; c <= 100; c++) {
      const a = out[c * 4 + 3]!;
      expect(a === 0 || a === 255).toBe(true);
      if (c / 100 >= NODATA_COVERAGE_THRESHOLD + 0.01) expect(a).toBe(255);
      if (c / 100 <= NODATA_COVERAGE_THRESHOLD - 0.01) expect(a).toBe(0);
      // A covered edge pixel carries the point colour, not a blend with the clear.
      if (a === 255) expect(out[c * 4]!).toBeGreaterThanOrEqual(253);
    }
  });

  it('recovers a coloured point at partial coverage', () => {
    // Point (200, 100, 40) at coverage 0.8.
    const c = 0.8;
    const dark = raster([[200 * c, 100 * c, 40 * c].map(Math.round) as [number, number, number]]);
    const light = raster([[200 * c + 255 * (1 - c), 100 * c + 255 * (1 - c), 40 * c + 255 * (1 - c)].map(Math.round) as [number, number, number]]);
    const out = new Uint8ClampedArray(4);
    composeNoDataAlpha(dark, light, out);
    expect(out[3]).toBe(255);
    expect(Math.abs(out[0]! - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(out[1]! - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(out[2]! - 40)).toBeLessThanOrEqual(1);
  });

  it('can write in place over the dark capture', () => {
    const dark = raster([[9, 9, 9], [0, 0, 0]]);
    expect(composeNoDataAlpha(dark, raster([[9, 9, 9], [255, 255, 255]]), dark)).toBe(1);
    expect([...dark]).toEqual([9, 9, 9, 255, 0, 0, 0, 0]);
  });

  it('refuses rasters of different sizes', () => {
    expect(() => composeNoDataAlpha(new Uint8ClampedArray(4), new Uint8ClampedArray(8), new Uint8ClampedArray(4))).toThrow();
  });
});

describe('presentedBlobAtSize with a no-data capture', () => {
  it('captures on both clears, composes alpha, and restores the background', async () => {
    const W = 2;
    const H = 1;
    const DARK = { name: 'dark' };
    const LIGHT = { name: 'light' };
    const ORIGINAL = { name: 'original' };
    const scene: { background: unknown } = { background: ORIGINAL };
    const gl = { width: W, height: H };
    const renderer = { getPixelRatio: () => 1, setPixelRatio: () => {}, setSize: () => {} };
    // The scene: pixel 0 holds a red point, pixel 1 is empty.
    const frame = (): number[] => {
      const bg = scene.background === LIGHT ? 255 : 0;
      return [220, 10, 10, 255, bg, bg, bg, 255];
    };
    let blobbed: number[] | null = null;
    const canvases: Array<{ data: number[] }> = [];
    const makeCanvas = () => {
      const state = { data: new Array(W * H * 4).fill(0) };
      canvases.push(state);
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          save() {}, restore() {}, fillRect() {},
          globalCompositeOperation: 'source-over', fillStyle: '#000',
          drawImage: () => { state.data = frame(); },
          getImageData: () => ({ data: new Uint8ClampedArray(state.data) }),
          putImageData: (img: { data: Uint8ClampedArray }) => { state.data = [...img.data]; },
        }),
        toBlob: (cb: (b: Blob | null) => void) => { blobbed = state.data; cb(new Blob(['png'])); },
      };
      return canvas;
    };
    const g = globalThis as unknown as { document?: unknown; requestAnimationFrame?: unknown };
    const prevDoc = g.document;
    g.document = { createElement: makeCanvas };
    const seenBackgrounds: unknown[] = [];
    try {
      const result = await presentedBlobAtSize(
        gl as unknown as HTMLCanvasElement,
        renderer,
        W,
        H,
        () => { seenBackgrounds.push(scene.background); },
        ORIGINAL,
        { scene, dark: DARK, light: LIGHT },
      );
      expect(result.noDataTransparent).toBe(true);
      expect([result.widthPx, result.heightPx]).toEqual([W, H]);
      expect(blobbed).toEqual([220, 10, 10, 255, 0, 0, 0, 0]);
      expect(scene.background).toBe(ORIGINAL);
      // Two present cycles plus the captured render on each clear, in order.
      expect(seenBackgrounds).toEqual([DARK, DARK, DARK, LIGHT, LIGHT, LIGHT]);
    } finally {
      g.document = prevDoc;
    }
  });

  it('restores the background when a capture throws', async () => {
    const ORIGINAL = { name: 'original' };
    const scene: { background: unknown } = { background: ORIGINAL };
    const g = globalThis as unknown as { document?: unknown };
    const prevDoc = g.document;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
    try {
      await expect(presentedBlobAtSize(
        { width: 1, height: 1 } as unknown as HTMLCanvasElement,
        { getPixelRatio: () => 1, setPixelRatio: () => {}, setSize: () => {} },
        1,
        1,
        () => {},
        ORIGINAL,
        { scene, dark: {}, light: {} },
      )).rejects.toThrow(/2-D canvas context/);
      expect(scene.background).toBe(ORIGINAL);
    } finally {
      g.document = prevDoc;
    }
  });
});
