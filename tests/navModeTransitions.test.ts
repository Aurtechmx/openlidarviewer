/**
 * Getting back to Orbit from Walk / Fly.
 *
 * Reported: after pressing Walk or Fly, pressing Orbit in the navigation dock
 * does nothing. The mode state machine is not the cause. `NavController.
 * setMode` has no guard against walk/fly as the outgoing mode, so every ordered
 * pair of the four modes switches when the setter is reached (the matrix below
 * pins that).
 *
 * The cause is pointer lock. A click on the canvas in walk/fly calls
 * `canvas.requestPointerLock()`; from that moment the browser delivers every
 * mouse event to the canvas rather than to the element under the cursor, and
 * hides the cursor. The dock buttons are outside the locked element, so their
 * click handlers never run and the setter is never reached. Before the fix the
 * only exits were the Esc key (browser default) and the 1/2/3/4 shortcuts.
 *
 * `clickAimedAtDock` below models that delivery rule: while the canvas holds
 * the lock, the click goes to the canvas; otherwise it reaches the dock button.
 *
 * A recording stub rather than jsdom, matching navControllerTeardown.test.ts:
 * jsdom implements neither pointer lock nor hit testing, so the delivery rule
 * has to be modelled explicitly either way. The camera is a real three.js
 * object because the controller does maths on it during a transition.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { NavController } from '../src/render/NavController';
import type { NavMode } from '../src/render/NavController';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

type Handler = (event?: unknown) => void;

interface Bus {
  addEventListener(type: string, handler: Handler, options?: unknown): void;
  removeEventListener(type: string, handler: Handler): void;
  dispatch(type: string, event?: unknown): void;
}

function makeBus(): Bus {
  const listeners: { type: string; handler: Handler }[] = [];
  return {
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const i = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (i !== -1) listeners.splice(i, 1);
    },
    dispatch(type, event) {
      for (const l of [...listeners]) if (l.type === type) l.handler(event);
    },
  };
}

/** The stub document, holding the one piece of state the bug turns on. */
interface DocStub extends Bus {
  pointerLockElement: unknown;
  exitPointerLock(): void;
}

function makeControls(): OrbitControls {
  return {
    enabled: true,
    enableZoom: true,
    minDistance: 0,
    maxDistance: Infinity,
    target: new THREE.Vector3(0, 0, -10),
    mouseButtons: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    touches: { ONE: 0, TWO: 1 },
    update: () => {},
  } as unknown as OrbitControls;
}

const MODES: NavMode[] = ['orbit', 'pan', 'walk', 'fly'];

