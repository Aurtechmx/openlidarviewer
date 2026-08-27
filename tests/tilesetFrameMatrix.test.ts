/**
 * tilesetFrameMatrix.test.ts — the ENU frame as a matrix agrees with the ENU
 * frame as a point mapping.
 *
 * The merged reader maps every point through `SpatialFrame.sourceToRenderPoint`.
 * The streaming reader never holds every point, so it composes the same rotation
 * as a matrix at the root of the tile tree. If the two disagree, a geocentric
 * tileset still draws as a plausible scene and only the numbers read off it are
 * wrong, which is a failure with no visual trace.
 *
 * The fixture sits at Monterrey, 25.6866°N 100.3161°W, where the polar axis and
 * local up are 64.3° apart. On the equator at longitude zero they coincide and
 * every assertion below would pass against a matrix that only translates.
 */

import { describe, it, expect } from 'vitest';
import { geodeticToEcef } from '../src/io/tiles3d/boundingVolume';
import { enuFrameMatrix } from '../src/io/tiles3d/tilesetFrame';
import { createLocalEnuFrame, type Vec3 } from '../src/geo/frame/spatialFrame';

const DEG = Math.PI / 180;
const ANCHOR = geodeticToEcef(-100.3161 * DEG, 25.6866 * DEG, 540) as Vec3;

/** Apply a column-major 4x4 to a point. */
function apply(m: readonly number[], p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

describe('enuFrameMatrix', () => {
  it('maps points exactly as createLocalEnuFrame does', () => {
    const frame = createLocalEnuFrame(ANCHOR);
    const m = enuFrameMatrix(ANCHOR);
    const probes: Vec3[] = [
      ANCHOR,
      [ANCHOR[0] + 120, ANCHOR[1] - 45, ANCHOR[2] + 8],
      [ANCHOR[0] - 2000, ANCHOR[1] + 3000, ANCHOR[2] - 150],
    ];
    for (const p of probes) {
      const viaFrame = frame.sourceToRenderPoint(p);
      const viaMatrix = apply(m, p);
      for (let i = 0; i < 3; i++) {
        expect(
          viaMatrix[i],
          'the streaming reader would place tiles differently from the merged one',
        ).toBeCloseTo(viaFrame[i], 6);
      }
    }
  });

  it('puts the anchor at the origin', () => {
    for (const v of apply(enuFrameMatrix(ANCHOR), ANCHOR)) {
      expect(Math.abs(v)).toBeLessThan(1e-6);
    }
  });

  it('sends local up along +Z, which is the reason the frame exists', () => {
    // A point straight up from the anchor, about 64 m out along the ECEF radius.
    const s = 1 + 1e-5;
    const up: Vec3 = [ANCHOR[0] * s, ANCHOR[1] * s, ANCHOR[2] * s];
    const r = apply(enuFrameMatrix(ANCHOR), up);
    expect(r[2]).toBeGreaterThan(50);
    expect(
      Math.hypot(r[0], r[1]),
      'local up leaked into the horizontal axes, so heights here are not heights',
    ).toBeLessThan(1);
  });
});
