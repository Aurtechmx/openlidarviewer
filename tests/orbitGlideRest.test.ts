/**
 * orbitGlideRest.test.ts
 *
 * A released drag's damped glide comes to exact rest. OrbitControls shrinks
 * its pending rotation and pan by the damping factor on every update and never
 * reaches zero; `glideAtRest` (orbitFeel.ts) is the floor below which
 * NavController drops the remainder. Checked three ways: the pure predicate,
 * the glide integrated the way OrbitControls integrates it at 30, 60 and
 * 120 Hz, and a NavController driving a real OrbitControls. The arrow-key
 * orbit and the wheel dolly decay their own velocities and go through the
 * same rule (`glideRestRule`); they are checked the same way.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';
import { stepDolly } from '../src/render/wheelDollyMath';
import {
  DAMPING_FACTOR,
  dollyVelocityAtRest,
  glideRestRule,
  orbitVelocityAtRest,
  DAMPING_FACTOR_TOUCH,
  GLIDE_REST_ROTATION_RAD,
  glideAtRest,
  perFrameToDt,
} from '../src/render/orbitFeel';

describe('glideAtRest', () => {
  it('drops a glide whose remaining travel is under the pixels the loop still draws', () => {
    const view = { heightPx: 600, fovYRad: THREE.MathUtils.degToRad(50) };
    // At 1 km and this viewport one pixel is 2 * 1000 * tan(25 deg) / 600 = 1.55 m, i.e. 1.55e-3 rad of arc.
    const px = (2 * 1000 * Math.tan(view.fovYRad / 2)) / 600 / 1000;
    const at = (rot: number, pan: number) => glideAtRest({ theta: rot, phi: 0 }, { x: pan, y: 0, z: 0 }, 1000, DAMPING_FACTOR, view);
    expect(at(1.9 * px, 0).rotation).toBe(true);
    expect(at(2.1 * px, 0).rotation).toBe(false);
    expect(at(0, 1.9 * px * 1000).pan).toBe(true);
    expect(at(0, 2.1 * px * 1000).pan).toBe(false);
  });

  it('compares the per-update share against relative floors without a viewport', () => {
    const k = DAMPING_FACTOR;
    const at = (rot: number, pan: number, dist: number) => glideAtRest({ theta: rot, phi: 0 }, { x: pan, y: 0, z: 0 }, dist, k);
    expect(at((GLIDE_REST_ROTATION_RAD / k) * 0.99, 0, 1000).rotation).toBe(true);
    expect(at((GLIDE_REST_ROTATION_RAD / k) * 1.01, 0, 1000).rotation).toBe(false);
    // Pan scales with the target distance: 1 mm pending is rest at 1 km, not at 1 m.
    expect(at(0, 1e-3, 1000).pan).toBe(true);
    expect(at(0, 1e-3, 1).pan).toBe(false);
    expect(at(0, 0, 0)).toEqual({ rotation: true, pan: true });
  });
});

const VIEW = { heightPx: 600, fovYRad: THREE.MathUtils.degToRad(50) };
/** Two pixels of arc at the target, in radians, for {@link VIEW}. */
const TWO_PX_RAD = (2 * 2 * Math.tan(VIEW.fovYRad / 2)) / VIEW.heightPx;

/** Integrate a released glide the way OrbitControls does, with the rest rule applied first. */
function glide(delta0: number, hz: number, k = DAMPING_FACTOR): { travelled: number; restAtSec: number } {
  const dt = 1 / hz;
  let delta = delta0;
  let travelled = 0;
  for (let n = 0; n < hz * 60; n++) {
    if (glideAtRest({ theta: delta, phi: 0 }, { x: 0, y: 0, z: 0 }, 1000, k, VIEW).rotation) delta = 0;
    if (delta === 0) return { travelled, restAtSec: n * dt };
    const f = perFrameToDt(k, dt);
    travelled += delta * f;
    delta *= 1 - f;
  }
  return { travelled, restAtSec: Infinity };
}

