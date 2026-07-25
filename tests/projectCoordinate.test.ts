/**
 * projectXYZ — the project-space companion to worldXYZ (step 1 of the flip
 * sequence in docs/architecture/float64-transform.md).
 *
 * A point's project-local coordinate is its source-local position plus the
 * layer's Float64 sourceToProject translation — computed at read time, never
 * written into the buffer. With the identity transform (the single-layer
 * case, and every mount today) it must equal the raw source-local position
 * bit for bit, which is what makes each consumer migration a provable no-op.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import {
  createProjectFrame,
  layerTransform,
} from '../src/geo/ProjectSpatialFrame';

function cloud(origin: [number, number, number]): PointCloud {
  const positions = new Float32Array([0.5, 1.25, 2.0, 10.75, 20.5, 3.125]);
  return new PointCloud({
    positions,
    origin,
    sourceFormat: 'las',
    name: 'project-accessor-fixture',
  });
}

describe('projectXYZ', () => {
  it('is the identity for a layer anchoring its own frame', () => {
    const c = cloud([516_000, 4_644_000, 70]);
    const frame = createProjectFrame([516_000, 4_644_000, 70]);
    const t = layerTransform(frame, [516_000, 4_644_000, 70]);
    const p = c.projectXYZ(1, t);
    expect(p).toEqual([c.positions[3], c.positions[4], c.positions[5]]);
  });

  it('adds the Float64 translation for a layer away from the anchor', () => {
    const c = cloud([516_100, 4_644_050, 71]);
    const frame = createProjectFrame([516_000, 4_644_000, 70]);
    const t = layerTransform(frame, [516_100, 4_644_050, 71]);
    const p = c.projectXYZ(0, t);
    expect(p[0]).toBeCloseTo(c.positions[0] + 100, 9);
    expect(p[1]).toBeCloseTo(c.positions[1] + 50, 9);
    expect(p[2]).toBeCloseTo(c.positions[2] + 1, 9);
  });

  it('agrees with worldXYZ through the frame: project + projectOrigin == world', () => {
    // The commuting square that keeps the two lifts honest: lifting to
    // project space and adding the frame's origin must land exactly where
    // the source-frame world lift lands.
    const c = cloud([516_100, 4_644_050, 71]);
    const frame = createProjectFrame([516_000, 4_644_000, 70]);
    const t = layerTransform(frame, [516_100, 4_644_050, 71]);
    for (let i = 0; i < c.pointCount; i++) {
      const w = c.worldXYZ(i);
      const p = c.projectXYZ(i, t);
      expect(p[0] + frame.projectOrigin[0]).toBeCloseTo(w[0], 6);
      expect(p[1] + frame.projectOrigin[1]).toBeCloseTo(w[1], 6);
      expect(p[2] + frame.projectOrigin[2]).toBeCloseTo(w[2], 6);
    }
  });

  it('never touches the buffer', () => {
    const c = cloud([516_100, 4_644_050, 71]);
    const snapshot = Array.from(c.positions);
    const frame = createProjectFrame([516_000, 4_644_000, 70]);
    const t = layerTransform(frame, [516_100, 4_644_050, 71]);
    for (let i = 0; i < c.pointCount; i++) c.projectXYZ(i, t);
    expect(Array.from(c.positions)).toEqual(snapshot);
  });

  it('range-checks like worldXYZ', () => {
    const c = cloud([0, 0, 0]);
    const t = layerTransform(createProjectFrame([0, 0, 0]), [0, 0, 0]);
    expect(() => c.projectXYZ(2, t)).toThrow(RangeError);
    expect(() => c.projectXYZ(-1, t)).toThrow(RangeError);
  });
});
