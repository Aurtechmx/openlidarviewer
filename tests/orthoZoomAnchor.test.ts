/**
 * orthoZoomAnchor.test.ts
 *
 * In orthographic mode a wheel or pinch zoom must keep the world point under
 * the cursor where it is on screen. The displayed camera is the orthographic
 * follower `followPerspective` builds from the perspective master, so every
 * check here builds real three.js cameras, projects the anchor through the
 * follower before and after the step, and measures the move in CSS pixels at
 * the viewport size given.
 *
 * Covers: the helper itself (off-centre, aspect, lens shift, both up axes,
 * repeated steps), the NavController wheel path frame by frame through the
 * inertial tail (wheel notch, trackpad pinch stream, clamped step, reduced
 * motion), and a perspective pin: with orthographic off, the dolly produces
 * the same pose as before this change.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';
import { followPerspective, setLensShift } from '../src/render/camera/orthoCamera';
import {
  lensShiftNdc,
  orthoAnchorShift,
  orthoCursorDolly,
} from '../src/render/camera/orthoZoomAnchor';
import { stubTarget } from './helpers/navCanvasStubs';

type Up = 'z' | 'y';

interface Rig {
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  target: THREE.Vector3;
  width: number;
  height: number;
}

/** A perspective master looking at an off-origin target, with its ortho follower. */
function makeRig(width: number, height: number, up: Up, lens = 0): Rig {
  const persp = new THREE.PerspectiveCamera(60, width / height, 0.01, 1e5);
  const target = new THREE.Vector3(3, -2, 1);
  if (up === 'z') {
    persp.up.set(0, 0, 1);
    persp.position.set(11, -7, 7);
  } else {
    persp.up.set(0, 1, 0);
    persp.position.set(11, 7, -7);
  }
  persp.lookAt(target);
  persp.updateMatrixWorld(true);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1e5);
  if (lens !== 0) setLensShift(persp, ortho, lens);
  else persp.updateProjectionMatrix();
  follow({ persp, ortho, target, width, height });
  return { persp, ortho, target, width, height };
}

/** What the Viewer does every frame: OrbitControls re-aims, the follower copies. */
function follow(r: Rig): void {
  r.persp.lookAt(r.target);
  r.persp.updateMatrixWorld(true);
  followPerspective(r.ortho, r.persp, r.target, r.persp.fov, r.persp.aspect, r.persp.near, r.persp.far);
}

/** World points at several depths that the follower draws under NDC (x, y). */
function anchorsUnder(r: Rig, x: number, y: number): THREE.Vector3[] {
  return [-0.9, -0.4, 0, 0.4, 0.9].map((z) => new THREE.Vector3(x, y, z).unproject(r.ortho));
}

/** Largest on-screen distance, in CSS px, between each anchor and NDC (x, y). */
function driftPx(r: Rig, anchors: THREE.Vector3[], x: number, y: number): number {
  let worst = 0;
  for (const a of anchors) {
    const p = a.clone().project(r.ortho);
    const dx = ((p.x - x) * r.width) / 2;
    const dy = ((p.y - y) * r.height) / 2;
    worst = Math.max(worst, Math.hypot(dx, dy));
  }
  return worst;
}

const CURSOR = { x: 0.62, y: -0.47 };

describe('orthoAnchorShift', () => {
  it('is zero at the axis and when the frustum does not change', () => {
    expect(orthoAnchorShift(0, 0, 2, 1, 1.5)).toEqual({ right: 0, up: 0 });
    expect(orthoAnchorShift(0.5, 0.5, 2, 2, 1.5)).toEqual({ right: 0, up: 0 });
  });

  it('moves toward the cursor on zoom in and away on zoom out', () => {
    const zin = orthoAnchorShift(0.5, -0.25, 2, 1.8, 1.25);
    expect(zin.right).toBeCloseTo(0.5 * 2 * 1.25 * 0.1, 12);
    expect(zin.up).toBeCloseTo(-0.25 * 2 * 0.1, 12);
    const zout = orthoAnchorShift(0.5, -0.25, 2, 2.2, 1.25);
    expect(zout.right).toBeLessThan(0);
    expect(zout.up).toBeGreaterThan(0);
  });

  it('refuses a degenerate frustum', () => {
    expect(orthoAnchorShift(0.5, 0.5, 0, 1, 1)).toEqual({ right: 0, up: 0 });
    expect(orthoAnchorShift(0.5, 0.5, 1, Number.NaN, 1)).toEqual({ right: 0, up: 0 });
  });
});

