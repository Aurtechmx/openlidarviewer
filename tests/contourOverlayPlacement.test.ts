/**
 * contourOverlayPlacement.test.ts
 *
 * The frame proof for drawing analysed contours in the 3D scene.
 *
 * The bug this pins is the mirrored overlay: contours are computed in the
 * canonical Z-up survey frame, and placing them into a Y-up scene by moving the
 * elevation alone is a REFLECTION, which draws every contour on the wrong side
 * of the scan while still looking like a valid contour map. The load-bearing
 * test composes the Y-up build and asserts it equals the Z-up build put through
 * `canonicalZUpToYUp` — the exact inverse rotation — so a reflection cannot pass.
 */

import { describe, it, expect } from 'vitest';
import {
  overlayVerticalAxisFor,
  overlayBufferParamsFor,
  overlayScenePosition,
  overlayHeightOffsetVector,
} from '../src/render/contourOverlayPlacement';
import { buildContourOverlayBuffers } from '../src/terrain/contour/contourOverlayGeometry';
import { canonicalZUpToYUp } from '../src/terrain/canonicalFrame';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

/**
 * A model with a deliberately ASYMMETRIC northing span. A mirror is invisible on
 * a north-symmetric fixture, so the coordinates must not be balanced about 0.
 */
function model(): ContourFeatureModel {
  return {
    features: [
      {
        value: 12,
        grade: 'solid',
        isIndex: true,
        closed: false,
        meanConfidence: 90,
        coordinates: [
          [5, 20],
          [7, 35],
          [11, 60],
        ],
      },
    ],
  } as unknown as ContourFeatureModel;
}

describe('overlayVerticalAxisFor', () => {
  it('survey formats draw Z-up; mesh formats draw Y-up', () => {
    for (const f of ['las', 'laz', 'e57', 'xyz', 'pcd', 'ptx', 'pts'] as const) {
      expect(overlayVerticalAxisFor(f)).toBe('z');
    }
    for (const f of ['gltf', 'obj', 'ply'] as const) {
      expect(overlayVerticalAxisFor(f)).toBe('y');
    }
  });
});

describe('overlayBufferParamsFor — the axis and the sign travel together', () => {
  it('Z-up: no negation (the northing keeps its own axis)', () => {
    expect(overlayBufferParamsFor('las')).toEqual({ verticalAxis: 'z', negateNorthing: false });
  });

  it('Y-up: negation is REQUIRED, so the placement is a rotation not a mirror', () => {
    expect(overlayBufferParamsFor('gltf')).toEqual({ verticalAxis: 'y', negateNorthing: true });
  });
});

describe('the Y-up overlay build IS the canonical inverse rotation', () => {
  it('equals canonicalZUpToYUp applied to the Z-up build, vertex for vertex', () => {
    const m = model();
    const zUp = buildContourOverlayBuffers(m, { verticalAxis: 'z' });
    const yUp = buildContourOverlayBuffers(m, overlayBufferParamsFor('gltf'));

    // The reference: rotate the Z-up buffer with the shared inverse transform.
    const expected = canonicalZUpToYUp(Float32Array.from(zUp.positions));

    expect(yUp.segmentCount).toBe(zUp.segmentCount);
    expect(yUp.positions.length).toBe(expected.length);
    expect(yUp.positions.length).toBeGreaterThan(0);
    for (let i = 0; i < expected.length; i++) {
      expect(yUp.positions[i]).toBeCloseTo(expected[i], 6);
    }
  });

  it('the tempting shortcut (axis only, no negation) does NOT match — it is the mirror', () => {
    const m = model();
    const zUp = buildContourOverlayBuffers(m, { verticalAxis: 'z' });
    const expected = canonicalZUpToYUp(Float32Array.from(zUp.positions));
    // verticalAxis:'y' WITHOUT negateNorthing — the bug this module exists to stop.
    const mirrored = buildContourOverlayBuffers(m, { verticalAxis: 'y' });

    let differs = false;
    for (let i = 0; i < expected.length; i++) {
      if (Math.abs(mirrored.positions[i] - expected[i]) > 1e-6) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('negation flips only the northing — easting and elevation are untouched', () => {
    const m = model();
    const plain = buildContourOverlayBuffers(m, { verticalAxis: 'y' });
    const rotated = buildContourOverlayBuffers(m, { verticalAxis: 'y', negateNorthing: true });
    for (let i = 0; i < plain.positions.length; i += 3) {
      expect(rotated.positions[i]).toBe(plain.positions[i]); // easting
      expect(rotated.positions[i + 1]).toBe(plain.positions[i + 1]); // elevation
      expect(rotated.positions[i + 2]).toBe(-plain.positions[i + 2]); // northing
    }
  });

  it('the Z-up build is unchanged by the new option (default off, byte-identical)', () => {
    const m = model();
    const before = buildContourOverlayBuffers(m, { verticalAxis: 'z' });
    const after = buildContourOverlayBuffers(m, { verticalAxis: 'z', negateNorthing: false });
    expect([...after.positions]).toEqual([...before.positions]);
  });
});

describe('overlayScenePosition', () => {
  it('sits on the cloud render origin so the lines land over their own terrain', () => {
    expect(overlayScenePosition([10, -20, 3])).toEqual([10, -20, 3]);
  });

  it('a cloud that was never recentred sits at the scene origin', () => {
    expect(overlayScenePosition(null)).toEqual([0, 0, 0]);
    expect(overlayScenePosition(undefined)).toEqual([0, 0, 0]);
  });
});

describe('overlayHeightOffsetVector', () => {
  it('lifts along the scene vertical axis only', () => {
    expect(overlayHeightOffsetVector('z', 0.5)).toEqual([0, 0, 0.5]);
    expect(overlayHeightOffsetVector('y', 0.5)).toEqual([0, 0.5, 0]);
  });

  it('a non-finite offset degrades to no lift rather than NaN-ing the object', () => {
    expect(overlayHeightOffsetVector('z', Number.NaN)).toEqual([0, 0, 0]);
    expect(overlayHeightOffsetVector('y', Number.POSITIVE_INFINITY)).toEqual([0, 0, 0]);
  });
});
