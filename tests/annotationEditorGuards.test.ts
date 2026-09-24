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

type Handler = (e: unknown) => void;
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

/** A recording DOM node covering only the surface these views touch — same
 * minimal shape as tests/annotationIssuePanel.test.ts's stub. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  private _text = '';
  title = '';
  value = '';
  type = '';
  placeholder = '';
  rows = 0;
  maxLength = 0;
  checked = false;
  disabled = false;
  tabIndex = -1;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (...c: string[]): void => void c.forEach((x) => classes.add(x)),
      remove: (...c: string[]): void => void c.forEach((x) => classes.delete(x)),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }
  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) {
    /* icon markup — not parsed by this stub */
  }

  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) {
      kid.parent = this;
      return kid;
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return t;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(this._adopt(k));
  }
  appendChild(kid: unknown): unknown {
    this.children.push(this._adopt(kid));
    return kid;
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {
    /* not exercised */
  }
  click(): void {
    for (const fn of this.handlers.get('click') ?? [])
      fn({
        type: 'click',
        clientX: 0,
        clientY: 0,
        stopPropagation: () => {},
        preventDefault: () => {},
      });
  }
  focus(): void {}
  blur(): void {}
  select(): void {}

  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

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
