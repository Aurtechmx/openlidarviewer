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

    switch (e.key) {
      case 'a':
      case 'A':
        handlers.onAnnotate();
        return;
      case 'm':
      case 'M':
        handlers.onMeasure();
        return;
      case 'i':
      case 'I':
        handlers.onInspect();
        return;
      case 'v':
      case 'V':
        handlers.onSaveView();
        return;
      case '?':
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
