import { el } from './dom';
import { clamp01 } from '../numeric';

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
  /** Visually-hidden polite live region — mirrors progress / preload text. */
  private readonly _srStatus: HTMLElement;
  /** Visually-hidden assertive live region — mirrors error text. */
  private readonly _srAlert: HTMLElement;
  private _onCancel: (() => void) | null = null;
  /**
   * Handle of the error auto-hide timeout. Tracked so a new toast state can
   * cancel it: without this, an error shown just before a retry's progress
   * would hide the LIVE progress toast 6 s later (the stale timer doesn't
   * know the toast was reused).
   */
  private _hideTimer: number | null = null;

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
    // Screen-reader announcements live in two PERMANENTLY rendered,
    // visually-hidden nodes rather than on the toast itself: the toast hides
    // via `display:none`, which removes it from the accessibility tree, so
    // live-region announcements from it fire unreliably (or not at all)
    // across screen readers. The status node announces progress politely;
    // the alert node interrupts for failures. `el()` has no role/aria-live
    // props — set the attributes directly.
    this._srStatus = el('span', { className: 'olv-visually-hidden' });
    this._srStatus.setAttribute('role', 'status');
    this._srStatus.setAttribute('aria-live', 'polite');
    this._srAlert = el('span', { className: 'olv-visually-hidden' });
    this._srAlert.setAttribute('role', 'alert');
    // Mounted on the drop target (the document body), not inside the toast,
    // so toggling the toast's visibility never silences them.
    target.append(this._srStatus, this._srAlert);

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
      const files = e.dataTransfer?.files;
      const file = files?.[0];
      if (!file) return;
      onFile(file);
      // Only one scan can be open at a time, so a multi-file drop silently
      // dropping files[1..n] looked like a bug. Say what happened and point
      // at the batch path. The load's own progress updates will overwrite
      // this hint, which is fine — it only needs to land once.
      const ignored = (files?.length ?? 1) - 1;
      if (ignored > 0) {
        this.setProgress(
          `Opened "${file.name}" — ${ignored} more file${ignored === 1 ? '' : 's'} ignored. Use Convert for batches.`,
        );
      }
    });
  }

  /** Cancel a pending error auto-hide so it cannot hide a newer toast state. */
  private _clearHideTimer(): void {
    if (this._hideTimer !== null) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  }

  /**
   * Show the prominent blue blinking "Opening …" state — the first feedback a
   * scan open gives, before staged progress (decoding / uploading / rendering)
   * takes over. Used by BOTH device-file and public/streaming opens so the two
   * entry points feel identical. The pulse is pure CSS (`is-opening`); staged
   * `setProgress`, `setError`, `setPreload`, and clear all drop the class.
   */
  setOpening(text: string): void {
    this._clearHideTimer();
    this.toast.classList.remove('olv-toast-error');
    this.toast.classList.add('is-opening');
    this._bar.classList.add('olv-hidden');
    this._text.textContent = text;
    this._srStatus.textContent = text;
    this._srAlert.textContent = '';
    this.toast.classList.remove('olv-hidden');
  }

  /**
   * Show a progress message, optionally with a 0..1 completion bar. Pass
   * `null` to hide the toast entirely.
   */
  setProgress(text: string | null, fraction?: number): void {
    this._clearHideTimer();
    // Staged progress supersedes the blue "Opening …" pulse.
    this.toast.classList.remove('is-opening');
    if (text === null) {
      this.toast.classList.add('olv-hidden');
      this._bar.classList.add('olv-hidden');
      // Empty both live regions on hide so a re-shown toast re-announces
      // (live regions only fire on content CHANGE) and no stale text lingers.
      this._srStatus.textContent = '';
      this._srAlert.textContent = '';
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this._text.textContent = text;
    this._srStatus.textContent = text;
    this._srAlert.textContent = '';
    this.toast.classList.remove('olv-hidden');
    if (fraction === undefined) {
      this._bar.classList.add('olv-hidden');
    } else {
      const pct = Math.round(clamp01(fraction) * 100);
      this._barFill.style.width = `${pct}%`;
      this._bar.classList.remove('olv-hidden');
    }
  }

  /**
   * Show a multi-line preload summary — what the file's header revealed and
   * how it will be loaded — before the decode begins. Each entry is one line.
   */
  setPreload(lines: string[]): void {
    this._clearHideTimer();
    if (lines.length === 0) {
      this.setProgress(null);
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this.toast.classList.remove('is-opening');
    const text = lines.join('\n');
    this._text.textContent = text;
    this._srStatus.textContent = text;
    this._srAlert.textContent = '';
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

  /** Show an error message in the toast. Auto-hides after 6 s. */
  setError(text: string): void {
    this._clearHideTimer();
    this._onCancel = null;
    this._cancel.classList.add('olv-hidden');
    this._bar.classList.add('olv-hidden');
    this.toast.classList.remove('is-opening');
    this.toast.classList.add('olv-toast-error');
    this._text.textContent = text;
    // The alert node announces immediately (role=alert is implicitly
    // assertive) — a load failure should interrupt; routine progress should
    // not. The status node is emptied so the failure isn't double-read.
    this._srAlert.textContent = text;
    this._srStatus.textContent = '';
    this.toast.classList.remove('olv-hidden');
    this._hideTimer = window.setTimeout(() => {
      this._hideTimer = null;
      this.toast.classList.add('olv-hidden');
      this._srAlert.textContent = '';
    }, 6000);
  }
}
