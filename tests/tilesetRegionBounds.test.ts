/**
 * tilesetRegionBounds.test.ts — a tile's bounds and its points describe the
 * same place.
 *
 * `volumeToAabb` converts a `region` directly to ECEF, because a region is
 * EPSG:4979 and absolute, while a box or sphere arrives already carried through
 * the tile transform by the walk. A geocentric tileset's POINTS are decoded
 * through that transform, root frame included, so they land near the ENU origin
 * while the region's box stayed out at the ECEF radius, some six thousand
 * kilometres away.
 *
 * The scheduler culls node bounds against the camera. Bounds in one frame and
 * points in another means it culls against a place the user is not looking at,
 * and a tileset either shows nothing or streams by accident. `region` is also
 * the only in-spec declaration of geocentricity, so this is precisely the case
 * the ENU frame exists to serve.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';
import { tilesetRootFrameMatrix } from '../src/render/streaming/TilesetStreamingSource';

const DEG = Math.PI / 180;
/** Monterrey, where the polar axis and local up are 64 degrees apart. */
const REGION = {
  region: [-100.32 * DEG, 25.68 * DEG, -100.31 * DEG, 25.69 * DEG, 500, 580],
};

const geocentric = parseTileset(
  JSON.stringify({
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      boundingVolume: REGION,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'r.pnts' },
    },
  }),
);

/** Distance from the frame origin to the centre of a node's bounds. */
function centreDistance(b: readonly number[]): number {
  return Math.hypot((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
}

describe('a region-bounded tileset', () => {
  it('bounds its tiles in the frame its points decode into', () => {
    const m = tilesetRootFrameMatrix(geocentric);
    expect(m, 'a region declares geocentricity, so a frame must be built').not.toBeNull();
    const idx = tilesetNodes(geocentric, m ?? undefined);
    const d = centreDistance(idx.records[0].bounds);
    // Points decode to within a few hundred metres of the ENU origin. Bounds
    // left in ECEF sit at the Earth's radius, about 6.37e6 m out.
    expect(
      d,
      `node bounds sit ${Math.round(d)} m from the frame origin while the points ` +
        'land within a few hundred; the scheduler would cull against empty space',
    ).toBeLessThan(50_000);
  });

  it('keeps the bounds big enough to contain the region', () => {
    const idx = tilesetNodes(geocentric, tilesetRootFrameMatrix(geocentric) ?? undefined);
    const b = idx.records[0].bounds;
    // The region spans about 0.01 degrees, roughly a kilometre. A rotated box's
    // axis-aligned bound is larger than the original, never smaller.
    expect(b[3] - b[0]).toBeGreaterThan(100);
    expect(b[4] - b[1]).toBeGreaterThan(100);
  });

  it('leaves a box-bounded tileset alone, since the walk already placed it', () => {
    const boxed = parseTileset(
      JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: { box: [5, 6, 7, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
          geometricError: 50,
          refine: 'REPLACE',
          content: { uri: 'r.pnts' },
        },
      }),
    );
    // No frame is declared for a box, so nothing is applied and the bounds are
    // the authored ones.
    expect(tilesetRootFrameMatrix(boxed)).toBeNull();
    const b = tilesetNodes(boxed).records[0].bounds;
    expect(centreDistance(b)).toBeCloseTo(Math.hypot(5, 6, 7), 6);
  });
});
