// What these tests would catch:
//
//  - Closing or replacing a scan leaving the old scan's annotations in the undo
//    history, so Ctrl+Z on the next scan brought them back at positions that
//    meant nothing there.
//  - The user's own "Clear all" losing its undo step.
//  - A close or replace path still calling the undoable clear.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl } from './support/measurePanelDom';

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    querySelector: () => null,
    contains: () => true,
    activeElement: null,
  };
  g.window = { innerWidth: 1280, innerHeight: 800 };
});

const note = (title: string) => ({ title, type: 'note' as const, localPosition: { x: 1, y: 2, z: 3 } });

describe('annotation history across scans', () => {
  it('reset empties the list and leaves nothing to undo or redo', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    c.add(note('a'));
    c.add(note('b'));
    c.undo();
    expect(c.canUndo).toBe(true);
    expect(c.canRedo).toBe(true);
    c.reset();
    expect(c.getAnnotations()).toHaveLength(0);
    expect(c.canUndo).toBe(false);
    expect(c.canRedo).toBe(false);
    c.undo();
    expect(c.getAnnotations()).toHaveLength(0);
  });

  it('reset with no annotations still drops the history', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    const a = c.add(note('a'));
    c.remove(a.id);
    expect(c.getAnnotations()).toHaveLength(0);
    expect(c.canUndo).toBe(true);
    c.reset();
    expect(c.canUndo).toBe(false);
  });

  it('resetHistory keeps the annotations and drops only the history', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    c.add(note('a'));
    c.resetHistory();
    expect(c.getAnnotations()).toHaveLength(1);
    expect(c.canUndo).toBe(false);
  });

  it('the user\'s Clear all stays undoable', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    c.add(note('a'));
    c.clear();
    expect(c.getAnnotations()).toHaveLength(0);
    expect(c.canUndo).toBe(true);
    c.undo();
    expect(c.getAnnotations()).toHaveLength(1);
  });

  it('every close and replace path resets rather than clears', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const read = (p: string) => readFileSync(join(root, p), 'utf8');
    const main = read('main.ts');
    const reset = main.slice(main.indexOf('function resetToEmptyState(): void {'));
    expect(reset.slice(0, reset.indexOf('\n}\n'))).toContain('viewer.annotate.reset();');
    // The one undoable clear left in the shell is the panel's own Clear all.
    expect(main.match(/annotate\.clear\(\)/g) ?? []).toHaveLength(1);
    expect(main).toContain('onClearAll: () => viewer.annotate.clear()');
    expect(read('app/openScan.ts')).not.toMatch(/annotate\.clear\(\)/);
    expect(read('app/openStreaming.ts')).not.toMatch(/annotate\.clear\(\)/);
  });
});