describe('lensShiftNdc', () => {
  it('reads the shift setLensShift writes, on both cameras', () => {
    const persp = new THREE.PerspectiveCamera(60, 1.25, 0.1, 100);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    expect(lensShiftNdc(persp)).toEqual({ x: 0, y: 0 });
    setLensShift(persp, ortho, 0.14);
    expect(lensShiftNdc(persp).y).toBeCloseTo(0.14, 12);
    expect(lensShiftNdc(ortho).y).toBeCloseTo(0.14, 12);
    expect(lensShiftNdc(persp).x).toBeCloseTo(0, 12);
  });

  it('matches where the follower draws the camera axis', () => {
    const r = makeRig(1000, 800, 'z', 0.14);
    const onAxis = r.target.clone().project(r.ortho);
    expect(onAxis.x).toBeCloseTo(0, 9);
    expect(onAxis.y).toBeCloseTo(lensShiftNdc(r.persp).y, 9);
  });
});

describe('orthoCursorDolly: one step keeps the cursor point on screen', () => {
  const cases: Array<{ name: string; w: number; h: number; up: Up; lens: number }> = [
    { name: '1000×800, Z up', w: 1000, h: 800, up: 'z', lens: 0 },
    { name: '1000×800, Y up', w: 1000, h: 800, up: 'y', lens: 0 },
    { name: '1000×800, Z up, lens shift', w: 1000, h: 800, up: 'z', lens: 0.14 },
    { name: '1000×800, Y up, lens shift', w: 1000, h: 800, up: 'y', lens: -0.09 },
    { name: 'portrait 480×800, Z up, lens shift', w: 480, h: 800, up: 'z', lens: 0.14 },
    { name: 'wide 1600×600, Y up', w: 1600, h: 600, up: 'y', lens: 0 },
  ];
  for (const c of cases) {
    for (const factor of [0.9, 1.1]) {
      it(`${c.name}, distance × ${factor}`, () => {
        const r = makeRig(c.w, c.h, c.up, c.lens);
        const anchors = anchorsUnder(r, CURSOR.x, CURSOR.y);
        expect(driftPx(r, anchors, CURSOR.x, CURSOR.y)).toBeLessThan(1e-6);
        const dist = r.persp.position.distanceTo(r.target);
        expect(orthoCursorDolly(r.persp, r.target, CURSOR.x, CURSOR.y, dist * factor)).toBe(true);
        follow(r);
        expect(r.persp.position.distanceTo(r.target)).toBeCloseTo(dist * factor, 9);
        expect(driftPx(r, anchors, CURSOR.x, CURSOR.y)).toBeLessThan(1e-3);
      });
    }
  }

  it('keeps the camera orientation', () => {
    const r = makeRig(1000, 800, 'z', 0.14);
    const q = r.persp.quaternion.clone();
    orthoCursorDolly(r.persp, r.target, CURSOR.x, CURSOR.y, r.persp.position.distanceTo(r.target) * 0.8);
    follow(r);
    expect(r.persp.quaternion.angleTo(q)).toBeLessThan(1e-9);
  });

  it('does not accumulate drift over many steps in and out', () => {
    const r = makeRig(1000, 800, 'y', 0.14);
    const anchors = anchorsUnder(r, CURSOR.x, CURSOR.y);
    for (let i = 0; i < 400; i++) {
      const d = r.persp.position.distanceTo(r.target);
      const factor = i < 150 ? 0.97 : i < 300 ? 1.025 : i % 2 === 0 ? 0.93 : 1.06;
      orthoCursorDolly(r.persp, r.target, CURSOR.x, CURSOR.y, d * factor);
      follow(r);
    }
    expect(driftPx(r, anchors, CURSOR.x, CURSOR.y)).toBeLessThan(1e-3);
  });

  it('changes nothing for a degenerate distance', () => {
    const r = makeRig(1000, 800, 'z');
    const before = r.persp.position.clone();
    expect(orthoCursorDolly(r.persp, r.target, CURSOR.x, CURSOR.y, 0)).toBe(false);
    expect(orthoCursorDolly(r.persp, r.target, CURSOR.x, CURSOR.y, Number.POSITIVE_INFINITY)).toBe(false);
    expect(r.persp.position.equals(before)).toBe(true);
  });
});

