/**
 * objectMetrics.test.ts — OBB dimensions, envelope volume, spacing, completeness.
 */

import { describe, it, expect } from 'vitest';
import { objectMetrics } from '../src/terrain/objectMetrics';

/** A solid-ish 4×2×1 box sampled on a 0.25 grid, optionally rotated about Z. */
function box(rotRad = 0): Float32Array {
  const out: number[] = [];
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  for (let x = 0; x <= 4; x += 0.25)
    for (let y = 0; y <= 2; y += 0.25)
      for (let z = 0; z <= 1; z += 0.25) {
        out.push(x * c - y * s, x * s + y * c, z);
      }
  return Float32Array.from(out);
}

describe('objectMetrics', () => {
  it('measures box dimensions and envelope volume', () => {
    const m = objectMetrics(box(0));
    expect(m.obb.lengthM).toBeCloseTo(4, 1);
    expect(m.obb.widthM).toBeCloseTo(2, 1);
    expect(m.obb.heightM).toBeCloseTo(1, 1);
    expect(m.envelopeVolumeM3).toBeCloseTo(8, 0);
  });

  it('OBB recovers a rotated box that the AABB over-states', () => {
    const m = objectMetrics(box(Math.PI / 6)); // 30°
    // Oriented box stays true to the real side lengths…
    expect(m.obb.lengthM).toBeCloseTo(4, 1);
    expect(m.obb.widthM).toBeCloseTo(2, 1);
    // …while the axis-aligned box is inflated by the rotation.
    expect(m.aabb.lengthM).toBeGreaterThan(m.obb.lengthM + 0.2);
  });

  it('median spacing reflects the sample grid', () => {
    const m = objectMetrics(box(0), { probeSamples: 1500 });
    expect(m.medianSpacingM).toBeGreaterThan(0.2);
    expect(m.medianSpacingM).toBeLessThan(0.4);
  });

  it('completeness is high for a full sphere shell, low for a flat plane', () => {
    const sphere: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const u = Math.random(), v = Math.random();
      const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
      sphere.push(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph));
    }
    const sm = objectMetrics(Float32Array.from(sphere));
    expect(sm.completenessPct).toBeGreaterThan(85);

    const plane: number[] = [];
    for (let x = 0; x <= 20; x += 0.5) for (let y = 0; y <= 20; y += 0.5) plane.push(x, y, 0);
    const pm = objectMetrics(Float32Array.from(plane));
    expect(pm.completenessPct).toBeLessThan(60);
  });
});
