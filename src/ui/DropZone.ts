import { el } from './dom';
import { createBusyScanController, type BusyScanController } from './busyScan';
import { clamp01 } from '../numeric';
import { createDisplayThrottle, type DisplayThrottle } from './displayThrottle';

/** What is known about the file an open is reading, as plain text. */
export interface LoadContext {
  /** Short facts in display order, e.g. the format and the loading scope. */
  readonly facts: readonly string[];
  /** A preflight warning, kept under the progress line until the open ends. */
  readonly note?: string;
  /** What the polite region says once when these facts arrive. */
  readonly announce?: string;
}

/** How a staged progress update is paced and announced. */
export interface StageOptions {
  /** The operation the update belongs to (`DropZone.operation`); a stale one is dropped. */
  readonly op?: number;
  /** Stage key. A new key renders at once and is announced; repeats are paced. */
  readonly stage: string;
  /** What the polite region says for the stage, without the changing detail. */
  readonly announce?: string;
  /** False keeps the busy scan's trail out of this stage's fraction. */
  readonly trail?: boolean;
}

/** One multi-file drop being opened in turn. */
interface DropQueue {
  /** Files in the drop. */
  readonly total: number;
  /** One-based position of the file being opened. */
  index: number;
  /** Set by "Cancel remaining files": no later file in this drop starts. */
  stopped: boolean;
}

