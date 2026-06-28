/**
 * undoRouter.ts — decides which edit stack a global Undo / Redo targets.
 *
 * The viewer keeps two independent edit histories: annotations and
 * classification. A single Ctrl/Cmd+Z should undo whatever the user *touched
 * last* (the intuitive "most-recent stack" model), then fall through to the
 * other stack once the first is exhausted — rather than always favouring one.
 *
 * This module is a tiny shared singleton: every real edit calls `noteEdit`,
 * and the global shortcut handler asks `pickUndo` / `pickRedo` which stack to
 * act on given which stacks currently have undoable / redoable items. It holds
 * no references to the viewer, so it stays trivially testable and chunk-safe
 * (one instance shared across lazy chunks).
 */

export type EditStack = 'annotation' | 'classification';

let lastEdited: EditStack | null = null;
let lastUndone: EditStack | null = null;
let suppressed = false;

/**
 * Run `fn` with edit-notes suppressed. The global Undo/Redo replays through the
 * same controllers that fire change callbacks; without this, undoing an
 * annotation would re-mark the annotation stack as "most recently edited" and
 * corrupt the router's memory. User edits are never wrapped, so they still
 * register.
 */
export function withSuppressed<T>(fn: () => T): T {
  const prev = suppressed;
  suppressed = true;
  try {
    return fn();
  } finally {
    suppressed = prev;
  }
}

/** Record that the user just edited `stack` (ignored while suppressed). */
export function noteEdit(stack: EditStack): void {
  if (suppressed) return;
  lastEdited = stack;
  lastUndone = null;
}

function order(primary: EditStack | null): readonly EditStack[] {
  return primary === 'classification'
    ? (['classification', 'annotation'] as const)
    : (['annotation', 'classification'] as const);
}

/**
 * Choose the stack a global Undo should act on. Prefers the most-recently
 * touched stack that still has undoable items, then the other. Returns null
 * when nothing can be undone. Records the choice so consecutive undos stay on
 * the same stack until it empties, and so Redo can target it.
 */
export function pickUndo(canUndoAnnotation: boolean, canUndoClassification: boolean): EditStack | null {
  for (const stack of order(lastEdited)) {
    if (stack === 'classification' && canUndoClassification) {
      lastEdited = 'classification';
      lastUndone = 'classification';
      return 'classification';
    }
    if (stack === 'annotation' && canUndoAnnotation) {
      lastEdited = 'annotation';
      lastUndone = 'annotation';
      return 'annotation';
    }
  }
  return null;
}

/**
 * Choose the stack a global Redo should act on. Prefers the stack most recently
 * undone (so Redo mirrors Undo), then the other. Returns null when nothing can
 * be redone.
 */
export function pickRedo(canRedoAnnotation: boolean, canRedoClassification: boolean): EditStack | null {
  for (const stack of order(lastUndone ?? lastEdited)) {
    if (stack === 'classification' && canRedoClassification) {
      lastEdited = 'classification';
      lastUndone = 'classification';
      return 'classification';
    }
    if (stack === 'annotation' && canRedoAnnotation) {
      lastEdited = 'annotation';
      lastUndone = 'annotation';
      return 'annotation';
    }
  }
  return null;
}

/** Test-only: reset the singleton between cases. */
export function _resetUndoRouter(): void {
  lastEdited = null;
  lastUndone = null;
  suppressed = false;
}
