import { describe, test, expect } from 'vitest';
import {
  diffClassification,
  recordEdit,
  ClassEditHistory,
} from '../src/render/measure/classEditHistory';

describe('diffClassification', () => {
  test('identical buffers produce no delta', () => {
    const a = Uint8Array.from([1, 2, 3]);
    expect(diffClassification(a, Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  test('captures only the changed points, with prev and next', () => {
    const before = Uint8Array.from([1, 1, 1, 1]);
    const after = Uint8Array.from([1, 6, 1, 8]);
    const d = diffClassification(before, after)!;
    expect(Array.from(d.indices)).toEqual([1, 3]);
    expect(Array.from(d.prev)).toEqual([1, 1]);
    expect(Array.from(d.next)).toEqual([6, 8]);
  });

  test('throws on a length mismatch rather than corrupt the wrong points', () => {
    expect(() => diffClassification(new Uint8Array(3), new Uint8Array(4))).toThrow(/length/);
  });
});

describe('ClassEditHistory', () => {
  test('multi-step undo reverts edits one at a time (not coalesced)', () => {
    const buf = Uint8Array.from([0, 0, 0]);
    const h = new ClassEditHistory();
    recordEdit(h, buf, () => (buf[0] = 2)); // edit 1
    recordEdit(h, buf, () => (buf[1] = 6)); // edit 2
    expect(Array.from(buf)).toEqual([2, 6, 0]);
    expect(h.depth).toBe(2);

    h.undo(buf);
    expect(Array.from(buf)).toEqual([2, 0, 0]); // only edit 2 undone
    h.undo(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0]); // edit 1 undone
    expect(h.canUndo).toBe(false);
  });

  test('redo re-applies an undone edit; a new edit clears the redo branch', () => {
    const buf = Uint8Array.from([0, 0]);
    const h = new ClassEditHistory();
    recordEdit(h, buf, () => (buf[0] = 2));
    h.undo(buf);
    expect(Array.from(buf)).toEqual([0, 0]);
    expect(h.canRedo).toBe(true);
    h.redo(buf);
    expect(Array.from(buf)).toEqual([2, 0]);

    // undo, then a fresh edit — redo branch must be discarded.
    h.undo(buf);
    recordEdit(h, buf, () => (buf[1] = 9));
    expect(h.canRedo).toBe(false);
    expect(Array.from(buf)).toEqual([0, 9]);
  });

  test('a no-op edit records nothing', () => {
    const buf = Uint8Array.from([3, 3]);
    const h = new ClassEditHistory();
    expect(recordEdit(h, buf, () => void 0)).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  test('the stack is bounded — oldest edits are evicted past the limit', () => {
    const buf = Uint8Array.from([0]);
    const h = new ClassEditHistory(2);
    recordEdit(h, buf, () => (buf[0] = 1));
    recordEdit(h, buf, () => (buf[0] = 2));
    recordEdit(h, buf, () => (buf[0] = 3));
    expect(h.depth).toBe(2); // first edit evicted
    h.undo(buf); // 3 → 2
    h.undo(buf); // 2 → 1
    expect(buf[0]).toBe(1); // can't undo past the evicted edit-1 boundary
    expect(h.canUndo).toBe(false);
  });

  test('undo/redo on an empty history are safe no-ops', () => {
    const buf = Uint8Array.from([5]);
    const h = new ClassEditHistory();
    expect(h.undo(buf)).toBeNull();
    expect(h.redo(buf)).toBeNull();
    expect(buf[0]).toBe(5);
  });
});
