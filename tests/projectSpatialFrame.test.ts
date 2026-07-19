/**
 * projectSpatialFrame.test.ts
 *
 * The shared project frame's pure transform math. A layer mapped source-local →
 * project-local → world must land at the same absolute coordinates it has today
 * (source-local + its own source origin), every layer must share one project
 * origin so they render at their true relative offsets, and the Float32 residual
 * a layer feeds the GPU must stay small even for survey-scale origins.
 */

import { describe, test, expect } from 'vitest';
import {
  createProjectFrame,
  chooseProjectOrigin,
  layerTransform,
  sourceLocalToProjectLocal,
  projectLocalToSourceLocal,
  projectLocalToWorld,
  worldToProjectLocal,
} from '../src/geo/ProjectSpatialFrame';

type Vec3 = readonly [number, number, number];

describe('chooseProjectOrigin', () => {
  test('is the per-axis floored min over the layer origins', () => {
    const o = chooseProjectOrigin([
      [500123, 4100876, 210],
      [500050, 4100999, 205],
      [500200, 4100800, 260],
    ]);
    expect(o).toEqual([500050, 4100800, 205]);
  });

  test('throws on an empty project — nothing to anchor', () => {
    expect(() => chooseProjectOrigin([])).toThrow();
  });
});

describe('layerTransform round-trips', () => {
  const frame = createProjectFrame([500000, 4100000, 200], { crs: 'UTM 13N', horizontalUnit: 'metre' });

  test('a layer at the project origin maps identically (identity translation)', () => {
    const t = layerTransform(frame, [500000, 4100000, 200]);
    expect(t.sourceToProject).toEqual([0, 0, 0]);
    expect(sourceLocalToProjectLocal(t, [12, 34, 5])).toEqual([12, 34, 5]);
  });

  test('a layer offset from the project origin renders at its true offset', () => {
    // Source origin 300 m east / 120 m north / 10 m up of the project origin.
    const t = layerTransform(frame, [500300, 4100120, 210]);
    expect(t.sourceToProject).toEqual([300, 120, 10]);
    // A point at source-local [0,0,0] sits at project-local [300,120,10].
    expect(sourceLocalToProjectLocal(t, [0, 0, 0])).toEqual([300, 120, 10]);
  });

  test('source-local → project-local → world equals the coordinate it has today', () => {
    const sourceOrigin: Vec3 = [500300, 4100120, 210];
    const t = layerTransform(frame, sourceOrigin);
    const sourceLocal: Vec3 = [4.25, 9.5, 1.75];
    const projectLocal = sourceLocalToProjectLocal(t, sourceLocal);
    const world = projectLocalToWorld(frame, projectLocal);
    // Today's absolute coordinate = source-local + the layer's own source origin.
    expect(world[0]).toBeCloseTo(sourceLocal[0] + sourceOrigin[0], 6);
    expect(world[1]).toBeCloseTo(sourceLocal[1] + sourceOrigin[1], 6);
    expect(world[2]).toBeCloseTo(sourceLocal[2] + sourceOrigin[2], 6);
  });

  test('project-local ↔ source-local is an exact inverse', () => {
    const t = layerTransform(frame, [500300, 4100120, 210]);
    const p: Vec3 = [123.5, -8.25, 3.5];
    const back = projectLocalToSourceLocal(t, sourceLocalToProjectLocal(t, p));
    expect(back).toEqual([p[0], p[1], p[2]]);
  });

  test('world ↔ project-local is an exact inverse', () => {
    const w: Vec3 = [500456.789, 4100234.567, 233.21];
    const back = projectLocalToWorld(frame, worldToProjectLocal(frame, w));
    expect(back[0]).toBeCloseTo(w[0], 6);
    expect(back[1]).toBeCloseTo(w[1], 6);
    expect(back[2]).toBeCloseTo(w[2], 6);
  });
});

describe('precision', () => {
  test('every layer feeds the GPU a small residual despite survey-scale origins', () => {
    // Two clouds a few hundred metres apart at a UTM-scale easting.
    const origins: Vec3[] = [
      [500000, 4100000, 200],
      [500420, 4100310, 240],
    ];
    const frame = createProjectFrame(chooseProjectOrigin(origins), { horizontalUnit: 'metre' });
    for (const o of origins) {
      const t = layerTransform(frame, o);
      // A point 800 m into a cloud, mapped to project-local, must stay within a
      // few km of zero — Float32's sub-mm sweet spot — not carry the 4.1e6 origin.
      const projectLocal = sourceLocalToProjectLocal(t, [800, 800, 50]);
      for (const c of projectLocal) expect(Math.abs(c)).toBeLessThan(5000);
    }
  });
});
