/**
 * modalConfirm.test.ts
 *
 * Contract tests for `openConfirm` (src/ui/Modal.ts) — the styled, Promise-based
 * replacement for `window.confirm()`. The motivation is platform reliability:
 * `window.confirm()` is suppressed in many embedded WebViews, so the three
 * gate prompts (large-file open, sample download, reset-stats) needed a dialog
 * that renders on our own chrome everywhere. These tests pin the resolve
 * semantics that the call sites depend on:
 *   • confirm button  → resolves true
 *   • cancel button   → resolves false
 *   • Escape key      → resolves false (via onClose)
 *   • backdrop click  → resolves false (via onClose)
 *   • close-X button  → resolves false (via onClose)
 *   • the resolution is settled exactly once (idempotent)
 *
 * Runs in the node environment (the project keeps tests DOM-free for speed), so
 * it drives the real Modal code through a minimal recording DOM stub — the same
 * stub-the-slice approach used across the panel tests, extended with the focus
 * / body / listener surface the modal chrome touches.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

type Handler = (e: unknown) => void;

/** A fake element supporting only the surface openModal/openConfirm touch. */
class FakeEl {
  id = '';
  title = '';
  type = '';
  text = '';
  parent: FakeEl | null = null;
  readonly tagName: string;
  readonly children: FakeEl[] = [];
  private readonly _attrs = new Map<string, string>();
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();
  /** Always "visible" so the focus-trap's offsetParent filter keeps buttons. */
  readonly offsetParent: FakeEl | null = FAKE_VISIBLE;
  focused = false;

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  set textContent(v: string) {
    this.text = v;
  }
  get textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(k: string, v: string): void {
    this._attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this._attrs.get(k) ?? null;
  }
  append(...kids: FakeEl[]): void {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  focus(): void {
    ACTIVE.el = this;
    this.focused = true;
  }
  addEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type) ?? [];
    list.push(fn);
    this._handlers.set(type, list);
  }
  dispatch(type: string, e: unknown = {}): void {
    for (const fn of this._handlers.get(type) ?? []) fn(e);
  }
  /** Recursively collect descendants (and self) matching a class token. */
  private _collect(token: string, acc: FakeEl[]): void {
    if (this._classes.has(token)) acc.push(this);
    for (const c of this.children) c._collect(token, acc);
  }
  querySelectorAll(selector: string): FakeEl[] {
    // The modal's FOCUSABLE selector targets buttons; we approximate by
    // returning every descendant <button>. That's exactly the trap's input.
    void selector;
    const acc: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      if (n.tagName === 'button') acc.push(n);
      for (const c of n.children) walk(c);
    };
    walk(this);
    return acc;
  }
  /** Test helper: find first descendant (or self) with a class token. */
  find(token: string): FakeEl | null {
    const acc: FakeEl[] = [];
    this._collect(token, acc);
    return acc[0] ?? null;
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
/** Window-level keydown listeners (the modal traps Tab / Escape here). */
const WIN_LISTENERS = new Map<string, Handler[]>();
let BODY: FakeEl;

beforeAll(() => {
  // `el()` guards `node instanceof HTMLAnchorElement / HTMLInputElement` before
  // setting href / type. In the node environment those globals don't exist, so
  // provide inert constructors that FakeEl never instances (every `instanceof`
  // stays false) — exactly mirroring the real DOM, where our buttons/divs are
  // neither anchors nor inputs.
  (globalThis as unknown as { HTMLAnchorElement: unknown }).HTMLAnchorElement = class {};
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = class {};
  // The modal narrows `document.activeElement instanceof HTMLElement` (to know
  // what to restore focus to). Our FakeEl IS the element type here, so map
  // HTMLElement onto it — then a focused FakeEl satisfies the guard.
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeEl;
  BODY = new FakeEl('body');
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    get activeElement() {
      return ACTIVE.el;
    },
    get body() {
      return BODY;
    },
    contains: (node: FakeEl | null) => BODY.contains(node),
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

/** Fire a window-level keydown (what the modal's Escape/Tab trap listens on). */
function winKeydown(key: string): void {
  const e = { key, stopPropagation() {}, preventDefault() {}, shiftKey: false };
  for (const fn of [...(WIN_LISTENERS.get('keydown') ?? [])]) fn(e);
}

async function open(message = 'Proceed?') {
  const { openConfirm } = await import('../src/ui/Modal');
  const promise = openConfirm({ title: 'Confirm', message });
  // The backdrop is the only child appended to <body>.
  const backdrop = BODY.children[BODY.children.length - 1];
  return { promise, backdrop };
}

describe('openConfirm', () => {
  it('resolves true when the confirm button is clicked', async () => {
    const { promise, backdrop } = await open();
    backdrop.find('olv-confirm-ok')!.dispatch('click');
    await expect(promise).resolves.toBe(true);
    // Dialog is torn down after a decision.
    expect(BODY.children.length).toBe(0);
  });

  it('resolves false when the cancel button is clicked', async () => {
    const { promise, backdrop } = await open();
    backdrop.find('olv-confirm-cancel')!.dispatch('click');
    await expect(promise).resolves.toBe(false);
    expect(BODY.children.length).toBe(0);
  });

  it('resolves false on Escape (window keydown trap)', async () => {
    const { promise } = await open();
    winKeydown('Escape');
    await expect(promise).resolves.toBe(false);
    expect(BODY.children.length).toBe(0);
  });

  it('resolves false when the backdrop is clicked outside the card', async () => {
    const { promise, backdrop } = await open();
    // The handler closes only when the click target IS the backdrop itself.
    backdrop.dispatch('click', { target: backdrop });
    await expect(promise).resolves.toBe(false);
  });

  it('resolves false when the close-X is clicked', async () => {
    const { promise, backdrop } = await open();
    backdrop.find('olv-modal-x')!.dispatch('click');
    await expect(promise).resolves.toBe(false);
  });

  it('settles exactly once — a later interaction cannot flip the result', async () => {
    const { promise, backdrop } = await open();
    backdrop.find('olv-confirm-ok')!.dispatch('click'); // true wins
    // A stray Escape after the decision must not change the resolved value.
    winKeydown('Escape');
    await expect(promise).resolves.toBe(true);
  });

  it('focuses the cancel button so a reflexive Enter is a safe "no"', async () => {
    const { backdrop } = await open();
    expect(backdrop.find('olv-confirm-cancel')!.focused).toBe(true);
  });

  it('splits a multi-line message into one paragraph per non-empty line', async () => {
    const { backdrop } = await open('Reason one.\nReason two.');
    const lines = backdrop.querySelectorAll('button'); // not the target; sanity
    void lines;
    const body = backdrop.find('olv-confirm-body')!;
    const paras = body.children.filter((c) => c.className.includes('olv-confirm-line'));
    expect(paras.map((p) => p.textContent)).toEqual(['Reason one.', 'Reason two.']);
  });
});
