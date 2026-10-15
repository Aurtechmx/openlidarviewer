/**
 * An export-sized capture delivers exactly the pixels it was planned for.
 *
 * The georeferenced ortho export plans a raster (e.g. 2048 px wide) and writes
 * the world file for that width. The live render loop can re-apply the display
 * pixel ratio (1.5 on a 2x screen with the default ceiling) while the capture
 * awaits its present cycles; the renderer then keeps its 2048 px logical size
 * but grows the drawing buffer to 3072 px, and a copy of `gl.width` shipped a
 * 3072 px PNG under a world file computed for 2048 px (pixel size 1.5x too
 * large, the far corner 50 % of the footprint off).
 *
 * `renderedBlobAtSize` re-pins ratio 1 and the planned size in the same task
 * as the render and copies exactly the planned size.
 */

import { describe, it, expect } from 'vitest';
import { pinDrawingBuffer, renderedBlobAtSize } from '../src/render/snapshot';

/** A renderer that sizes its canvas the way three's CanvasTarget does. */
function fakeRenderer(ratio: number) {
  const canvas = { width: 0, height: 0 };
  let w = 0;
  let h = 0;
  let r = ratio;
  const apply = (): void => {
    canvas.width = Math.floor(w * r);
    canvas.height = Math.floor(h * r);
  };
  return {
    canvas,
    getPixelRatio: () => r,
    setPixelRatio: (v: number) => {
      if (v === r) return;
      r = v;
      apply();
    },
    setSize: (width: number, height: number) => {
      w = width;
      h = height;
      apply();
    },
  };
}

describe('pinDrawingBuffer', () => {
  it('undoes a pixel-ratio bump that grew the buffer past the planned size', () => {
    const r = fakeRenderer(1);
    r.setSize(2048, 1024);
    // The live loop's adaptive DPR re-applies the display ratio mid-capture.
    r.setPixelRatio(1.5);
    expect(r.canvas.width).toBe(3072);
    pinDrawingBuffer(r, r.canvas, 2048, 1024);
    expect(r.getPixelRatio()).toBe(1);
    expect([r.canvas.width, r.canvas.height]).toEqual([2048, 1024]);
  });

  it('resizes a buffer that a resize handler moved to another size', () => {
    const r = fakeRenderer(1);
    r.setSize(1280, 720);
    pinDrawingBuffer(r, r.canvas, 2048, 1024);
    expect([r.canvas.width, r.canvas.height]).toEqual([2048, 1024]);
  });

  it('leaves a buffer that already matches untouched', () => {
    const r = fakeRenderer(1);
    r.setSize(2048, 1024);
    let calls = 0;
    const counted = {
      getPixelRatio: r.getPixelRatio,
      setPixelRatio: (v: number) => { calls++; r.setPixelRatio(v); },
      setSize: (w: number, h: number) => { calls++; r.setSize(w, h); },
    };
    pinDrawingBuffer(counted, r.canvas, 2048, 1024);
    expect(calls).toBe(0);
  });
});

describe('renderedBlobAtSize', () => {
  it('renders and copies at the planned size even after a ratio bump', async () => {
    const r = fakeRenderer(1);
    r.setSize(2048, 1024);
    r.setPixelRatio(1.5); // the bump that happened between setup and copy
    const seen: Array<{ glW: number; outW: number; outH: number }> = [];
    const out = {
      width: 0,
      height: 0,
      getContext: () => ({
        save() {}, restore() {}, fillRect() {},
        globalCompositeOperation: 'source-over', fillStyle: '#000',
        drawImage: (src: { width: number }, _x: number, _y: number, w: number, h: number) => {
          seen.push({ glW: src.width, outW: w, outH: h });
        },
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'])),
    };
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: () => out };
    try {
      let renderedAt = 0;
      const result = await renderedBlobAtSize(
        r.canvas as unknown as HTMLCanvasElement,
        r,
        2048,
        1024,
        () => { renderedAt = r.canvas.width; },
      );
      expect(renderedAt, 'the frame renders into the planned buffer').toBe(2048);
      expect(seen).toEqual([{ glW: 2048, outW: 2048, outH: 1024 }]);
      expect([out.width, out.height]).toEqual([2048, 1024]);
      expect(result.widthPx).toBe(2048);
      expect(result.heightPx).toBe(1024);
    } finally {
      g.document = prev;
    }
  });
});
