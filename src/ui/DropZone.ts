import { el } from './dom';

/**
 * Full-window drag-and-drop. The whole document is a drop target; a slim
 * toast reports load status — a preload summary, staged progress with an
 * optional progress bar, a Cancel control, or an error. No file ever leaves
 * the browser.
 */
export class DropZone {
  /** The toast element — mount it into the overlay. */
  readonly toast: HTMLElement;
  private readonly _text: HTMLElement;
  private readonly _bar: HTMLElement;
  private readonly _barFill: HTMLElement;
  private readonly _cancel: HTMLButtonElement;
  private _onCancel: (() => void) | null = null;

  constructor(target: HTMLElement, onFile: (file: File) => void) {
    this._text = el('span', { className: 'olv-toast-text' });

    this._cancel = el('button', {
      className: 'olv-toast-cancel',
      text: 'Cancel',
      ariaLabel: 'Cancel loading',
    });
    this._cancel.type = 'button';
    this._cancel.classList.add('olv-hidden');
    this._cancel.addEventListener('click', () => this._onCancel?.());

    this._barFill = el('span', { className: 'olv-toast-bar-fill' });
    this._bar = el('div', { className: 'olv-toast-bar olv-hidden' }, [this._barFill]);

    const row = el('div', { className: 'olv-toast-row' }, [
      el('span', { className: 'olv-toast-dot' }),
      this._text,
      this._cancel,
    ]);
    // Visibility is driven by .olv-hidden so theming + reduced-motion
    // overrides hit the toast the same way they hit every other surface.
    this.toast = el('div', { className: 'olv-toast olv-hidden' }, [row, this._bar]);

    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.classList.add('olv-dragging');
    });
    target.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) target.classList.remove('olv-dragging');
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('olv-dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) onFile(file);
    });
  }

  /**
   * Show a progress message, optionally with a 0..1 completion bar. Pass
   * `null` to hide the toast entirely.
   */
  setProgress(text: string | null, fraction?: number): void {
    if (text === null) {
      this.toast.classList.add('olv-hidden');
      this._bar.classList.add('olv-hidden');
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this._text.textContent = text;
    this.toast.classList.remove('olv-hidden');
    if (fraction === undefined) {
      this._bar.classList.add('olv-hidden');
    } else {
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      this._barFill.style.width = `${pct}%`;
      this._bar.classList.remove('olv-hidden');
    }
  }

  /**
   * Show a multi-line preload summary — what the file's header revealed and
   * how it will be loaded — before the decode begins. Each entry is one line.
   */
  setPreload(lines: string[]): void {
    if (lines.length === 0) {
      this.setProgress(null);
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this._text.textContent = lines.join('\n');
    this._bar.classList.add('olv-hidden');
    this.toast.classList.remove('olv-hidden');
  }

  /**
   * Wire (or clear) the Cancel control. Passing a handler shows the control
   * and runs it on click; passing `null` hides the control.
   */
  setCancelHandler(handler: (() => void) | null): void {
    this._onCancel = handler;
    this._cancel.classList.toggle('olv-hidden', handler === null);
  }

  /** Show an error message in the toast. */
  setError(text: string): void {
    this._onCancel = null;
    this._cancel.classList.add('olv-hidden');
    this._bar.classList.add('olv-hidden');
    this.toast.classList.add('olv-toast-error');
    this._text.textContent = text;
    this.toast.classList.remove('olv-hidden');
    window.setTimeout(() => {
      this.toast.classList.add('olv-hidden');
    }, 6000);
  }
}
