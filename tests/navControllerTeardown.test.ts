/**
 * The Ctrl-state reset was registered as its own anonymous `blur` listener:
 *
 *     window.addEventListener('blur', () => { this._ctrlHeld = false; });
 *
 * `dispose()` held no reference to that closure, so it could not remove it. The
 * listener survived teardown, and because it closes over `this` it kept the
 * whole controller (camera, canvas, OrbitControls) reachable. Two window
 * `blur` handlers also meant the two focus-loss resets could drift apart.
 *
 * The reset now lives in `_handleBlur`, which the stored `_onBlur` already
 * calls and `dispose()` already removes.
 *
 * A recording stub rather than jsdom: the claim is that every registration is
 * matched by a removal of the same handler, which only a counting stub shows.
 * The camera is a real three.js object because the controller does maths on it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { NavController } from '../src/render/NavController';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

interface Registration {
  type: string;
  handler: unknown;
}

interface TargetStub {
  added: Registration[];
  removed: Registration[];
  addEventListener(type: string, handler: unknown, options?: unknown): void;
  removeEventListener(type: string, handler: unknown): void;
}

function makeTarget(): TargetStub {
  const target: TargetStub = {
    added: [],
    removed: [],
    addEventListener: (type, handler) => void target.added.push({ type, handler }),
    removeEventListener: (type, handler) => void target.removed.push({ type, handler }),
  };
  return target;
}

function makeCanvas(): TargetStub & { style: Record<string, string> } {
  const base = makeTarget();
  return {
    ...base,
    addEventListener: base.addEventListener,
    removeEventListener: base.removeEventListener,
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    contains: () => false,
    releasePointerCapture: () => {},
    setPointerCapture: () => {},
    requestPointerLock: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as TargetStub & { style: Record<string, string> };
}

function makeControls(): OrbitControls {
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

/**
 * A registration is only removable if the same handler reference comes back.
 * Compares by (type, handler identity) so an anonymous closure can never be
 * counted as matched by a same-named removal.
 */
function unmatched(target: TargetStub): Registration[] {
  const pool = [...target.removed];
  const left: Registration[] = [];
  for (const reg of target.added) {
    const i = pool.findIndex((r) => r.type === reg.type && r.handler === reg.handler);
    if (i === -1) left.push(reg);
    else pool.splice(i, 1);
  }
  return left;
}

describe('NavController listener teardown', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  let win: TargetStub;
  let docTarget: TargetStub;
  let canvas: TargetStub & { style: Record<string, string> };
  let nav: NavController | null = null;

  beforeEach(() => {
    win = makeTarget();
    docTarget = makeTarget();
    canvas = makeCanvas();
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = docTarget as unknown as Document;
    nav = new NavController(
      new THREE.PerspectiveCamera(),
      canvas as unknown as HTMLCanvasElement,
      makeControls(),
    );
  });

  afterEach(() => {
    nav = null;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  it('registers exactly one window blur handler', () => {
    // Two of them was the tell: the second was the anonymous Ctrl reset.
    expect(win.added.filter((r) => r.type === 'blur')).toHaveLength(1);
  });

  it('leaves no listener behind after dispose', () => {
    nav?.dispose();
    expect(unmatched(win)).toEqual([]);
    expect(unmatched(docTarget)).toEqual([]);
    expect(unmatched(canvas)).toEqual([]);
  });

  it('still resets the Ctrl flag on focus loss', () => {
    const ctrlDown = win.added.filter((r) => r.type === 'keydown');
    // Two keydown registrations exist (movement keys and the Ctrl tracker);
    // feed the event to both, since only one of them cares.
    for (const r of ctrlDown) {
      (r.handler as (e: Partial<KeyboardEvent>) => void)({
        type: 'keydown',
        ctrlKey: true,
        code: 'ControlLeft',
        preventDefault: () => {},
      });
    }
    const held = (): boolean => (nav as unknown as { _ctrlHeld: boolean })._ctrlHeld;
    expect(held()).toBe(true);

    const blur = win.added.find((r) => r.type === 'blur');
    (blur?.handler as () => void)();
    // Without this the flag stays stuck after a mid-chord tab switch and every
    // later trackpad pinch is handed to the browser instead of the camera.
    expect(held()).toBe(false);
  });

  it('reaches the Ctrl reset through the same handler dispose removes', () => {
    const blur = win.added.find((r) => r.type === 'blur');
    nav?.dispose();
    const removedBlur = win.removed.filter((r) => r.type === 'blur');
    expect(removedBlur).toHaveLength(1);
    expect(removedBlur[0].handler).toBe(blur?.handler);
  });
});
