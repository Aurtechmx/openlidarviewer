import { describe, expect, it } from 'vitest';
import { streamingClipBounds, verticalExtentOf } from '../src/render/clip/clipBox';
import { fitMergedBounds } from '../src/render/clip/fitBoundsInProject';
import { mergePlacedBounds } from '../src/render/layerPlacement';

type Box6 = [number, number, number, number, number, number];
const src = (data: Box6, cube: Box6) => ({ dataBounds: () => data, localBounds: () => cube });
const CUBE: Box6 = [-500, -500, -500, 500, 500, 500];
const DATA: Box6 = [-500, -500, -110, 500, 500, 28];

describe('streamed scan clip bounds', () => {
  it('fits the clip box and vertical extent to the data, not the octree cube', () => {
    const merged = mergePlacedBounds([], streamingClipBounds(src(DATA, CUBE)));
    const fit = fitMergedBounds(merged)!;
    expect(fit.max[2] - fit.min[2]).toBeCloseTo(138, 3);
    expect(fit.max[0] - fit.min[0]).toBeCloseTo(1000, 3);
    expect(verticalExtentOf(merged, 2)).toEqual({ axis: 2, min: -110, max: 28 });
  });

  it('falls back to the cube when the declared box is zeroed or unreadable', () => {
    expect(streamingClipBounds(src([0, 0, 0, 0, 0, 0], CUBE))).toEqual(CUBE);
    expect(streamingClipBounds(src([NaN, 0, 0, 1, 1, 1], CUBE))).toEqual(CUBE);
  });
});
