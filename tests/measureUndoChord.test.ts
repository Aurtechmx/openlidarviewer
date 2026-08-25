/**
 * measureUndoChord.test.ts
 *
 * What these tests would catch:
 *
 *  - Undo bound to Backspace alone, so the chord every desktop user reaches
 *    for (Cmd+Z on macOS, Ctrl+Z elsewhere) does nothing mid-measurement.
 *  - Backspace losing its binding while the chord is added.
 *  - Redo folded into undo: Shift+Cmd+Z and Ctrl+Y have no measurement
 *    meaning, and swallowing them would strand the user with two undos.
 *  - The editable-target check reading only the event target's tag name, so a
 *    keystroke inside a contenteditable's inner span, or inside the panel's
 *    name field, pops a vertex instead of undoing the text.
 *  - The chord being claimed with the tool armed but nothing drawn. The caller
 *    consumes whatever this returns, so a non-null answer there would
 *    preventDefault over a focused field's own undo and over the global
 *    annotation undo.
 */
import { describe, it, expect } from 'vitest';
import { isEditableTarget, measureKeyAction } from '../src/ui/shortcuts';

type KeyLike = Parameters<typeof measureKeyAction>[0];

/** A key event stripped to the fields the decision reads. */
function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, ...partial };
}

/** A DOM-shaped stand-in: `tagName` plus a parent chain, which is all the walk reads. */
function node(tagName: string, attrs: Record<string, string> = {}, parent: unknown = null): unknown {
  return {
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
    parentElement: parent,
  };
}

/**
 * The caller's rule, stated once here: consume the key event exactly when the
 * decision names an action. A null answer must leave the event untouched, so
 * the browser's own undo and the global annotation undo still see it.
 */
function handle(e: KeyLike, drafting: boolean): { action: string | null; prevented: boolean } {
  const action = measureKeyAction(e, drafting);
  return { action, prevented: action !== null };
}

describe('measure undo chord', () => {
  it('undoes a point on Cmd+Z and on Ctrl+Z mid-measurement', () => {
    expect(measureKeyAction(key({ key: 'z', metaKey: true }), true)).toBe('undo');
    expect(measureKeyAction(key({ key: 'z', ctrlKey: true }), true)).toBe('undo');
    // Caps Lock / Shift-less uppercase reports 'Z' on some layouts.
    expect(measureKeyAction(key({ key: 'Z', metaKey: true }), true)).toBe('undo');
  });

  it('keeps Backspace and Enter working', () => {
    expect(measureKeyAction(key({ key: 'Backspace' }), true)).toBe('undo');
    expect(measureKeyAction(key({ key: 'Backspace' }), false)).toBe('undo');
    expect(measureKeyAction(key({ key: 'Enter' }), true)).toBe('finish');
  });

  it('leaves redo chords alone', () => {
    expect(measureKeyAction(key({ key: 'z', metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(measureKeyAction(key({ key: 'Z', ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(measureKeyAction(key({ key: 'y', ctrlKey: true }), true)).toBeNull();
  });

  it('yields to text entry, including a nested editable target', () => {
    const input = node('INPUT');
    expect(measureKeyAction(key({ key: 'z', metaKey: true, target: input as EventTarget }), true)).toBeNull();
    expect(measureKeyAction(key({ key: 'Backspace', target: input as EventTarget }), true)).toBeNull();

    const inner = node('SPAN', {}, node('DIV', { contenteditable: 'true' }));
    expect(measureKeyAction(key({ key: 'z', metaKey: true, target: inner as EventTarget }), true)).toBeNull();
    expect(isEditableTarget(inner as EventTarget)).toBe(true);
    expect(isEditableTarget(node('SPAN', {}, node('DIV', { contenteditable: 'false' })) as EventTarget)).toBe(false);
    expect(isEditableTarget(node('SPAN') as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('does not claim the chord with measure mode armed but nothing drawn', () => {
    expect(measureKeyAction(key({ key: 'z', metaKey: true }), false)).toBeNull();
    expect(measureKeyAction(key({ key: 'z', ctrlKey: true }), false)).toBeNull();
    expect(handle(key({ key: 'z', metaKey: true }), false).prevented).toBe(false);
  });

  it('leaves the event unconsumed when it belongs to a text field', () => {
    const inField = key({ key: 'z', metaKey: true, target: node('TEXTAREA') as EventTarget });
    expect(handle(inField, true)).toEqual({ action: null, prevented: false });
    expect(handle(key({ key: 'z', metaKey: true }), true)).toEqual({ action: 'undo', prevented: true });
  });
});
