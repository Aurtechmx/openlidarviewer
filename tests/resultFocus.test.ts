/**
 * resultFocus.test.ts
 *
 * Contract tests for `openResultFocus` (src/ui/ResultFocus.ts) — the shared
 * "expand to focus" surface a panel escalates a rich result into. It is a thin
 * presentation container over `openModal`, so these tests pin the state machine
 * it owns: the render callback fills the surface, the surface mounts on <body>,
 * and every dismissal path (Escape, backdrop click, close-X, the returned
 * handle) tears it down and restores focus to the trigger. The exit timer is
 * exercised too: with motion enabled the node lingers for its fade, then drops.
 *
 * Runs in the node environment (the project keeps tests DOM-free for speed), so
 * it drives the real Modal/ResultFocus code through a recording DOM stub — the
 * same stub-the-slice approach modalConfirm.test.ts uses, extended with the
 * matchMedia / setTimeout / querySelector surface this surface touches.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

type Handler = (e: unknown) => void;

/** A fake element supporting only the surface openModal/openResultFocus touch. */
class FakeEl {
  id = '';
  title = '';
  type = '';
  text = '';
  tabIndex = 0;
  parent: FakeEl | null = null;
  readonly tagName: string;
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  private readonly _attrs = new Map<string, string>();
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();
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
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
      contains: (c: string): boolean => classes.has(c),
    };
  }
  set textContent(v: string) {
    this.text = v;
  }
  get textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) {
    /* icon markup — irrelevant to these tests */
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
  getBoundingClientRect(): Record<string, number> {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  private _collect(token: string, acc: FakeEl[]): void {
    if (this._classes.has(token)) acc.push(this);
    for (const c of this.children) c._collect(token, acc);
  }
  querySelector(selector: string): FakeEl | null {
    const token = selector.replace(/^\./, '');
    const acc: FakeEl[] = [];
    this._collect(token, acc);
    return acc[0] ?? null;
  }
  querySelectorAll(_selector: string): FakeEl[] {
    const acc: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      if (n.tagName === 'button') acc.push(n);
      for (const c of n.children) walk(c);
    };
    walk(this);
    return acc;
  }
  /** Test helper: first descendant (or self) carrying a class token. */
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

const FAKE_VISIBLE = {} as unknown as FakeEl;
const ACTIVE: { el: FakeEl | null } = { el: null };
const WIN_LISTENERS = new Map<string, Handler[]>();
/** Pending exit-timer callbacks (openModal's `exitMs` path). */
const TIMERS: Array<() => void> = [];
/** Toggles what `window.matchMedia('(prefers-reduced-motion: reduce)')` reports. */
let REDUCE = false;
let BODY: FakeEl;

beforeAll(() => {
  (globalThis as unknown as { HTMLAnchorElement: unknown }).HTMLAnchorElement = class {};
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = class {};
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
    matchMedia: (_q: string) => ({ matches: REDUCE }),
    setTimeout: (fn: () => void) => {
      TIMERS.push(fn);
      return TIMERS.length;
    },
  };
});

beforeEach(() => {
  REDUCE = false;
});

afterEach(() => {
  BODY.children.length = 0;
  WIN_LISTENERS.clear();
  TIMERS.length = 0;
  ACTIVE.el = null;
});

function winKeydown(key: string): void {
  const e = { key, stopPropagation() {}, preventDefault() {}, shiftKey: false };
  for (const fn of [...(WIN_LISTENERS.get('keydown') ?? [])]) fn(e);
}

async function openFocus(reduce = true): Promise<{
  handle: { element: FakeEl; close(): void };
  backdrop: FakeEl;
  trigger: FakeEl;
}> {
  REDUCE = reduce; // reduced motion → synchronous teardown (exitMs 0)
  const { openResultFocus } = await import('../src/ui/ResultFocus');
  const trigger = new FakeEl('button');
  trigger.focus(); // the control that "opened" the surface holds focus
  const handle = openResultFocus({
    title: 'Profile A',
    triggerEl: trigger as unknown as HTMLElement,
    render: (container) => {
      const marker = new FakeEl('div');
      marker.className = 'rf-marker';
      (container as unknown as FakeEl).append(marker);
    },
  }) as unknown as { element: FakeEl; close(): void };
  const backdrop = BODY.children[BODY.children.length - 1];
  return { handle, backdrop, trigger };
}

describe('openResultFocus', () => {
  it('mounts on <body> and runs the render callback into the surface body', async () => {
    const { backdrop } = await openFocus();
    expect(backdrop.classList.contains('olv-result-focus')).toBe(true);
    // The caller's content lands inside the surface body, not loose on the backdrop.
    const body = backdrop.find('olv-result-focus-body')!;
    expect(body.find('rf-marker')).not.toBeNull();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const { trigger } = await openFocus();
    winKeydown('Escape');
    expect(BODY.children.length).toBe(0);
    expect(trigger.focused).toBe(true);
  });

  it('closes on a backdrop click (outside the card)', async () => {
    const { backdrop } = await openFocus();
    backdrop.dispatch('click', { target: backdrop });
    expect(BODY.children.length).toBe(0);
  });

  it('closes on the close-X control', async () => {
    const { backdrop } = await openFocus();
    backdrop.find('olv-modal-x')!.dispatch('click');
    expect(BODY.children.length).toBe(0);
  });

  it('closes via the returned handle', async () => {
    const { handle } = await openFocus();
    handle.close();
    expect(BODY.children.length).toBe(0);
  });

  it('with motion, defers teardown for the exit transition, then removes', async () => {
    const { handle, backdrop } = await openFocus(false);
    handle.close();
    // Still mounted, marked closing/inert while the fade plays.
    expect(BODY.children.length).toBe(1);
    expect(backdrop.classList.contains('olv-modal-closing')).toBe(true);
    // Flush the exit timer → the node is dropped.
    for (const fn of TIMERS.splice(0)) fn();
    expect(BODY.children.length).toBe(0);
  });
});
