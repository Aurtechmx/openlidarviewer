/**
 * profileCorridorOverlay.test.ts
 *
 * The 3D sample-corridor overlay. It draws a corridor outline as scene line
 * segments, attaches to its host only while something is shown, and clears
 * cleanly — mirroring the ProfileLinkOverlay lifecycle. A degenerate ('none')
 * outline draws nothing, so an empty section never leaves a stray object.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { ProfileCorridorOverlay } from '../src/render/ProfileCorridorOverlay';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import { buildProfileCorridorOutline } from '../src/render/measure/profileCorridorOutline';

function fakeHost() {
  const added: THREE.Object3D[] = [];
  let frames = 0;
  return {
    added,
    frames: () => frames,
    add(o: THREE.Object3D) {
      added.push(o);
    },
    remove(o: THREE.Object3D) {
      const i = added.indexOf(o);
      if (i >= 0) added.splice(i, 1);
    },
    requestFrame() {
      frames++;
    },
  };
}

const positionCount = (o: THREE.Object3D): number =>
  ((o as THREE.LineSegments).geometry.getAttribute('position')?.count as number) ?? 0;

describe('ProfileCorridorOverlay', () => {
  it('attaches a line object with vertices when shown a capsule outline', () => {
    const host = fakeHost();
    const overlay = new ProfileCorridorOverlay(host);
    const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [0, 0, 1]);
    const outline = buildProfileCorridorOutline(frame, 2);
    expect(outline.kind).toBe('capsule');

    overlay.show(outline);
    expect(host.added).toHaveLength(1);
    expect(host.added[0]).toBeInstanceOf(THREE.LineSegments);
    expect(positionCount(host.added[0]!)).toBeGreaterThan(0);
    expect(host.added[0]!.visible).toBe(true);
    expect(host.frames()).toBeGreaterThan(0);
  });

  it('clears cleanly on null: detaches and hides', () => {
    const host = fakeHost();
    const overlay = new ProfileCorridorOverlay(host);
    const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [0, 0, 1]);
    overlay.show(buildProfileCorridorOutline(frame, 2));
    const obj = host.added[0]!;
    overlay.show(null);
    expect(host.added).toHaveLength(0);
    expect(obj.visible).toBe(false);
  });

  it('draws nothing for a degenerate (none) outline', () => {
    const host = fakeHost();
    const overlay = new ProfileCorridorOverlay(host);
    // A zero-length section with no up gives a degenerate frame → 'none'.
    const frame = buildProfileFrame([1, 1, 1], [1, 1, 1], [0, 0, 0]);
    const outline = buildProfileCorridorOutline(frame, 0);
    overlay.show(outline);
    expect(host.added).toHaveLength(0);
  });

  it('dispose is idempotent and releases the object', () => {
    const host = fakeHost();
    const overlay = new ProfileCorridorOverlay(host);
    const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [0, 0, 1]);
    overlay.show(buildProfileCorridorOutline(frame, 2));
    overlay.dispose();
    overlay.dispose();
    expect(host.added).toHaveLength(0);
    // A show after dispose is a no-op, never a throw.
    expect(() => overlay.show(buildProfileCorridorOutline(frame, 2))).not.toThrow();
    expect(host.added).toHaveLength(0);
  });
});