/** Shown beside the file name until the format and scope are known. */
export const CHECKING_FILE = 'Checking file…';

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
  /** The busy slot; carries the progressbar role while a load runs. */
  private readonly _mark: HTMLElement;
  private readonly _cancel: HTMLButtonElement;
  /** Cancels the current file and empties the rest of a multi-file drop. */
  private readonly _cancelRest: HTMLButtonElement;
  /** "Opening 2 of 3 —" ahead of the file name while a multi-file drop runs. */
  private readonly _queueLabel: HTMLElement;
  private _queue: DropQueue | null = null;
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
  /**
   * The open in progress. Bumped when an open starts and when it ends (done,
   * failed, cancelled, hidden), so an update or held timer from an earlier
   * open is dropped instead of drawing over a later one.
   */
  private _op = 0;
  /** The file-context line: name, then the facts known so far. */
  private readonly _context: HTMLElement;
  private readonly _file: HTMLElement;
  private readonly _facts: HTMLElement;
  /** A preflight warning, shown under the progress line. */
  private readonly _note: HTMLElement;
  /** The file name of the open in progress, or '' when none. */
  private _name = '';
  /** The stage last drawn, and the last quarter of it announced. */
  private _stage: string | null = null;
  private _quarter = 0;
  /** What this toast last wrote to the polite region; null once it should stay. */
  private _ownStatus: string | null = null;
  /** Paces same-stage updates; stage changes and ends bypass it. */
  private readonly _throttle: DisplayThrottle = createDisplayThrottle();

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

    this._cancelRest = el('button', {
      className: 'olv-toast-cancel olv-hidden',
      text: 'Cancel remaining files',
      ariaLabel: 'Cancel this file and the remaining files',
    });
    this._cancelRest.type = 'button';
    this._cancelRest.addEventListener('click', () => {
      if (this._queue) this._queue.stopped = true;
      this._onCancel?.();
    });
    this._queueLabel = el('span', { className: 'olv-toast-queue olv-hidden' });

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
    // The bar is the visual; the progressbar role sits on the always-visible
    // busy slot below, so an indeterminate stage is still announced as one.
    this._bar.setAttribute('aria-hidden', 'true');

    // File context: the name (ellipsised by CSS, whole in the DOM so assistive
    // technology reads all of it) and what preflight found. Text only.
    this._file = el('span', { className: 'olv-toast-file' });
    this._facts = el('span', { className: 'olv-toast-facts' });
    const sep = el('span', { className: 'olv-toast-sep', text: '·' });
    sep.setAttribute('aria-hidden', 'true');
    this._context = el('div', { className: 'olv-toast-context olv-hidden' }, [this._queueLabel, this._file, sep, this._facts]);
    this._note = el('div', { className: 'olv-toast-note olv-hidden' });
    const mark = el('span', { className: 'olv-toast-mark' }, [
      el('span', { className: 'olv-toast-dot' }),
      this._scan.element as unknown as HTMLElement,
    ]);
    this._mark = mark;

    const row = el('div', { className: 'olv-toast-row' }, [
      // One fixed-width slot holds the status dot and the busy scan. While a
      // load runs the scan shows; on error or idle the dot shows. The slot
      // keeps its width either way, so the text never moves.
      mark,
      this._text,
      this._cancel,
      this._cancelRest,
      this._copy,
    ]);
    // Visibility is driven by .olv-hidden so theming + reduced-motion
    // overrides hit the toast the same way they hit every other surface.
    this.toast = el('div', { className: 'olv-toast olv-hidden' }, [this._context, row, this._note, this._bar]);
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
    // Opening the file picker is the same intent: warm while the picker is open.
    target.addEventListener('click', (e) => {
      if ((e.target as HTMLInputElement | null)?.type === 'file' && !this._dragIntentFired) { this._dragIntentFired = true; this._onDragIntent?.(); }
    }, true);
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
   * toast and does not stop the rest. "Cancel this file" stops the current
   * file and the queue goes on; "Cancel remaining files" also empties it.
   */
  private async _openSequentially(
    files: readonly File[],
    onFile: (file: File) => void | Promise<void>,
  ): Promise<void> {
    const queue: DropQueue = { total: files.length, index: 0, stopped: false };
    this._queue = files.length > 1 ? queue : null;
    try {
      for (const file of files) {
        if (queue.stopped) break;
        queue.index++;
        this._syncCancel();
        try {
          await onFile(file);
        } catch {
          // The load reports its own failure; continue with the remaining files.
        }
      }
    } finally {
      if (this._queue === queue) this._queue = null;
      this._syncCancel();
    }
    if (queue.stopped && queue.index < queue.total) {
      const left = queue.total - queue.index;
      this._announce(`Skipped ${left} remaining ${left === 1 ? 'file' : 'files'}.`, true);
    }
  }

  /** Files still to open after the current one; 0 outside a multi-file drop. */
  get remainingFiles(): number {
    const q = this._queue;
    return q && !q.stopped ? q.total - q.index : 0;
  }

  /** Show "Opening 2 of 3 —" and the right Cancel controls for the queue state. */
  private _syncCancel(): void {
    const q = this._queue;
    const active = this._onCancel !== null;
    const left = this.remainingFiles;
    const multi = q !== null && left > 0;
    this._cancel.classList.toggle('olv-hidden', !active);
    this._cancel.textContent = multi ? 'Cancel this file' : 'Cancel';
    this._cancel.setAttribute('aria-label', multi ? 'Cancel loading this file' : 'Cancel loading');
    this._cancelRest.classList.toggle('olv-hidden', !(active && multi));
    this._cancelRest.setAttribute(
      'aria-label',
      `Cancel this file and the ${left} remaining ${left === 1 ? 'file' : 'files'}`,
    );
    const showLabel = q !== null && this._name !== '';
    this._queueLabel.textContent = showLabel ? `Opening ${q.index} of ${q.total} —` : '';
    this._queueLabel.classList.toggle('olv-hidden', !showLabel);
  }

  /** Cancel a pending error auto-hide so it cannot hide a newer toast state. */
  private _clearHideTimer(): void {
    this._copy.classList.add('olv-hidden');
    if (this._hideTimer !== null) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  }

  /** The open in progress; pass it back with updates so a stale one is dropped. */
  get operation(): number {
    return this._op;
  }

  /**
   * Show the prominent blue blinking "Opening …" state — the first feedback a
   * scan open gives, before staged progress (decoding / uploading / rendering)
   * takes over. Used by BOTH device-file and public/streaming opens so the two
   * entry points feel identical. The pulse is pure CSS (`is-opening`); staged
   * `setProgress`, `setError`, `setPreload`, and clear all drop the class.
   *
   * Starts a new operation. With `fileName`, the context line shows the name
   * and "Checking file…" until `setFileContext` says what the file is.
   */
  setOpening(text: string, fileName?: string): void {
    this._clearHideTimer();
    this._beginOperation();
    this._token++;
    // A new load starts from the short trail.
    this._scan.reset();
    this.toast.classList.remove('olv-toast-error');
    this.toast.classList.remove('is-finishing');
    this.toast.classList.add('is-opening', 'is-busy');
    this._setBar(undefined);
    if (fileName) {
      this._name = fileName;
      this._file.textContent = fileName;
      this._file.title = fileName;
      this._facts.textContent = CHECKING_FILE;
      this._context.classList.remove('olv-hidden');
    }
    this._syncCancel();
    // The name is already on the context line; the progress line says what is
    // happening. The polite region names the file once, here.
    this._text.textContent = fileName ? 'Opening…' : text;
    this._announce(text);
    this._srAlert.textContent = '';
    this.toast.classList.remove('olv-hidden');
  }

  /**
   * Say what the file is: its format and loading scope, and any preflight
   * warning. Stays on screen through every later stage of the same open and is
   * cleared when the open ends. Ignored for a stale `op` or with no file open.
   */
  setFileContext(context: LoadContext, op?: number): void {
    if (op !== undefined && op !== this._op) return;
    if (!this._name) return;
    this._facts.textContent = context.facts.length > 0 ? context.facts.join(' · ') : CHECKING_FILE;
    const note = context.note ?? '';
    this._note.textContent = note;
    this._note.classList.toggle('olv-hidden', note === '');
    const said = context.announce ?? context.facts.join(', ');
    const spoken = [said, note].filter(Boolean).join('. ');
    if (spoken) this._announce(spoken);
  }

  /**
   * Show a progress message, optionally with a 0..1 completion bar. Pass
   * `null` to hide the toast entirely.
   */
  setProgress(text: string | null, fraction?: number): void {
    if (text === null) {
      this._hide();
      return;
    }
    this._throttle.cancel();
    this._stage = null;
    this._render(text, fraction, true);
    this._announce(text);
  }

  /**
   * Staged progress for an open. A new stage draws at once and is announced
   * once; repeats within the stage are paced (about 150 ms) and announce only
   * at each quarter of a determinate stage. An update for a stale operation is
   * dropped, and so is a paced update still held when the operation ends.
   */
  setStageProgress(text: string, fraction: number | undefined, options: StageOptions): void {
    if (options.op !== undefined && options.op !== this._op) return;
    const op = this._op;
    const changed = options.stage !== this._stage;
    const f = fraction === undefined || !Number.isFinite(fraction) ? undefined : clamp01(fraction);
    // A stage reaching its end is drawn at once, so the last quarter is never
    // held behind the next stage's first update and dropped.
    const immediate = changed || (f !== undefined && f >= 1);
    if (changed) this._stage = options.stage;
    // The trail is one style value, so it follows every update; only the text
    // and the announcements are paced.
    if (f !== undefined && options.trail !== false) {
      this._scan.setProgress(f);
    }
    this._throttle.push(() => {
      if (op !== this._op) return;
      this._render(text, f, options.trail !== false);
      this._announceStage(text, f, changed, options.announce);
    }, immediate);
  }

  /** Draw a busy progress state. */
  private _render(text: string, fraction: number | undefined, trail: boolean): void {
    this._clearHideTimer();
    this._token++;
    // Staged progress supersedes the blue "Opening …" pulse.
    this.toast.classList.remove('is-opening', 'olv-toast-error', 'is-finishing');
    this.toast.classList.add('is-busy');
    this._text.textContent = text;
    this._srAlert.textContent = '';
    this.toast.classList.remove('olv-hidden');
    // The trail grows with the bar; a stage without a fraction leaves it.
    if (fraction !== undefined && trail) this._scan.setProgress(fraction);
    this._setBar(fraction, text);
  }

  /** Announce a stage once on entry, then at each quarter it completes. */
  private _announceStage(text: string, fraction: number | undefined, changed: boolean, label?: string): void {
    const base = label ?? text;
    const quarter = fraction === undefined ? 0 : Math.floor(fraction * 4);
    if (changed) {
      this._quarter = quarter;
      this._announce(fraction === undefined || quarter === 0 ? base : `${base}, ${quarter * 25}%`);
      return;
    }
    if (quarter > this._quarter) {
      this._quarter = quarter;
      this._announce(`${base}, ${quarter * 25}%`);
    }
  }

  /**
   * The bar and the busy slot's progressbar semantics. A fraction shows the
   * bar and sets aria-valuenow; without one the bar is hidden, its width is
   * dropped and aria-valuenow removed, so the progressbar reads as
   * indeterminate and never carries an earlier stage's percentage.
   */
  private _setBar(fraction: number | undefined, text?: string): void {
    const m = this._mark;
    m.setAttribute('role', 'progressbar');
    m.setAttribute('aria-label', 'Loading progress');
    m.setAttribute('aria-valuemin', '0');
    m.setAttribute('aria-valuemax', '100');
    if (text) m.setAttribute('aria-valuetext', text);
    else m.removeAttribute('aria-valuetext');
    if (fraction === undefined) {
      m.removeAttribute('aria-valuenow');
      this._barFill.style.width = '0%';
      this._bar.classList.add('olv-hidden');
      return;
    }
    const pct = Math.round(clamp01(fraction) * 100);
    m.setAttribute('aria-valuenow', String(pct));
    this._barFill.style.width = `${pct}%`;
    this._bar.classList.remove('olv-hidden');
  }

  /** Drop the progressbar semantics once nothing is loading. */
  private _clearMeter(): void {
    for (const a of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) {
      this._mark.removeAttribute(a);
    }
  }

  /** Start a new operation: drop held updates and any earlier context. */
  private _beginOperation(): void {
    this._op++;
    this._throttle.cancel();
    this._stage = null;
    this._quarter = 0;
    this._clearContext();
  }

  /** End the operation: later updates for it are dropped. */
  private _endOperation(): void {
    this._op++;
    this._throttle.cancel();
    this._stage = null;
    this._quarter = 0;
  }

  /** Empty the context line and the warning. */
  private _clearContext(): void {
    this._name = '';
    this._file.textContent = '';
    this._file.title = '';
    this._facts.textContent = '';
    this._context.classList.add('olv-hidden');
    this._note.textContent = '';
    this._note.classList.add('olv-hidden');
  }

  /** Hide the toast and end any open. */
  private _hide(): void {
    this._clearHideTimer();
    this._endOperation();
    this._token++;
    this.toast.classList.remove('is-opening', 'is-busy', 'is-finishing');
    this._scan.reset();
    this.toast.classList.add('olv-hidden');
    this._setBar(undefined);
    this._clearMeter();
    this._clearContext();
    // Empty both live regions on hide so a re-shown toast re-announces
    // (live regions only fire on content CHANGE) and no stale text lingers.
    // The polite region is shared (`announcePolite`), so it is emptied only
    // while it still holds the toast's own text: a hide that lands after the
    // settle must not erase a newer announcement from another panel.
    this._clearOwnStatus();
    this._srAlert.textContent = '';
  }

  /**
   * End an open the user cancelled: hide at once and say so politely. Nothing
   * was added, so there is no error.
   */
  setCancelled(): void {
    const name = this._name;
    this._onCancel = null;
    this._syncCancel();
    this._hide();
    this._announce(name ? `Cancelled opening ${name}.` : 'Loading cancelled.', true);
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
    const name = this._name;
    if (this.toast.classList.contains('olv-hidden') || !this.toast.classList.contains('is-busy')) {
      this.setProgress(null);
      if (name) this._announce(`Opened ${name}.`, true);
      return Promise.resolve(true);
    }
    this._clearHideTimer();
    // The open is over: late updates from it are dropped from here on.
    this._endOperation();
    const token = ++this._token;
    this._onCancel = null;
    this._syncCancel();
    // The load is done; while the scan settles the toast gives the lane to a
    // tool opened meanwhile.
    this.toast.classList.add('is-finishing');
    if (name) this._announce(`Opened ${name}.`, true);
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
    this.toast.classList.remove('olv-toast-error', 'is-opening', 'is-finishing');
    this.toast.classList.add('is-busy');
    const text = lines.join('\n');
    this._text.textContent = text;
    this._announce(text);
    this._srAlert.textContent = '';
    this._setBar(undefined, text);
    this.toast.classList.remove('olv-hidden');
  }

  /**
   * Wire (or clear) the Cancel control. Passing a handler shows the control
   * and runs it on click; passing `null` hides the control.
   */
  setCancelHandler(handler: (() => void) | null): void {
    this._onCancel = handler;
    this._syncCancel();
  }

  /**
   * Show an error message in the toast. Auto-hides after 6 s, or 20 s when a
   * `report` is offered through the Copy report control. Ends any open, so its
   * file context is cleared and a late update from it is dropped.
   */
  setError(text: string, report?: string): void {
    this._clearHideTimer();
    this._endOperation();
    this._clearContext();
    this._token++;
    this._scan.reset();
    if (report) {
      this._report = report;
      this._copy.textContent = 'Copy report';
      this._copy.classList.remove('olv-hidden');
    }
    this._onCancel = null;
    this._syncCancel();
    this._setBar(undefined);
    this._clearMeter();
    this.toast.classList.remove('is-opening', 'is-busy', 'is-finishing');
    this.toast.classList.add('olv-toast-error');
    // The status node is emptied (when it holds the toast's text) so the
    // failure isn't double-read.
    this._clearOwnStatus();
    this._text.textContent = text;
    // The alert node announces immediately (role=alert is implicitly
    // assertive) — a load failure should interrupt; routine progress should
    // not.
    this._srAlert.textContent = text;
    this.toast.classList.remove('olv-hidden');
    this._hideTimer = window.setTimeout(() => {
      this._hideTimer = null;
      this.toast.classList.add('olv-hidden');
      this._srAlert.textContent = '';
    }, report ? 20000 : 6000);
  }

  /**
   * Write to the polite region. Cleared first, so a repeat of the same words is
   * still a change a screen reader announces. `keep` marks an end-of-open
   * message that a later hide must leave in place.
   */
  private _announce(message: string, keep = false): void {
    this._srStatus.textContent = '';
    this._srStatus.textContent = message;
    this._ownStatus = keep ? null : message;
  }

  /** Empty the shared polite region if it still holds the toast's text. */
  private _clearOwnStatus(): void {
    if (this._ownStatus !== null && this._srStatus.textContent === this._ownStatus) this._srStatus.textContent = '';
    this._ownStatus = null;
  }
}
