/**
 * wheelSmallDeltas.test.ts
 *
 * A trackpad scroll or pinch is a stream of wheel events of a few pixels. Each
 * one's dolly is under the glide rest floor, and the controller used to drop
 * that travel, so a stream of ±1..6 px events (every pinch, any slow scroll)
 * left the camera still while larger events zoomed. The rest rule now ends
 * the tail by applying what is left, so the zoom follows the stream's sum.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NavController } from '../src/render/NavController';
import { stubCanvas, stubTarget } from './helpers/navCanvasStubs';

const saved = { window: globalThis.window, document: globalThis.document };
afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

type Wheel = { deltaY: number; deltaMode?: number; ctrlKey?: boolean };

/** Camera distance before / after a wheel stream, one event per 60 Hz frame. */
function zoomAfter(events: Wheel[]): number {
  globalThis.window = { ...stubTarget(), matchMedia: () => ({ matches: false }), innerHeight: 800 } as unknown as Window & typeof globalThis;
  globalThis.document = stubTarget() as unknown as Document;
  const canvas = stubCanvas();
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1e6);
  const controls = new OrbitControls(camera);
  (controls as unknown as { domElement: HTMLCanvasElement }).domElement = canvas;
  const nav = new NavController(camera, canvas, controls);
  nav.setWorldUp(new THREE.Vector3(0, 0, 1));
  camera.position.set(0, 250, 170);
  controls.update();
  const d0 = camera.position.distanceTo(controls.target);
  const wheel = nav as unknown as { _handleWheel(e: unknown): void };
  for (const e of events) {
    wheel._handleWheel({
      target: canvas, deltaX: 0, deltaY: e.deltaY, deltaMode: e.deltaMode ?? 0, ctrlKey: !!e.ctrlKey,
      offsetX: 400, offsetY: 300, preventDefault: () => {},
    });
    nav.update(1 / 60);
  }
  for (let n = 0; n < 300; n++) nav.update(1 / 60);
  return camera.position.distanceTo(controls.target) / d0;
}

const stream = (deltaY: number, n: number, ctrlKey = false): Wheel[] => Array.from({ length: n }, () => ({ deltaY, ctrlKey }));

describe('wheel streams of small deltas', () => {
  it('a stream of 1 px events zooms', () => {
    expect(zoomAfter(stream(1, 20))).toBeGreaterThan(1.005);
    expect(zoomAfter(stream(-1, 20))).toBeLessThan(0.995);
  });

  it('a ctrlKey pinch stream zooms in when the fingers spread', () => {
    expect(zoomAfter(stream(-3, 20, true))).toBeLessThan(0.98);
  });

  it('the zoom follows the sum of the stream, not the size of each event', () => {
    const log = (events: Wheel[]) => Math.log(zoomAfter(events));
    const fine = log(stream(2, 50)); // 100 px in 2 px steps
    const coarse = log(stream(20, 5)); // 100 px in 20 px steps
    const notch = log([{ deltaY: 100 }]);
    expect(fine).toBeCloseTo(notch, 2);
    expect(coarse).toBeCloseTo(notch, 2);
  });

  it('a line-mode notch zooms like its pixel equivalent', () => {
    expect(Math.log(zoomAfter([{ deltaY: 3, deltaMode: 1 }]))).toBeCloseTo(Math.log(zoomAfter([{ deltaY: 48 }])), 3);
  });
});
