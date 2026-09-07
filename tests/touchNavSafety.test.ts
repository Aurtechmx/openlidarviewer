/**
 * touchNavSafety.test.ts — three touch-navigation defects that reached a user
 * as a wrong camera, a thrown click, or a focus they never asked for.
 *
 *   TWIST. Yaw rotated the camera offset in a fixed XY plane, written when +Z
 *   was the only world up. `_worldUp` has been dynamic since, and on a Y-up
 *   cloud — which is what a phone scan is — that plane is vertical, so a twist
 *   changed the camera's HEIGHT instead of its heading.
 *
 *   POINTER LOCK. Walk/Fly asked for the lock with no capability check, so a
 *   canvas without the API threw a TypeError out of the click handler.
 *
 *   CANCEL. `pointercancel` was aliased to the pointer-up handler, so an
 *   interrupted touch arrived as a completed tap and could focus the camera.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { Viewer } from '../src/render/Viewer';
import { NavController } from '../src/render/NavController';
import { TouchTapGate } from '../src/render/touchTapGate';

/** The slice of a Viewer `_applyTouchGesture` reads, with a stubbed controls. */
function orbitAt(pos: [number, number, number], up: [number, number, number]) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(...pos);
  return {
    _camera: camera,
    _worldUp: new THREE.Vector3(...up),
    _controls: {
      target: new THREE.Vector3(),
      update: () => {},
      minDistance: 0.1,
      maxDistance: 1000,
    },
  };
}

const twist = (host: ReturnType<typeof orbitAt>, dTwist: number) =>
  (Viewer.prototype as unknown as {
    _applyTouchGesture: (d: { dPinch: number; dTwist: number; dPan: { x: number; y: number } }) => void;
  })._applyTouchGesture.call(host, { dPinch: 0, dTwist, dPan: { x: 0, y: 0 } });

describe('touch twist', () => {
  it('keeps the camera at its height above a Y-up scene', () => {
    const host = orbitAt([10, 5, 0], [0, 1, 0]);
    twist(host, Math.PI / 2);
    // The defect put this at 10: the rotation was applied in the XY plane,
    // which on a Y-up scene is the vertical one.
    expect(host._camera.position.y).toBeCloseTo(5, 6);
  });

  it('yaws around the up axis on a Y-up scene', () => {
    const host = orbitAt([10, 5, 0], [0, 1, 0]);
    twist(host, Math.PI / 2);
    // A quarter turn about +Y takes +X to −Z.
    expect(host._camera.position.x).toBeCloseTo(0, 6);
    expect(host._camera.position.z).toBeCloseTo(-10, 6);
  });

  it('still keeps the camera at its height on a Z-up scene', () => {
    const host = orbitAt([10, 0, 5], [0, 0, 1]);
    twist(host, Math.PI / 2);
    expect(host._camera.position.z).toBeCloseTo(5, 6);
    expect(host._camera.position.y).toBeCloseTo(10, 6);
  });

  it('preserves orbit distance on either orientation', () => {
    for (const up of [[0, 1, 0], [0, 0, 1]] as [number, number, number][]) {
      const host = orbitAt([10, 5, 0], up);
      const before = host._camera.position.length();
      twist(host, 0.7);
      expect(host._camera.position.length()).toBeCloseTo(before, 6);
    }
  });
});

describe('Walk/Fly pointer lock', () => {
  /**
   * A host on the real prototype, so the handler reaches its own helpers.
   *
   * A bare object literal cannot: `_handleCanvasClick` calls
   * `this._requestPointerLock`, which lives on the prototype, and the call
   * would fail for a reason that has nothing to do with what is being tested.
   */
  const click = (fields: Record<string, unknown>) => {
    const host = Object.assign(Object.create(NavController.prototype), fields);
    (host as { _handleCanvasClick: () => void })._handleCanvasClick();
  };

  it('does not throw when the canvas has no pointer-lock API', () => {
    // A tap in Walk mode threw a TypeError straight out of the handler.
    expect(() => click({ _inputEnabled: true, _mode: 'walk', _locked: false, _canvas: {} })).not.toThrow();
  });

  it('does not throw when the request rejects', () => {
    const canvas = { requestPointerLock: () => Promise.reject(new Error('denied')) };
    expect(() => click({ _inputEnabled: true, _mode: 'fly', _locked: false, _canvas: canvas })).not.toThrow();
  });

  it('does not throw when the request throws synchronously', () => {
    const canvas = { requestPointerLock: () => { throw new Error('refused'); } };
    expect(() => click({ _inputEnabled: true, _mode: 'walk', _locked: false, _canvas: canvas })).not.toThrow();
  });

  it('still asks for the lock when the API is there', () => {
    let asked = 0;
    const canvas = { requestPointerLock: () => { asked += 1; } };
    click({ _inputEnabled: true, _mode: 'walk', _locked: false, _canvas: canvas });
    expect(asked).toBe(1);
  });
});

describe('a cancelled touch', () => {
  it('cannot complete a double tap', () => {
    const g = new TouchTapGate();
    g.down(1, 20, 20);
    expect(g.up(0, 100, 20, 20)).toBeNull(); // first tap, no focus yet
    g.down(1, 20, 20);
    g.cancel(); // the browser took the touch away
    expect(g.up(0, 200, 20, 20)).toBeNull();
  });

  it('cannot seed the next double tap either', () => {
    const g = new TouchTapGate();
    g.down(1, 20, 20);
    g.cancel();
    g.up(0, 100, 20, 20);
    // A real tap after a cancelled one is the FIRST tap of a new sequence.
    g.down(1, 20, 20);
    expect(g.up(0, 200, 20, 20)).toBeNull();
  });

  it('leaves a deliberate double tap working', () => {
    const g = new TouchTapGate();
    g.down(1, 20, 20);
    expect(g.up(0, 100, 20, 20)).toBeNull();
    g.down(1, 20, 20);
    expect(g.up(0, 200, 20, 20)).toEqual({ x: 20, y: 20 });
  });
});
