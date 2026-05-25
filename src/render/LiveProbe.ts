/**
 * LiveProbe.ts
 *
 * The live-probe readout (stretch #17): a compact card that follows the cursor
 * and shows the point under it — coordinates and key attributes — with no
 * click. Unlike the Inspect tool it never freezes navigation, so the user can
 * orbit and probe at the same time.
 *
 * The Viewer does the throttled per-frame picking and feeds this view; the
 * component is pure DOM. Desktop-only by default (a hover affordance), so the
 * tool dock hides its toggle on touch devices.
 *
 * Browser-bound (DOM); not imported in Node tests.
 */

import { el } from '../ui/dom';
import { type PointInfo, classificationText } from './pointInfo';

/** Cursor offset and viewport margin for the floating readout, in pixels. */
const CURSOR_OFFSET = 16;
const VIEWPORT_MARGIN = 8;

export class LiveProbe {
  /** The floating readout element — mount into the stage overlay. */
  readonly element: HTMLElement;

  private readonly _coords: HTMLElement;
  private readonly _attr: HTMLElement;
  private _active = false;

  constructor() {
    this._coords = el('div', { className: 'olv-probe-coords' });
    this._attr = el('div', { className: 'olv-probe-attr' });
    this.element = el('div', { className: 'olv-probe-readout olv-hidden' }, [
      this._coords,
      this._attr,
    ]);
  }

  /** Whether live-probe mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /** Enter or leave probe mode; leaving hides the readout. */
  setActive(on: boolean): void {
    this._active = on;
    if (!on) this.element.classList.add('olv-hidden');
  }

  /**
   * Show the readout for the point under the cursor at screen `(clientX,
   * clientY)`, or hide it when `info` is null (the cursor missed the cloud or
   * left the canvas). A no-op while the tool is inactive.
   */
  update(info: PointInfo | null, clientX: number, clientY: number): void {
    if (!this._active || !info) {
      this.element.classList.add('olv-hidden');
      return;
    }
    this._coords.textContent = `${info.x}, ${info.y}, ${info.z} m`;
    const attrs: string[] = [];
    if (info.classification !== null) attrs.push(classificationText(info));
    if (info.intensity !== null) attrs.push(`Intensity ${info.intensity}`);
    this._attr.textContent = attrs.join('  ·  ');
    this._attr.classList.toggle('olv-hidden', attrs.length === 0);

    // Float near the cursor, flipping and clamping to stay on screen.
    this.element.classList.remove('olv-hidden');
    const w = this.element.offsetWidth || 180;
    const h = this.element.offsetHeight || 44;
    let left = clientX + CURSOR_OFFSET;
    if (left + w > window.innerWidth - VIEWPORT_MARGIN) left = clientX - CURSOR_OFFSET - w;
    let top = clientY + CURSOR_OFFSET;
    if (top + h > window.innerHeight - VIEWPORT_MARGIN) top = clientY - CURSOR_OFFSET - h;
    this.element.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    this.element.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
  }

  /** Free DOM references. */
  dispose(): void {
    this.element.remove();
  }
}
