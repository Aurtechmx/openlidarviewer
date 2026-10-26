/**
 * editHistoryActions.test.ts
 *
 * The global Undo and Redo pick the stack the router names, run it with the
 * router's edit-notes suppressed, refresh the class controls after a class
 * edit moved, and say what happened in a toast. Nothing to act on means no
 * toast; an open Help overlay means the chord is left alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { undoLastEdit, redoLastEdit, type EditHistoryDeps, type EditHistoryViewer } from '../src/app/editHistoryActions';
import { noteEdit, _resetUndoRouter } from '../src/ui/undoRouter';

function viewer(over: { annotationUndo?: boolean; annotationRedo?: boolean; classUndo?: boolean; classRedo?: boolean } = {}) {
  const v = {
    annotate: {
      canUndo: over.annotationUndo ?? false,
      canRedo: over.annotationRedo ?? false,
      undo: vi.fn(),
      redo: vi.fn(),
    },
    canUndoClassification: vi.fn(() => over.classUndo ?? false),
    canRedoClassification: vi.fn(() => over.classRedo ?? false),
    undoClassification: vi.fn(),
    redoClassification: vi.fn(),
  };
  return v as unknown as EditHistoryViewer & typeof v;
}

function deps(v: ReturnType<typeof viewer>, over: Partial<EditHistoryDeps> = {}) {
  const toast = vi.fn();
  const refreshClassUi = vi.fn();
  const d: EditHistoryDeps = { viewer: () => v, activeId: () => 'scan-1', blocked: () => false, refreshClassUi, toast, ...over };
  return { d, toast, refreshClassUi };
}

beforeEach(() => _resetUndoRouter());

describe('global undo', () => {
  it('undoes an annotation edit and says so', () => {
    const v = viewer({ annotationUndo: true });
    const { d, toast, refreshClassUi } = deps(v);
    expect(undoLastEdit(d)).toBe(true);
    expect(v.annotate.undo).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Undid annotation edit.');
    expect(refreshClassUi).not.toHaveBeenCalled();
  });

  it('undoes the class edit touched last, refreshes the class controls and says so', () => {
    const v = viewer({ annotationUndo: true, classUndo: true });
    const { d, toast, refreshClassUi } = deps(v);
    noteEdit('classification');
    expect(undoLastEdit(d)).toBe(true);
    expect(v.undoClassification).toHaveBeenCalledWith('scan-1');
    expect(v.annotate.undo).not.toHaveBeenCalled();
    expect(refreshClassUi).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Undid class edit.');
  });

  it('does nothing, and says nothing, with nothing to undo', () => {
    const { d, toast } = deps(viewer());
    expect(undoLastEdit(d)).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('leaves the chord alone while a dialog owns the keys', () => {
    const v = viewer({ annotationUndo: true });
    const { d, toast } = deps(v, { blocked: () => true });
    expect(undoLastEdit(d)).toBe(false);
    expect(v.annotate.undo).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('skips the class stack with no active scan', () => {
    const v = viewer({ classUndo: true });
    const { d } = deps(v, { activeId: () => null });
    expect(undoLastEdit(d)).toBe(false);
    expect(v.undoClassification).not.toHaveBeenCalled();
  });
});

describe('global redo', () => {
  it('redoes the stack that was undone and says so', () => {
    const v = viewer({ annotationUndo: true, annotationRedo: true, classRedo: true });
    const { d, toast } = deps(v);
    undoLastEdit(d);
    expect(redoLastEdit(d)).toBe(true);
    expect(v.annotate.redo).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith('Redid annotation edit.');
  });

  it('redoes a class edit and refreshes the class controls', () => {
    const v = viewer({ classRedo: true });
    const { d, toast, refreshClassUi } = deps(v);
    expect(redoLastEdit(d)).toBe(true);
    expect(v.redoClassification).toHaveBeenCalledWith('scan-1');
    expect(refreshClassUi).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Redid class edit.');
  });
});
