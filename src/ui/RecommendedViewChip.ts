/**
 * RecommendedViewChip.ts
 *
 * A small, dismissible chip shown after a scan loads that suggests the camera
 * preset best suited to the scan (see `recommendCameraPreset`). Clicking it
 * applies the preset; an × dismisses it; it also auto-hides after a few seconds
 * so it never lingers. A suggestion, never a demand.
 *
 * DOM-bound. Its data dependency is the pure {@link ViewRecommendation}.
 */

import { el } from './dom';
import { CAMERA_PRESET_LABEL } from '../render/camera/cameraPresets';
import type { ViewRecommendation } from '../render/camera/recommendView';

/** How long the chip stays up before auto-hiding, in ms. */
const AUTO_HIDE_MS = 9000;

export class RecommendedViewChip {
  /** The chip element — mount into the stage overlay. */
  readonly element: HTMLElement;
  private readonly _label: HTMLElement;
  private _onApply: (() => void) | null = null;
  private _timer: number | null = null;

  constructor() {
    this._label = el('span', { className: 'olv-rvc-label' });
    const apply = el('button', {
      className: 'olv-rvc-apply',
      type: 'button',
      title: 'Apply this view',
    }, [el('span', { className: 'olv-rvc-spark', text: '✦' }), this._label]);
    apply.addEventListener('click', () => this._apply());

    const dismiss = el('button', {
      className: 'olv-rvc-dismiss',
      type: 'button',
      text: '×',
      title: 'Dismiss',
      ariaLabel: 'Dismiss the recommended view',
    });
    dismiss.addEventListener('click', () => this.hide());

    this.element = el('div', { className: 'olv-rvc olv-hidden' }, [apply, dismiss]);
    this.element.setAttribute('role', 'status');
  }

  /** Show the chip for a recommendation; `onApply` fires when the user accepts. */
  show(rec: ViewRecommendation, onApply: () => void): void {
    this._onApply = onApply;
    this._label.textContent = `Recommended: ${CAMERA_PRESET_LABEL[rec.preset]} view`;
    this.element.title = rec.reason;
    this.element.classList.remove('olv-hidden');
    this._arm();
  }

  /** Hide the chip and cancel the auto-hide timer. */
  hide(): void {
    this._clearTimer();
    this.element.classList.add('olv-hidden');
  }

  private _apply(): void {
    this._onApply?.();
    this.hide();
  }

  private _arm(): void {
    this._clearTimer();
    this._timer = window.setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