describe('the perspective ray dolly does not anchor the orthographic image', () => {
  // The step NavController applies in perspective: move along the world ray
  // through the cursor by the change in radius, re-seat the target on the
  // unchanged forward vector. Reproduced here to measure it under ortho.
  function rayDolly(r: Rig, x: number, y: number, next: number): void {
    const offset = r.persp.position.clone().sub(r.target);
    const dist = offset.length();
    const dir = new THREE.Vector3(x, y, 0.5).unproject(r.persp).sub(r.persp.position).normalize();
    const forward = offset.multiplyScalar(-1 / dist);
    r.persp.position.addScaledVector(dir, dist - next);
    r.target.copy(r.persp.position).addScaledVector(forward, next);
  }

  it('reproduces the 0.8 → 0.808192 drift (fov 60, aspect 1, distance 1 → 0.9)', () => {
    const persp = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
    persp.position.set(0, 0, 1);
    const target = new THREE.Vector3();
    persp.lookAt(target);
    persp.updateMatrixWorld(true);
    const r: Rig = { persp, ortho: new THREE.OrthographicCamera(), target, width: 1000, height: 1000 };
    follow(r);
    const anchor = new THREE.Vector3(0.8, 0, 0.5).unproject(r.ortho);
    anchor.z = 0; // on the target plane
    expect(anchor.clone().project(r.ortho).x).toBeCloseTo(0.8, 9);
    rayDolly(r, 0.8, 0, 0.9);
    follow(r);
    expect(anchor.clone().project(r.ortho).x).toBeCloseTo(0.808192, 5);
  });
});

// ── NavController: the wheel path frame by frame ───────────────────────────

const W = 1000;
const H = 800;