describe('navigation mode transitions', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  let doc: DocStub;
  let canvasBus: Bus;
  let canvas: unknown;
  let nav: NavController;

  /** A click on the 3-D canvas. */
  const clickCanvas = (): void => canvasBus.dispatch('click');

  /**
   * A click the user aims at a dock mode button, delivered the way a browser
   * delivers it: to the locked element while pointer lock is held, to the
   * button otherwise. The button handler is `NavBar`'s: it calls the setter.
   */
  const clickAimedAtDock = (mode: NavMode): void => {
    if (doc.pointerLockElement) clickCanvas();
    else nav.setMode(mode);
  };

  const pressKey = (code: string): void =>
    (globalThis.window as unknown as Bus).dispatch('keydown', {
      code,
      type: 'keydown',
      ctrlKey: false,
      preventDefault: () => {},
    });

  beforeEach(() => {
    const windowBus = makeBus();
    canvasBus = makeBus();
    const docBus = makeBus();
    doc = {
      ...docBus,
      pointerLockElement: null,
      exitPointerLock() {
        doc.pointerLockElement = null;
        docBus.dispatch('pointerlockchange');
      },
    };
    canvas = {
      ...canvasBus,
      style: {} as Record<string, string>,
      clientWidth: 800,
      clientHeight: 600,
      contains: () => false,
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      requestPointerLock() {
        doc.pointerLockElement = canvas;
        docBus.dispatch('pointerlockchange');
      },
    };
    globalThis.window = windowBus as unknown as Window & typeof globalThis;
    globalThis.document = doc as unknown as Document;
    nav = new NavController(
      new THREE.PerspectiveCamera(),
      canvas as HTMLCanvasElement,
      makeControls(),
    );
    nav.setHasCloud(true);
  });

  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  describe('every ordered pair of modes', () => {
    for (const from of MODES) {
      for (const to of MODES) {
        if (from === to) continue;
        it(`switches ${from} to ${to}`, () => {
          nav.setMode(from);
          expect(nav.mode).toBe(from);
          nav.setMode(to);
          expect(nav.mode).toBe(to);
        });
      }
    }
  });

  describe('pointer lock', () => {
    it('locks the pointer when the scan is clicked in walk', () => {
      nav.setMode('walk');
      clickCanvas();
      expect(nav.pointerLocked).toBe(true);
      expect(doc.pointerLockElement).toBe(canvas);
    });

    it('locks the pointer when the scan is clicked in fly', () => {
      nav.setMode('fly');
      clickCanvas();
      expect(nav.pointerLocked).toBe(true);
    });

    it('never locks the pointer in orbit or pan', () => {
      for (const mode of ['orbit', 'pan'] as NavMode[]) {
        nav.setMode(mode);
        clickCanvas();
        expect(nav.pointerLocked).toBe(false);
      }
    });

    for (const from of ['walk', 'fly'] as NavMode[]) {
      for (const to of ['orbit', 'pan'] as NavMode[]) {
        it(`releases the lock on ${from} to ${to}`, () => {
          nav.setMode(from);
          clickCanvas();
          expect(nav.pointerLocked).toBe(true);
          nav.setMode(to);
          expect(nav.mode).toBe(to);
          expect(nav.pointerLocked).toBe(false);
          expect(doc.pointerLockElement).toBe(null);
        });
      }
    }

    it('keeps mouse-look across walk and fly', () => {
      // Both modes are mouse-look modes and the dock is unreachable while the
      // lock is held, so this transition only ever arrives from the keyboard.
      // Dropping the lock there would interrupt a look the user is in.
      nav.setMode('walk');
      clickCanvas();
      nav.setMode('fly');
      expect(nav.mode).toBe('fly');
      expect(nav.pointerLocked).toBe(true);
      nav.setMode('walk');
      expect(nav.pointerLocked).toBe(true);
    });

    it('hands the cursor back on a click while mouse-look is engaged', () => {
      nav.setMode('walk');
      clickCanvas();
      expect(nav.pointerLocked).toBe(true);
      // The click a user aiming at the dock actually produces: the browser
      // routes it to the locked canvas. It has to end the capture, or the
      // dock stays unreachable to the mouse.
      clickCanvas();
      expect(nav.pointerLocked).toBe(false);
      expect(doc.pointerLockElement).toBe(null);
      expect(nav.mode).toBe('walk');
    });
  });

  describe('reaching Orbit from a locked walk or fly', () => {
    for (const from of ['walk', 'fly'] as NavMode[]) {
      for (const to of ['orbit', 'pan'] as NavMode[]) {
        it(`reaches ${to} from a locked ${from} with the mouse alone`, () => {
          nav.setMode(from);
          clickCanvas(); // "Click the scan to look around"
          expect(nav.pointerLocked).toBe(true);

          // No Esc, no shortcut key: the user presses the dock button.
          clickAimedAtDock(to);
          clickAimedAtDock(to);

          expect(nav.mode).toBe(to);
          expect(nav.pointerLocked).toBe(false);
        });
      }
    }

    it('reaches orbit from an unlocked walk in one press', () => {
      nav.setMode('walk');
      clickAimedAtDock('orbit');
      expect(nav.mode).toBe('orbit');
    });

    it('still reaches orbit from a locked walk with the 1 key', () => {
      nav.setMode('walk');
      clickCanvas();
      pressKey('Digit1');
      expect(nav.mode).toBe('orbit');
      expect(nav.pointerLocked).toBe(false);
    });
  });
});
