import { el } from './dom';
import { createBusyScanController, type BusyScanController } from './busyScan';
import { clamp01 } from '../numeric';

/**
 * Full-window drag-and-drop. The whole document is a drop target; a slim
 * toast reports load status — a preload summary, staged progress with an
 * optional progress bar, a Cancel control, or an error. No file ever leaves
 * the browser.
 *
 * A second toast (`createToastHost` in panelChrome.ts, `.olv-lasso-toast`)
 * covers other transient status. The two are not merged: this one hides via
 * `display: none`, so its live-region behaviour lives on two permanently
 * mounted, visually hidden status/alert nodes instead of on the visible
 * `.olv-toast` (see tests/e2e/a11yAnnouncements.spec.ts's header comment),
 * which the single-region `.olv-lasso-toast` doesn't need.
 */
export class DropZone {
  /** The toast element — mount it into the overlay. */
  readonly toast: HTMLElement;
  private readonly _text: HTMLElement;
  private readonly _bar: HTMLElement;
  private readonly _barFill: HTMLElement;
  private readonly _cancel: HTMLButtonElement;
  /** Copies the open failure report; shown only with an error that has one. */
  private readonly _copy: HTMLButtonElement;
  private _report = '';
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

  /** Fired once, on the first drag over the drop target, to warm lazy loaders. */
  private _onDragIntent?: () => void;
  private _dragIntentFired = false;
  /** The busy scan in the toast; its trail carries the load's progress. */
  private readonly _scan: BusyScanController;
  /** Bumped by every state change, so a finishing settle knows it was superseded. */
  private _token = 0;

  constructor(target: HTMLElement, onFile: (file: File) => void | Promise<void>, onDragIntent?: () => void) {
    this._onDragIntent = onDragIntent;
    this._text = el('span', { className: 'olv-toast-text' });
    this._scan = createBusyScanController();

    this._cancel = el('button', {
      className: 'olv-toast-cancel',
      text: 'Cancel',
      ariaLabel: 'Cancel loading',
    });
    this._cancel.type = 'button';
    this._cancel.classList.add('olv-hidden');
    this._cancel.addEventListener('click', () => this._onCancel?.());

    this._copy = el('button', {
      className: 'olv-toast-cancel olv-hidden',
      text: 'Copy report',
      tip: 'Copy what was found in this file as plain text: size, content type and format evidence. No file name, path or coordinates.',
    });
    this._copy.type = 'button';
    this._copy.addEventListener('click', () => {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        this._copy.textContent = 'Copy blocked by the browser';
        return;
      }
      navigator.clipboard.writeText(this._report).then(
        () => { this._copy.textContent = 'Report copied'; },
        () => { this._copy.textContent = 'Copy blocked by the browser'; },
      );
    });

    this._barFill = el('span', { className: 'olv-toast-bar-fill' });
    this._bar = el('div', { className: 'olv-toast-bar olv-hidden' }, [this._barFill]);

    const row = el('div', { className: 'olv-toast-row' }, [
      // One fixed-width slot holds the status dot and the busy scan. While a
      // load runs the scan shows; on error or idle the dot shows. The slot
      // keeps its width either way, so the text never moves.
      el('span', { className: 'olv-toast-mark' }, [
        el('span', { className: 'olv-toast-dot' }),
        this._scan.element as unknown as HTMLElement,
      ]),
      this._text,
      this._cancel,
      this._copy,
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
      // First drag over the page: warm the lazy decode/Viewer chunks now, so a
      // user who drops immediately does not wait on the chunk fetch. Fires once;
      // the prewarm itself is idempotent.
      if (!this._dragIntentFired) {
        this._dragIntentFired = true;
        this._onDragIntent?.();
      }
    });
    target.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) target.classList.remove('olv-dragging');
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('olv-dragging');
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // Multiple datasets mount together, loaded one at a time. A multi-file
      // drop opens each in turn rather than dropping all but the first; each
      // file's own progress updates take over as it loads.
      void this._openSequentially(Array.from(files), onFile);
    });
  }

  /**
   * Open dropped files one after another. The loader takes one scan at a time,
   * so these are awaited in sequence; a file that fails surfaces its own error
   * toast and does not stop the rest.
   */
  private async _openSequentially(
    files: readonly File[],
    onFile: (file: File) => void | Promise<void>,
  ): Promise<void> {
    for (const file of files) {
      try {
        await onFile(file);
      } catch {
        // The load reports its own failure; continue with the remaining files.
      }
    }
  }

  /** Cancel a pending error auto-hide so it cannot hide a newer toast state. */
  private _clearHideTimer(): void {
    this._copy.classList.add('olv-hidden');
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
    this._token++;
    // A new load starts from the short trail.
    this._scan.reset();
    this.toast.classList.remove('olv-toast-error');
    this.toast.classList.add('is-opening', 'is-busy');
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
    this._token++;
    // Staged progress supersedes the blue "Opening …" pulse.
    this.toast.classList.remove('is-opening');
    if (text === null) {
      this.toast.classList.remove('is-busy');
      this._scan.reset();
      this.toast.classList.add('olv-hidden');
      this._bar.classList.add('olv-hidden');
      // Empty both live regions on hide so a re-shown toast re-announces
      // (live regions only fire on content CHANGE) and no stale text lingers.
      this._srStatus.textContent = '';
      this._srAlert.textContent = '';
      return;
    }
    this.toast.classList.remove('olv-toast-error');
    this.toast.classList.add('is-busy');
    this._text.textContent = text;
    this._srStatus.textContent = text;
    this._srAlert.textContent = '';
    this.toast.classList.remove('olv-hidden');
    // The trail grows with the bar; a stage without a fraction leaves it.
    if (fraction !== undefined) this._scan.setProgress(fraction);
    if (fraction === undefined) {
      this._bar.classList.add('olv-hidden');
    } else {
      const pct = Math.round(clamp01(fraction) * 100);
      this._barFill.style.width = `${pct}%`;
      this._bar.classList.remove('olv-hidden');
    }
  }

  /**
   * End a load that succeeded: the trail closes to full, the point comes to
   * rest at the front, the trail fades, then the toast hides. A failure or a
   * cancel hides at once instead (`setError`, `setProgress(null)`). Any other
   * state change during the settle wins and the late hide is dropped.
   *
   * Resolves once the toast has left the top-centre lane: `true` when this
   * settle hid it, `false` when a later state change took the toast over.
   */
  finish(): Promise<boolean> {
    if (this.toast.classList.contains('olv-hidden') || !this.toast.classList.contains('is-busy')) {
      this.setProgress(null);
      return Promise.resolve(true);
    }
    this._clearHideTimer();
    const token = ++this._token;
    this._onCancel = null;
    this._cancel.classList.add('olv-hidden');
    return this._scan.complete().then(() => {
      if (token !== this._token) return false;
      this.setProgress(null);
      return true;
    });
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
    this.toast.classList.remove('olv-toast-error', 'is-opening');
    this.toast.classList.add('is-busy');
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

  /**
   * Show an error message in the toast. Auto-hides after 6 s, or 20 s when a
   * `report` is offered through the Copy report control.
   */
  setError(text: string, report?: string): void {
    this._clearHideTimer();
    this._token++;
    this._scan.reset();
    if (report) {
      this._report = report;
      this._copy.textContent = 'Copy report';
      this._copy.classList.remove('olv-hidden');
    }
    this._onCancel = null;
    this._cancel.classList.add('olv-hidden');
    this._bar.classList.add('olv-hidden');
    this.toast.classList.remove('is-opening', 'is-busy');
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
    }, report ? 20000 : 6000);
  }
}