function stubControls(min = 0, max = Infinity): OrbitControls {
  return {
    enabled: true,
    enableZoom: true,
    minDistance: min,
    maxDistance: max,
    target: new THREE.Vector3(),
    mouseButtons: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    touches: { ONE: 0, TWO: 1 },
    update: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as OrbitControls;
}

function canvas1000x800(): HTMLCanvasElement {
  return {
    ...stubTarget(),
    style: {},
    clientWidth: W,
    clientHeight: H,
    contains: () => false,
    releasePointerCapture: () => {},
    setPointerCapture: () => {},
    requestPointerLock: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  } as unknown as HTMLCanvasElement;
}

interface NavRig extends Rig {
  nav: NavController;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
}

function makeNavRig(opts: {
  orthographic: boolean | undefined;
  up?: Up;
  lens?: number;
  reduce?: boolean;
  min?: number;
  max?: number;
}): NavRig {
  globalThis.window = {
    ...stubTarget(),
    matchMedia: (q: string) => ({ matches: !!opts.reduce && q.includes('prefers-reduced-motion'), media: q }),
  } as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const r = makeRig(W, H, opts.up ?? 'z', opts.lens ?? 0);
  const controls = stubControls(opts.min, opts.max);
  (controls.target as THREE.Vector3).copy(r.target);
  // The rig's target IS the controls' target, as in the app.
  const target = controls.target as THREE.Vector3;
  // OrbitControls re-aims the camera on every update.
  (controls as unknown as { update: () => void }).update = () => {
    r.persp.lookAt(target);
    r.persp.updateMatrixWorld(true);
  };
  const canvas = canvas1000x800();
  const cb = opts.orthographic === undefined ? {} : { isOrthographic: () => opts.orthographic === true };
  const nav = new NavController(r.persp, canvas, controls, cb);
  return { ...r, target, nav, canvas, controls };
}

/** A wheel event over the canvas at CSS pixel (px, py). */
function wheel(rig: NavRig, px: number, py: number, deltaY: number, ctrlKey = false): void {
  const e = {
    target: rig.canvas,
    deltaY,
    deltaMode: 0,
    ctrlKey,
    offsetX: px,
    offsetY: py,
    preventDefault: () => {},
  } as unknown as WheelEvent;
  (rig.nav as unknown as { _handleWheel: (e: WheelEvent) => void })._handleWheel(e);
}

/** Step frames at 60 Hz until the dolly settles; `each` runs after every frame. */
function runFrames(rig: NavRig, each: () => void, maxFrames = 600): number {
  let last = rig.persp.position.clone();
  for (let i = 0; i < maxFrames; i++) {
    rig.nav.update(1 / 60);
    follow(rig);
    each();
    if (rig.persp.position.equals(last)) return i;
    last = rig.persp.position.clone();
  }
  return maxFrames;
}

const PX = { x: 790, y: 610 }; // off-centre CSS pixel
const NDC = { x: (PX.x / W) * 2 - 1, y: -(PX.y / H) * 2 + 1 };

describe('NavController wheel dolly in orthographic mode', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  for (const up of ['z', 'y'] as const) {
    for (const lens of [0, 0.14]) {
      it(`holds the cursor point every frame of a wheel notch (up ${up}, lens ${lens})`, () => {
        const rig = makeNavRig({ orthographic: true, up, lens });
        const anchors = anchorsUnder(rig, NDC.x, NDC.y);
        const d0 = rig.persp.position.distanceTo(rig.target);
        let worst = 0;
        wheel(rig, PX.x, PX.y, -100);
        const frames = runFrames(rig, () => {
          worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
        });
        expect(frames).toBeGreaterThan(2); // the notch glides over several frames
        expect(rig.persp.position.distanceTo(rig.target)).toBeLessThan(d0);
        expect(worst).toBeLessThan(1);
        expect(worst).toBeLessThan(1e-3);
      });
    }
  }

  it('holds the cursor point through a trackpad pinch stream (ctrlKey wheels)', () => {
    const rig = makeNavRig({ orthographic: true, up: 'y', lens: 0.14 });
    const anchors = anchorsUnder(rig, NDC.x, NDC.y);
    const d0 = rig.persp.position.distanceTo(rig.target);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      wheel(rig, PX.x, PX.y, i < 20 ? -3 : 2, true);
      rig.nav.update(1 / 60);
      follow(rig);
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    }
    runFrames(rig, () => {
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    });
    expect(rig.persp.position.distanceTo(rig.target)).not.toBeCloseTo(d0, 3);
    expect(worst).toBeLessThan(1e-3);
  });

  it('anchors a step the minimum distance clamps', () => {
    const rig0 = makeNavRig({ orthographic: true });
    const d0 = rig0.persp.position.distanceTo(rig0.target);
    const min = d0 * 0.97;
    const rig = makeNavRig({ orthographic: true, lens: 0.14, min });
    const anchors = anchorsUnder(rig, NDC.x, NDC.y);
    let worst = 0;
    for (let i = 0; i < 5; i++) wheel(rig, PX.x, PX.y, -100);
    runFrames(rig, () => {
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    });
    expect(rig.persp.position.distanceTo(rig.target)).toBeCloseTo(min, 9);
    expect(worst).toBeLessThan(1e-3);
  });

  it('anchors a step the maximum distance clamps', () => {
    const rig0 = makeNavRig({ orthographic: true });
    const max = rig0.persp.position.distanceTo(rig0.target) * 1.02;
    const rig = makeNavRig({ orthographic: true, up: 'y', max });
    const anchors = anchorsUnder(rig, NDC.x, NDC.y);
    let worst = 0;
    for (let i = 0; i < 5; i++) wheel(rig, PX.x, PX.y, 100);
    runFrames(rig, () => {
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    });
    expect(rig.persp.position.distanceTo(rig.target)).toBeCloseTo(max, 9);
    expect(worst).toBeLessThan(1e-3);
  });

  it('holds the cursor point over many notches in and out', () => {
    const rig = makeNavRig({ orthographic: true, lens: 0.14 });
    const anchors = anchorsUnder(rig, NDC.x, NDC.y);
    let worst = 0;
    for (let n = 0; n < 40; n++) {
      wheel(rig, PX.x, PX.y, n % 3 === 2 ? 120 : -100);
      for (let f = 0; f < 4; f++) {
        rig.nav.update(1 / 60);
        follow(rig);
        worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
      }
    }
    runFrames(rig, () => {
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    });
    expect(worst).toBeLessThan(1e-3);
  });

  it('holds the cursor point under prefers-reduced-motion', () => {
    const rig = makeNavRig({ orthographic: true, reduce: true, lens: 0.14 });
    const anchors = anchorsUnder(rig, NDC.x, NDC.y);
    const d0 = rig.persp.position.distanceTo(rig.target);
    let worst = 0;
    wheel(rig, PX.x, PX.y, -100);
    runFrames(rig, () => {
      worst = Math.max(worst, driftPx(rig, anchors, NDC.x, NDC.y));
    });
    expect(rig.persp.position.distanceTo(rig.target)).toBeLessThan(d0);
    expect(worst).toBeLessThan(1e-3);
  });
});

