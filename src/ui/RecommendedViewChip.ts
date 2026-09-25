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

/**
 * The auto-hide delay. Test-seam builds (`?test=1`) accept `rvcHideMs=<n>` so
 * an e2e can exercise the pause/resume behaviour on a short timer; shipped
 * builds compile this down to the constant.
 */
function autoHideMs(): number {
  if (typeof __OLV_TEST_SEAM__ !== 'undefined' && __OLV_TEST_SEAM__ && typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search);
    const n = Number(q.get('rvcHideMs'));
    if (q.get('test') === '1' && Number.isFinite(n) && n > 0) return n;
  }
  return AUTO_HIDE_MS;
}

export class RecommendedViewChip {
  /** The chip element — mount into the stage overlay. */
  readonly element: HTMLElement;
  private readonly _label: HTMLElement;
  private _onApply: (() => void) | null = null;
  private _timer: number | null = null;
  private readonly _hideMs: number;
  /**
   * Tracked separately, not as one combined flag: a mouse hover and a
   * keyboard focus can both be active on the chip at once (the user tabs to
   * Apply, then also happens to move the mouse over it), and only the LAST
   * one to end may resume the timer. A single flag cleared by either
   * `mouseleave` or `focusout` would resume it while the other was still
   * true — hiding the chip out from under a still-focused button.
   */
  private _hovered = false;
  private _focusedInside = false;
  /** The element focused right before `show()`, restored to on hide if the
   *  chip held focus at that point — the same opener-restore idea Modal.ts's
   *  `openModal` uses for dialogs, applied here without a focus trap. */
  private _returnFocusTo: HTMLElement | null = null;

  /** @param hideMs auto-hide delay in ms; defaults to 9 s (see {@link autoHideMs}). */
  constructor(hideMs: number = autoHideMs()) {
    this._hideMs = hideMs;
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

    // Pause the auto-hide timer while hovered or focused (WCAG 2.2.1
    // timing-adjustable): a keyboard user reading the reason tooltip or just
    // deciding must not have the chip vanish, and drop their focus, under
    // them. `mouseenter`/`mouseleave` fire on the element they are bound to
    // for the whole hit region including its children, so one listener each
    // covers both buttons without needing per-button wiring; `focusin` /
    // `focusout` bubble, so the same is true for keyboard focus.
    this.element.addEventListener('mouseenter', () => {
      this._hovered = true;
      this._syncTimer();
    });
    this.element.addEventListener('mouseleave', () => {
      this._hovered = false;
      this._syncTimer();
    });
    this.element.addEventListener('focusin', () => {
      this._focusedInside = true;
      this._syncTimer();
    });
    this.element.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget;
      // Moving focus between the chip's own Apply/Dismiss buttons is not
      // leaving the chip — only resume once focus is actually outside it.
      if (next instanceof Node && this.element.contains(next)) return;
      this._focusedInside = false;
      this._syncTimer();
    });
  }

  /** Show the chip for a recommendation; `onApply` fires when the user accepts. */
  show(rec: ViewRecommendation, onApply: () => void): void {
    this._onApply = onApply;
    this._label.textContent = `Recommended: ${CAMERA_PRESET_LABEL[rec.preset]} view`;
    this.element.title = rec.reason;
    this._returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.element.classList.remove('olv-hidden');
    this._arm();
  }

  /**
   * Hide the chip and cancel the auto-hide timer. If focus is currently
   * inside the chip (its buttons are about to leave the accessibility tree),
   * move it back to whatever held focus before the chip appeared rather than
   * letting it silently fall to `<body>` with no relocation.
   */
  hide(): void {
    this._clearTimer();
    this.element.dataset.autohide = 'off';
    this._hovered = false;
    this._focusedInside = false;
    const hadFocus = this.element.contains(document.activeElement);
    this.element.classList.add('olv-hidden');
    if (hadFocus) {
      const target = this._returnFocusTo;
      if (target && document.contains(target)) target.focus();
    }
    this._returnFocusTo = null;
  }

  private _apply(): void {
    this._onApply?.();
    this.hide();
  }

  /**
   * Re-decide the timer from the current hover/focus state: cleared while
   * either holds it up, armed fresh once both are false (and the chip is
   * still showing).
   */
  private _syncTimer(): void {
    if (this._hovered || this._focusedInside) {
      this._clearTimer();
      this.element.dataset.autohide = 'paused';
      return;
    }
    if (this.element.classList.contains('olv-hidden')) return;
    this._arm();
  }

  private _arm(): void {
    this._clearTimer();
    this._timer = window.setTimeout(() => this.hide(), this._hideMs);
    this.element.dataset.autohide = 'running';
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