describe('the post-drag glide', () => {
  for (const hz of [30, 60, 120]) {
    for (const k of [DAMPING_FACTOR, DAMPING_FACTOR_TOUCH]) {
      it(`reaches exact rest in bounded time at ${hz} Hz (d = ${k}), short of the undamped limit by under 2 px`, () => {
        for (const flick of [0.2, 0.02, 1e-3]) {
          const g = glide(flick, hz, k);
          expect(g.restAtSec).toBeLessThan(1.5);
          // What was dropped: the glide still to come when the rule tripped.
          const dropped = flick - g.travelled;
          expect(dropped).toBeGreaterThanOrEqual(0);
          expect(dropped).toBeLessThan(TWO_PX_RAD);
        }
      });
    }
  }
});

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

type Internals = { state: number; _sphericalDelta: THREE.Spherical; _panOffset: THREE.Vector3 };

function makeNav() {
  globalThis.window = { ...stubTarget(), matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1e6);
  camera.up.set(0, 0, 1);
  camera.position.set(356_500, 3_971_500, 3500);
  const controls = new OrbitControls(camera);
  controls.target.set(356_500, 3_972_500, 2800);
  controls.enableDamping = true;
  controls.dampingFactor = DAMPING_FACTOR;
  controls.update();
  const nav = new NavController(camera, stubCanvas(), controls);
  return { nav, camera, controls, internals: controls as unknown as Internals };
}

describe('glideRestRule', () => {
  it('rests with nothing left, under the per-update floor, or under 2 px still to come', () => {
    expect(glideRestRule(null, 0, 1)).toBe(true);
    expect(glideRestRule(null, 0.5, 1)).toBe(true);
    expect(glideRestRule(null, 2, 1)).toBe(false);
    expect(glideRestRule(1.9, 2, 1)).toBe(true);
    expect(glideRestRule(2.1, 2, 1)).toBe(false);
  });
});

const KEY_RATE = 8;
const WHEEL_FRICTION = 12;

describe('the arrow-key orbit tail', () => {
  for (const hz of [30, 60, 120]) {
    it(`reaches exact rest in bounded time at ${hz} Hz, short of the undamped limit by under 2 px`, () => {
      for (const v0 of [1.6, 0.4, 0.01]) {
        const dt = 1 / hz;
        const decay = Math.exp(-KEY_RATE * dt);
        let v = v0;
        let travelled = 0;
        let n = 0;
        for (; n < hz * 60; n++) {
          v *= decay;
          if (orbitVelocityAtRest(v, KEY_RATE, 1000, VIEW)) { v = 0; break; }
          travelled += v * dt;
        }
        expect(v).toBe(0);
        expect(n * dt).toBeLessThan(1.5);
        // The undamped limit of the same discrete easing.
        const limit = (v0 * dt * decay) / (1 - decay);
        expect(limit - travelled).toBeGreaterThanOrEqual(0);
        expect(limit - travelled).toBeLessThan(TWO_PX_RAD);
      }
    });
  }
});

describe('the wheel-dolly tail', () => {
  /** Content at the viewport edge moves by heightPx / 2 * |scale - 1|. */
  const edgePx = (logScale: number) => (VIEW.heightPx / 2) * Math.abs(Math.expm1(logScale));
  for (const hz of [30, 60, 120]) {
    it(`reaches exact rest in bounded time at ${hz} Hz, short of the undamped limit by under 2 px`, () => {
      for (const v0 of [4, -4, 0.05]) {
        const dt = 1 / hz;
        let v = v0;
        let logTravel = 0;
        let n = 0;
        for (; n < hz * 60; n++) {
          if (dollyVelocityAtRest(v, WHEEL_FRICTION, VIEW)) { v = 0; break; }
          const s = stepDolly(v, dt, WHEEL_FRICTION);
          logTravel += Math.log(s.scale);
          v = s.velocity;
        }
        expect(v).toBe(0);
        expect(n * dt).toBeLessThan(1.5);
        // Undamped limit of the stepped decay (no per-frame clamp at these speeds).
        const limit = (v0 * dt) / (1 - Math.exp(-WHEEL_FRICTION * dt));
        expect(edgePx(limit - logTravel)).toBeLessThan(2);
      }
    });
  }
});

