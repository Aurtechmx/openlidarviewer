/**
 * undoRouter.test.ts — the most-recent-stack Undo/Redo arbiter.
 *
 * The viewer has two independent edit histories (annotations + classification).
 * A global Ctrl/Cmd+Z must undo whichever the user touched last, then fall
 * through to the other once the first empties. These tests lock that contract
 * and the suppression guard that keeps programmatic replay from corrupting the
 * router's memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteEdit,
  pickUndo,
  pickRedo,
  withSuppressed,
  _resetUndoRouter,
} from '../src/ui/undoRouter';

beforeEach(() => _resetUndoRouter());

describe('pickUndo — most-recent stack wins', () => {
  it('undoes the most-recently-edited stack when both have items', () => {
    noteEdit('annotation');
    noteEdit('classification'); // classification is now most recent
    expect(pickUndo(true, true)).toBe('classification');
  });

  it('targets annotation when it was edited last', () => {
    noteEdit('classification');
    noteEdit('annotation');
    expect(pickUndo(true, true)).toBe('annotation');
  });

  it('falls through to the other stack when the preferred one is empty', () => {
    noteEdit('classification');
    // classification preferred, but it has nothing undoable → annotation
    expect(pickUndo(true, false)).toBe('annotation');
  });

  it('returns null when nothing can be undone', () => {
    noteEdit('annotation');
    expect(pickUndo(false, false)).toBeNull();
  });

  it('stays on a stack for consecutive undos until it empties', () => {
    noteEdit('classification');
    expect(pickUndo(true, true)).toBe('classification');
    expect(pickUndo(true, true)).toBe('classification'); // still class
    expect(pickUndo(true, false)).toBe('annotation'); // class empty → anno
  });
});

describe('pickRedo — mirrors the most-recent undo', () => {
  it('redoes the stack that was just undone', () => {
    noteEdit('classification');
    pickUndo(true, true); // undo classification
    expect(pickRedo(true, true)).toBe('classification');
  });

  it('redoes annotation after an annotation undo', () => {
    noteEdit('annotation');
    pickUndo(true, true);
    expect(pickRedo(true, true)).toBe('annotation');
  });

  it('falls through when the mirrored stack has nothing to redo', () => {
    noteEdit('classification');
    pickUndo(true, true);
    expect(pickRedo(true, false)).toBe('annotation');
  });
});

describe('withSuppressed — programmatic replay does not rewrite memory', () => {
  it('ignores noteEdit while suppressed', () => {
    noteEdit('classification'); // user edit
    withSuppressed(() => {
      // The annotation controller's onChange fires during a programmatic
      // undo and calls noteEdit('annotation') — this must be ignored.
      noteEdit('annotation');
    });
    // classification is still the most-recent user-edited stack.
    expect(pickUndo(true, true)).toBe('classification');
  });

  it('restores the prior suppression state (nestable)', () => {
    let inner: unknown;
    withSuppressed(() => {
      withSuppressed(() => {
        inner = noteEdit('annotation'); // suppressed
      });
      // still suppressed here
      noteEdit('classification');
    });
    expect(inner).toBeUndefined();
    // nothing was noted while suppressed → both edits ignored, fallback order
    expect(pickUndo(true, true)).toBe('annotation'); // default order anno-first
  });
});

describe('fresh edit clears the redo target', () => {
  it('a new edit after an undo prevents a stale redo from winning', () => {
    noteEdit('annotation');
    pickUndo(true, true); // undo annotation; lastUndone = annotation
    noteEdit('classification'); // new user edit clears lastUndone
    // Redo should now prefer the freshly-edited classification stack.
    expect(pickRedo(true, true)).toBe('classification');
  });
});
