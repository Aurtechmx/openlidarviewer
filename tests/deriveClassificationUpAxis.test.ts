/**
 * deriveClassificationUpAxis.test.ts — the derive reads height on the axis
 * the frame says is up.
 *
 * Everything in `deriveClassification` reads index 2 as height and 0/1 as the
 * horizontal pair, which is survey LiDAR's frame. Mesh and phone-scan sources
 * (PLY, OBJ, GLB) are Y-up, and the module's own header names "a raw
 * photogrammetry export" as the case it exists for — that case is Y-up. Run
 * the Z-up reading over a Y-up cloud and the grid minimum is taken over the
 * X/height plane, so "ground" becomes the points with the smallest NORTHING:
 * a vertical slab, not a surface.
 *
 * The test is a rotation invariant, which is the strongest statement available
 * here and needs no reference implementation: the SAME scene, expressed in
 * either frame, must be classified the same way point for point.
 */

import { describe, it, expect } from 'vitest';

import {
  DERIVED_GROUND,
  deriveClassification,
} from '../src/render/class/deriveClassification';

/**
 * A 60 x 60 m ground plane with a 10 m building on it, Z-up.
 * Deterministic: no RNG, so the two frames see identical numbers.
 */
function scene(): { xyz: Float32Array; count: number; roofFrom: number } {
  const pts: number[] = [];
  const step = 1;
  for (let x = 0; x <= 60; x += step) {
    for (let y = 0; y <= 60; y += step) {
      pts.push(x, y, 0); // ground
    }
  }
  const roofFrom = pts.length / 3;
  for (let x = 20; x <= 30; x += step) {
    for (let y = 20; y <= 30; y += step) {
      pts.push(x, y, 10); // roof
    }
  }
  return { xyz: new Float32Array(pts), count: pts.length / 3, roofFrom };
}

/** The same scene with Y up: (x, y, z)_zup -> (x, z, -y). */
function toYUp(zUp: Float32Array): Float32Array {
  const out = new Float32Array(zUp.length);
  for (let i = 0; i + 2 < zUp.length; i += 3) {
    out[i] = zUp[i];
    out[i + 1] = zUp[i + 2];
    out[i + 2] = -zUp[i + 1];
  }
  return out;
}

describe('the same scene in either frame classifies the same', () => {
  const { xyz, count, roofFrom } = scene();
  const yUp = toYUp(xyz);

  const zResult = deriveClassification(xyz, count, { upAxis: 'z' });
  const yResult = deriveClassification(yUp, count, { upAxis: 'y' });

  it('finds the ground plane as ground in the Z-up frame', () => {
    // Sanity: without this the invariant below could pass on two wrong answers.
    let ground = 0;
    for (let i = 0; i < roofFrom; i++) if (zResult.codes[i] === DERIVED_GROUND) ground++;
    expect(ground / roofFrom).toBeGreaterThan(0.9);
  });

  it('agrees point for point once told which way is up', () => {
    let same = 0;
    for (let i = 0; i < count; i++) if (zResult.codes[i] === yResult.codes[i]) same++;
    expect(same / count).toBeGreaterThan(0.98);
  });

  it('does not call the roof ground in either frame', () => {
    for (const r of [zResult, yResult]) {
      let roofAsGround = 0;
      for (let i = roofFrom; i < count; i++) if (r.codes[i] === DERIVED_GROUND) roofAsGround++;
      expect(roofAsGround / (count - roofFrom)).toBeLessThan(0.1);
    }
  });

  it('reading a Y-up cloud as Z-up gets it wrong, which is the defect', () => {
    // Not a prescription for what the wrong answer should be — only that the
    // axis genuinely changes it, so the option is not decoration.
    const asIfZ = deriveClassification(yUp, count, { upAxis: 'z' });
    let same = 0;
    for (let i = 0; i < count; i++) if (asIfZ.codes[i] === yResult.codes[i]) same++;
    expect(same / count).toBeLessThan(0.9);
  });

  it('never mutates the caller buffer, which is the live cloud', () => {
    const before = Float32Array.from(yUp);
    deriveClassification(yUp, count, { upAxis: 'y' });
    expect([...yUp]).toEqual([...before]);
  });

  it('defaults to Z-up, so every existing caller is unchanged', () => {
    const noOption = deriveClassification(xyz, count, {});
    expect([...noOption.codes]).toEqual([...zResult.codes]);
  });
});
