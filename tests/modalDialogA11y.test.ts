/**
 * modalDialogA11y.test.ts
 *
 * Contract tests for `wireDialogA11y` (src/ui/Modal.ts) — the shared
 * Escape-anywhere + Tab-trap + focus-restore primitive that hand-rolled
 * dialogs (CommandPalette, ShortcutSheet, HelpOverlay, BatchConverter,
 * WorkflowConfigPanel) wire themselves onto instead of reimplementing this
 * from scratch. These tests pin the exact defect those surfaces had before
 * adopting it:
 *   • Escape fires `onEscape`, even reached via the window (not just a
 *     listener scoped to one input inside the dialog).
 *   • Tab cycles inside the dialog rather than escaping to the background.
 *   • `teardown()` stops listening and restores focus to the element that
 *     was active before the dialog was wired.
 *   • `teardown()` is idempotent (a stray second close cannot double-restore
 *     or throw).
 *
 * Runs in the node environment, driving the real Modal code through the same
 * minimal recording DOM stub used by modalConfirm.test.ts.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

type Handler = (e: unknown) => void;

/** A fake element supporting only the surface wireDialogA11y/trapTab touch. */
class FakeEl {
  parent: FakeEl | null = null;
  readonly tagName: string;
  readonly children: FakeEl[] = [];
  private readonly _handlers = new Map<string, Handler[]>();
  /** Always "visible" so the focus-trap's offsetParent filter keeps buttons. */
  readonly offsetParent: FakeEl | null = FAKE_VISIBLE;
  focused = false;
  disabled = false;

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...kids: FakeEl[]): void {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  focus(): void {
    if (this.disabled) return;
    ACTIVE.el = this;
    this.focused = true;
  }
  addEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type) ?? [];
    list.push(fn);
    this._handlers.set(type, list);
  }
  removeEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  querySelectorAll(selector: string): FakeEl[] {
    // The FOCUSABLE selector targets buttons/inputs; approximate by
    // returning every descendant "button" — exactly the trap's real input.
    void selector;
    const acc: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      if (n.tagName === 'button') acc.push(n);
      for (const c of n.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return acc;
  }
  contains(node: FakeEl | null): boolean {
    if (node === null) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
}

/** Sentinel for offsetParent (just needs to be non-null). */
const FAKE_VISIBLE = {} as unknown as FakeEl;
/** Tracks the "active element" so document.activeElement reflects focus(). */
const ACTIVE: { el: FakeEl | null } = { el: null };
/** Window-level keydown listeners (what the primitive wires Escape/Tab to). */
const WIN_LISTENERS = new Map<string, Handler[]>();
let BODY: FakeEl;

beforeAll(() => {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeEl;
  BODY = new FakeEl('body');
  (globalThis as unknown as { document: unknown }).document = {
    get activeElement() {
      return ACTIVE.el;
    },
    get body() {
      return BODY;
    },
    contains: (node: FakeEl | null) => BODY.contains(node) || node === BODY,
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, fn: Handler) => {
      const list = WIN_LISTENERS.get(type) ?? [];
      list.push(fn);
      WIN_LISTENERS.set(type, list);
    },
    removeEventListener: (type: string, fn: Handler) => {
      const list = WIN_LISTENERS.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
});

afterEach(() => {
  BODY.children.length = 0;
  WIN_LISTENERS.clear();
  ACTIVE.el = null;
});

/** Fire a window-level keydown (what the trap listens on). */
function winKeydown(key: string, extra: Record<string, unknown> = {}): void {
  const e = { key, stopPropagation() {}, preventDefault() {}, shiftKey: false, ...extra };
  for (const fn of [...(WIN_LISTENERS.get('keydown') ?? [])]) fn(e);
}

describe('wireDialogA11y', () => {
  it('calls onEscape when Escape reaches the window, not just a per-input listener', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const dialog = new FakeEl('div');
    const trigger = new FakeEl('button');
    trigger.focus();
    let escaped = false;
    wireDialogA11y(dialog as unknown as HTMLElement, { onEscape: () => { escaped = true; } });
    // Focus has moved off the dialog entirely (e.g. Tab walked focus onto a
    // background control) — the old per-input Escape listener would have
    // missed this. The window-level trap must not.
    ACTIVE.el = null;
    winKeydown('Escape');
    expect(escaped).toBe(true);
  });

  it('traps Tab inside the dialog: Shift+Tab from the first item wraps to the last', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const dialog = new FakeEl('div');
    const first = new FakeEl('button');
    const last = new FakeEl('button');
    dialog.append(first, last);
    first.focus();
    wireDialogA11y(dialog as unknown as HTMLElement, { onEscape: () => {} });
    let prevented = false;
    const e = { key: 'Tab', shiftKey: true, stopPropagation() {}, preventDefault() { prevented = true; } };
    for (const fn of [...(WIN_LISTENERS.get('keydown') ?? [])]) fn(e);
    expect(prevented).toBe(true);
    expect(ACTIVE.el).toBe(last);
  });

  it('teardown() stops listening — a later Escape no longer fires onEscape', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const dialog = new FakeEl('div');
    let calls = 0;
    const handle = wireDialogA11y(dialog as unknown as HTMLElement, { onEscape: () => { calls += 1; } });
    winKeydown('Escape');
    expect(calls).toBe(1);
    handle.teardown();
    winKeydown('Escape');
    expect(calls).toBe(1); // unchanged — the listener is gone
  });

  it('teardown() restores focus to the element that was active before wiring', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const trigger = new FakeEl('button');
    BODY.append(trigger);
    trigger.focus();
    const dialog = new FakeEl('div');
    const input = new FakeEl('input' /* stand-in focusable dialog control */);
    dialog.append(input);
    BODY.append(dialog);
    const handle = wireDialogA11y(dialog as unknown as HTMLElement, { onEscape: () => {} });
    input.focus(); // the dialog moves focus into itself, same as every real caller
    expect(ACTIVE.el).toBe(input);
    handle.teardown();
    expect(ACTIVE.el).toBe(trigger);
  });

  it('teardown() is idempotent — a second call does not throw or re-restore', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const trigger = new FakeEl('button');
    BODY.append(trigger);
    trigger.focus();
    const dialog = new FakeEl('div');
    const handle = wireDialogA11y(dialog as unknown as HTMLElement, { onEscape: () => {} });
    handle.teardown();
    const other = new FakeEl('button');
    BODY.append(other);
    other.focus();
    expect(() => handle.teardown()).not.toThrow();
    // The second teardown must not steal focus back a second time.
    expect(ACTIVE.el).toBe(other);
  });

  it('honours an explicit returnFocusTo over the active element at wire time', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const explicit = new FakeEl('button');
    const ambient = new FakeEl('button');
    BODY.append(explicit, ambient);
    ambient.focus();
    const dialog = new FakeEl('div');
    const handle = wireDialogA11y(dialog as unknown as HTMLElement, {
      onEscape: () => {},
      returnFocusTo: explicit as unknown as HTMLElement,
    });
    handle.teardown();
    expect(ACTIVE.el).toBe(explicit);
  });
});
