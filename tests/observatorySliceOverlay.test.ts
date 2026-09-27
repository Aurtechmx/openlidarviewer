/**
 * observatorySliceOverlay.test.ts: the OB-PR-02 slice plane in the scene.
 * A level change re-fills the one texture and moves the plane; it builds no
 * new geometry. Dispose detaches and releases, and is idempotent.
 */
import { describe, it, expect } from 'vitest';
import type * as THREE from 'three/webgpu';
import { ObservatoryOverlay } from '../src/render/ObservatoryOverlay';

function host() {
  const objects = new Set<THREE.Object3D>();
  return { objects, add: (o: THREE.Object3D) => { objects.add(o); }, remove: (o: THREE.Object3D) => { objects.delete(o); }, requestFrame: () => {} };
}

const field = {
  stateOf: () => 'SHADOWED' as const,
  frontier: new Set<number>(),
  grid: { nx: 4, ny: 3, nz: 5 },
  voxelEdge: 0.5,
  domainMin: [10, 20, 30] as const,
};

describe('ObservatoryOverlay slice plane', () => {
  it('draws one plane at the level, clamps the level, and moves without new geometry', () => {
    const h = host();
    const o = new ObservatoryOverlay(h);
    o.show(field, 2);
    expect(h.objects.size).toBe(1);
    const mesh = [...h.objects][0] as THREE.Mesh;
    const geometry = mesh.geometry;
    expect(mesh.position.z).toBeCloseTo(30 + 2.5 * 0.5, 9);
    o.setLevel(99);
    expect(o.currentLevel).toBe(4);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.position.z).toBeCloseTo(30 + 4.5 * 0.5, 9);
  });

  it('dispose detaches, is idempotent, and a disposed overlay draws nothing', () => {
    const h = host();
    const o = new ObservatoryOverlay(h);
    o.show(field, 0);
    o.dispose();
    o.dispose();
    expect(h.objects.size).toBe(0);
    o.show(field, 0);
    expect(h.objects.size).toBe(0);
    expect(o.currentLevel).toBe(-1);
  });
});
