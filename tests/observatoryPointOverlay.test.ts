/**
 * observatoryPointOverlay.test.ts
 *
 * The three.js binding for OB-PR-01's per-point presentation. three/webgpu
 * builds geometries and materials without a GPU, so the no-geometry-rebuild
 * guarantee (position attribute identity survives repeated colour updates)
 * and the attach/dispose lifecycle are provable headlessly. Visibility on an
 * actual screen is a browser concern this file does not touch.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { ObservationPointOverlay } from '../src/render/observation/ObservationPointOverlay';

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

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

describe('ObservationPointOverlay — OB-PR-01 no-geometry-rebuild', () => {
  it('creates the position attribute once in attach() and never replaces it across setColors() calls', () => {
    const host = fakeHost();
    const overlay = new ObservationPointOverlay(host);
    overlay.attach(positions);
    const posAttr1 = overlay.positionAttribute;
    expect(posAttr1).not.toBeNull();
    expect(posAttr1!.count).toBe(3);

    overlay.setColors(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]));
    const posAttr2 = overlay.positionAttribute;

    overlay.setColors(new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3]));
    const posAttr3 = overlay.positionAttribute;

    // Same object identity across every field-version update: no rebuild.
    expect(posAttr2).toBe(posAttr1);
    expect(posAttr3).toBe(posAttr1);
    // The position array's own bytes never moved either.
    expect(posAttr3!.array).toBe(positions);
  });

  it('attaches to the host only on the first setColors(), not on attach() alone', () => {
    const host = fakeHost();
    const overlay = new ObservationPointOverlay(host);
    overlay.attach(positions);
    expect(host.objects.length).toBe(0);
    overlay.setColors(new Uint8Array(9));
    expect(host.objects.length).toBe(1);
  });

  it('refuses a colour buffer whose length disagrees with the point count', () => {
    const host = fakeHost();
    const overlay = new ObservationPointOverlay(host);
    overlay.attach(positions);
    expect(() => overlay.setColors(new Uint8Array(6))).toThrow();
  });

  it('dispose() detaches, releases geometry/material, and is idempotent', () => {
    const host = fakeHost();
    const overlay = new ObservationPointOverlay(host);
    overlay.attach(positions);
    overlay.setColors(new Uint8Array(9));
    expect(host.objects.length).toBe(1);

    overlay.dispose();
    expect(host.objects.length).toBe(0);
    expect(overlay.positionAttribute).toBeNull();
    expect(overlay.pointCount).toBe(0);

    // Second dispose is a no-op, not an error.
    expect(() => overlay.dispose()).not.toThrow();
  });

  it('a disposed overlay ignores further setColors() calls', () => {
    const host = fakeHost();
    const overlay = new ObservationPointOverlay(host);
    overlay.attach(positions);
    overlay.dispose();
    expect(() => overlay.setColors(new Uint8Array(9))).not.toThrow();
    expect(host.objects.length).toBe(0);
  });
});
