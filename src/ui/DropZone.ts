import { el } from './dom';

/**
 * Full-window drag-and-drop. The whole document is a drop target; a slim
 * progress toast reports load status. No file ever leaves the browser.
 */
export class DropZone {
  /** The progress toast — mount it into the overlay. */
  readonly toast: HTMLElement;
  private readonly _toastText: HTMLElement;
  private readonly _onFile: (file: File) => void;

  constructor(target: HTMLElement, onFile: (file: File) => void) {
    this._onFile = onFile;
    this._toastText = el('span', { className: 'olv-toast-text' });
    this.toast = el('div', { className: 'olv-toast' }, [
      el('span', { className: 'olv-toast-dot' }),
      this._toastText,
    ]);
    this.toast.style.display = 'none';

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
      if (file) this._onFile(file);
    });
  }

  /** Show a progress message, or pass `null` to hide the toast. */
  setProgress(text: string | null): void {
    if (text === null) {
      this.toast.style.display = 'none';
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this._toastText.textContent = text;
    this.toast.style.display = 'flex';
  }

  /** Show an error message in the toast. */
  setError(text: string): void {
    this.toast.classList.add('olv-toast-error');
    this._toastText.textContent = text;
    this.toast.style.display = 'flex';
    window.setTimeout(() => {
      this.toast.style.display = 'none';
    }, 6000);
  }
}
