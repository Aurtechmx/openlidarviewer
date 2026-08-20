/**
 * contourOverlay.test.ts
 *
 * The three.js binding that draws analysed contours in the scene. three/webgpu
 * constructs geometries, materials and objects without a GPU, so the lifecycle
 * (upload, replace, dispose), the placement, and the evidence-honesty colour
 * mapping are all provable in Node. What a headless test CANNOT prove is that
 * the result is visible on screen — that is the browser check, and it is called
 * out as such rather than implied by these passing.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { ContourOverlay, vertexColours } from '../src/render/ContourOverlay';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

/** A host that records what the overlay attaches and detaches. */
function fakeHost() {
  const objects: THREE.Object3D[] = [];
  let frames = 0;
  return {
    add: (o: THREE.Object3D) => { objects.push(o); },
    remove: (o: THREE.Object3D) => {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    requestFrame: () => { frames++; },
    objects,
    get frames() { return frames; },
  };
}

/** Two solid segments + one dashed, with one index contour among them. */
function model(): ContourFeatureModel {
  return {
    features: [
      {
        value: 10, grade: 'solid', isIndex: true, closed: false, meanConfidence: 90,
        coordinates: [[0, 0], [10, 0], [20, 5]],
      },
      {
        value: 12, grade: 'dashed', isIndex: false, closed: false, meanConfidence: 40,
        coordinates: [[0, 8], [10, 8]],
      },
    ],
  } as unknown as ContourFeatureModel;
}

const zUpInput = (m = model()) =>
  ({ model: m, format: 'las' as const, renderOrigin: [100, 200, 5] as const });

describe('ContourOverlay — lifecycle', () => {
  it('attaches one object to the host on first build', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    expect(host.objects).toHaveLength(0);
    overlay.setModel(zUpInput());
    expect(host.objects).toHaveLength(1);
    expect(overlay.segmentCount).toBe(3); // 2 from the 3-point line + 1 dashed
    expect(overlay.object).not.toBeNull();
  });

  it('rebuilding REPLACES the object — no stale second overlay is left drawn', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    const first = overlay.object;
    overlay.setModel(zUpInput());
    expect(host.objects).toHaveLength(1);
    expect(host.objects[0]).not.toBe(first);
  });

  it('dispose detaches and is idempotent', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    overlay.dispose();
    expect(host.objects).toHaveLength(0);
    expect(overlay.object).toBeNull();
    expect(overlay.segmentCount).toBe(0);
    expect(() => overlay.dispose()).not.toThrow();
  });

  it('an empty model draws nothing and stays hidden', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel({ ...zUpInput({ features: [] } as unknown as ContourFeatureModel) });
    expect(overlay.segmentCount).toBe(0);
    expect(host.objects[0].visible).toBe(false);
  });

  it('requests a redraw on every state change', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    const after = host.frames;
    overlay.setVisible(false);
    overlay.setOpacity(0.5);
    overlay.setHeightOffset(1);
    expect(host.frames).toBeGreaterThan(after);
  });
});

