/**
 * ClipIndicator.ts: the unobtrusive "why is part of the cloud missing" chip.
 *
 * Shown only while a clip is on: "Clipping on · Showing inside box" with a
 * one-click Turn off.
 * It reads the Clip panel's own state (enabled, mode) and is repainted by the
 * panel's subscription, so it holds no clip state of its own. It states the
 * mode only; the kept/total figure stays on the state strip, which owns it.
 * It is a status, not a drawing operation: it never touches the tool state.
 */

import { el } from './dom';
import type { ClipMode } from '../render/clip/clipBox';

export interface ClipIndicatorSource {
  readonly enabled: boolean;
  readonly mode: ClipMode;
  clear(): void;
}

export class ClipIndicator {
  readonly element: HTMLElement;
  private readonly _text: HTMLElement;
  private readonly _src: ClipIndicatorSource;

  constructor(source: ClipIndicatorSource) {
    this._src = source;
    this._text = el('span', { className: 'olv-clip-ind-text' });
    this._text.setAttribute('role', 'status');
    this._text.setAttribute('aria-live', 'polite');
    const clear = el('button', {
      className: 'olv-clip-ind-clear', type: 'button', text: 'Turn off',
      title: 'Turn the clip off and show the whole scan', ariaLabel: 'Turn off clipping',
    });
    clear.addEventListener('click', () => this._src.clear());
    this.element = el('div', { className: 'olv-clip-indicator olv-hidden' }, [this._text, clear]);
    this.sync();
  }

  /** Repaint from the source. Cheap and idempotent. */
  sync(): void {
    const on = this._src.enabled;
    this.element.classList.toggle('olv-hidden', !on);
    this._text.textContent = on
      ? `Clipping on · Showing ${this._src.mode === 'keep-inside' ? 'inside' : 'outside'} box`
      : '';
  }
}