describe('NavController with OrbitControls', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  it('stops the camera exactly after a released flick and a released pan', () => {
    const { nav, camera, internals } = makeNav();
    internals._sphericalDelta.theta = 0.03;
    internals._sphericalDelta.phi = -0.01;
    internals._panOffset.set(4, -2, 0);
    let still = -1;
    const prev = camera.position.clone();
    for (let n = 0; n < 60 * 5; n++) {
      nav.update(1 / 60);
      if (camera.position.equals(prev)) { still = n; break; }
      prev.copy(camera.position);
    }
    expect(still).toBeGreaterThan(0);
    expect(still).toBeLessThan(60 * 2.5);
    expect(internals._sphericalDelta.theta).toBe(0);
    expect(internals._sphericalDelta.phi).toBe(0);
    expect(internals._panOffset.length()).toBe(0);
    // And stays put.
    const rest = camera.position.clone();
    for (let n = 0; n < 20; n++) nav.update(0.25);
    expect(camera.position.equals(rest)).toBe(true);
  });

  it('leaves the pending motion alone while a drag is in progress', () => {
    const { nav, internals } = makeNav();
    internals.state = 0; // ROTATE
    internals._sphericalDelta.theta = 1e-7;
    internals._panOffset.set(1e-6, 0, 0);
    nav.update(1 / 60);
    expect(internals._sphericalDelta.theta).not.toBe(0);
    expect(internals._panOffset.length()).toBeGreaterThan(0);
  });

  it('stops the arrow-key orbit tail exactly, and leaves a held key at full speed', () => {
    for (const hz of [30, 60, 120]) {
      const { nav, camera, controls } = makeNav();
      const keys = (nav as unknown as { _orbitKeys: { left: boolean } })._orbitKeys;
      const vel = () => (nav as unknown as { _orbitVel: number[] })._orbitVel;
      keys.left = true;
      for (let n = 0; n < hz; n++) nav.update(1 / hz);
      expect(Math.abs(vel()[0])).toBeGreaterThan(1.5);
      keys.left = false;
      let still = -1;
      const prev = camera.position.clone();
      for (let n = 0; n < hz * 5; n++) {
        nav.update(1 / hz);
        if (camera.position.equals(prev)) { still = n; break; }
        prev.copy(camera.position);
      }
      expect(still).toBeGreaterThan(0);
      expect(still / hz).toBeLessThan(1.5);
      expect(vel()).toEqual([0, 0, 0]);
      void controls;
    }
  });

  it('stops the wheel-dolly tail exactly', () => {
    for (const hz of [30, 60, 120]) {
      const { nav, camera } = makeNav();
      const inner = nav as unknown as { _dollyVelocity: number };
      inner._dollyVelocity = -3;
      let still = -1;
      const prev = camera.position.clone();
      for (let n = 0; n < hz * 5; n++) {
        nav.update(1 / hz);
        if (camera.position.equals(prev)) { still = n; break; }
        prev.copy(camera.position);
      }
      expect(still).toBeGreaterThan(0);
      expect(still / hz).toBeLessThan(1.5);
      expect(inner._dollyVelocity).toBe(0);
    }
  });

  it('keeps a live glide above the floor', () => {
    const { nav, internals } = makeNav();
    internals._sphericalDelta.theta = 0.01;
    nav.update(1 / 60);
    expect(internals._sphericalDelta.theta).toBeCloseTo(0.01 * (1 - DAMPING_FACTOR), 12);
  });
});
