/**
 * navMotionOwnership.test.ts
 *
 * One residual motion at a time. A released orbit glide, a pan glide, the
 * wheel-dolly tail and the arrow-key orbit each decay on their own; a new
 * input or a tween drops the others (NavController `_cancelMotionExcept`).
 * Driven through a real OrbitControls at a fixed 60 Hz step.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';
import { stubCanvas, stubTarget } from './helpers/navCanvasStubs';
import { DAMPING_FACTOR } from '../src/render/orbitFeel';

type Internals = { _sphericalDelta: THREE.Spherical; _panOffset: THREE.Vector3 };
type Hooks = {
  _dollyVelocity: number;
  _handleWheel(e: unknown): void;
  _handlePanPointerDown(e: unknown): void;
  _handlePanPointerMove(e: unknown): void;
};

const saved = { window: globalThis.window, document: globalThis.document };
afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

function makeNav() {
  globalThis.window = { ...stubTarget(), matchMedia: () => ({ matches: false }), innerHeight: 800 } as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const canvas = stubCanvas();
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1e6);
  const controls = new OrbitControls(camera);
  (controls as unknown as { domElement: HTMLCanvasElement }).domElement = canvas;
  controls.enableDamping = true;
  controls.dampingFactor = DAMPING_FACTOR;
  const nav = new NavController(camera, canvas, controls);
  nav.setWorldUp(new THREE.Vector3(0, 0, 1));
  camera.position.set(0, -250, 170);
  controls.update();
  const hooks = nav as unknown as Hooks;
  const wheel = (x = 600, y = 200) =>
    hooks._handleWheel({ target: canvas, deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, offsetX: x, offsetY: y, preventDefault: () => {} });
  const run = (n: number) => { for (let k = 0; k < n; k++) nav.update(1 / 60); };
  return { nav, camera, controls, hooks, internals: controls as unknown as Internals, wheel, run };
}

const azimuth = (c: THREE.Camera, t: THREE.Vector3) => Math.atan2(c.position.y - t.y, c.position.x - t.x);

describe('motion ownership', () => {
  it('a wheel zoom drops the orbit glide and keeps the point under the cursor', () => {
    const h = makeNav();
    h.internals._sphericalDelta.theta = 0.3;
    h.internals._panOffset.set(5, 0, 0);
    h.camera.updateMatrixWorld();
    const dir = new THREE.Vector3(0.5, 1 / 3, 0.5).unproject(h.camera).sub(h.camera.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().subVectors(h.controls.target, h.camera.position).normalize(), h.controls.target);
    const anchor = new THREE.Ray(h.camera.position.clone(), dir).intersectPlane(plane, new THREE.Vector3())!;
    const a0 = azimuth(h.camera, h.controls.target);
    const d0 = h.camera.position.distanceTo(h.controls.target);
    for (let k = 0; k < 3; k++) h.wheel();
    let worst = 0;
    for (let k = 0; k < 60; k++) {
      h.run(1);
      h.camera.updateMatrixWorld();
      const s = anchor.clone().project(h.camera);
      worst = Math.max(worst, Math.hypot((s.x + 1) * 400 - 600, (1 - s.y) * 300 - 200));
    }
    expect(h.camera.position.distanceTo(h.controls.target)).toBeLessThan(d0 * 0.9);
    expect(Math.abs(azimuth(h.camera, h.controls.target) - a0)).toBeLessThan(1e-9);
    expect(worst).toBeLessThan(0.5);
  });

  it('an orbit drag drops the dolly tail, so the pivot stays put', () => {
    const h = makeNav();
    h.wheel();
    h.run(1);
    expect(h.hooks._dollyVelocity).not.toBe(0);
    h.controls.dispatchEvent({ type: 'start' });
    expect(h.hooks._dollyVelocity).toBe(0);
    const t0 = h.controls.target.clone();
    const d0 = h.camera.position.distanceTo(t0);
    h.run(30);
    expect(h.controls.target.distanceTo(t0)).toBe(0);
    expect(h.camera.position.distanceTo(h.controls.target)).toBeCloseTo(d0, 9);
  });

  it('an orbit drag keeps its own glide', () => {
    const h = makeNav();
    h.internals._sphericalDelta.theta = 0.05;
    h.controls.dispatchEvent({ type: 'start' });
    expect(h.internals._sphericalDelta.theta).toBe(0.05);
  });

  it('a hand-tool grab inherits no orbit, pan or dolly tail', () => {
    const h = makeNav();
    h.nav.setMode('pan');
    h.internals._sphericalDelta.theta = 0.3;
    h.internals._panOffset.set(20, 0, 0);
    h.hooks._dollyVelocity = 4;
    const a0 = azimuth(h.camera, h.controls.target);
    const d0 = h.camera.position.distanceTo(h.controls.target);
    const p = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 400, clientY: 300, offsetX: 400, offsetY: 300, preventDefault: () => {} };
    h.hooks._handlePanPointerDown(p);
    for (let k = 1; k <= 20; k++) {
      h.hooks._handlePanPointerMove({ ...p, clientX: 400 + 5 * k, offsetX: 400 + 5 * k });
      h.run(1);
    }
    expect(Math.abs(azimuth(h.camera, h.controls.target) - a0)).toBeLessThan(1e-9);
    expect(h.camera.position.distanceTo(h.controls.target)).toBeCloseTo(d0, 6);
  });

  it('a tween starts from rest and the camera stays where it lands', () => {
    for (const residual of ['orbit', 'pan', 'dolly'] as const) {
      const h = makeNav();
      if (residual === 'orbit') h.internals._sphericalDelta.theta = 0.3;
      if (residual === 'pan') h.internals._panOffset.set(30, 0, 0);
      if (residual === 'dolly') h.hooks._dollyVelocity = 6;
      const toPos = new THREE.Vector3(50, -150, 120);
      const toTarget = new THREE.Vector3(50, 50, 0);
      h.nav.tweenTo(toPos, toTarget, 0.8);
      h.run(49);
      expect(h.camera.position.distanceTo(toPos)).toBeLessThan(1e-9);
      h.run(600);
      expect(h.camera.position.distanceTo(toPos)).toBeLessThan(1e-9);
      expect(h.controls.target.distanceTo(toTarget)).toBeLessThan(1e-9);
    }
  });

  it('dispose removes the orbit-start listener', () => {
    const h = makeNav();
    h.nav.dispose();
    h.hooks._dollyVelocity = 4;
    h.controls.dispatchEvent({ type: 'start' });
    expect(h.hooks._dollyVelocity).toBe(4);
  });
});
