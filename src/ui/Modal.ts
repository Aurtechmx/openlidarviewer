/**
 * Modal.ts
 *
 * A small, reusable accessible modal — a dimmed backdrop holding a centred
 * dialog card in the dark "instrument" aesthetic. Built for the pre-export MAP
 * PDF dialog but deliberately content-agnostic so other flows can reuse it.
 *
 * Accessibility: the dialog carries `role="dialog"` + `aria-modal="true"` and
 * is labelled by its title. Focus is trapped inside the dialog (Tab / Shift+Tab
 * cycle the focusable children), Escape closes it, a click on the backdrop
 * (outside the card) closes it, and focus is restored to the trigger (or the
 * previously-focused element) when it closes.
 *
 * Browser-bound (DOM) — not imported in Node tests.
 */

import { el } from './dom';

export interface ModalOptions {
  /** Visible dialog title; also wires `aria-labelledby`. */
  readonly title: string;
  /** The dialog body (form fields, etc.). */
  readonly body: HTMLElement;
  /** The action row (e.g. Export / Cancel). Pinned below the scrollable body. */
  readonly footer?: HTMLElement;
  /** Element to restore focus to on close; defaults to the active element at open. */
  readonly returnFocusTo?: HTMLElement | null;
  /** Called once, after the modal is torn down. */
  readonly onClose?: () => void;
  /**
   * Keep the backdrop mounted this many ms after close so a caller can play a
   * CSS exit transition — the backdrop gets `olv-modal-closing` for the wait,
   * then is removed. Focus restore + `onClose` still fire synchronously, so the
   * dismissal semantics are unchanged; only the DOM removal is deferred. Omit
   * (the default) to remove immediately, byte-for-byte the prior behaviour.
   */
  readonly exitMs?: number;
}

export interface ModalHandle {
  /** The backdrop element (already mounted into the document). */
  readonly element: HTMLElement;
  /** Close the modal, restore focus, and fire `onClose` (idempotent). */
  close(): void;
}

/** Selector for the elements Tab should cycle through inside the dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let modalSeq = 0;

/**
 * Open an accessible modal and mount it on `document.body`. Returns a handle
 * whose `close()` tears it down and restores focus. The caller owns the
 * body/footer content; this primitive only provides the chrome + a11y wiring.
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const restoreTo =
    opts.returnFocusTo ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const titleId = `olv-modal-title-${++modalSeq}`;
  const titleEl = el('h2', { className: 'olv-modal-title', text: opts.title });
  titleEl.id = titleId;

  const closeBtn = el('button', {
    className: 'olv-modal-x',
    text: '×', // ×
    ariaLabel: 'Close dialog',
    type: 'button',
  });

  const head = el('div', { className: 'olv-modal-head' }, [titleEl, closeBtn]);
  const bodyWrap = el('div', { className: 'olv-modal-body' }, [opts.body]);
  const children: HTMLElement[] = [head, bodyWrap];
  if (opts.footer) children.push(el('div', { className: 'olv-modal-foot' }, [opts.footer]));

  const dialog = el('div', { className: 'olv-modal' }, children);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);

  const backdrop = el('div', { className: 'olv-modal-backdrop' }, [dialog]);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    const exitMs = opts.exitMs ?? 0;
    if (exitMs > 0) {
      // Keep the surface painted for the exit transition, but immediately inert
      // so it cannot take input while it fades; drop it once the wait elapses.
      backdrop.classList.add('olv-modal-closing');
      window.setTimeout(() => backdrop.remove(), exitMs);
    } else {
      backdrop.remove();
    }
    // Restore focus to the trigger so keyboard users land back where they were.
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    opts.onClose?.();
  };

  const focusable = (): HTMLElement[] =>
    Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Focus trap — keep Tab / Shift+Tab cycling within the dialog.
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', onKeyDown, true);

  document.body.append(backdrop);

  // Move focus into the dialog: the first field, else the dialog itself.
  const initial = focusable()[0] ?? dialog;
  initial.focus();

  return { element: backdrop, close };
}

export interface ConfirmOptions {
  /** Dialog title — the question's headline (e.g. "Open large file?"). */
  readonly title: string;
  /**
   * Body text. Newlines become separate paragraphs so multi-reason prompts
   * (the cellular + memory sample gate) read as a list, not one run-on line.
   */
  readonly message: string;
  /** Confirm-button label. Defaults to "Continue". */
  readonly confirmLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** Element to restore focus to on close. */
  readonly returnFocusTo?: HTMLElement | null;
}

/**
 * Styled confirm dialog — a Promise-based replacement for `window.confirm()`.
 *
 * WHY this exists: native `confirm()` is unreliable in embedded WebViews (some
 * suppress it entirely, returning `false` without ever showing a prompt), so a
 * user inside an iframe/app shell could never approve a large-file or cellular
 * download. This builds the same blocking yes/no decision on our own Modal
 * chrome, which renders identically everywhere the app does.
 *
 * Resolves `true` on confirm, `false` on cancel / Escape / backdrop click /
 * close-X — matching `confirm()`'s "anything-but-OK is no" semantics. The
 * Cancel button takes initial focus so an accidental Enter is a safe no.
 */
export function openConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let decided = false;
    const settle = (value: boolean): void => {
      if (decided) return;
      decided = true;
      resolve(value);
    };

    // One paragraph per line keeps multi-reason prompts legible.
    const body = el(
      'div',
      { className: 'olv-confirm-body' },
      opts.message
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => el('p', { className: 'olv-confirm-line', text: line })),
    );

    const cancelBtn = el('button', {
      className: 'olv-confirm-cancel',
      text: opts.cancelLabel ?? 'Cancel',
      type: 'button',
    });
    const confirmBtn = el('button', {
      className: 'olv-confirm-ok',
      text: opts.confirmLabel ?? 'Continue',
      type: 'button',
    });
    const footer = el('div', { className: 'olv-confirm-actions' }, [cancelBtn, confirmBtn]);

    const handle = openModal({
      title: opts.title,
      body,
      footer,
      returnFocusTo: opts.returnFocusTo,
      // Backdrop click, Escape, and the close-X all route here — treat any
      // dismissal that isn't an explicit confirm as a "no".
      onClose: () => settle(false),
    });

    cancelBtn.addEventListener('click', () => {
      settle(false);
      handle.close();
    });
    confirmBtn.addEventListener('click', () => {
      settle(true);
      handle.close();
    });

    // Cancel is the safe default — focus it so a reflexive Enter cancels.
    cancelBtn.focus();
  });
}