describe('ContourOverlay — placement', () => {
  it('sits on the scan render origin so the lines land over their own terrain', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    const p = overlay.object!.position;
    expect([p.x, p.y, p.z]).toEqual([100, 200, 5]);
  });

  it('height offset lifts along Z for a survey (Z-up) scan', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    overlay.setHeightOffset(0.5);
    const p = overlay.object!.position;
    expect([p.x, p.y, p.z]).toEqual([100, 200, 5.5]);
  });

  it('height offset lifts along Y for a Y-up mesh scan', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel({ model: model(), format: 'gltf', renderOrigin: [0, 0, 0] });
    overlay.setHeightOffset(2);
    const p = overlay.object!.position;
    expect([p.x, p.y, p.z]).toEqual([0, 2, 0]);
  });

  it('a Y-up scan is built through the rotation, so its northing is negated', () => {
    const host = fakeHost();
    const zUp = new ContourOverlay(host);
    zUp.setModel({ model: model(), format: 'las', renderOrigin: null });
    const zPos = (zUp.object as THREE.LineSegments).geometry.getAttribute('position');

    const yHost = fakeHost();
    const yUp = new ContourOverlay(yHost);
    yUp.setModel({ model: model(), format: 'gltf', renderOrigin: null });
    const yPos = (yUp.object as THREE.LineSegments).geometry.getAttribute('position');

    // canonicalZUpToYUp: (x, y, z) -> (x, z, -y).
    for (let i = 0; i < zPos.count; i++) {
      expect(yPos.getX(i)).toBeCloseTo(zPos.getX(i), 5);
      expect(yPos.getY(i)).toBeCloseTo(zPos.getZ(i), 5);
      expect(yPos.getZ(i)).toBeCloseTo(-zPos.getY(i), 5);
    }
  });

  it('a non-finite height offset degrades to no lift rather than NaN-ing the object', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    overlay.setHeightOffset(Number.NaN);
    const p = overlay.object!.position;
    expect(Number.isFinite(p.z)).toBe(true);
    expect(p.z).toBe(5);
  });
});

describe('ContourOverlay — display state', () => {
  it('setVisible toggles without discarding the upload', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    overlay.setVisible(false);
    expect(overlay.object!.visible).toBe(false);
    expect(overlay.segmentCount).toBe(3); // geometry retained
    overlay.setVisible(true);
    expect(overlay.object!.visible).toBe(true);
  });

  it('opacity is clamped to 0..1 and survives a rebuild', () => {
    const host = fakeHost();
    const overlay = new ContourOverlay(host);
    overlay.setModel(zUpInput());
    overlay.setOpacity(2);
    const mat = (overlay.object as THREE.LineSegments).material as THREE.LineBasicNodeMaterial;
    expect(mat.opacity).toBe(1);
    overlay.setOpacity(-1);
    expect(mat.opacity).toBe(0);
    overlay.setOpacity(0.4);
    overlay.setModel(zUpInput());
    const mat2 = (overlay.object as THREE.LineSegments).material as THREE.LineBasicNodeMaterial;
    expect(mat2.opacity).toBeCloseTo(0.4, 6);
  });
});

describe('vertexColours — evidence honesty', () => {
  const buffers = (grades: number[], isIndex: number[]) => ({
    segmentCount: grades.length,
    grades: Uint8Array.from(grades),
    isIndex: Uint8Array.from(isIndex),
  });

  it('interpolated (dashed) support never renders identically to measured (solid)', () => {
    const c = vertexColours(buffers([0, 1], [0, 0]), true);
    const solid = [c[0], c[1], c[2]];
    const dashed = [c[6], c[7], c[8]];
    expect(solid).not.toEqual(dashed);
  });

  it('dashed is dimmer than solid on every channel — it recedes, never advances', () => {
    const c = vertexColours(buffers([0, 1], [0, 0]), true);
    for (let k = 0; k < 3; k++) expect(c[6 + k]).toBeLessThan(c[k]);
  });

  it('both vertices of a segment carry the same colour', () => {
    const c = vertexColours(buffers([0], [0]), true);
    expect([c[0], c[1], c[2]]).toEqual([c[3], c[4], c[5]]);
  });

  it('index emphasis brightens an index contour, and turning it off equalises them', () => {
    const on = vertexColours(buffers([0, 0], [1, 0]), true);
    expect(on[0] + on[1] + on[2]).toBeGreaterThan(on[6] + on[7] + on[8]);
    const off = vertexColours(buffers([0, 0], [1, 0]), false);
    expect([off[0], off[1], off[2]]).toEqual([off[6], off[7], off[8]]);
  });

  it('every channel stays inside the legal 0..1 range', () => {
    const c = vertexColours(buffers([0, 1, 0], [1, 1, 0]), true);
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
