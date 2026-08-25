/**
 * shortcuts.ts
 *
 * The global keyboard shortcuts (design §6.10): single-key access to the
 * inspection tools and a few common actions.
 *
 * Every shortcut is suppressed while a text input, textarea, or contenteditable
 * holds focus — checked against `document.activeElement` — so typing an
 * annotation note never triggers a tool. Modifier combinations (Ctrl / Cmd /
 * Alt) are left untouched so browser and OS shortcuts keep working.
 *
 * Browser-bound (DOM); not imported in Node tests.
 */

/** The actions the global shortcut handler can invoke. */
export interface ShortcutHandlers {
  /** `A` — toggle the annotation tool. */
  onAnnotate: () => void;
  /** `M` — toggle the measurement tool. */
  onMeasure: () => void;
  /** `I` — toggle the point inspector. */
  onInspect: () => void;
  /** `V` — save the current camera view. */
  onSaveView: () => void;
  /** `Delete` / `Backspace` — delete the selected annotation. */
  onDeleteSelection: () => void;
  /** `?` — toggle the help overlay. */
  onToggleHelp: () => void;
  /** `Ctrl/Cmd+Z` — undo the last annotation change. */
  onUndo: () => void;
  /** `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` — redo. */
  onRedo: () => void;
}

/**
 * Whether a text-entry element currently holds focus. Shortcuts are suppressed
 * in that case so a keystroke meant for a note or a title is never also read
 * as a tool shortcut.
 */
function isTypingTarget(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
}

/**
 * Bind the global keyboard shortcuts to `window`. Returns a disposer that
 * removes the listener.
 *
 * Escape is intentionally NOT handled here — the viewer already cancels the
 * active tool on Escape, and the inline editor and help overlay handle their
 * own — so a single source owns each Escape context.
 */
export function bindShortcuts(handlers: ShortcutHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    // Shortcuts never fire while a field has focus — a note's own undo, and
    // every typed key, stays with the input.
    if (isTypingTarget()) return;

    // Undo / redo are the one place a modifier IS the shortcut.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) handlers.onRedo();
      else handlers.onUndo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      handlers.onRedo();
      return;
    }
    // Every other shortcut is a bare key — leave browser / OS combos alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Every handled bare key calls `preventDefault()` so any OTHER bare-key
    // window handler (e.g. main.ts's T/O/P camera presets, which bails on
    // `defaultPrevented` just like the check at the top of this handler)
    // sees the keystroke as consumed. This is what stops 'I' from firing
    // both Inspect and a camera preset on one press (the v0.4.3 collision).
    switch (e.key) {
      case 'a':
      case 'A':
        e.preventDefault();
        handlers.onAnnotate();
        return;
      case 'm':
      case 'M':
        e.preventDefault();
        handlers.onMeasure();
        return;
      case 'i':
      case 'I':
        e.preventDefault();
        handlers.onInspect();
        return;
      case 'v':
      case 'V':
        e.preventDefault();
        handlers.onSaveView();
        return;
      case '?':
        e.preventDefault();
        handlers.onToggleHelp();
        return;
      case 'Delete':
      case 'Backspace':
        // Guard against Backspace's legacy "navigate back" behaviour.
        e.preventDefault();
        handlers.onDeleteSelection();
        return;
      default:
        return;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/**
 * Whether a key event originates inside a text-entry element.
 *
 * The ancestor walk is the point: a keystroke inside a contenteditable lands
 * on the deepest node under the caret, so a check against the event target
 * alone reads a styled span as non-editable and steals the user's own undo.
 * Structural, not DOM-typed, so the decision stays testable outside a browser.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  type Node = {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    parentElement?: Node | null;
  };
  for (let node = target as Node | null; node; node = node.parentElement ?? null) {
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    const attr = node.getAttribute?.('contenteditable');
    if (attr != null && attr !== 'false') return true;
  }
  return false;
}

/** What a key press means to an armed measurement tool, or null for nothing. */
export type MeasureKeyAction = 'finish' | 'undo';

/**
 * Read a key event as a measure-tool action, given whether a measurement is
 * mid-draft. Callers act on a non-null result and consume the event.
 *
 * Undo answers to Backspace and to the platform chord (Cmd+Z on macOS,
 * Ctrl+Z elsewhere; both accepted, since a chord that silently does nothing
 * is worse than one that fires on the other platform's modifier). The chord
 * counts only while a draft is open, so with the tool merely armed the event
 * stays with whatever owns it otherwise — a focused name field's own undo,
 * and the global annotation/classification undo.
 *
 * Shift+Cmd+Z and Ctrl+Y are redo. There is no measurement redo, so they are
 * not claimed here rather than being folded into undo.
 */
export function measureKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & {
    target?: EventTarget | null;
  },
  drafting: boolean,
): MeasureKeyAction | null {
  if (isEditableTarget(e.target ?? null)) return null;
  if (e.key === 'Enter') return 'finish';
  if (e.key === 'Backspace') return 'undo';
  const chord = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
  if (chord && (e.key === 'z' || e.key === 'Z')) return drafting ? 'undo' : null;
  return null;
}
