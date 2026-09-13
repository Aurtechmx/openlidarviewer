/**
 * navControllerReducedMotion.test.ts
 *
 * `tweenTo` runs the 0.8 s cinematic sweep behind frame-all and every camera
 * preset. A user who asked the OS for less motion gets the same sweep, since
 * the tween reads no preference. This pins the contract: under
 * `prefers-reduced-motion: reduce` the camera lands on the first advance;
 * without it the tween is still in flight after the same step.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';

function stubTarget(): { addEventListener: () => void; removeEventListener: () => void } {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

function stubCanvas(): HTMLCanvasElement {
  return {
    ...stubTarget(),
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    contains: () => false,
    releasePointerCapture: () => {},
    setPointerCapture: () => {},
    requestPointerLock: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
}

function stubControls(): OrbitControls {
  return {
    enabled: true,
    enableZoom: true,
    minDistance: 0,
    maxDistance: Infinity,
    target: new THREE.Vector3(),
    mouseButtons: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    touches: { ONE: 0, TWO: 1 },
    update: () => {},
  } as unknown as OrbitControls;
}

function makeNav(reduce: boolean): { nav: NavController; camera: THREE.PerspectiveCamera } {
  const win = {
    ...stubTarget(),
    matchMedia: (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q }),
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  const nav = new NavController(camera, stubCanvas(), stubControls());
  return { nav, camera };
}

describe('NavController camera tween under prefers-reduced-motion', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  it('lands the camera on the first advance when the user asked for less motion', () => {
    const { nav, camera } = makeNav(true);
    nav.tweenTo(new THREE.Vector3(100, 0, 0), new THREE.Vector3(0, 0, 0));
    nav.update(1 / 60);
    expect(nav.isTweening).toBe(false);
    expect(camera.position.x).toBeCloseTo(100, 6);
  });

  it('keeps the sweep when no preference is set', () => {
    const { nav, camera } = makeNav(false);
    nav.tweenTo(new THREE.Vector3(100, 0, 0), new THREE.Vector3(0, 0, 0));
    nav.update(1 / 60);
    expect(nav.isTweening).toBe(true);
    expect(camera.position.x).toBeLessThan(100);
  });

  it('survives a host with no matchMedia', () => {
    globalThis.window = stubTarget() as unknown as Window & typeof globalThis;
    globalThis.document = stubTarget() as unknown as Document;
    const nav = new NavController(new THREE.PerspectiveCamera(), stubCanvas(), stubControls());
    expect(() => nav.tweenTo(new THREE.Vector3(1, 0, 0), new THREE.Vector3())).not.toThrow();
  });
});
