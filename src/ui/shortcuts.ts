/**
 * shortcuts.ts
 *
 * Focus-guard predicates and the measure-tool key reading shared by the global
 * shortcut table (`ui/keyBindings.ts`). The routing — which key runs which
 * action, and in what precedence — now lives in that declarative table; this
 * module keeps only the pure decision helpers, which the table and the tests
 * both import.
 *
 * `isTypingTarget` / `isEditableTarget` are deliberately two DISTINCT checks
 * (activeElement vs an ancestor walk of the event target); each shortcut site
 * uses the one it always used, so neither is unified into the other.
 */

/**
 * Whether a text-entry element currently holds focus. The former `bindShortcuts`
 * used this; the global-action bindings in `keyBindings.ts` still do. Suppresses
 * a shortcut so a keystroke meant for a note or a title is never also read as a
 * tool shortcut.
 */
export function isTypingTarget(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
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