describe('NavController wheel dolly in perspective is unchanged', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  /** A fixed script: two notches in, one out, a pinch burst, settled at 60 Hz. */
  function script(rig: NavRig): number[] {
    wheel(rig, PX.x, PX.y, -100);
    for (let f = 0; f < 5; f++) rig.nav.update(1 / 60);
    wheel(rig, 300, 200, -100);
    for (let f = 0; f < 7; f++) rig.nav.update(1 / 60);
    wheel(rig, 120, 700, 140);
    for (let f = 0; f < 3; f++) rig.nav.update(1 / 60);
    for (let i = 0; i < 8; i++) {
      wheel(rig, 640, 380, -4, true);
      rig.nav.update(1 / 60);
    }
    runFrames(rig, () => {});
    const p = rig.persp.position;
    const t = rig.target;
    return [p.x, p.y, p.z, t.x, t.y, t.z];
  }

  // The pose this script produced before the orthographic anchoring existed,
  // recorded from the unchanged perspective path.
  const GOLDEN_Z = [
    10.609723105052169, -6.677773784611443, 6.810220895741934,
    3.004415633365979, -1.9244566148075748, 1.1062402919772882,
  ];
  const GOLDEN_Y = [
    10.501364494917672, 6.687638980728516, -6.622789291589324,
    2.896057023231478, -1.868331924918448, 0.9825181800968696,
  ];

  for (const [up, golden] of [['z', GOLDEN_Z], ['y', GOLDEN_Y]] as const) {
    for (const ortho of [undefined, false] as const) {
      it(`matches the recorded pose (up ${up}, isOrthographic ${String(ortho)})`, () => {
        const pose = script(makeNavRig({ orthographic: ortho, up, lens: 0.14 }));
        expect(pose).toHaveLength(6);
        pose.forEach((v, i) => expect(v).toBe(golden[i]));
      });
    }
  }

  it('keeps the perspective cursor ray fixed for one notch', () => {
    const rig = makeNavRig({ orthographic: false });
    const anchor = new THREE.Vector3(NDC.x, NDC.y, 0.5).unproject(rig.persp);
    wheel(rig, PX.x, PX.y, -100);
    runFrames(rig, () => {});
    const p = anchor.clone().project(rig.persp);
    expect(Math.hypot(((p.x - NDC.x) * W) / 2, ((p.y - NDC.y) * H) / 2)).toBeLessThan(1e-3);
  });
});
