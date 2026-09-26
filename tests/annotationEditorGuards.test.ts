/**
 * tests/annotationEditorGuards.test.ts
 *
 * Round-1 quality-review fixes for the annotation editor's dirty-draft guard
 * (AnnotationController._guardReopen/_guardedClose/_guardedRestore +
 * AnnotationEditor.reopenIfPossible/confirmDiscard):
 *
 *   1. Re-entrancy: a second guarded call (beginDraft/beginEdit/setActive(false)
 *      /undo/redo) arriving while a discard confirm from an earlier one is
 *      still pending must not stack a second dialog, and must not fire the
 *      deferred action twice once the user finally answers.
 *   2. A deferred undo/redo (one that had to wait on the confirm) must still
 *      run inside `withSuppressed`, even though the caller's own suppression
 *      window (main.ts's `withSuppressed(() => viewer.annotate.undo())`) has
 *      already closed by the time the user answers.
 *   3. The editor's ResizeObserver is disconnected on dispose, not leaked.
 *   5. `confirmDiscard`'s prompt returns focus into the still-open draft on
 *      "Keep editing", not to whatever triggered the interrupted reopen.
 *
 * `openConfirm` (src/ui/Modal.ts) is mocked to a controllable promise so these
 * tests can drive the async confirm step by hand; `trapTab` passes through
 * unmocked since nothing here fires a keydown.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { withSuppressed, noteEdit, _resetUndoRouter } from '../src/ui/undoRouter';
import { FakeEl } from './support/measurePanelDom';

type ConfirmOpts = { returnFocusTo?: unknown };

const openConfirmCalls: ConfirmOpts[] = [];
let pendingResolvers: Array<(v: boolean) => void> = [];

vi.mock('../src/ui/Modal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/Modal')>();
  return {
    ...actual,
    openConfirm: vi.fn((opts: ConfirmOpts) => {
      openConfirmCalls.push(opts);
      return new Promise<boolean>((resolve) => {
        pendingResolvers.push(resolve);
      });
    }),
  };
});

/** A ResizeObserver stub that records every instance created, so `dispose()`
 * can be asserted to have disconnected the one the editor made. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(_cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    querySelector: () => null,
    contains: () => true,
    activeElement: null,
  };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.HTMLTextAreaElement = class HTMLTextAreaElement {};
  g.window = { innerWidth: 1280, innerHeight: 800 };
  g.ResizeObserver = FakeResizeObserver;
});

beforeEach(() => {
  openConfirmCalls.length = 0;
  pendingResolvers = [];
  FakeResizeObserver.instances.length = 0;
  _resetUndoRouter();
});

/** Flush the microtask + one macrotask turn — enough for the
 * confirmDiscard()/`.then()` chain to settle after a resolver fires. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a second guarded call while a discard confirm is pending', () => {
  it('does not stack a second dialog, and does not fire the deferred action twice', async () => {
    const { AnnotationEditor } = await import('../src/ui/AnnotationEditor');
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const openSpy = vi.spyOn(AnnotationEditor.prototype, 'open');

    const c = new AnnotationController();
    await c.ensureEditor(); // the card rides its own chunk; load it first
    const card = c.editorElement as unknown as FakeEl;

    // Open the first draft, then dirty it with a real click (the same
    // signal reopenIfPossible checks).
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(openSpy).toHaveBeenCalledTimes(1);
    card.querySelectorAll('.olv-anno-chip-warning')[0].click();

    // Two more guarded calls arrive before the user answers anything.
    c.beginDraft({ x: 1, y: 1, z: 1 }, 10, 10);
    c.beginDraft({ x: 2, y: 2, z: 2 }, 20, 20);

    // Only one confirm dialog was ever raised for the two re-entrant calls.
    expect(openConfirmCalls).toHaveLength(1);

    // The user discards. If the second re-entrant call had also attached its
    // own `.then`, this single answer would fire `open()` twice more.
    pendingResolvers[0](true);
    await flush();

    expect(openSpy).toHaveBeenCalledTimes(2);
  });
});

describe('a deferred undo/redo stays suppressed after the caller\'s own withSuppressed has closed', () => {
  it('does not let the router think annotation edits happened while a dirty draft confirm was pending', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    await c.ensureEditor();
    // Mirror main.ts's wiring: every controller change notes the annotation
    // stack, unless the caller is inside withSuppressed; the real
    // `withSuppressed` is injected exactly as main.ts injects it, so a
    // deferred restore is suppressed by the same singleton the global
    // undo/redo handler and `noteEdit` share.
    c.setOnChange(() => noteEdit('annotation'));
    c.setEditSuppressor(withSuppressed);

    // A real user edit — creates an undo-able snapshot and (correctly)
    // marks 'annotation' as last-edited.
    c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    (c.editorElement as unknown as FakeEl)
      .querySelectorAll('.olv-anno-editor-save')[0]
      .click();
    expect(c.canUndo).toBe(true);

    // The user's most recent action, per the router, is now classification —
    // simulating the failure scenario: a classification edit happened after
    // the annotation one.
    noteEdit('classification');

    // Open a second, dirty draft so undo() cannot run synchronously.
    c.beginDraft({ x: 1, y: 1, z: 1 }, 10, 10);
    (c.editorElement as unknown as FakeEl)
      .querySelectorAll('.olv-anno-chip-warning')[0]
      .click();

    // main.ts's global undo handler: `withSuppressed(() => viewer.annotate.undo())`.
    // This call returns immediately (the draft is dirty, so undo() only
    // queues the confirm) — the outer suppression window is CLOSED by the
    // time we get past this line.
    withSuppressed(() => c.undo());
    expect(openConfirmCalls).toHaveLength(1);

    // The user discards the dirty draft, so the deferred undo now runs — well
    // after main.ts's own withSuppressed already returned above.
    pendingResolvers[0](true);
    await flush();

    // The undo genuinely ran...
    expect(c.getAnnotations()).toHaveLength(0);
    // ...but did NOT re-mark 'annotation' as last-edited: a redo issued right
    // now must still be free to pick 'classification' first, which is what a
    // router unaffected by this stale, deferred change looks like.
    const { pickRedo, pickUndo } = await import('../src/ui/undoRouter');
    void pickUndo;
    // lastUndone is null (nothing was undone through the router's own
    // pickUndo), so pickRedo falls back to lastEdited — which must still read
    // 'classification', not 'annotation', if the deferred restore was
    // correctly suppressed.
    expect(pickRedo(true, true)).toBe('classification');
  });
});

describe('AnnotationEditor.dispose()', () => {
  it('disconnects the ResizeObserver instead of leaking it', async () => {
    const { AnnotationEditor } = await import('../src/ui/AnnotationEditor');
    const card = new AnnotationEditor();
    expect(FakeResizeObserver.instances).toHaveLength(1);
    card.dispose();
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });

  it('is reached through AnnotationController.dispose()', async () => {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    await c.ensureEditor();
    const before = FakeResizeObserver.instances.length;
    expect(before).toBeGreaterThan(0);
    c.dispose();
    expect(FakeResizeObserver.instances.at(-1)?.disconnected).toBe(true);
  });
});

describe("confirmDiscard's prompt returns focus into the draft", () => {
  it('passes the card\'s own title field as returnFocusTo, not the interrupting trigger', async () => {
    const { AnnotationEditor } = await import('../src/ui/AnnotationEditor');
    const card = new AnnotationEditor();
    card.open({ x: 0, y: 0, onSave: () => {}, onCancel: () => {} });
    const el = card.element as unknown as FakeEl;
    el.querySelectorAll('.olv-anno-chip-warning')[0].click(); // dirty it

    expect(card.reopenIfPossible()).toBe(false);
    void card.confirmDiscard();

    expect(openConfirmCalls).toHaveLength(1);
    const titleField = el.querySelectorAll('.olv-anno-editor-title')[0];
    expect(openConfirmCalls[0].returnFocusTo).toBe(titleField);
  });
});

describe('AnnotationPanel row and header controls are keyboard-reachable', () => {
  it('gives every interactive button an explicit tabIndex, matching the editor chips', async () => {
    const { AnnotationPanel } = await import('../src/ui/AnnotationPanel');
    const panel = new AnnotationPanel({
      onActivate: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onClearAll: () => {},
      onHover: () => {},
      onSetIssueStatus: () => {},
    });
    panel.update([
      {
        id: 'a',
        index: 1,
        title: 'a',
        type: 'issue',
        note: '',
        createdAt: 1,
        updatedAt: 1,
        selected: false,
        localPosition: { x: 0, y: 0, z: 0 },
        issue: { severity: 'high', status: 'open' },
      },
    ]);
    const el = panel.element as unknown as FakeEl;
    const buttons = [
      ...el.querySelectorAll('.olv-ap-view'),
      ...el.querySelectorAll('.olv-collapse-toggle'),
      ...el.querySelectorAll('.olv-ap-action'),
      ...el.querySelectorAll('.olv-ap-name'),
      ...el.querySelectorAll('.olv-ap-edit'),
      ...el.querySelectorAll('.olv-ap-del'),
      ...el.querySelectorAll('.olv-ap-issue-status'),
    ];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.tabIndex).toBe(0);
  });
});
