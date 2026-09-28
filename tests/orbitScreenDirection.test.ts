/**
 * orbitScreenDirection.test.ts
 *
 * A vertical drag must move the scene vertically on screen, whatever way the
 * camera faces. Drives a real OrbitControls through the NavController the way
 * the Viewer builds them (camera created Y-up, the loaded survey Z-up), poses
 * the camera at four azimuths and two elevations, drags straight down with a
 * mouse and with one finger, and projects the ground point that was under the
 * pointer before and after the drag.
 *
 * OrbitControls fixes its orbit pole from `camera.up` when it is constructed.
 * The camera is Y-up then, so on a Z-up survey a vertical drag turned the
 * camera about the world Y axis: seen from the east or west that is a sideways
 * slide, and seen from the north the tilt ran backwards. The NavController now
 * re-derives the pole whenever the world up changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';
import { stubCanvas, stubTarget } from './helpers/navCanvasStubs';

const W = 800;
const H = 600;

type Rotate = {
  _pointers: number[];
  _handleMouseDownRotate(e: { clientX: number; clientY: number }): void;
  _handleMouseMoveRotate(e: { clientX: number; clientY: number }): void;
  _handleTouchStartRotate(e: { pageX: number; pageY: number }): void;
  _handleTouchMoveRotate(e: { pageX: number; pageY: number }): void;
};

const saved = { window: globalThis.window, document: globalThis.document };
afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

function rig(azimuthDeg: number, elevationDeg: number) {
  globalThis.window = { ...stubTarget(), matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const canvas = stubCanvas();
  // As in viewerRenderBootstrap: the camera starts with three's default Y-up.
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 1e6);
  const controls = new OrbitControls(camera);
  (controls as unknown as { domElement: HTMLCanvasElement }).domElement = canvas;
  controls.enableDamping = true;
  const nav = new NavController(camera, canvas, controls);
  // A LAS survey loads: Z-up.
  nav.setWorldUp(new THREE.Vector3(0, 0, 1));
  const target = new THREE.Vector3(1000, 2000, 50);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const dist = 300;
  camera.position.set(
    target.x + dist * Math.cos(el) * Math.sin(az),
    target.y + dist * Math.cos(el) * Math.cos(az),
    target.z + dist * Math.sin(el),
  );
  camera.up.set(0, 0, 1); // what the framing tween leaves behind
  controls.target.copy(target);
  camera.lookAt(target);
  controls.update();
  camera.updateMatrixWorld();
  return { camera, controls, nav, target };
}

/** The ground point (z = target.z) under screen pixel (sx, sy). */
function groundUnder(camera: THREE.PerspectiveCamera, z: number, sx: number, sy: number): THREE.Vector3 {
  const p = new THREE.Vector3((sx / W) * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera);
  const dir = p.sub(camera.position).normalize();
  const t = (z - camera.position.z) / dir.z;
  return camera.position.clone().addScaledVector(dir, t);
}

function toScreen(camera: THREE.PerspectiveCamera, p: THREE.Vector3): { x: number; y: number } {
  const v = p.clone().project(camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

/**
 * Drag straight down by `dy` px starting at (sx, sy) and let the damping
 * settle. Returns the screen displacement of the ground point that was under
 * the pointer at the start.
 */
function dragDown(kind: 'mouse' | 'touch', azimuthDeg: number, elevationDeg: number, sx: number, sy: number, dy: number) {
  const { camera, controls, nav, target } = rig(azimuthDeg, elevationDeg);
  const grabbed = groundUnder(camera, target.z, sx, sy);
  const before = toScreen(camera, grabbed);
  const c = controls as unknown as Rotate;
  const steps = 10;
  if (kind === 'mouse') {
    c._handleMouseDownRotate({ clientX: sx, clientY: sy });
    for (let i = 1; i <= steps; i++) c._handleMouseMoveRotate({ clientX: sx, clientY: sy + (dy * i) / steps });
  } else {
    c._pointers = [1];
    c._handleTouchStartRotate({ pageX: sx, pageY: sy });
    for (let i = 1; i <= steps; i++) {
      c._handleTouchMoveRotate({ pageX: sx, pageY: sy + (dy * i) / steps });
      controls.update();
    }
    c._pointers = [];
  }
  for (let n = 0; n < 600; n++) nav.update(1 / 60);
  camera.updateMatrixWorld();
  const after = toScreen(camera, grabbed);
  return { dx: after.x - before.x, dy: after.y - before.y };
}

const AZIMUTHS = [0, 90, 180, 270];
const ELEVATIONS = [35, 60];

describe('a vertical drag moves the scene vertically on screen', () => {
  for (const kind of ['mouse', 'touch'] as const) {
    for (const az of AZIMUTHS) {
      for (const el of ELEVATIONS) {
        it(`${kind}, azimuth ${az}°, elevation ${el}°`, () => {
          // The pointer starts below the centre, on the near half of the ground.
          const m = dragDown(kind, az, el, W / 2, H / 2 + 120, 60);
          // Mostly along screen Y: a basis error shows up as sideways motion.
          expect(Math.abs(m.dx)).toBeLessThan(0.2 * Math.abs(m.dy));
          // The grabbed point moves the same way as the pointer (down).
          expect(m.dy).toBeGreaterThan(0);
        });
      }
    }
  }

  it('mouse and touch map the same drag to the same motion', () => {
    for (const az of AZIMUTHS) {
      const a = dragDown('mouse', az, 35, W / 2, H / 2 + 120, 60);
      const b = dragDown('touch', az, 35, W / 2, H / 2 + 120, 60);
      expect(b.dx).toBeCloseTo(a.dx, 3);
      expect(b.dy).toBeCloseTo(a.dy, 3);
    }
  });

  it('a horizontal drag yaws about world up: the pivot stays put and height is kept', () => {
    for (const az of AZIMUTHS) {
      const { camera, controls, nav, target } = rig(az, 35);
      const z0 = camera.position.z;
      const c = controls as unknown as Rotate;
      c._handleMouseDownRotate({ clientX: 300, clientY: 300 });
      c._handleMouseMoveRotate({ clientX: 400, clientY: 300 });
      for (let n = 0; n < 600; n++) nav.update(1 / 60);
      expect(camera.position.z).toBeCloseTo(z0, 6);
      expect(controls.target.distanceTo(target)).toBe(0);
    }
  });
});
