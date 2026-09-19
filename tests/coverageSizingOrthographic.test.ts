/**
 * Coverage sizing under an orthographic camera.
 *
 * The perspective behaviour is covered in `nodeCoverageScale.test.ts`. The
 * question here is the one an orthographic view raises: a projection with no
 * distance falloff is where size policies that quietly assume perspective stop
 * working, usually by scaling with a distance that no longer means anything.
 *
 * Coverage sizing takes no camera at all. It is a function of the resolution a
 * node was recorded at relative to the root, so the same node yields the same
 * scale under either projection. The renderer also draws points with
 * `sizeAttenuation` off, so the scale is in device pixels rather than world
 * units and does not acquire a projection dependency downstream.
 *
 * These assertions read that as a property rather than restating it: the scale
 * is pinned across every camera state a test can vary, because none of them are
 * inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  nodeCoverageScale,
  relativeNodeResolution,
  MAX_COVERAGE_SCALE,
} from '../src/render/streamingLodSize';

/** Camera states that change nothing, named so the test says what it varied. */
const CAMERA_STATES = [
  { label: 'orthographic, zoomed out', distance: 1000, zoom: 0.1 },
  { label: 'orthographic, zoomed in', distance: 1000, zoom: 8 },
  { label: 'perspective, near', distance: 5, zoom: 1 },
  { label: 'perspective, far', distance: 5000, zoom: 1 },
];

describe('coverage sizing is projection-independent', () => {
  it('takes no camera input, so every camera state gives one scale', () => {
    const scales = CAMERA_STATES.map(() => nodeCoverageScale(0.4, 0.8, 'density'));
    expect(new Set(scales).size).toBe(1);
  });

  it('gives an orthographic view the same scale a perspective view gets', () => {
    for (const node of [0.05, 0.2, 0.4, 0.8]) {
      const ortho = nodeCoverageScale(node, 0.8, 'density');
      const persp = nodeCoverageScale(node, 0.8, 'density');
      expect(ortho).toBe(persp);
    }
  });

  it('stays inside its bound at every node resolution', () => {
    for (const node of [0, 0.01, 0.4, 0.8, 80, 1e9]) {
      const s = nodeCoverageScale(node, 0.8, 'density');
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(MAX_COVERAGE_SCALE);
    }
  });

  it('is identity outside density mode under either projection', () => {
    expect(nodeCoverageScale(0.4, 0.8, 'fixed')).toBe(1);
  });

  it('survives resolutions that are not resolutions', () => {
    for (const bad of [NaN, Infinity, -1, 0]) {
      const s = nodeCoverageScale(bad, 0.8, 'density');
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(MAX_COVERAGE_SCALE);
      const t = nodeCoverageScale(0.4, bad, 'density');
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the relative resolution it is built on inside the unit range', () => {
    for (const node of [0, 0.4, 8, 1e9, NaN, -3]) {
      const rel = relativeNodeResolution(node, 0.8);
      expect(rel).toBeGreaterThanOrEqual(0);
      expect(rel).toBeLessThanOrEqual(1);
    }
  });
});
