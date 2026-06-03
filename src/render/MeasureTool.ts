/**
 * MeasureTool.ts
 *
 * Straight-line distance measurement. The user clicks two points on the scan;
 * the tool draws markers, a connecting line and a distance label.
 *
 * The visuals are an **SVG overlay**, not three.js scene objects: the picked
 * points are 3D, but every frame their screen projections drive SVG circles,
 * lines and labels. This sidesteps the WebGPU 1-pixel limit on line/point
 * primitives entirely and keeps measurements crisply readable on top of the
 * cloud at any depth.
 *
 * Browser-bound (DOM + three.js camera) — not imported in Node tests. The
 * distance formatting lives in `navMath.ts` and is unit-tested there.
 */

import * as THREE from 'three/webgpu';
import { el } from '../ui/dom';
import { formatDistance } from './navMath';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Touch devices have no mouse — the instructions say "Tap" rather than
 * "Click", and point at the on-screen Done button instead of the Esc key.
 */
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const PICK_VERB = COARSE_POINTER ? 'Tap' : 'Click';
const FINISH_HINT = COARSE_POINTER ? 'tap Done to finish' : 'Esc to finish';

/** A completed measurement between two picked points. */
interface Measurement {
  a: THREE.Vector3;
  b: THREE.Vector3;
  distance: number;
}

/** Hooks the tool calls back into. */
export interface MeasureCallbacks {
  /** The user finished measuring (the "Done" button). */
  onExit: () => void;
}

/** Create an SVG element with attributes set. */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class MeasureTool {
  /** The SVG layer drawing markers, lines and labels — append to the overlay. */
  readonly overlay: SVGSVGElement;
  /** The instruction panel shown while measuring — append to the overlay. */
  readonly hint: HTMLElement;

  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _cb: MeasureCallbacks;
  private readonly _hintText: HTMLElement;
  private readonly _clearBtn: HTMLButtonElement;

  private _active = false;
  /** The first point of an in-progress measurement, awaiting the second. */
  private _pending: THREE.Vector3 | null = null;
  private _measurements: Measurement[] = [];

  private readonly _ndc = new THREE.Vector3();
  private readonly _cameraSpace = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    callbacks: MeasureCallbacks,
  ) {
    this._camera = camera;
    this._canvas = canvas;
    this._cb = callbacks;

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('class', 'olv-measure-svg');

    this._hintText = el('span', { className: 'olv-measure-hint-text' });
    this._clearBtn = el('button', { className: 'olv-measure-clear olv-hidden', text: 'Clear' });
    this._clearBtn.addEventListener('click', () => {
      this._clearBtn.blur();
      this.clear();
    });
    const done = el('button', { className: 'olv-measure-done', text: 'Done' });
    done.addEventListener('click', () => {
      done.blur();
      this._cb.onExit();
    });
    this.hint = el('div', { className: 'olv-measure-hint olv-hidden' }, [
      el('div', { className: 'olv-measure-hint-row' }, [
        el('span', { className: 'olv-measure-badge', text: 'Measure' }),
        this._hintText,
      ]),
      el('div', { className: 'olv-measure-actions' }, [this._clearBtn, done]),
    ]);
  }

  /** Whether measurement mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /** Enter or leave measurement mode. */
  setActive(on: boolean): void {
    this._active = on;
    this._pending = null; // discard any half-finished measurement
    this.hint.classList.toggle('olv-hidden', !on);
    this._canvas.style.cursor = on ? 'crosshair' : '';
    if (on) this._setHint(`${PICK_VERB} the first point on the scan`);
    this.render();
  }

  /**
   * Feed a picked point into the current measurement. Pass `null` when a
   * click missed the cloud so the tool can prompt the user.
   */
  addPoint(point: THREE.Vector3 | null): void {
    if (!this._active) return;
    if (!point) {
      this._setHint(`No point there — ${PICK_VERB.toLowerCase()} directly on the scan`);
      return;
    }
    if (!this._pending) {
      this._pending = point.clone();
      this._setHint(`${PICK_VERB} the second point`);
    } else {
      const a = this._pending;
      const b = point.clone();
      this._measurements.push({ a, b, distance: a.distanceTo(b) });
      this._pending = null;
      this._setHint(`${PICK_VERB} two more points to measure again, or ${FINISH_HINT}`);
    }
    this.render();
  }

  /** Remove every measurement. */
  clear(): void {
    this._measurements = [];
    this._pending = null;
    if (this._active) this._setHint(`${PICK_VERB} the first point on the scan`);
    this.render();
  }

  /** Project the 3D points and redraw the overlay. Call once per frame. */
  render(): void {
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const kids: SVGElement[] = [];
    for (const m of this._measurements) {
      const pa = this._project(m.a);
      const pb = this._project(m.b);
      if (!pa.visible || !pb.visible) continue;
      kids.push(svg('line', {
        x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: 'olv-measure-line',
      }));
      kids.push(this._dot(pa.x, pa.y, false), this._dot(pb.x, pb.y, false));
      kids.push(this._label((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, formatDistance(m.distance)));
    }
    if (this._pending) {
      const pp = this._project(this._pending);
      if (pp.visible) kids.push(this._dot(pp.x, pp.y, true));
    }
    this.overlay.replaceChildren(...kids);
  }

  /** Free DOM references. */
  dispose(): void {
    this._canvas.style.cursor = '';
    this.overlay.remove();
    this.hint.remove();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private _setHint(text: string): void {
    this._hintText.textContent = text;
    this._clearBtn.classList.toggle('olv-hidden', this._measurements.length === 0);
  }

  /** Project a world point to canvas pixels, flagging if it is in front. */
  private _project(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this._cameraSpace.copy(p).applyMatrix4(this._camera.matrixWorldInverse);
    const inFront = this._cameraSpace.z < 0; // the camera looks down -Z
    this._ndc.copy(p).project(this._camera);
    return {
      x: (this._ndc.x * 0.5 + 0.5) * this._canvas.clientWidth,
      y: (-this._ndc.y * 0.5 + 0.5) * this._canvas.clientHeight,
      visible: inFront,
    };
  }

  private _dot(x: number, y: number, pending: boolean): SVGElement {
    return svg('circle', {
      cx: x, cy: y, r: 4.5,
      class: pending ? 'olv-measure-dot olv-measure-dot-pending' : 'olv-measure-dot',
    });
  }

  private _label(x: number, y: number, text: string): SVGElement {
    const node = svg('text', { x, y: y - 11, class: 'olv-measure-label', 'text-anchor': 'middle' });
    node.textContent = text;
    return node;
  }
}
