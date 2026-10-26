/**
 * editHistoryActions.ts — the global Undo and Redo, lifted out of main.ts.
 *
 * The viewer keeps two edit histories, annotations and classification.
 * `undoRouter` decides which one a chord targets; this runs the choice through
 * the viewer with the router's edit-notes suppressed, refreshes the class UI
 * when a class edit moved, and says in a toast what was undone or redone. A
 * chord with nothing to act on does nothing and says nothing: the toast is
 * for a change that happened.
 */

import type { Viewer } from '../render/Viewer';
import { pickRedo, pickUndo, withSuppressed } from '../ui/undoRouter';

/** The viewer surface the two histories live on. `Viewer` satisfies it structurally. */
export type EditHistoryViewer = Pick<
  Viewer,
  'annotate' | 'canUndoClassification' | 'canRedoClassification' | 'undoClassification' | 'redoClassification'
>;

export interface EditHistoryDeps {
  readonly viewer: () => EditHistoryViewer;
  /** The active scan, whose class history the chord may target; null with none. */
  readonly activeId: () => string | null;
  /** True while a dialog that owns the keys is open (Help), so the chord is left alone. */
  readonly blocked: () => boolean;
  /** Repaint the reclassify controls after a class edit moved. */
  readonly refreshClassUi: () => void;
  readonly toast: (message: string) => void;
}

/** Undo the most recent annotation or class edit. True when something was undone. */
export function undoLastEdit(d: EditHistoryDeps): boolean {
  if (d.blocked()) return false;
  const viewer = d.viewer();
  const id = d.activeId();
  const pick = pickUndo(viewer.annotate.canUndo, !!id && viewer.canUndoClassification(id));
  if (!pick) return false;
  withSuppressed(() => {
    if (pick === 'classification' && id) viewer.undoClassification(id);
    else viewer.annotate.undo();
  });
  if (pick === 'classification') d.refreshClassUi();
  d.toast(pick === 'classification' ? 'Undid class edit.' : 'Undid annotation edit.');
  return true;
}

/** Redo the most recently undone annotation or class edit. True when something was redone. */
export function redoLastEdit(d: EditHistoryDeps): boolean {
  if (d.blocked()) return false;
  const viewer = d.viewer();
  const id = d.activeId();
  const pick = pickRedo(viewer.annotate.canRedo, !!id && viewer.canRedoClassification(id));
  if (!pick) return false;
  withSuppressed(() => {
    if (pick === 'classification' && id) viewer.redoClassification(id);
    else viewer.annotate.redo();
  });
  if (pick === 'classification') d.refreshClassUi();
  d.toast(pick === 'classification' ? 'Redid class edit.' : 'Redid annotation edit.');
  return true;
}
