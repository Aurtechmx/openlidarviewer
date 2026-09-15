/**
 * renderBootstrapPolicy.test.ts
 *
 * The GPU-free decisions of the renderer bootstrap: a canvas with no layout
 * yet falls back to a fixed buffer, a laid-out one keeps its own box and
 * aspect, the pixel ratio never exceeds the ceiling, and the depth mode is
 * read off the renderer instead of assumed. The constants are pinned because
 * the render behaviour they set must not move in an extraction. Nothing here
 * touches three.js. The renderer stand-in is a plain object with the one flag
 * the policy reads.
 */
import { describe, it, expect } from 'vitest';
import {
  CAMERA_FAR, CAMERA_NEAR, DEFAULT_FOV, FALLBACK_BUFFER, SCENE_BACKGROUND,
  effectivePixelRatio, resolveDrawingBuffer, usesLogDepthOf,
} from '../src/render/renderBootstrapPolicy';

describe('render bootstrap policy', () => {
  it('falls back to the fixed buffer only for a zero client box', () => {
    expect(resolveDrawingBuffer(0, 0)).toEqual({ width: 800, height: 600, aspect: 800 / 600 });
    expect(resolveDrawingBuffer(1200, 0)).toEqual({ width: 1200, height: 600, aspect: 2 });
    expect(resolveDrawingBuffer(1000, 500)).toEqual({ width: 1000, height: 500, aspect: 2 });
    expect(FALLBACK_BUFFER).toEqual({ width: 800, height: 600 });
  });

  it('caps the device pixel ratio at the ceiling and reads a missing one as 1', () => {
    expect(effectivePixelRatio(3, 2)).toBe(2);
    expect(effectivePixelRatio(1.5, 2)).toBe(1.5);
    expect(effectivePixelRatio(undefined, 2)).toBe(1);
    expect(effectivePixelRatio(0, 2)).toBe(1);
  });

  it('reads the depth mode off the renderer', () => {
    expect(usesLogDepthOf({ logarithmicDepthBuffer: true })).toBe(true);
    expect(usesLogDepthOf({ logarithmicDepthBuffer: false })).toBe(false);
    expect(usesLogDepthOf({})).toBe(false);
  });

  it('pins the constants the extraction must not move', () => {
    expect(CAMERA_NEAR).toBe(0.1);
    expect(CAMERA_FAR).toBe(5_000_000);
    expect(SCENE_BACKGROUND).toBe(0x070b16);
    expect(DEFAULT_FOV).toBeGreaterThan(0);
  });
});
