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
export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The focusable children of `dialog`, in tab order. Hidden nodes are dropped,
 * but the active element is kept so a focused-then-hidden control cannot
 * strand Tab.
 */
export function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (n) => n.offsetParent !== null || n === document.activeElement,
  );
}

/**
 * Keep Tab / Shift+Tab cycling inside `dialog`. Call from a keydown handler for
 * any `role="dialog"` surface; a no-op for every key but Tab. Shared so the
 * modal primitive and the hand-rolled dialogs cannot drift apart.
 */
export function trapTab(dialog: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = focusableIn(dialog);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items.at(-1)!;
  const active = document.activeElement;
  // Focus outside the dialog (a click on the page behind) comes back in at
  // the end Tab is heading for: the first control forward, the last reverse.
  if (!dialog.contains(active) || active === (e.shiftKey ? first : last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/** One open dialog and the keydown handler it listens with. */
type StackedDialog = readonly [dialog: HTMLElement, onKeyDown: (e: KeyboardEvent) => void];

/**
 * Every open dialog, topmost last. Each handler listens on `window` in the
 * capture phase, but only the topmost acts, so one Escape closes one dialog
 * and Tab stays inside the dialog on top.
 */
const openDialogs: StackedDialog[] = [];

/**
 * The topmost open dialog. On the way it drops any dialog that left the
 * document without its teardown, so a removed dialog cannot keep Tab, Cmd-K
 * or ? blocked.
 */
function topDialog(): StackedDialog | undefined {
  let top;
  while ((top = openDialogs.at(-1)) && !top[0].isConnected) {
    openDialogs.pop();
    window.removeEventListener('keydown', top[1], true);
  }
  return top;
}

/** Whether a dialog wired through this module is open. */
export const dialogOpen = (): boolean => topDialog() !== undefined;

/** Put `dialog` on top of the stack with its Escape and Tab handling. Returns the remover. */
function stackDialog(dialog: HTMLElement, onEscape: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (topDialog()?.[1] !== onKeyDown) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onEscape();
      return;
    }
    trapTab(dialog, e);
  };
  const entry: StackedDialog = [dialog, onKeyDown];
  openDialogs.push(entry);
  window.addEventListener('keydown', onKeyDown, true);
  return () => {
    const i = openDialogs.indexOf(entry);
    if (i >= 0) openDialogs.splice(i, 1);
    window.removeEventListener('keydown', onKeyDown, true);
  };
}

export interface DialogA11yOptions {
  /** Called when Escape is pressed while the dialog is wired. */
  readonly onEscape: () => void;
  /** Element to restore focus to on teardown; defaults to the active element at wire time. */
  readonly returnFocusTo?: HTMLElement | null;
}

export interface DialogA11yHandle {
  /** The element focus will be restored to on teardown, if still in the document. */
  readonly restoreTo: HTMLElement | null;
  /** Stop listening for Escape/Tab and restore focus. Idempotent. */
  teardown(): void;
}

/**
 * Wire the standard backdrop-dismiss behaviour for a hand-rolled dialog: a
 * click on the backdrop closes it, while a click inside the card does not
 * bubble to the backdrop (so selecting text or clicking a control never
 * closes the dialog by accident). Shared by CommandPalette and ShortcutSheet,
 * which both stack a `card` over a `backdrop` outside `openModal`.
 */
export function wireBackdropDismiss(backdrop: HTMLElement, card: HTMLElement, close: () => void): void {
  backdrop.addEventListener('click', () => close());
  card.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * Give a hand-rolled dialog (one that doesn't go through `openModal`) the same
 * Escape-anywhere + Tab-trap + focus-restore behaviour as the modal primitive,
 * without duplicating the wiring. Installs a window-level, capture-phase
 * keydown listener so Escape and Tab work even once focus has left the
 * dialog (the failure mode a per-element listener cannot catch), and records
 * the previously-focused element to restore on `teardown()`. With dialogs
 * stacked, only the one opened last answers Escape and Tab.
 *
 * The caller still owns opening/closing and initial focus; call `teardown()`
 * from the dialog's own `close()`.
 */
export function wireDialogA11y(dialog: HTMLElement, opts: DialogA11yOptions): DialogA11yHandle {
  const restoreTo =
    opts.returnFocusTo ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  let torn = false;
  const unstack = stackDialog(dialog, opts.onEscape);

  return {
    restoreTo,
    teardown(): void {
      if (torn) return;
      torn = true;
      unstack();
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    },
  };
}

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
    tip: 'Close this dialog.',
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
    unstack();
    const exitMs = opts.exitMs ?? 0;
    if (exitMs > 0) {
      // Keep the surface painted for the exit transition, but immediately inert
      // so it cannot take input while it fades; drop it once the wait elapses.
      backdrop.classList.add('olv-modal-closing');
      backdrop.inert = true;
      window.setTimeout(() => backdrop.remove(), exitMs);
    } else {
      backdrop.remove();
    }
    // Restore focus to the trigger so keyboard users land back where they were.
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    opts.onClose?.();
  };

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  // Escape closes; Tab / Shift+Tab cycle within the dialog.
  const unstack = stackDialog(dialog, close);

  document.body.append(backdrop);

  // Move focus into the dialog: the first field, else the dialog itself.
  const initial = focusableIn(dialog)[0] ?? dialog;
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
  /** Hover/focus explanation for the confirm button. */
  readonly confirmTip?: string;
  /** Hover/focus explanation for the cancel button. */
  readonly cancelTip?: string;
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
      tip: opts.cancelTip ?? 'Close this dialog and take no action.',
    });
    const confirmBtn = el('button', {
      className: 'olv-confirm-ok',
      text: opts.confirmLabel ?? 'Continue',
      type: 'button',
      tip: opts.confirmTip ?? (opts.title ? `Proceed with: ${opts.title}` : 'Confirm and proceed.'),
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
